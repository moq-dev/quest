// Host-wide command admission, sized from the host itself: every platform waits
// for CPU load and free memory before starting the command. The gate then owns
// the command's descendants until they stop, and holds nothing else while it runs.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, constants, cpus, hostname, loadavg, totalmem, userInfo } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type Cancellation, cancelled, follow, forwards, GROUP, interrupts, requested } from "./interrupt";
import { systemdScopes } from "./supervise";

/**
 * One admitted command: a unique id, the wall-clock time it was admitted, and the process ID of
 * the gate that runs it, which holds a slot until that command ends.
 */
export interface Admission {
	id: string;
	at: number;
	pid?: number;
}

/** One version of the host's admission ledger. Versions only grow; 0 is the empty ledger. */
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
}

export interface Limits {
	/** The highest 1-minute load average that still admits a command. */
	load: number;
	/** The least available memory, in bytes, that still admits a command. */
	memory: number;
}

export type Waiting = "load" | "memory";

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
				(entry.pid === undefined || (Number.isSafeInteger(entry.pid) && entry.pid > 0)),
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
		running: (admission) => admission.pid !== undefined && alive(admission.pid),
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
 * one, the load is work the gate cannot wait out, such as a fresh macOS
 * runner's Spotlight index, so the raw load counts as having room.
 *
 * Each caller decides against the newest ledger and publishes its admission
 * atomically, so concurrent callers never exceed the rule and one always wins
 * while it has room. No fairness promise or admission timeout.
 */
export async function admit(limits: Limits, host: Host, signal: AbortSignal, waiting?: (reason: Waiting) => void) {
	const id = randomUUID();
	for (;;) {
		signal.throwIfAborted();
		const ledger = host.ledger();
		// Sampled after the read, so only a backward clock step dates an admission in the future.
		const now = host.now();
		// A running admission stays in the ledger past the minute, so later callers still see its slot.
		const running = new Set(ledger.admissions.filter((admission) => host.running(admission)));
		const kept = ledger.admissions.filter((admission) => admission.at > now - RECENT_MS || running.has(admission));
		const recent = kept.filter((admission) => admission.at > now - RECENT_MS);
		if (kept.some((admission) => admission.at > now)) {
			// Date those now, so they still count and space admissions but expire a minute after
			// the step. A forward step can only expire admissions up to a minute early.
			host.publish(
				ledger,
				kept.map((admission) => ({ ...admission, at: Math.min(admission.at, now) })),
			);
			continue;
		}
		const load = running.size > 0 ? host.load() : Math.min(host.load(), limits.load);
		const memory = host.memory();
		let wait = SETTLE_MS;
		if (load > limits.load) waiting?.("load");
		else if (memory < limits.memory) waiting?.("memory");
		else {
			const headroom =
				load + recent.length < limits.load && memory - recent.length * limits.memory >= limits.memory;
			const last = Math.max(-Infinity, ...recent.map((admission) => admission.at));
			wait = headroom ? 0 : last + SETTLE_MS - now;
			if (wait <= 0) {
				// A caller descheduled since sampling would record a stale time, which lets the
				// next one skip its spacing; decide again once the stall reaches that interval.
				const at = host.now();
				if (at - now < SETTLE_MS && host.publish(ledger, [...kept, { id, at, pid: process.pid }])) return;
				continue;
			}
		}
		await host.sleep(wait, signal);
	}
}

/** Marks an admitted command, so nested gated calls inside it run at once. */
const ADMITTED = "QUEST_GATE_ADMITTED";

/**
 * Runs an admitted command with inherited streams and resolves with its exact exit status.
 * Asking to cancel forwards the requested signal unless the command already has it (see
 * `forwards`), so the command's own handling of it runs; killing stops it outright.
 */
export type Owner = (command: string[], env: NodeJS.ProcessEnv, cancel: Cancellation) => Promise<number>;

/** Run the command as a plain child, for a caller whose own owner already holds its descendants. */
export const direct: Owner = (command, env, cancel) =>
	new Promise((resolve, reject) => {
		const child = spawn(command[0], command.slice(1), { env, stdio: "inherit" });
		const stop = () => {
			if (forwards(cancel.signal)) child.kill(requested(cancel.signal));
		};
		const cleanup = follow(cancel, stop, () => child.kill("SIGKILL"));
		child.once("error", (error) => {
			cleanup();
			reject(error);
		});
		child.once("close", (code, killed) => {
			cleanup();
			resolve(code ?? (killed ? 128 + constants.signals[killed] : 1));
		});
	});

/** Run the command in its own systemd scope, whose cgroup holds every descendant (see supervise.ts). */
export const scope: Owner = (command, env, cancel) =>
	systemdScopes.run(`quest-gate-${randomUUID()}.scope`, process.cwd(), command, { env, cancel });

/**
 * Run the command as the leader of a new session, whose process group holds every descendant that
 * does not move to another group or session. Once the command exits, the rest of its group is
 * killed. The session has no controlling terminal: the command keeps its inherited streams, but a
 * terminal's signals reach it only through Quest, which stands in for the terminal: every SIGINT
 * Quest receives goes to the whole group, as a terminal's Ctrl-C would, and Quest inside the group
 * leaves it there (see `GROUP`).
 */
export const group: Owner = (command, env, cancel) =>
	new Promise((resolve, reject) => {
		const child = spawn(command[0], command.slice(1), {
			env: { ...env, [GROUP]: "1" },
			stdio: "inherit",
			detached: true,
		});
		const signal = (name: NodeJS.Signals) => {
			try {
				process.kill(-child.pid!, name);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		};
		const stop = () => {
			const name = requested(cancel.signal);
			if (name === "SIGINT") signal(name);
			else child.kill(name);
		};
		const terminate = () => signal("SIGKILL");
		child.once("error", reject);
		if (child.pid === undefined) return; // It never started.
		const cleanup = follow(cancel, stop, terminate);
		child.once("exit", (code, killed) => {
			cleanup();
			try {
				// The group outlives its leader while any member remains, so its ID is not reused yet.
				terminate();
			} catch (error) {
				return reject(error);
			}
			resolve(code ?? 128 + constants.signals[killed!]);
		});
	});

/** Whether this process already runs in a Quest scope, which then holds whatever it starts. */
export function scoped(self = "/proc/self/cgroup"): boolean {
	const unified = readFileSync(self, "utf8")
		.split("\n")
		.find((line) => line.startsWith("0::"));
	return unified !== undefined && /\/quest-[a-z]+-[0-9a-f-]+\.scope$/.test(unified);
}

/**
 * The strongest owner this host offers. A nested call runs inside its admitted command, and a call
 * inside a Quest scope inside that scope: moving into an owner of its own would take its command out
 * of reach of the enclosing one. Linux owns descendants through a systemd scope, and settles for a
 * process group, like macOS, without a systemd user manager. Windows owns only the command.
 */
export function owner(env = process.env): Owner {
	if (env[ADMITTED] === "1" || process.platform === "win32") return direct;
	if (process.platform !== "linux") return group;
	if (scoped()) return direct;
	try {
		systemdScopes.check();
		return scope;
	} catch {
		return group;
	}
}

const notices: Record<Waiting, string> = {
	load: "quest gate: waiting for the load average to fall",
	memory: "quest gate: waiting for free memory",
};

/** Run from the CLI. */
export async function gate(command: string[]): Promise<number> {
	const cancel = interrupts();
	try {
		const run = owner();
		// A nested invocation executes inside the already admitted command.
		if (process.env[ADMITTED] !== "1") {
			const shown = new Set<Waiting>();
			try {
				await admit(hostLimits(), fileHost(claimDirectory()), cancel.signal, (reason) => {
					if (shown.has(reason)) return;
					shown.add(reason);
					process.stderr.write(`${notices[reason]}\n`);
				});
			} catch (error) {
				if (cancel.signal.aborted) return cancelled(cancel.signal);
				throw error;
			}
		}
		const result = await run(command, { ...process.env, [ADMITTED]: "1" }, cancel);
		return cancel.signal.aborted ? cancelled(cancel.signal) : result;
	} finally {
		cancel.close();
	}
}
