// Host-wide command admission, sized from the host itself: every platform waits
// for CPU load and free memory before starting the command. Linux measures the
// CPUs busy; elsewhere the 1-minute load average stands in for them. The gate then owns
// the command's descendants until they stop, and holds nothing else while it runs.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants as fs,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readlinkSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { availableParallelism, constants, cpus, hostname, loadavg, totalmem, userInfo } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { type Cancellation, cancelled, follow, forwards, GROUP, interrupts, received, requested } from "./interrupt";
import { stubbed } from "./job";
import { argvName } from "../core";
import { runs } from "./program";
import { envSessions, logWait } from "./waits";
import { cgroupUsage, measuredRun, questScope, scopeGroup, startTime, systemdScopes } from "./supervise";

/**
 * One admitted command: a unique id, the wall-clock time it was admitted, and the process ID of
 * the gate that runs it, which holds a slot until that command ends, with when that gate started
 * (see `processStart`), so a reused process ID holds nothing. `queued` marks a caller still
 * waiting for its turn instead, as of `at`: it holds a place in the queue, the ledger's order of
 * queued entries, and no slot. `cores` is the most CPUs the command kept busy over any
 * SETTLE_MS of the last RECENT_MS, and `group` the cgroup of its systemd scope, from which other
 * gates read its memory, where its gate measures them (see `measure`).
 */
export interface Admission {
	id: string;
	at: number;
	pid?: number;
	queued?: boolean;
	start?: string;
	cores?: number;
	group?: string;
}

/** One version of the host's admission ledger and queue. Versions only grow; 0 is the empty ledger. */
export interface Ledger {
	version: number;
	admissions: Admission[];
}

/** The machine-wide inputs to load admission, replaceable in tests. */
export interface Host {
	/**
	 * The host's CPU load in CPUs, or undefined until it can be measured: on Linux the CPUs busy
	 * lately (see `busyCpus`), which each call also samples for every gate on the host, elsewhere
	 * the 1-minute load average.
	 */
	load(): number | undefined;
	/** Bytes available to a new command without swapping. */
	memory(): number;
	/** Wall-clock milliseconds, shared by every process on the host. */
	now(): number;
	/** Whether the gate that recorded this admission still runs its command. */
	running(admission: Admission): boolean;
	/** The newest ledger. */
	ledger(): Ledger;
	/**
	 * Atomically publish `admissions` as the version after `base`. False when another caller
	 * published since `base` was read, so the caller reads the ledger again and decides afresh.
	 */
	publish(base: Ledger, admissions: Admission[]): boolean;
	sleep(ms: number, signal: AbortSignal): Promise<void>;
	/** CPU microseconds the processes in systemd scope `unit` have used, or undefined while it does not exist. */
	usage(unit: string): number | undefined;
	/** The cgroup of systemd scope `unit`, or undefined while it does not exist or the kernel keeps no peak memory. */
	memoryGroup(unit: string): string | undefined;
	/** The memory cgroup `group` holds, or undefined once it is gone. */
	footprint(group: string): Footprint | undefined;
}

/** Bytes of memory a cgroup holds. */
export interface Footprint {
	/** Held now, less the inactive file cache that available memory already counts as free. */
	current: number;
	/** The most it has held, file cache included. */
	peak: number;
}

export interface Limits {
	/** The highest CPU load that still admits a command. */
	load: number;
	/** The least available memory, in bytes, that still admits a command. */
	memory: number;
}

export type Waiting = "load" | "memory" | "queue";

/**
 * Admissions that only fit the host's raw load and memory, not its headroom,
 * start at least this far apart, so each one's load can begin to show. Linux
 * measures busy CPUs over about this long.
 */
export const SETTLE_MS = 5000;

/**
 * How long an admission counts against the host's headroom. The 1-minute load
 * average and available memory take about this long to reflect a new command.
 */
export const RECENT_MS = 60_000;

/** The shortest span busy CPUs are measured over; a caller with no sample this old waits this long for one. */
export const CPU_SAMPLE_MS = 1000;

/**
 * How a caller is admitted ahead of the rest.
 *
 * - `priority`: wait only for memory, never for load, whether or not another
 *   gated command runs. Its admissions still count against every other caller's
 *   headroom, so it goes first while the host is loaded. For work whose own
 *   runner bounds it, such as a check that lands PRs.
 */
export interface Precedence {
	priority?: boolean;
}

/** The memory one gated build or test stack is assumed to need. */
export const COMMAND_MEMORY = 4 * 2 ** 30;

/** Usable memory: physical RAM, or a smaller cgroup/container limit. */
export function usableMemory(uid?: number): number {
	if (process.platform === "linux") return linuxMemory("/proc", "/sys/fs/cgroup", uid).total;
	const constrained = process.constrainedMemory?.() ?? 0;
	return constrained > 0 ? Math.min(totalmem(), constrained) : totalmem();
}

/**
 * Derive the limits from the host: no configuration. The load counts every
 * CPU of the host, including ones outside this process's affinity, so its
 * limit is one per host CPU. Each admission reserves one
 * command's memory, though never more than a quarter of a small host's RAM.
 */
export function hostLimits(
	processors = Math.max(availableParallelism(), cpus().length),
	memory = usableMemory(),
): Limits {
	return {
		load: processors,
		memory: Math.min(COMMAND_MEMORY, memory / 4),
	};
}

/** A memory.stat counter, or 0 where the file or key is absent. */
function cgroupStat(group: string, key: string): number {
	try {
		const stat = readFileSync(join(group, "memory.stat"), "utf8");
		return Number(stat.match(new RegExp(`^${key} (\\d+)$`, "m"))?.[1] ?? 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
}

/** The user manager's slice that gate scopes run in (see `background`). */
const BACKGROUND_SLICE = "background.slice";

/**
 * Count reclaimable host cache and the headroom of every enclosing memory cgroup. With `uid`,
 * a command that runs in that user's `background.slice` also counts the slice's headroom, so a
 * slice at its cap reads as full however much the host and the caller's own cgroups have free.
 * Its cap bounds `total` too, so a command's budget (see `hostLimits`) fits under it.
 */
export function linuxMemory(
	proc = "/proc",
	cgroups = "/sys/fs/cgroup",
	uid?: number,
): { total: number; available: number } {
	const meminfo = readFileSync(join(proc, "meminfo"), "utf8");
	const bytes = (key: string) => {
		const value = meminfo.match(new RegExp(`^${key}:\\s+(\\d+) kB$`, "m"))?.[1];
		if (value === undefined) throw new Error(`gate cannot read Linux ${key}`);
		return Number(value) * 1024;
	};
	let total = bytes("MemTotal");
	let available = bytes("MemAvailable");
	/** Bound `total` and the headroom by the limits of the cgroup at `path` under `root` and of each ancestor. */
	const bound = (root: string, path: string, unified: boolean) => {
		const usage = unified ? "memory.current" : "memory.usage_in_bytes";
		// Usage includes inactive file cache, which the kernel reclaims without
		// swapping; subtract it, as container runtimes do for their working set.
		const cache = unified ? "inactive_file" : "total_inactive_file";
		const limits = unified
			? ["memory.max", "memory.high"]
			: ["memory.limit_in_bytes", "memory.soft_limit_in_bytes"];
		// Child cgroups inherit their parents' limits and shared memory usage. The
		// walk ends at the mount point, which a container without a cgroup
		// namespace bind-mounts from its own cgroup: its membership path may not
		// exist below the mount, but the container's limit still applies there.
		const start = resolve(root, `.${path}`);
		// A cgroup namespace shows a cgroup outside it as `/..`, which is not mounted.
		const inside = relative(root, start);
		if (inside === ".." || inside.startsWith(`..${sep}`)) return;
		for (let group = start; ; group = dirname(group)) {
			for (const file of limits) {
				try {
					const limit = Number(readFileSync(join(group, file), "utf8").trim());
					if (!Number.isFinite(limit) || limit <= 0) continue; // "max", or an unset v1 soft limit.
					const current = Number(readFileSync(join(group, usage), "utf8").trim());
					if (!Number.isFinite(current) || current < 0)
						throw new Error("gate cannot read Linux cgroup memory usage");
					const used = Math.max(0, current - cgroupStat(group, cache));
					total = Math.min(total, limit);
					available = Math.min(available, Math.max(0, limit - used));
				} catch (error) {
					// The memory controller may not be enabled in every ancestor.
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
			if (group === root || group === dirname(group)) break;
		}
	};
	for (const line of readFileSync(join(proc, "self/cgroup"), "utf8").trim().split("\n")) {
		const [, controllers, path] = line.match(/^\d+:([^:]*):(.*)$/) ?? [];
		if (controllers === undefined || path === undefined) throw new Error("gate cannot read Linux memory cgroups");
		const unified = controllers === "";
		if (!unified && !controllers?.split(",").includes("memory")) continue;
		bound(resolve(cgroups, unified ? "" : "memory"), path, unified);
	}
	// The slice need not enclose the caller, as for a login session outside the user manager.
	// Only the unified hierarchy has systemd's scopes, and the slice does not exist until one
	// runs in it, when nothing counts against its cap.
	const slice = `/user.slice/user-${uid}.slice/user@${uid}.service/${BACKGROUND_SLICE}`;
	if (uid !== undefined && existsSync(join(cgroups, "cgroup.controllers")) && existsSync(join(cgroups, slice)))
		bound(resolve(cgroups), slice, true);
	return { total, available };
}

/** One reading of `/proc/stat`'s aggregate CPU time, in clock ticks, at wall-clock `at`. */
interface CpuSample {
	at: number;
	busy: number;
	total: number;
}

/**
 * The CPUs busy over the span closest to SETTLE_MS, from `proc`'s `stat` and the samples every gate on
 * the host shares in `file`, which this call adds to: user, nice, system, IRQ, and steal time count,
 * idle and I/O wait do not, so tasks blocked on disk leave their CPUs free. Undefined while no
 * sample is at least CPU_SAMPLE_MS old.
 *
 * Busy CPUs top out at the CPU count however much more work is runnable, so less than one idle CPU
 * reads as unbounded load: the host may be oversubscribed by any amount, and has no CPU for one
 * more command.
 */
export function busyCpus(proc: string, file: string, now: number): number | undefined {
	const stat = readFileSync(join(proc, "stat"), "utf8");
	// user nice system idle iowait irq softirq steal; guest time is already in user and nice.
	const fields = /^cpu +(\d+(?: +\d+){7})/m.exec(stat)?.[1]?.split(/ +/).map(Number);
	const cpus = stat.match(/^cpu\d+ /gm)?.length ?? 0;
	if (fields === undefined || cpus === 0)
		throw new Error(`gate cannot read Linux CPU time from ${join(proc, "stat")}`);
	const total = fields.reduce((sum, ticks) => sum + ticks, 0);
	const current: CpuSample = { at: now, busy: total - fields[3]! - fields[4]!, total };
	// A clock stepped backward dates samples in the future; they are dropped with the stale ones.
	const samples = readSamples(file).filter((sample) => sample.at <= now && sample.at > now - 2 * SETTLE_MS);
	// The sample closest to SETTLE_MS old, so the span is about SETTLE_MS wherever samples allow.
	const base = samples
		.filter((sample) => sample.at <= now - CPU_SAMPLE_MS)
		.reduce<CpuSample | undefined>(
			(best, sample) =>
				best === undefined || Math.abs(now - sample.at - SETTLE_MS) < Math.abs(now - best.at - SETTLE_MS)
					? sample
					: best,
			undefined,
		);
	const newest = samples.at(-1);
	if (newest === undefined || newest.at <= now - CPU_SAMPLE_MS) {
		mkdirSync(dirname(file), { recursive: true });
		const draft = `${file}.${randomUUID()}.tmp`;
		writeFileSync(draft, JSON.stringify([...samples, current]));
		// Concurrent callers each replace the file whole, so a lost sample only shortens the history.
		renameSync(draft, file);
	}
	if (base === undefined) return undefined;
	const ticks = current.total - base.total;
	const busy = current.busy - base.busy;
	// Counters that ran backward, as in a sample from another boot, measure nothing.
	if (ticks <= 0 || busy < 0) return undefined;
	const used = (busy / ticks) * cpus;
	return cpus - used < 1 ? Infinity : used;
}

/** The CPU samples in `file`, oldest first, or none where it is missing or malformed. */
function readSamples(file: string): CpuSample[] {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const valid =
		Array.isArray(value) &&
		value.every((sample: Partial<CpuSample>) =>
			[sample?.at, sample?.busy, sample?.total].every((number) => Number.isFinite(number)),
		);
	return valid ? (value as CpuSample[]) : [];
}

/**
 * Whether the kernel keeps a cgroup's peak memory (`memory.peak`, Linux 5.19), as read from this
 * process's own cgroup, so a gate decides once rather than at each scope's every sample.
 */
export function memoryPeaks(proc = "/proc", cgroups = "/sys/fs/cgroup"): boolean {
	if (process.platform !== "linux") return false;
	const path = /^0::(\/.*)$/m.exec(readFileSync(join(proc, "self/cgroup"), "utf8"))?.[1];
	return path !== undefined && existsSync(join(cgroups, path, "memory.peak"));
}

/** What a scope's cgroup holds, or undefined once systemd removed it. */
function cgroupFootprint(group: string): Footprint | undefined {
	try {
		const read = (file: string) => {
			const bytes = Number(readFileSync(join(group, file), "utf8").trim());
			if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`cannot read ${join(group, file)}`);
			return bytes;
		};
		const current = Math.max(0, read("memory.current") - cgroupStat(group, "inactive_file"));
		return { current, peak: read("memory.peak") };
	} catch (error) {
		if (["ENOENT", "ENODEV"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
		throw error;
	}
}

/**
 * The account's home directory from the user database, not `$HOME`, which
 * callers may override; null for an account missing from it. Bun's `userInfo()`
 * prefers `$HOME`, so a child without one looks the account up.
 */
export function accountHome(): string | null {
	if (process.platform === "win32") return userInfo().homedir;
	const script = `try {
		process.stdout.write(require("node:os").userInfo().homedir);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}`;
	// A compiled Quest runs the script as Bun would. The root holds no project config.
	const lookup = spawnSync(process.execPath, ["-e", script], {
		cwd: "/",
		env: { BUN_BE_BUN: "1" },
		encoding: "utf8",
	});
	if (lookup.error) throw lookup.error;
	if (lookup.status !== 0) throw new Error(`gate cannot look up the account's home: ${lookup.stderr.trim()}`);
	return lookup.stdout || null;
}

/**
 * The Linux PID namespace this process runs in, such as a sandbox's own, or undefined elsewhere.
 * A gate only sees the process IDs of its namespace, so it cannot tell whether a gate in another
 * one still runs, and would drop that gate's admission a minute after it was admitted.
 */
export function pidNamespace(): string | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		return /^pid:\[(\d+)\]$/.exec(readlinkSync("/proc/self/ns/pid"))?.[1];
	} catch {
		return undefined;
	}
}

/**
 * The format version of the gate and agents ledgers, part of their paths, so builds whose ledgers disagree never share one.
 * Bump it with any change to what an admission records or how a gate keeps one that an older gate
 * would misread. An added optional field needs none: older gates keep every field of the entries
 * they carry forward, and only miss what it adds, as a gate without it would.
 */
export const LEDGER_VERSION = 2;

/**
 * Every caller of one user on one host and PID namespace shares this directory, whatever its
 * environment or login sessions. It is named for the host, since a home directory may be shared
 * between machines, and for the namespace, since a gate judges another's admission by its
 * process ID (see `pidNamespace`). An account missing from the user database, as in arbitrary-UID
 * containers, has no home of its own, so it shares one in `tmp` keyed by its UID.
 */
export function claimDirectory(
	home = accountHome(),
	host = hostname(),
	uid = process.getuid?.(),
	tmp = "/tmp",
	namespace: string | null = pidNamespace() ?? null,
): string {
	const name = namespace === null ? host : `${host}-pid${namespace}`;
	const ledger = `admissions-v${LEDGER_VERSION}`;
	if (home !== null) return join(home, ".cache", "quest", ledger, name);
	// Other users can create this name first, so it must be a directory only this UID can write.
	const root = join(tmp, `quest-${uid}`);
	try {
		mkdirSync(root, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const stat = lstatSync(root);
	if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o022) !== 0)
		throw new Error(`gate cannot trust ${root}: it must be a directory that only UID ${uid} can write`);
	return join(root, ledger, name);
}

/** A version cut short, as by power loss, is read as empty: its commands ended with the host. */
function parse(text: string): Admission[] {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return [];
	}
	const valid =
		Array.isArray(value) &&
		value.every(
			(entry: Partial<Admission>) =>
				typeof entry?.id === "string" &&
				Number.isFinite(entry?.at) &&
				(entry.pid === undefined || (Number.isSafeInteger(entry.pid) && entry.pid > 0)) &&
				(entry.queued === undefined || entry.queued === true) &&
				(entry.start === undefined || typeof entry.start === "string") &&
				(entry.cores === undefined || (Number.isSafeInteger(entry.cores) && entry.cores >= 0)) &&
				// Only a gate scope's cgroup, which other gates read memory files from.
				(entry.group === undefined ||
					(typeof entry.group === "string" &&
						entry.group.startsWith("/sys/fs/cgroup/") &&
						posix.normalize(entry.group) === entry.group &&
						/\/quest-gate-[\w-]+\.scope$/.test(entry.group))),
		);
	return valid ? (value as Admission[]) : [];
}

/** Whether a process with this ID exists on the host. A reused ID reads as alive, which only defers to load. */
export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: it exists, but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * When a process started, so that a reused process ID never passes for the one recorded: on Linux
 * the boot's ID and the start time in clock ticks since boot, on macOS the start date `ps` reports
 * in UTC, whatever the caller's time zone and locale. Undefined once the process is gone, and on
 * Windows, which offers neither cheaply.
 */
export function processStart(pid: number): string | undefined {
	if (process.platform === "linux") {
		try {
			return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()} ${startTime(pid)}`;
		} catch (error) {
			if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
			throw error;
		}
	}
	if (process.platform !== "darwin") return undefined;
	const ps = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
		encoding: "utf8",
		env: { TZ: "UTC", LC_ALL: "C" },
	});
	return (ps.status === 0 && ps.stdout.trim()) || undefined;
}

/**
 * Remove a file that another caller may already have removed, or on Windows may still hold open
 * or be removing too. Bun on Windows reports a concurrent removal as EFAULT, where Node reports EPERM.
 */
function remove(file: string) {
	try {
		rmSync(file, { force: true });
	} catch (error) {
		if (!["EPERM", "EBUSY", "EFAULT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
	}
}

/** The file in the ledger's directory holding the host's recent CPU samples (see `busyCpus`). */
const CPU_FILE = "cpu";

/**
 * The ledger is a directory of numbered versions, each the JSON list of recent
 * admissions. A caller publishes version N + 1 by linking a complete draft to
 * that name, which only one caller can create. No lock is held, so a caller
 * that dies at any point leaves nothing that blocks the others. A `uid` says the commands run
 * in that user's `background.slice`, whose headroom bounds the host's memory (see `linuxMemory`).
 */
export function fileHost(directory: string, now = Date.now, uid?: number): Host {
	const path = (version: number) => join(directory, String(version));
	// A scope's cgroup never moves, so systemd is asked for it once.
	const groups = new Map<string, string>();
	const scoped = (unit: string) => {
		const group = groups.get(unit) ?? scopeGroup(unit);
		if (group !== undefined) groups.set(unit, group);
		return group;
	};
	let peaks: boolean | undefined;
	const latest = (): number => {
		let names: string[];
		try {
			names = readdirSync(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
			throw error;
		}
		return names.reduce((max, name) => (/^\d+$/.test(name) ? Math.max(max, Number(name)) : max), 0);
	};
	const ledger = (): Ledger => {
		for (;;) {
			const version = latest();
			if (version === 0) return { version, admissions: [] };
			try {
				return { version, admissions: parse(readFileSync(path(version), "utf8")) };
			} catch (error) {
				// Superseded and pruned since the listing: gone, or on Windows refusing reads while it is removed.
				if (latest() === version) throw error;
			}
		}
	};
	return {
		load: () => (process.platform === "linux" ? busyCpus("/proc", join(directory, CPU_FILE), now()) : loadavg()[0]),
		// macOS counts reclaimable cache as used, so only its load is gated.
		memory: () =>
			process.platform === "darwin"
				? Infinity
				: process.platform === "linux"
					? linuxMemory("/proc", "/sys/fs/cgroup", uid).available
					: process.availableMemory(),
		now,
		running: (admission) =>
			admission.pid !== undefined &&
			alive(admission.pid) &&
			(admission.start === undefined || processStart(admission.pid) === admission.start),
		ledger,
		publish(base, admissions) {
			mkdirSync(directory, { recursive: true });
			const version = base.version + 1;
			const draft = join(directory, `${randomUUID()}.tmp`);
			writeFileSync(draft, JSON.stringify(admissions));
			try {
				linkSync(draft, path(version));
			} catch (error) {
				// EEXIST: another caller published first. ENOENT: a prune took the draft after a clock step.
				if (["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
				throw error;
			} finally {
				remove(draft);
			}
			// A caller that stalled after reading can recreate a version already pruned below the
			// newest. That copy is outside the ledger's history, so it admitted no one.
			const newest = ledger();
			const added = admissions.filter((admission) => !base.admissions.some(({ id }) => id === admission.id));
			const kept =
				newest.version === version ||
				(added.length > 0 &&
					added.every((admission) => newest.admissions.some(({ id }) => id === admission.id)));
			if (!kept) {
				remove(path(version));
				return false;
			}
			// Older versions, and drafts left by callers that died before publishing.
			for (const name of readdirSync(directory)) {
				const file = join(directory, name);
				try {
					if (/^\d+$/.test(name) ? Number(name) < newest.version : statSync(file).mtimeMs < now() - RECENT_MS)
						remove(file);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
			return true;
		},
		sleep: (ms, signal) => sleep(ms, undefined, { signal }),
		usage(unit) {
			const group = scoped(unit);
			// Null once the scope ended, and systemd removed its cgroup.
			return group === undefined ? undefined : (cgroupUsage(group) ?? undefined);
		},
		memoryGroup(unit) {
			peaks ??= memoryPeaks();
			return peaks ? scoped(unit) : undefined;
		},
		footprint: cgroupFootprint,
	};
}

/**
 * The memory a caller is admitted against while the `running` admissions hold the host and the
 * `recent` ones are not yet reflected in it. `memory` is the host's available memory less what each
 * running command's peak adds beyond what it holds now, which available memory already reflects.
 * `reserved` is what the recent admissions take from it on top: one command's memory each, or for
 * a measured one, what the larger of that and its peak adds beyond what it holds now, less what
 * `memory` already took.
 */
function standing(limits: Limits, host: Host, running: Admission[], recent: Admission[]) {
	let grows = 0;
	let reserved = 0;
	for (const admission of new Set([...running, ...recent])) {
		const isRecent = recent.includes(admission);
		// Only a running command still holds its scope; one not measured yet keeps the constant.
		const footprint =
			admission.group !== undefined && running.includes(admission) ? host.footprint(admission.group) : undefined;
		if (footprint === undefined) {
			if (isRecent) reserved += limits.memory;
			continue;
		}
		const { current, peak } = footprint;
		const growth = Math.max(0, peak - current);
		grows += growth;
		if (isRecent) reserved += Math.max(0, Math.max(peak, limits.memory) - current) - growth;
	}
	return { memory: host.memory() - grows, reserved };
}

/** The ledger's queued callers still waiting, and its running and recent admissions, as `host` reads them now. */
function snapshot(host: Host) {
	const ledger = host.ledger();
	const now = host.now();
	const live = ledger.admissions.filter((admission) => host.running(admission));
	const queued = live.filter(
		(admission) => admission.queued && (admission.start !== undefined || admission.at > now - RECENT_MS),
	).length;
	const admissions = ledger.admissions.filter((admission) => !admission.queued);
	const running = admissions.filter((admission) => live.includes(admission));
	const recent = admissions.filter((admission) => admission.at > now - RECENT_MS);
	return { queued, running, recent };
}

/**
 * Whether the host's memory has room for a command arriving now even with `reserved` more recent
 * admissions counted against it: work admitted elsewhere that has not reached the gate yet, such
 * as an agent still reading (see admission.ts). Neither load nor the gate's queue counts, so work
 * waiting for CPUs never holds back what only needs memory.
 */
export function memoryRoom(limits: Limits, host: Host, reserved: number): boolean {
	const { running, recent } = snapshot(host);
	const { memory, reserved: recentMemory } = standing(limits, host, running, recent);
	return memory - recentMemory - reserved * limits.memory >= limits.memory;
}

/**
 * Why a command arriving now would wait, or null when the gate would admit it at once even with
 * `reserved` more recent admissions counted against the headroom, for hosts whose memory alone
 * cannot bound that work (see admission.ts). It counts every queued caller as ahead, and never the
 * spaced admissions `admit` grants on raw room, which would pass the reserved work one by one. Like
 * the gate, it admits a lone arrival whatever the load: with nothing gated running, recent, queued,
 * or reserved, the load is work no gate can wait out.
 */
export function room(limits: Limits, host: Host, reserved: number): Waiting | null {
	const { queued, running, recent } = snapshot(host);
	const measured = host.load();
	if (measured === undefined) return "load";
	const used = running.reduce((sum, admission) => sum + (admission.cores ?? 0), 0);
	const load = running.length > 0 ? Math.max(measured, used) : Math.min(measured, limits.load);
	const { memory, reserved: recentMemory } = standing(limits, host, running, recent);
	if (load > limits.load || used >= limits.load) return "load";
	if (memory < limits.memory) return "memory";
	const pending = queued + reserved;
	const taken = recent.length + pending;
	if (running.length === 0 && taken === 0) return null;
	if (load + taken >= limits.load) return queued > 0 ? "queue" : "load";
	return memory - recentMemory - pending * limits.memory >= limits.memory ? null : queued > 0 ? "queue" : "memory";
}

/**
 * Wait until the host has room for a command, then record its admission. The
 * load and available memory lag new work, so each admission from the last
 * minute counts as one more unit of load and as one command's memory taken
 * from available memory:
 *
 * 1. While load and memory have room even counting those, admit at once.
 * 2. While only the raw load and memory have room, admit one command at a
 *    time, SETTLE_MS after the previous admission.
 * 3. Otherwise wait.
 *
 * The load limit applies only while an admitted command still runs. Without
 * one, the load is work the gate cannot wait out, as on a freshly booted macOS
 * runner, so the raw load counts as having room.
 *
 * Until the host's load can be measured (see `Host.load`), a caller waits
 * CPU_SAMPLE_MS for it.
 *
 * A running command's load can lull, as between a build's phases, while it will
 * soon take the whole host again. So where gates measure their commands (see
 * `measure`), the load counts as at least the CPUs those commands kept busy at
 * their busiest in the last minute, and nothing is admitted while they kept
 * every CPU busy. Likewise its memory can lull, so available memory counts
 * less what each running command's peak adds beyond what it holds now, and a
 * measured recent admission reserves that, or one command's memory if more,
 * rather than one command's memory on top of it.
 *
 * Callers are admitted first come, first served: each records its place in the
 * queue when it starts waiting, and counts every caller queued ahead of it as
 * one more recent admission, so it starts before them only while the host has
 * room for them all. Only the head of the queue waits out the spacing. A place
 * lasts until its caller is admitted, cancelled, or its gate ends; one whose
 * gate's start time is unknown, as on Windows, could pass for a reused process
 * ID, so its caller refreshes it, and it frees a minute after the last refresh.
 * A priority caller goes ahead of the queue (see `Precedence`).
 *
 * Each caller decides against the newest ledger and publishes atomically, so
 * concurrent callers never exceed the rule and one always wins while it has
 * room. There is no admission timeout. Resolves with the admission's id.
 */
export async function admit(
	limits: Limits,
	host: Host,
	signal: AbortSignal,
	waiting?: (reason: Waiting) => void,
	precedence: Precedence = {},
): Promise<string> {
	const id = randomUUID();
	// A place in the queue has an id of its own, so publishing the admission adds a new entry.
	const place = randomUUID();
	// Every admission names its gate's start, so a reused process ID holds no slot.
	const self = { pid: process.pid, start: processStart(process.pid) };

	/** One decision against the newest ledger: true once admitted. */
	const turn = async (): Promise<boolean> => {
		const ledger = host.ledger();
		// Sampled after the read, so only a backward clock step dates an admission in the future.
		const now = host.now();
		const live = new Set(ledger.admissions.filter((admission) => host.running(admission)));
		const kept = ledger.admissions.filter((admission) =>
			admission.queued
				? // A place whose gate cannot be told from a reused process ID lasts only while refreshed.
					admission.id === place ||
					(live.has(admission) && (admission.start !== undefined || admission.at > now - RECENT_MS))
				: // A running admission stays in the ledger past the minute, so later callers still see its slot.
					admission.at > now - RECENT_MS || live.has(admission),
		);
		const admissions = kept.filter((admission) => !admission.queued);
		const running = new Set(admissions.filter((admission) => live.has(admission)));
		const recent = admissions.filter((admission) => admission.at > now - RECENT_MS);
		if (kept.some((admission) => admission.at > now)) {
			// Date those now, so they still count and space admissions but expire a minute after
			// the step. A forward step can only expire admissions up to a minute early.
			host.publish(
				ledger,
				kept.map((admission) => ({ ...admission, at: Math.min(admission.at, now) })),
			);
			return false;
		}
		const position = kept.findIndex((admission) => admission.id === place);
		const mine = kept[position];
		if (
			!precedence.priority &&
			(mine === undefined || (mine.start === undefined && mine.at <= now - RECENT_MS / 2))
		) {
			// Take a place at the back, or refresh one that would otherwise expire where it stands.
			const entry = { id: place, at: now, ...self, queued: true };
			host.publish(
				ledger,
				mine ? kept.map((admission) => (admission === mine ? entry : admission)) : [...kept, entry],
			);
			return false;
		}
		const ahead = kept.slice(0, Math.max(position, 0)).filter((admission) => admission.queued).length;
		// An admission takes the place of this caller's entry in the queue.
		const admitted = (at: number) =>
			host.publish(ledger, [...kept.filter((admission) => admission.id !== place), { id, at, ...self }]);
		// Priority ignores load, whether or not a gated command runs; memory still applies.
		const measured = precedence.priority ? 0 : host.load();
		if (measured === undefined) {
			await host.sleep(CPU_SAMPLE_MS, signal);
			return false;
		}
		const used = precedence.priority ? 0 : [...running].reduce((sum, admission) => sum + (admission.cores ?? 0), 0);
		// The load counts as at least the CPUs the running commands kept busy, and without one as having room.
		const load = running.size > 0 ? Math.max(measured, used) : Math.min(measured, limits.load);
		const { memory, reserved } = standing(limits, host, [...running], recent);
		let wait = SETTLE_MS;
		if (load > limits.load || used >= limits.load) waiting?.("load");
		else if (memory < limits.memory) waiting?.("memory");
		else {
			// Every caller queued ahead takes a slot before this one, so it starts first only while
			// the host has room for them all.
			const taken = recent.length + ahead;
			const headroom = load + taken < limits.load && memory - reserved - ahead * limits.memory >= limits.memory;
			if (!headroom && ahead > 0) waiting?.("queue");
			else {
				const last = Math.max(-Infinity, ...recent.map((admission) => admission.at));
				wait = headroom ? 0 : last + SETTLE_MS - now;
				if (wait <= 0) {
					// A caller descheduled since sampling would record a stale time, which lets the
					// next one skip its spacing; decide again once the stall reaches that interval.
					const at = host.now();
					return at - now < SETTLE_MS && admitted(at);
				}
			}
		}
		await host.sleep(wait, signal);
		return false;
	};

	try {
		for (;;) {
			signal.throwIfAborted();
			if (await turn()) return id;
		}
	} finally {
		// A cancelled caller leaves the queue at once, rather than once its gate ends.
		for (let ledger = host.ledger(); ledger.admissions.some((admission) => admission.id === place);) {
			if (
				host.publish(
					ledger,
					ledger.admissions.filter((admission) => admission.id !== place),
				)
			)
				break;
			ledger = host.ledger();
		}
	}
}

/**
 * Until `signal` aborts, sample the CPU use of the admitted command in systemd scope `unit` every
 * SETTLE_MS, and keep its admission's `cores` at the most CPUs it kept busy over one sample in the
 * last RECENT_MS, rounded, and record the scope's cgroup, from which other callers read its peak
 * memory, so they count it at its busiest rather than at a lull.
 */
export async function measure(
	host: Host,
	admission: { id: string; unit: string },
	signal: AbortSignal,
	lost?: (id: string) => void,
) {
	const samples: { at: number; cores: number }[] = [];
	// The command's scope starts with no CPU use, so a burst before the first sample still counts.
	let previous = { at: host.now(), usage: 0 };
	// The admission as last read, to record again should another gate drop it.
	let known: Admission = { id: admission.id, at: host.now(), pid: process.pid, start: processStart(process.pid) };
	let group: string | undefined;
	for (;;) {
		try {
			await host.sleep(SETTLE_MS, signal);
		} catch (error) {
			if (signal.aborted) return;
			throw error;
		}
		// Sample the host's CPUs too, so a gate arriving while this command runs measures them at once.
		host.load();
		const usage = host.usage(admission.unit);
		const at = host.now();
		if (usage !== undefined) {
			// A clock stepped backward yields no rate for its interval.
			if (at > previous.at) samples.push({ at, cores: (usage - previous.usage) / ((at - previous.at) * 1000) });
			previous = { at, usage };
		}
		while (samples.length > 0 && samples[0].at <= at - RECENT_MS) samples.shift();
		const cores = Math.round(Math.max(0, ...samples.map((sample) => sample.cores)));
		// Other gates read the scope's memory live from its cgroup, once it exists.
		group ??= host.memoryGroup(admission.unit);
		const measured = group === undefined ? { cores } : { cores, group };
		// Checked every sample, so an admission another gate dropped counts again within one.
		for (let ledger = host.ledger(); ; ledger = host.ledger()) {
			const mine = ledger.admissions.find(({ id }) => id === admission.id);
			if (mine !== undefined) known = mine;
			if (mine !== undefined && (mine.cores ?? 0) === cores && mine.group === group) break;
			const updated =
				mine === undefined
					? [...ledger.admissions, { ...known, ...measured }]
					: ledger.admissions.map((other) => (other === mine ? { ...mine, ...measured } : other));
			if (host.publish(ledger, updated)) {
				if (mine === undefined) lost?.(admission.id);
				break;
			}
		}
	}
}

/** Marks an admitted command, so nested gated calls inside it run at once. */
const ADMITTED = "QUEST_GATE_ADMITTED";

/**
 * Set to 1 by whatever runs a check that lands PRs, such as a merge queue build
 * or the land daemon's sandbox, so every gate inside the check is admitted with
 * priority (see `Precedence`).
 */
export const PRIORITY = "QUEST_GATE_PRIORITY";

/**
 * Runs an admitted command with inherited streams and resolves with its exact exit status.
 * Asking to cancel delivers the requested signal to every process the owner holds, unless they
 * already have it (see `forwards`), so each one's own handling of it runs; killing stops them
 * outright.
 */
export type Owner = (command: string[], env: NodeJS.ProcessEnv, cancel: Cancellation) => Promise<number>;

/**
 * Run the command as a plain child. `held` says whether an enclosing owner that signals everything
 * it holds, Quest's group owner (see `GROUP`) or a Quest scope, also holds the child. Its signal
 * then already reached the child, and it also kills everything at its second one, so this leaves
 * both to it: a repeated signal, such as the SIGTERM Just forwards to its own child on top of the
 * owner's, is no kill here.
 */
function plain(held: boolean): Owner {
	return (command, env, cancel) =>
		new Promise((resolve, reject) => {
			const child = spawn(command[0], command.slice(1), { env, stdio: "inherit" });
			const stop = () => {
				if (forwards(cancel.signal, held)) child.kill(requested(cancel.signal));
			};
			const terminate = () => {
				if (!(held && received(cancel.signal))) child.kill("SIGKILL");
			};
			const cleanup = follow(cancel, stop, terminate);
			child.once("error", (error) => {
				cleanup();
				reject(error);
			});
			child.once("close", (code, killed) => {
				cleanup();
				resolve(code ?? (killed ? 128 + constants.signals[killed] : 1));
			});
		});
}

/** Run the command as a plain child, for a caller whose own owner already holds its descendants. */
export const direct: Owner = plain(false);

/** Run the command as a plain child of an enclosing owner that signals everything it holds. */
export const inside: Owner = plain(true);

/**
 * Run the command in its own systemd scope, whose cgroup holds every descendant (see supervise.ts),
 * in the user manager's `background.slice`, whose low CPU weight keeps the desktop session ahead
 * of gated work under contention. Inside a Quest scope, the gate's scope is a sibling bound to
 * `enclosing`, so the enclosing scope keeps its own weight for the session's other work, its
 * owner's kill stops the gate's scope too, and the gate forwards that owner's signals to it.
 */
function background(unit: string, enclosing: string | null): Measuring {
	let used: number | null = null;
	const run: Owner = async (command, env, cancel) => {
		const { status, cpu } = await measuredRun(unit, process.cwd(), command, {
			env,
			cancel,
			within: enclosing,
			slice: BACKGROUND_SLICE,
		});
		used = cpu === null ? null : Math.round(cpu / 1000);
		return status;
	};
	return Object.assign(run, { cpu: () => used });
}

/** An owner that also reports the CPU milliseconds its last run used, or null when it could not read them. */
export type Measuring = Owner & { cpu(): number | null };

/** Run the command in background scope `unit`, a new name, outside any Quest scope (see `background`). */
export const scope = (unit: string): Measuring => background(unit, null);

/** Run the command in background scope `unit`, a new name, bound to the Quest scope `enclosing` (see `background`). */
export const bound = (unit: string, enclosing: string): Measuring => background(unit, enclosing);

/**
 * On Windows, run the command under a stub in a kill-on-close Job Object that forbids breakaway
 * (see job.ts), so every descendant stops once the command exits or the gate stops the stub. The
 * stub lowers itself to below-normal priority first, which everything it starts inherits.
 */
export const job: Owner = (command, env, cancel) => direct(...stubbed(command, env), cancel);

/**
 * Run the command as the leader of a new session, whose process group holds every descendant that
 * does not move to another group or session. `nice` lowers its priority, which every descendant
 * inherits, since no cgroup weighs it against the interactive session. Once the command exits, the rest of its group is
 * killed. The session has no controlling terminal: the command keeps its inherited streams, but a
 * terminal's signals reach it only through Quest, which stands in for the terminal: every SIGINT,
 * SIGTERM, and SIGHUP Quest receives goes to the whole group, as a terminal's Ctrl-C would, and
 * Quest inside the group leaves it there (see `GROUP`).
 *
 * No event reports that a process group emptied, so a cancelled run instead waits on a token: the
 * write end of a pipe on the command's descriptor 3 (`TOKEN`), which every descendant holds unless
 * it or a parent closes it, as Bun and Node do for what they start. Its read end ends once every
 * holder has exited, so each one, such as a leaf that outlives the wrappers around it, finishes its
 * own cleanup before the rest of the group is killed, unless a second signal kills it first.
 */
export const group: Owner = (command, env, cancel) =>
	new Promise((resolve, reject) => {
		const child = spawn("nice", ["-n", "10", ...command], {
			env: { ...env, [GROUP]: "1" },
			stdio: ["inherit", "inherit", "inherit", "pipe"],
			detached: true,
		});
		const token = child.stdio[TOKEN] as Readable;
		const released = new Promise<void>((resolve) => {
			token.once("end", resolve);
			token.once("close", resolve);
			token.once("error", () => resolve());
		});
		token.resume(); // Holders' writes are discarded; only the end matters.
		const signal = (name: NodeJS.Signals) => {
			try {
				process.kill(-child.pid!, name);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ESRCH") return;
				// macOS refuses a group of only zombies with EPERM, where Linux signals them.
				if (code !== "EPERM" || process.platform !== "darwin") throw error;
				const ps = spawnSync("/bin/ps", ["-A", "-o", "pgid=,stat="], { encoding: "utf8" });
				if (ps.status !== 0) throw error;
				const live = ps.stdout.split("\n").some((line) => {
					const [pgid, stat] = line.trim().split(/\s+/);
					return Number(pgid) === child.pid && !stat!.startsWith("Z");
				});
				if (live) throw error;
			}
		};
		let signalled = false;
		const stop = () => {
			signalled = true;
			signal(requested(cancel.signal));
		};
		const terminate = () => signal("SIGKILL");
		child.once("error", reject);
		if (child.pid === undefined) return; // It never started.
		const cleanup = follow(cancel, stop, terminate);
		const killed = new Promise<void>((resolve) => {
			if (cancel.kill.aborted) resolve();
			else cancel.kill.addEventListener("abort", () => resolve(), { once: true });
		});
		child.once("exit", async (code, name) => {
			// Every process in the group got the signal, so let each holder finish its own cleanup.
			if (signalled) await Promise.race([released, killed]);
			cleanup();
			token.destroy();
			try {
				// The group outlives its leader while any member remains, so its ID is not reused yet. A
				// group that emptied during the drain could only be mistaken once the host cycled through
				// every process ID.
				terminate();
			} catch (error) {
				return reject(error);
			}
			resolve(code ?? 128 + constants.signals[name!]);
		});
	});

/** The descriptor on which the group owner hands its command the token (see `group`). */
const TOKEN = 3;

/**
 * The strongest owner this host offers. A nested call runs inside its admitted command, which an
 * enclosing Quest owner also signals when it is Quest's group or a Quest scope (see `inside`). A
 * call inside a Quest scope runs its command in a background scope bound to it. Linux owns descendants through a systemd scope, and settles for a process group,
 * like macOS, without a systemd user manager. Windows owns them through a Job Object. A systemd
 * scope also lets the gate measure its command's CPU use (see `measure`), so `unit` names it.
 */
export function owner(env = process.env, cgroup = "/proc/self/cgroup"): { run: Owner | Measuring; unit?: string } {
	// A Quest scope around this process holds the command too, since it shares the cgroup or an ancestor.
	const enclosing = process.platform === "linux" ? questScope(cgroup) : undefined;
	if (env[ADMITTED] === "1") return { run: env[GROUP] === "1" || enclosing ? inside : direct };
	if (process.platform === "win32") return { run: job };
	const unit = `quest-gate-${randomUUID()}.scope`;
	if (enclosing) return { run: bound(unit, enclosing.unit), unit };
	if (process.platform !== "linux") return { run: group };
	try {
		systemdScopes.check();
		return { run: scope(unit), unit };
	} catch {
		return { run: group };
	}
}

/**
 * The user whose `background.slice` holds a command run as scope `unit`, which the slice's cap
 * bounds and sizes the budget of; undefined for a command no scope runs, as without a systemd user manager.
 */
export function sliceUser(unit: string | undefined): number | undefined {
	return unit === undefined ? undefined : process.getuid?.();
}

const notices: Record<Waiting, string> = {
	load: "quest gate: waiting for CPU load to fall",
	memory: "quest gate: waiting for free memory",
	queue: "quest gate: waiting for commands queued earlier to start",
};

/**
 * Names a file to which every outermost gate appends one JSON line describing its run, however it
 * ends (see `gate`). A nested gate runs inside a command its outermost gate already covers.
 */
const RECORD = "QUEST_GATE_RECORD";

/** Open the file `RECORD` names for appending, before anything runs; undefined while it is unset or empty. */
function recordFile(env: NodeJS.ProcessEnv): { path: string; fd: number } | undefined {
	const path = env[RECORD];
	if (!path) return undefined;
	// Windows has no O_NOFOLLOW, and no reader there yet.
	if (process.platform === "win32") throw new Error(`gate cannot record its run on Windows (${RECORD})`);
	// The command's shells change directory, so a relative path would scatter one reader's lines.
	if (!isAbsolute(path)) throw new Error(`${RECORD} must be an absolute path: ${path}`);
	try {
		// Private to the user, and never through a symlink someone else planted at a shared path.
		const flags = fs.O_WRONLY | fs.O_APPEND | fs.O_CREAT | fs.O_NOFOLLOW;
		return { path, fd: openSync(path, flags, 0o600) };
	} catch (error) {
		throw new Error(`gate cannot record its run in ${path}: ${message(error)}`);
	}
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** How `gate` admits its command. */
export interface GateOptions {
	/** The admission ledger and host measures; this user's on this host when omitted. */
	host?: Host;
}

/** What one gate observed of its run, for its record. */
interface Observed {
	/** Wall-clock milliseconds when the command was admitted. */
	admitted?: number;
	/** The systemd scope the command ran in, whose journal lines hold its CPU time and peak memory. */
	unit?: string;
	/** The CPU milliseconds the command used, where its owner measured them. */
	cpu?: number | null;
}

/**
 * Run from the CLI. A failure to measure the command is fatal even when the command succeeded,
 * since every other gate on the host relies on that accounting; a cancelled command still
 * reports its cancellation. With `RECORD` set, an outermost gate appends its run's line in one
 * write, so concurrent gates leave only whole lines; a line it cannot write fails the gate, except
 * that a cancelled run keeps its cancelled status.
 */
export async function gate(command: string[], options: GateOptions = {}): Promise<number> {
	const outermost = process.env[ADMITTED] !== "1";
	const record = outermost ? recordFile(process.env) : undefined;
	// An outermost gate in an agent session logs its waits for the session's record.
	const waits = outermost && envSessions().length > 0;
	const started = Date.now();
	// Read now: the command may remove its own directory.
	const directory = record || waits ? process.cwd() : "";
	const cancel = interrupts();
	const observed: Observed = {};
	try {
		let status: number;
		let failure: unknown;
		try {
			status = await gated(command, options, outermost, cancel, observed);
		} catch (error) {
			failure = error;
			// The status the CLI exits with for a gate's own failure.
			status = 1;
		}
		const iso = (ms: number) => new Date(ms).toISOString();
		const ended = iso(Date.now());
		if (waits) {
			try {
				logWait(
					{
						kind: "gate",
						command: argvName(command, runs(process.env, directory)),
						start: iso(started),
						admitted: observed.admitted === undefined ? null : iso(observed.admitted),
						end: ended,
						cpu: observed.cpu ?? null,
					},
					{ cwd: directory },
				);
			} catch (error) {
				// A cancelled run exits as it would have, logged or not.
				if (cancel.signal.aborted) process.stderr.write(`quest gate: ${message(error)}\n`);
				else {
					failure = failure === undefined ? error : new Error(`${message(failure)}; ${message(error)}`);
					status = 1;
				}
			}
		}
		if (!record) {
			if (failure !== undefined) throw failure;
			return status;
		}
		const line = Buffer.from(
			`${JSON.stringify({
				command,
				directory,
				started: iso(started),
				admitted: observed.admitted === undefined ? null : iso(observed.admitted),
				ended,
				cpu: observed.cpu ?? null,
				unit: observed.unit ?? null,
				exit: status,
				cancelled: cancel.signal.aborted,
				error: failure === undefined ? null : message(failure),
			})}\n`,
		);
		try {
			const written = writeSync(record.fd, line);
			if (written !== line.length) throw new Error(`wrote ${written} of ${line.length} bytes`);
		} catch (error) {
			const unrecorded = `gate cannot record its run in ${record.path}: ${message(error)}`;
			// A cancelled run exits as it would have, recorded or not.
			if (cancel.signal.aborted) {
				process.stderr.write(`quest ${unrecorded}\n`);
				if (failure !== undefined) throw failure;
				return status;
			}
			throw new Error(failure === undefined ? unrecorded : `${message(failure)}; ${unrecorded}`);
		} finally {
			closeSync(record.fd);
		}
		if (failure !== undefined) throw failure;
		return status;
	} finally {
		cancel.close();
	}
}

/** Admit the command unless nested, then run it, noting what the record needs in `observed`. */
async function gated(
	command: string[],
	options: GateOptions,
	outermost: boolean,
	cancel: ReturnType<typeof interrupts>,
	observed: Observed,
): Promise<number> {
	const { run, unit } = owner();
	let admitted: { host: Host; id: string } | undefined;
	// A nested invocation executes inside the already admitted command.
	if (outermost) {
		const shown = new Set<Waiting>();
		try {
			const notice = (reason: Waiting) => {
				if (shown.has(reason)) return;
				shown.add(reason);
				process.stderr.write(`${notices[reason]}\n`);
			};
			const precedence = {
				priority: process.env[PRIORITY] === "1",
			};
			const user = sliceUser(unit);
			const host = options.host ?? fileHost(claimDirectory(), Date.now, user);
			const limits = hostLimits(undefined, usableMemory(user));
			admitted = { host, id: await admit(limits, host, cancel.signal, notice, precedence) };
			observed.admitted = Date.now();
		} catch (error) {
			if (cancel.signal.aborted) return cancelled(cancel.signal);
			throw error;
		}
	}
	const stop = new AbortController();
	// Held as a value until the command ends, so a failure never goes unhandled meanwhile.
	const measuring =
		admitted !== undefined && unit !== undefined
			? measure(admitted.host, { id: admitted.id, unit }, stop.signal, (id) =>
					process.stderr.write(`quest gate: recorded admission ${id} again after another gate dropped it\n`),
				).then(
					() => undefined,
					(error: unknown) => ({ error }),
				)
			: undefined;
	const env: NodeJS.ProcessEnv = { ...process.env, [ADMITTED]: "1" };
	// mbx otherwise takes its configured priority, which agents' hosts may lower.
	if (process.env[PRIORITY] === "1") env.MBX_SCHEDULER_PRIORITY ??= "normal";
	observed.unit = unit;
	let result: number;
	try {
		result = await run(command, env, cancel);
	} finally {
		stop.abort();
		if ("cpu" in run) observed.cpu = run.cpu();
	}
	const failed = await measuring;
	if (cancel.signal.aborted) return cancelled(cancel.signal);
	if (failed) throw failed.error;
	return result;
}
