// Host-wide command admission, sized from the host itself: every platform waits
// for CPU load and free memory before starting the command, unless mbx's
// machine-wide pool admits its CPU instead. The gate then owns the command's
// descendants until they stop, and holds nothing else while it runs.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { availableParallelism, constants, cpus, hostname, loadavg, totalmem, userInfo } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { type Cancellation, cancelled, follow, forwards, GROUP, interrupts, received, requested } from "./interrupt";
import { stubbed } from "./job";
import { questScope, scopeGroup, startTime, systemdScopes } from "./supervise";

/**
 * One admitted command: a unique id, the wall-clock time it was admitted, and the process ID of
 * the gate that runs it, which holds a slot until that command ends, with when that gate started
 * (see `processStart`), so a reused process ID holds nothing. `queued` marks a caller still
 * waiting for its turn instead, as of `at`: it holds a place in the queue, the ledger's order of
 * queued entries, and no slot. `cores` is the most CPUs the command kept busy over any
 * SETTLE_MS of the last RECENT_MS, where its gate measures it (see `measure`).
 */
export interface Admission {
	id: string;
	at: number;
	pid?: number;
	queued?: boolean;
	start?: string;
	cores?: number;
}

/** One version of the host's admission ledger and queue. Versions only grow; 0 is the empty ledger. */
export interface Ledger {
	version: number;
	admissions: Admission[];
}

/** The machine-wide inputs to load admission, replaceable in tests. */
export interface Host {
	/** The 1-minute load average. */
	load(): number;
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
	/**
	 * CPU microseconds the processes in systemd scope `unit` have used, and how many of its CPU
	 * quota's periods throttled them, or undefined while it does not exist.
	 */
	usage(unit: string): { usage: number; throttled: number } | undefined;
}

export interface Limits {
	/** The highest 1-minute load average that still admits a command. */
	load: number;
	/** The least available memory, in bytes, that still admits a command. */
	memory: number;
}

export type Waiting = "load" | "memory" | "queue";

/**
 * Admissions that only fit the host's raw load and memory, not its headroom,
 * start at least this far apart, so each one's load can begin to show.
 */
export const SETTLE_MS = 5000;

/**
 * How long an admission counts against the host's headroom. The 1-minute load
 * average and available memory take about this long to reflect a new command.
 */
export const RECENT_MS = 60_000;

/**
 * The longest a quick command waits for room: the time the load average takes
 * to reflect new work, so it waits out at most one burst's lag.
 */
export const QUICK_MS = RECENT_MS;

/**
 * How a caller is admitted ahead of the rest.
 *
 * - `priority`: wait only for memory, never for load, whether or not another
 *   gated command runs. Its admissions still count against every other caller's
 *   headroom, so it goes first while the host is loaded. For work whose own
 *   runner bounds it, such as a check that lands PRs.
 * - `quick`: wait at most QUICK_MS, then start whatever the load and memory.
 *   For a command too cheap to be worth holding back, such as a formatter or a
 *   linter. Once started, it holds a slot like any admission.
 * - `pooled`: mbx's pool admits the command's CPU (see `reserve`), so it waits
 *   only for memory, as a priority caller does.
 *
 * `since` is when the caller began waiting, which a quick caller's deadline
 * counts from; the call's own start when omitted.
 */
export interface Precedence {
	priority?: boolean;
	quick?: boolean;
	pooled?: boolean;
	since?: number;
}

/** The memory one gated build or test stack is assumed to need. */
export const COMMAND_MEMORY = 4 * 2 ** 30;

/** Usable memory: physical RAM, or a smaller cgroup/container limit. */
function usableMemory(): number {
	if (process.platform === "linux") return linuxMemory().total;
	const constrained = process.constrainedMemory?.() ?? 0;
	return constrained > 0 ? Math.min(totalmem(), constrained) : totalmem();
}

/**
 * Derive the limits from the host: no configuration. The load average counts
 * runnable threads on every CPU, including ones outside this process's
 * affinity, so its limit is one per host CPU. Each admission reserves one
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

/** Count reclaimable host cache and the headroom of every enclosing memory cgroup. */
export function linuxMemory(proc = "/proc", cgroups = "/sys/fs/cgroup"): { total: number; available: number } {
	const meminfo = readFileSync(join(proc, "meminfo"), "utf8");
	const bytes = (key: string) => {
		const value = meminfo.match(new RegExp(`^${key}:\\s+(\\d+) kB$`, "m"))?.[1];
		if (value === undefined) throw new Error(`gate cannot read Linux ${key}`);
		return Number(value) * 1024;
	};
	let total = bytes("MemTotal");
	let available = bytes("MemAvailable");
	for (const line of readFileSync(join(proc, "self/cgroup"), "utf8").trim().split("\n")) {
		const [, controllers, path] = line.match(/^\d+:([^:]*):(.*)$/) ?? [];
		if (controllers === undefined || path === undefined) throw new Error("gate cannot read Linux memory cgroups");
		const unified = controllers === "";
		if (!unified && !controllers?.split(",").includes("memory")) continue;
		const root = resolve(cgroups, unified ? "" : "memory");
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
		if (inside === ".." || inside.startsWith(`..${sep}`)) continue;
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
	}
	return { total, available };
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
 * Every caller of one user on one host shares this directory, whatever its
 * environment or login sessions. It is named for the host, since a home
 * directory may be shared between machines. An account missing from the user
 * database, as in arbitrary-UID containers, has no home of its own, so it
 * shares one in `tmp` keyed by its UID.
 */
export function claimDirectory(
	home = accountHome(),
	host = hostname(),
	uid = process.getuid?.(),
	tmp = "/tmp",
): string {
	if (home !== null) return join(home, ".cache", "quest", "admissions", host);
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
	return join(root, "admissions", host);
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
				(entry.cores === undefined || (Number.isSafeInteger(entry.cores) && entry.cores >= 0)),
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

/**
 * The ledger is a directory of numbered versions, each the JSON list of recent
 * admissions. A caller publishes version N + 1 by linking a complete draft to
 * that name, which only one caller can create. No lock is held, so a caller
 * that dies at any point leaves nothing that blocks the others.
 */
export function fileHost(directory: string, now = Date.now): Host {
	const path = (version: number) => join(directory, String(version));
	// A scope's cgroup never moves, so systemd is asked for it once.
	const groups = new Map<string, string>();
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
		load: () => loadavg()[0],
		// macOS counts reclaimable cache as used, so only its load is gated.
		memory: () =>
			process.platform === "darwin"
				? Infinity
				: process.platform === "linux"
					? linuxMemory().available
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
			const group = groups.get(unit) ?? scopeGroup(unit);
			if (group === undefined) return undefined;
			groups.set(unit, group);
			let stat: string;
			try {
				stat = readFileSync(join(group, "cpu.stat"), "utf8");
			} catch (error) {
				// The scope ended, and systemd removed its cgroup.
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			}
			const usage = stat.match(/^usage_usec (\d+)$/m)?.[1];
			if (usage === undefined) throw new Error(`gate cannot read the CPU use of ${unit}`);
			// Present only where the cpu controller is enabled, which a scope without a quota may lack.
			const throttled = stat.match(/^nr_throttled (\d+)$/m)?.[1];
			return { usage: Number(usage), throttled: Number(throttled ?? 0) };
		},
	};
}

/**
 * Wait until the host has room for a command, then record its admission. The
 * load average and available memory lag new work, so each admission from the
 * last minute counts as one more unit of load and as one command's memory
 * taken from available memory:
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
 * A running command's load can lull, as between a build's phases, while it will
 * soon take the whole host again. So where gates measure their commands (see
 * `measure`), the load counts as at least the CPUs those commands kept busy at
 * their busiest in the last minute, and nothing is admitted while they kept
 * every CPU busy.
 *
 * Callers are admitted first come, first served: each records its place in the
 * queue when it starts waiting, and counts every caller queued ahead of it as
 * one more recent admission, so it starts before them only while the host has
 * room for them all. Only the head of the queue waits out the spacing. A place
 * lasts until its caller is admitted, cancelled, or its gate ends; one whose
 * gate's start time is unknown, as on Windows, could pass for a reused process
 * ID, so its caller refreshes it, and it frees a minute after the last refresh.
 * A priority caller goes ahead of the queue, and a quick one starts at its
 * deadline whatever its place (see `Precedence`).
 *
 * Each caller decides against the newest ledger and publishes atomically, so
 * concurrent callers never exceed the rule and one always wins while it has
 * room. No admission timeout except a quick caller's. Resolves with the
 * admission's id.
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
	const deadline = precedence.quick ? (precedence.since ?? host.now()) + QUICK_MS : Infinity;

	/** One decision against the newest ledger: true once admitted. */
	const turn = async (): Promise<boolean> => {
		const ledger = host.ledger();
		// Sampled after the read, so only a backward clock step dates an admission in the future.
		const now = host.now();
		const live = new Set(ledger.admissions.filter((admission) => host.running(admission)));
		// Waits for memory alone: the queue and the load are for callers the load decides.
		const memoryOnly = precedence.priority || precedence.pooled;
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
		if (!memoryOnly && (mine === undefined || (mine.start === undefined && mine.at <= now - RECENT_MS / 2))) {
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
		// Recorded like any admission, so it still counts against the others' headroom.
		if (now >= deadline) return admitted(now);
		// Priority ignores load, whether or not a gated command runs; memory still applies.
		const used = memoryOnly ? 0 : [...running].reduce((sum, admission) => sum + (admission.cores ?? 0), 0);
		const load = memoryOnly
			? 0
			: running.size > 0
				? Math.max(host.load(), used)
				: Math.min(host.load(), limits.load);
		const memory = host.memory();
		let wait = SETTLE_MS;
		if (load > limits.load || used >= limits.load) waiting?.("load");
		else if (memory < limits.memory) waiting?.("memory");
		else {
			// Every caller queued ahead takes a slot before this one, so it starts first only while
			// the host has room for them all.
			const taken = recent.length + ahead;
			const headroom = load + taken < limits.load && memory - taken * limits.memory >= limits.memory;
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
		await host.sleep(Math.min(wait, deadline - now), signal);
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
 * What `measure` saw of a whole run: the most CPUs it kept busy over one sample, undefined before
 * any sample, and whether its scope's CPU quota throttled it.
 */
export interface Measured {
	peak?: number;
	throttled: boolean;
}

/**
 * Until `signal` aborts, sample the CPU use of the admitted command in systemd scope `unit` every
 * SETTLE_MS, and keep its admission's `cores` at the most CPUs it kept busy over one sample in the
 * last RECENT_MS, rounded, so other callers count it at its busiest rather than at a lull. Resolves
 * with what it saw of the whole run. `usage` is the CPU microseconds the scope used before its
 * command started, such as while it waited for mbx; none when omitted.
 */
export async function measure(
	host: Host,
	admission: { id: string; unit: string; usage?: number },
	signal: AbortSignal,
): Promise<Measured> {
	const samples: { at: number; cores: number }[] = [];
	const run: Measured = { throttled: false };
	// A new scope starts with no CPU use, so a burst before the first sample still counts.
	let previous = { at: host.now(), usage: admission.usage ?? 0 };
	let recorded = 0;
	for (;;) {
		try {
			await host.sleep(SETTLE_MS, signal);
		} catch (error) {
			if (signal.aborted) return run;
			throw error;
		}
		const used = host.usage(admission.unit);
		const at = host.now();
		if (used !== undefined) {
			// A clock stepped backward yields no rate for its interval.
			if (at > previous.at) {
				const cores = (used.usage - previous.usage) / ((at - previous.at) * 1000);
				samples.push({ at, cores });
				run.peak = Math.max(run.peak ?? 0, cores);
			}
			run.throttled ||= used.throttled > 0;
			previous = { at, usage: used.usage };
		}
		while (samples.length > 0 && samples[0].at <= at - RECENT_MS) samples.shift();
		const cores = Math.round(Math.max(0, ...samples.map((sample) => sample.cores)));
		for (let ledger = host.ledger(); cores !== recorded; ledger = host.ledger()) {
			const mine = ledger.admissions.find(({ id }) => id === admission.id);
			if (mine === undefined) throw new Error(`gate lost its admission ${admission.id} from the ledger`);
			const updated = ledger.admissions.map((entry) => (entry === mine ? { ...mine, cores } : entry));
			if (host.publish(ledger, updated)) recorded = cores;
		}
	}
}

/** mbx's machine-wide scheduler pool (see `mbxPool`). */
export interface Pool {
	/** The most cores it admits at once. */
	cpus: number;
	/** Its `scheduler.cpus`, before `scheduler.reserve_cpus`. */
	total: number;
}

/** The oldest mbx whose `mbx reserve` switches mbx's scheduling off for its command, so its compiles take no permits. */
const MBX_MINIMUM = [1, 30, 0];

/**
 * mbx's pool, where mbx would schedule a command started in `cwd`: `scheduler.cpus` minus
 * `scheduler.reserve_cpus`, at least one, as `mbx reserve` reads them from the environment and the
 * global configuration. Undefined when mbx is missing or older than 1.30.0, its scheduler is off,
 * globally or by the workspace's `.mbx.toml`, or this process already runs inside a reservation or
 * a session that switched scheduling off: a second reservation there could wait on the first.
 */
export function mbxPool(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): Pool | undefined {
	if (env.MBX_SCHED_DISABLE !== undefined || env.MBX_SCHED_DIR === "") return undefined;
	const mbx = (...args: string[]) => {
		const run = spawnSync("mbx", args, { cwd, env, encoding: "utf8" });
		if (run.error) throw run.error;
		if (run.status !== 0) throw new Error(`gate cannot run mbx ${args.join(" ")}: ${run.stderr.trim()}`);
		return run.stdout.trim();
	};
	let version: string;
	try {
		version = mbx("--version");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const parts = /^mbx (\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number);
	if (parts === undefined) throw new Error(`gate cannot read mbx's version: ${version}`);
	const older = parts.findIndex((part, index) => part !== MBX_MINIMUM[index]);
	if (older !== -1 && parts[older] < MBX_MINIMUM[older]) return undefined;
	const enabled = mbx("settings", "get", "scheduler.enabled");
	if (enabled !== "true" && enabled !== "false")
		throw new Error(`gate cannot read mbx's scheduler.enabled: ${enabled}`);
	// `mbx reserve` needs the global scheduler; a workspace can only switch its own builds off.
	if (enabled === "false") return undefined;
	if (env.MBX_SCHEDULER === undefined && workspaceScheduler(cwd) === false) return undefined;
	const count = (key: string, fallback?: number) => {
		const text = mbx("settings", "get", key);
		const value = text === "" ? fallback : Number(text);
		if (value === undefined || !Number.isSafeInteger(value) || value < 0)
			throw new Error(`gate cannot read mbx's ${key}: ${text}`);
		return value;
	};
	// Unset, mbx counts the logical CPUs, as `hostLimits` does.
	const total = count("scheduler.cpus", Math.max(availableParallelism(), cpus().length));
	return { cpus: Math.max(1, total - count("scheduler.reserve_cpus", 0)), total };
}

/**
 * The `scheduler.enabled` of the `.mbx.toml` that mbx applies to a Cargo build started in `cwd`,
 * at the workspace root as mbx finds it: the outermost directory holding a Cargo.lock, else a
 * Cargo.toml, else `cwd` itself. Undefined when it sets none. `mbx settings get` leaves workspace
 * settings out, so the gate reads the file itself.
 */
export function workspaceScheduler(cwd: string): boolean | undefined {
	let lockfile: string | undefined;
	let manifest: string | undefined;
	for (let directory = resolve(cwd); ; directory = dirname(directory)) {
		if (existsSync(join(directory, "Cargo.lock"))) lockfile = directory;
		if (existsSync(join(directory, "Cargo.toml"))) manifest = directory;
		if (directory === dirname(directory)) break;
	}
	const file = join(lockfile ?? manifest ?? resolve(cwd), ".mbx.toml");
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	// Quest runs on Bun, whose TOML parser Node's types do not describe.
	const toml = (globalThis as unknown as { Bun: { TOML: { parse(text: string): unknown } } }).Bun.TOML;
	let enabled: unknown;
	try {
		enabled = (toml.parse(text) as { scheduler?: { enabled?: unknown } }).scheduler?.enabled;
	} catch (error) {
		throw new Error(`gate cannot parse ${file}: ${error instanceof Error ? error.message : error}`);
	}
	if (enabled !== undefined && typeof enabled !== "boolean")
		throw new Error(`gate cannot read ${file}: scheduler.enabled must be a boolean`);
	return enabled;
}

/** Whether the systemd user manager can cap a scope's CPU, which needs the cpu controller delegated to it. */
export function cappable(): boolean {
	// The manager's own process lives in init.scope, directly in the manager's cgroup.
	const own = execFileSync("systemctl", ["--user", "show", "--property=ControlGroup", "--value", "init.scope"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
	if (!own.endsWith("/init.scope")) throw new Error(`unexpected cgroup for the systemd user manager: ${own}`);
	return readFileSync(join("/sys/fs/cgroup", dirname(own), "cgroup.controllers"), "utf8")
		.trim()
		.split(" ")
		.includes("cpu");
}

/**
 * What a command identifies by across a repository's worktrees, hashed: its repository's common
 * Git directory, the working directory's path inside its checkout, and its argv. Outside a
 * repository, the working directory stands for the first two.
 */
export function commandKey(command: string[], cwd = process.cwd()): string {
	const git = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-prefix"], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const place = git.status === 0 ? git.stdout.split("\n").slice(0, 2) : [resolve(cwd)];
	return createHash("sha256")
		.update(JSON.stringify([...place, command]))
		.digest("hex");
}

/**
 * Each command's share of mbx's pool, learned from its runs, as one file per `commandKey` in
 * `directory`: beside the admission ledger, never in it, since the ledger prunes what it does not
 * own.
 */
export function shares(directory: string) {
	const file = (key: string) => join(directory, key);
	return {
		/** The cores the command's next run reserves, or undefined before its first measured run or SHARE_MS after its last. */
		read(key: string, now = Date.now()): number | undefined {
			try {
				if (statSync(file(key)).mtimeMs < now - SHARE_MS) return undefined;
				const value: unknown = JSON.parse(readFileSync(file(key), "utf8"));
				const cores =
					typeof value === "object" && value !== null ? (value as { cores?: unknown }).cores : undefined;
				return Number.isSafeInteger(cores) && (cores as number) > 0 ? (cores as number) : undefined;
			} catch (error) {
				// A file cut short, as by power loss, holds nothing learned.
				if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT")
					return undefined;
				throw error;
			}
		},
		/** Record the share, and forget commands not run for SHARE_MS and drafts of writers that died. */
		write(key: string, cores: number, now = Date.now()) {
			mkdirSync(directory, { recursive: true });
			const draft = join(directory, `${randomUUID()}.tmp`);
			writeFileSync(draft, JSON.stringify({ cores }));
			renameSync(draft, file(key));
			for (const name of readdirSync(directory)) {
				try {
					if (statSync(join(directory, name)).mtimeMs < now - SHARE_MS) remove(join(directory, name));
				} catch (error) {
					// Another writer pruned it first.
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
		},
	};
}

/** How long a command's learned share outlasts its last measured run. */
export const SHARE_MS = 30 * 24 * 60 * 60 * 1000;

/** The directory that holds the learned shares for the admission ledger in `claims` (see `claimDirectory`). */
export function sharesDirectory(claims: string): string {
	return join(dirname(dirname(claims)), "shares", basename(claims));
}

/** A command's share before its first measured run: half of mbx's pool, which fits beside the quarter mbx keeps for normal-priority work. */
export function firstShare(pool: Pick<Pool, "cpus">): number {
	return Math.max(1, Math.ceil(pool.cpus / 2));
}

/**
 * The share a command's next run reserves after one that reserved `cores` (see `reserve`), at
 * least one core and at most the pool. A throttled run used every core its cap allowed, so its
 * peak says nothing about what it wanted: the share doubles. Otherwise it moves halfway down to the
 * run's peak, since a 5-second sample understates a burst that a cap at the peak would throttle.
 */
export function learn(cores: number, run: Measured, pool: Pick<Pool, "cpus">): number {
	const next = run.throttled ? cores * 2 : Math.ceil((cores + (run.peak ?? cores)) / 2);
	return Math.min(pool.cpus, Math.max(1, next));
}

/**
 * The shell between `mbx reserve` and the command: it reports the grant on descriptor 5, then waits
 * for the gate's go on descriptor 6, so the command starts only once the gate says so and never
 * after the gate abandoned the reservation.
 */
const GRANT = 'printf "granted\\n" >&5; read -r go <&6 || exit 125; exec 5>&- 6<&-; exec "$@"';

/** A command to run under `mbx reserve` (see `reserve`). */
export interface Reserved {
	/** A new name for its background scope. */
	unit: string;
	/** The Quest scope its scope binds to (see `background`), or null outside one. */
	enclosing: string | null;
	/** The cores it holds of mbx's pool, and the CPUs its scope may keep busy. */
	cores: number;
	/** The pool it reserves from. */
	pool: Pool;
	command: string[];
	env: NodeJS.ProcessEnv;
	cancel: Cancellation;
}

/** A command waiting for, or running under, its reservation (see `reserve`). */
export interface Reservation {
	/** Resolves once mbx grants the reservation; the command then waits for `start`. */
	granted: Promise<void>;
	/** Start the command once granted. */
	start(): void;
	/**
	 * Stop a reservation whose command has not started, and resolve true once its scope is empty,
	 * so the command never runs; false once the command started.
	 */
	abandon(): Promise<boolean>;
	/**
	 * The command's exit status, or the cancelled status once cancelled. Rejects when mbx exits
	 * without granting.
	 */
	done: Promise<number>;
}

/**
 * Run the command in a background scope (see `background`) under a low-priority `mbx reserve` of
 * `cores`, and cap the scope at that many CPUs, which bounds every tool inside it whether or not
 * mbx schedules it. mbx switches its scheduling off inside the reservation, so the command's
 * compiles take no permits of their own and cannot wait on the reservation that covers them.
 */
export function reserve(run: Reserved): Reservation {
	const abandoning = new AbortController();
	// An abort without a signal's name always passes (see `forwards`): it stops mbx however Quest was signalled.
	const cancel = { signal: AbortSignal.any([run.cancel.signal, abandoning.signal]), kill: run.cancel.kill };
	let state: "waiting" | "granted" | "started" | "abandoned" = "waiting";
	let failure: Error | undefined;
	let go: (() => void) | undefined;
	let grant!: () => void;
	const granted = new Promise<void>((resolve) => {
		grant = resolve;
	});
	const reservation = ["mbx", "reserve", "--cpus", String(run.cores), "--priority", "low", "--"];
	const done = systemdScopes
		.run(run.unit, process.cwd(), [...reservation, "/bin/sh", "-c", GRANT, "quest-gate", ...run.command], {
			// mbx in the capped scope would otherwise count only the cap's CPUs as its pool. Inside the
			// reservation its scheduling is off, and nothing else reads the setting.
			env: { ...run.env, MBX_SCHEDULER_CPUS: String(run.pool.total) },
			cancel,
			within: run.enclosing,
			slice: "background.slice",
			cpus: run.cores,
			channel(report, reply) {
				// The shell, killed with its scope, may never read the go.
				reply.on("error", () => {});
				go = () => reply.end("go\n");
				let text = "";
				report.setEncoding("utf8");
				report.on("data", (data: string) => {
					text += data;
					if (state !== "waiting" || !text.endsWith("\n")) return;
					if (text !== "granted\n") {
						failure = new Error(`gate cannot read the grant of mbx reserve: ${JSON.stringify(text)}`);
						state = "abandoned";
						abandoning.abort(failure);
						return;
					}
					state = "granted";
					grant();
				});
			},
		})
		.then((status) => {
			if (failure) throw failure;
			if (state === "waiting" && !run.cancel.signal.aborted)
				throw new Error(`mbx reserve exited with ${status} before it granted ${run.cores} cores`);
			return status;
		});
	return {
		granted,
		done,
		start() {
			if (state !== "granted") throw new Error(`gate cannot start a reservation that is ${state}`);
			state = "started";
			go!();
		},
		async abandon() {
			if (state === "started") return false;
			state = "abandoned";
			abandoning.abort(new Error("the gate abandoned its reservation"));
			await done.catch(() => undefined);
			return true;
		},
	};
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
const background =
	(unit: string, enclosing: string | null): Owner =>
	(command, env, cancel) =>
		systemdScopes.run(unit, process.cwd(), command, {
			env,
			cancel,
			within: enclosing,
			slice: "background.slice",
		});

/** Run the command in background scope `unit`, a new name, outside any Quest scope (see `background`). */
export const scope = (unit: string): Owner => background(unit, null);

/** Run the command in background scope `unit`, a new name, bound to the Quest scope `enclosing` (see `background`). */
export const bound = (unit: string, enclosing: string): Owner => background(unit, enclosing);

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
 * scope also lets the gate measure its command's CPU use (see `measure`), so `unit` names it, and
 * `enclosing` the Quest scope it binds to, or null outside one.
 */
export function owner(
	env = process.env,
	cgroup = "/proc/self/cgroup",
): { run: Owner; unit?: string; enclosing?: string | null } {
	// A Quest scope around this process holds the command too, since it shares the cgroup or an ancestor.
	const enclosing = process.platform === "linux" ? questScope(cgroup) : undefined;
	if (env[ADMITTED] === "1") return { run: env[GROUP] === "1" || enclosing ? inside : direct };
	if (process.platform === "win32") return { run: job };
	const unit = `quest-gate-${randomUUID()}.scope`;
	if (enclosing) return { run: bound(unit, enclosing.unit), unit, enclosing: enclosing.unit };
	if (process.platform !== "linux") return { run: group };
	try {
		systemdScopes.check();
		return { run: scope(unit), unit, enclosing: null };
	} catch {
		return { run: group };
	}
}

const notices: Record<Waiting, string> = {
	load: "quest gate: waiting for the load average to fall",
	memory: "quest gate: waiting for free memory",
	queue: "quest gate: waiting for commands queued earlier to start",
};

/**
 * Wait until mbx grants `reservation`, it ends ungranted, or `deadline` passes, saying so on `slow`
 * once the wait reaches SETTLE_MS.
 */
async function granting(
	reservation: ReturnType<typeof reserve>,
	deadline: number,
	slow: () => void,
): Promise<"granted" | "ended" | "late"> {
	const done = new AbortController();
	const timer = (ms: number) => sleep(Math.max(0, ms), undefined, { signal: done.signal });
	const quiet = new Promise<never>(() => {});
	try {
		timer(SETTLE_MS).then(slow, () => {});
		return await Promise.race([
			reservation.granted.then(() => "granted" as const),
			reservation.done.then(
				() => "ended" as const,
				() => "ended" as const,
			),
			deadline === Infinity ? quiet : timer(deadline - Date.now()).then(() => "late" as const),
		]);
	} finally {
		done.abort();
	}
}

/**
 * Run from the CLI. A failure to measure the command is fatal even when the command succeeded,
 * since every other gate on the host relies on that accounting; a cancelled command still
 * reports its cancellation.
 *
 * Where a systemd scope that can cap CPU owns the command and mbx would schedule it (see
 * `mbxPool`), mbx's pool admits it instead of the load: the gate waits for mbx to grant a
 * reservation of the command's learned share (see `reserve` and `learn`), then for memory, and
 * only then starts it. A priority command skips the reservation, and mbx schedules its compiles at
 * normal priority instead.
 */
export async function gate(command: string[], options: { quick?: boolean } = {}): Promise<number> {
	const cancel = interrupts();
	try {
		const { run, unit, enclosing } = owner();
		const priority = process.env[PRIORITY] === "1";
		const env: NodeJS.ProcessEnv = { ...process.env, [ADMITTED]: "1" };
		// mbx otherwise takes its configured priority, which agents' hosts lower.
		if (priority) env.MBX_SCHEDULER_PRIORITY ??= "normal";
		// A nested invocation executes inside the already admitted command.
		if (process.env[ADMITTED] === "1") {
			const result = await run(command, env, cancel);
			return cancel.signal.aborted ? cancelled(cancel.signal) : result;
		}
		const scoped = unit !== undefined && enclosing !== undefined ? { unit, enclosing } : undefined;
		const pool = scoped && !priority ? mbxPool() : undefined;
		const pooled = pool !== undefined && cappable() ? pool : undefined;
		const since = Date.now();
		const claims = claimDirectory();
		const host = fileHost(claims);
		const shown = new Set<Waiting>();
		const notice = (reason: Waiting) => {
			if (shown.has(reason)) return;
			shown.add(reason);
			process.stderr.write(`${notices[reason]}\n`);
		};
		const admission = async () => {
			try {
				const precedence = { priority, quick: options.quick, pooled: pooled !== undefined, since };
				return await admit(hostLimits(), host, cancel.signal, notice, precedence);
			} catch (error) {
				if (cancel.signal.aborted) return undefined;
				throw error;
			}
		};
		const stop = new AbortController();
		// Held as a value until the command ends, so a failure never goes unhandled meanwhile.
		const measuring = (admitted: { id: string; unit: string; usage?: number }) =>
			measure(host, admitted, stop.signal).then(
				(measured) => ({ measured }),
				(error: unknown) => ({ error }),
			);
		let measured: ReturnType<typeof measuring> | undefined;
		let result: number;
		try {
			if (pooled !== undefined && scoped !== undefined) {
				const learned = shares(sharesDirectory(claims));
				const key = commandKey(command);
				const cores = Math.min(pooled.cpus, learned.read(key) ?? firstShare(pooled));
				const reservation = reserve({ ...scoped, cores, pool: pooled, command, env, cancel });
				const deadline = options.quick ? since + QUICK_MS : Infinity;
				const waited = await granting(reservation, deadline, () =>
					process.stderr.write(`quest gate: waiting for ${cores} of mbx's ${pooled.cpus} cores\n`),
				);
				// mbx failed, or the gate was cancelled while it waited.
				if (waited === "ended")
					return cancel.signal.aborted ? cancelled(cancel.signal) : await reservation.done;
				if (waited === "late") await reservation.abandon();
				let id: string | undefined;
				try {
					id = await admission();
				} finally {
					// Stops a granted command that will never start; nothing once it started.
					if (id === undefined) await reservation.abandon();
				}
				if (id === undefined) return cancelled(cancel.signal);
				if (waited === "late") {
					// A quick command starts anyway, outside the reservation, where mbx still schedules its compiles.
					const fallback = `quest-gate-${randomUUID()}.scope`;
					measured = measuring({ id, unit: fallback });
					result = await background(fallback, scoped.enclosing)(command, env, cancel);
				} else {
					measured = measuring({ id, unit: scoped.unit, usage: host.usage(scoped.unit)?.usage });
					reservation.start();
					result = await reservation.done;
					stop.abort();
					const seen = await measured;
					if (!cancel.signal.aborted && "measured" in seen && seen.measured.peak !== undefined)
						learned.write(key, learn(cores, seen.measured, pooled));
				}
			} else {
				const id = await admission();
				if (id === undefined) return cancelled(cancel.signal);
				measured = unit !== undefined ? measuring({ id, unit }) : undefined;
				result = await run(command, env, cancel);
			}
		} finally {
			stop.abort();
		}
		const failed = await measured;
		if (cancel.signal.aborted) return cancelled(cancel.signal);
		if (failed && "error" in failed) throw failed.error;
		return result;
	} finally {
		cancel.close();
	}
}
