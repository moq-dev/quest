// Linux process ownership for supervised checkout commands and gated ones. Each run gets its own
// systemd user scope, named once and never reused, so its cgroup holds every descendant that does
// not ask another service manager to start it. Other hosts fail explicitly; only the gate settles
// for a process group there (see `group` in gate.ts).
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, constants as fs, openSync, readdirSync, readFileSync, watch, writeSync } from "node:fs";
import { constants, hostname } from "node:os";
// Cgroup paths are POSIX paths, also in the tests that parse them on Windows.
import { join } from "node:path/posix";
import type { Readable, Writable } from "node:stream";
import { type Cancellation, cancelled, follow, forwards, interrupts, received, requested } from "./interrupt";

/** A process, identified so that a reused PID never looks like its predecessor. */
export interface Owner {
	host: string;
	pid: number;
	/** Linux start time in clock ticks since boot. */
	start?: string;
}

/**
 * Field 22 of /proc/<pid>/stat; the command name in parentheses may hold spaces. Throws once the
 * process is gone: ENOENT, or ESRCH when it exits mid-read.
 */
export function startTime(pid: number): string | undefined {
	if (process.platform !== "linux") return undefined;
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

export function currentOwner(): Owner {
	return { host: hostname(), pid: process.pid, start: startTime(process.pid) };
}

/** False only when the owner provably exited; another host's process is assumed to live. */
export function alive(owner: Owner): boolean {
	if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return true;
	if (owner.start !== undefined && process.platform === "linux") {
		try {
			return startTime(owner.pid) === owner.start;
		} catch (error) {
			if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
			throw error;
		}
	}
	try {
		process.kill(owner.pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** How a scope runs its command. */
export interface RunOptions {
	/** The command's environment; Quest's own when omitted. */
	env?: NodeJS.ProcessEnv;
	/**
	 * Asking stops a command that has not started, and otherwise delivers the requested signal to
	 * every process in the scope unless it already reached them (see `forwards`), so each one's own
	 * handling of it runs; killing stops the whole scope. Without it, the run follows Quest's own
	 * signals (see `interrupts`).
	 */
	cancel?: Cancellation;
	/** Pipes the command's streams to a protocol consumer instead of inheriting them. */
	spawned?(child: ChildProcessWithoutNullStreams): void;
	/**
	 * The Quest scope the supervisor runs in, which the run's own scope moves the command out of:
	 * the one around this process when omitted, and none when null. The run binds its scope to it,
	 * so the enclosing owner's kill stops this scope too, and leaves a repeated signal's kill to that
	 * owner, since it may be a copy of the one that owner delivered, as Just forwards SIGTERM.
	 */
	within?: string | null;
	/** The slice the scope runs in; the user manager's default, `app.slice`, when omitted. */
	slice?: string;
}

export interface Scopes {
	/** Throws on a platform this backend cannot own processes on. */
	check(): void;
	/** Whether any process may still run in the scope. */
	live(unit: string): boolean;
	/** Kill every process left in the scope and resolve once it is empty, including when it is already gone. */
	stop(unit: string): Promise<void>;
	/**
	 * Run a command in a new scope, then stop its remaining descendants: at once, or, when a
	 * cancellation signalled the whole scope, once the scope empties or the run is killed, so each
	 * process can finish its own cleanup. Resolves with the command's exit status, or the cancelled
	 * status once asked to stop, only once the scope is empty. Rejects with `Retained` when that
	 * cannot be confirmed, and otherwise only when the command never started.
	 */
	run(unit: string, cwd: string, command: string[], options?: RunOptions): Promise<number>;
}

/** The command may have started and its scope may still hold processes, so its run stays recorded. */
export class Retained extends Error {}

export const UNSUPPORTED =
	"quest worktree run needs Linux 5.14 or later with a systemd user manager (systemd 254 or later) and unified cgroup v2";

/**
 * The shell proves it runs in the scope's own v2 cgroup, then waits for the supervisor before it
 * executes the command. A supervisor that died never acknowledges, so the command never starts.
 */
const handshake =
	"IFS=: read -r hierarchy controllers path </proc/self/cgroup || exit 125; " +
	'[ "$hierarchy:$controllers" = 0: ] || exit 125; ' +
	'printf "%s\\n" "$path" >&3; ' +
	"read -r admitted <&4 || exit 125; " +
	'exec 3>&- 4<&-; exec "$@"';

function populated(group: string): boolean {
	try {
		return /^populated 1$/m.test(readFileSync(join(group, "cgroup.events"), "utf8"));
	} catch (error) {
		// ENODEV: the cgroup was removed between open and read.
		if (["ENOENT", "ENODEV"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
		throw error;
	}
}

/**
 * Resolves once the cgroup has no process left, including when it is already gone, or once `until`
 * aborts.
 */
function vacated(group: string, until?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		let watcher: ReturnType<typeof watch> | undefined;
		let finished = false;
		const finish = (error?: unknown) => {
			if (finished) return;
			finished = true;
			watcher?.close();
			until?.removeEventListener("abort", abandon);
			if (error) reject(error);
			else resolve();
		};
		const abandon = () => finish();
		if (until?.aborted) return finish();
		until?.addEventListener("abort", abandon, { once: true });
		const check = () => {
			try {
				if (!populated(group)) finish();
			} catch (error) {
				finish(error);
			}
		};
		try {
			// The kernel notifies cgroup.events when the last process leaves, not when the cgroup is removed.
			watcher = watch(join(group, "cgroup.events"), check);
			watcher.on("error", finish);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return finish(error);
		}
		// Registration precedes the read, covering an exit during setup.
		check();
	});
}

/**
 * Whether this process's unified cgroup offers `cgroup.kill` (Linux 5.14), which stops every
 * descendant in a scope at once. Without it a run's scope could never be emptied.
 */
export function killable(cgroups = "/sys/fs/cgroup", self = "/proc/self/cgroup"): boolean {
	const unified = readFileSync(self, "utf8")
		.split("\n")
		.find((line) => line.startsWith("0::"));
	return unified !== undefined && existsSync(join(cgroups, unified.slice(3), "cgroup.kill"));
}

/** SIGKILL every process in the cgroup; one already removed has none. */
export function kill(group: string): void {
	try {
		// Never create the file: a missing one means the cgroup is gone or cannot be killed.
		const fd = openSync(join(group, "cgroup.kill"), fs.O_WRONLY);
		try {
			writeSync(fd, "1");
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "";
		if (!["ENOENT", "ENODEV"].includes(code) || existsSync(group)) throw error;
	}
}

/**
 * Send `signal` to every process in the cgroup tree, as systemd's default `KillMode=control-group`
 * stops a unit; cgroup v2 offers only SIGKILL (`cgroup.kill`) itself. It signals from this process,
 * which handles the signal, rather than through a helper such as `systemctl kill`: inside a Quest
 * scope, a helper starts in the enclosing cgroup while that scope's owner may still be signalling
 * it, and would die of the very signal it forwards. Like systemd, it repeats until a pass finds no
 * process it has not signalled, so one forked meanwhile gets it too.
 */
function signalGroup(group: string, signal: NodeJS.Signals): void {
	const signalled = new Set<number>();
	for (let fresh = true; fresh;) {
		fresh = false;
		for (const pid of members(group)) {
			if (signalled.has(pid)) continue;
			signalled.add(pid);
			fresh = true;
			try {
				process.kill(pid, signal);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		}
	}
}

/** The processes in the cgroup and every cgroup below it; none once it is removed. */
export function members(group: string): number[] {
	try {
		const own = readFileSync(join(group, "cgroup.procs"), "utf8").split("\n").filter(Boolean).map(Number);
		const children = readdirSync(group, { withFileTypes: true }).filter((entry) => entry.isDirectory());
		return [...own, ...children.flatMap((child) => members(join(group, child.name)))];
	} catch (error) {
		if (["ENOENT", "ENODEV"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
		throw error;
	}
}

/** The scope's cgroup directory, or undefined once systemd no longer knows the unit. */
export function scopeGroup(unit: string): string | undefined {
	const group = execFileSync("systemctl", ["--user", "show", "--property=ControlGroup", "--value", unit], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
	if (!group) return undefined;
	if (!group.endsWith(`/${unit}`)) throw new Error(`unexpected cgroup for ${unit}: ${group}`);
	return join("/sys/fs/cgroup", group);
}

/**
 * The gate scopes bound to `unit` (see `RunOptions.within`). systemd stops them once `unit` stops,
 * but only after its cgroup empties, so whoever confirms `unit` stopped must wait for them too.
 */
function boundTo(unit: string): string[] {
	const show = execFileSync("systemctl", ["--user", "show", "--property=Id,BindsTo", "quest-gate-*.scope"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return show
		.split("\n\n")
		.filter((entry) => /^BindsTo=(.*)$/m.exec(entry)?.[1].split(" ").includes(unit))
		.map((entry) => /^Id=(.*)$/m.exec(entry)![1]);
}

/** Kill every gate scope bound to `unit` and resolve once each is empty. */
async function stopBound(unit: string): Promise<void> {
	for (const bound of boundTo(unit)) await systemdScopes.stop(bound);
}

export const systemdScopes: Scopes = {
	check() {
		if (process.platform !== "linux" || !killable()) throw new Error(UNSUPPORTED);
		try {
			const version = execFileSync("systemd-run", ["--version"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			const manager = execFileSync("systemctl", ["--user", "show", "--property=Version", "--value"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			if (!(Number(/^systemd (\d+)/.exec(version)?.[1]) >= 254) || !(Number.parseInt(manager, 10) >= 254))
				throw new Error(UNSUPPORTED);
		} catch {
			throw new Error(UNSUPPORTED);
		}
	},

	live(unit) {
		const group = scopeGroup(unit);
		return (group !== undefined && populated(group)) || boundTo(unit).some((bound) => systemdScopes.live(bound));
	},

	async stop(unit) {
		const group = scopeGroup(unit);
		if (group !== undefined) {
			kill(group);
			await vacated(group);
		}
		await stopBound(unit);
	},

	run(unit, cwd, command, options = {}) {
		// Once the enclosing owner kills everything it holds, systemd kills this scope too.
		const enclosing = options.within === undefined ? questScope()?.unit : options.within;
		const bound = enclosing ? [`--property=BindsTo=${enclosing}`, "--property=KillSignal=SIGKILL"] : [];
		return contain(
			[
				"systemd-run",
				"--user",
				"--scope",
				"--quiet",
				"--collect",
				`--unit=${unit}`,
				...bound,
				...(options.slice ? [`--slice=${options.slice}`] : []),
				"--expand-environment=no",
				"--",
				"/bin/sh",
				"-c",
				handshake,
				"quest-worktree",
			],
			(path) => path.endsWith(`/${unit}`),
			{
				name: unit,
				unsupported: UNSUPPORTED,
				launcher: "systemd-run",
				emptied: () => stopBound(unit),
				bound: Boolean(enclosing),
			},
			cwd,
			command,
			options,
		);
	},
};

/** How `contain` names, signals, and shares its run's cgroup. */
interface Containment {
	/** The run's scope or cgroup. */
	name: string;
	/** Why the command cannot run, prefixed to every failure before it starts. */
	unsupported: string;
	/** The program that starts the handshake shell. */
	launcher: string;
	/** Stop what the cgroup's end leaves to systemd, once the cgroup is empty. */
	emptied(): Promise<void>;
	/**
	 * Whether an enclosing Quest owner kills this cgroup at its own second signal, so a repeated
	 * signal this process receives, which may be a copy of that owner's, leaves the kill to it.
	 */
	bound: boolean;
}

/**
 * Start the handshake shell through `launch`, admit the command once the shell reports a cgroup
 * that `owns` accepts, and once the command exits, kill whatever is left in that cgroup and wait
 * until it is empty (see `Scopes.run`).
 */
function contain(
	launch: string[],
	owns: (path: string) => boolean,
	describe: Containment,
	cwd: string,
	command: string[],
	options: RunOptions,
): Promise<number> {
	return new Promise((resolve, reject) => {
		const own = options.cancel ? undefined : interrupts();
		const cancel = options.cancel ?? own!;
		const pipe = options.spawned ? "pipe" : "inherit";
		const child = spawn(launch[0], [...launch.slice(1), ...command], {
			cwd,
			env: options.env,
			stdio: [pipe, pipe, pipe, "pipe", "pipe"],
		});
		options.spawned?.(child as ChildProcessWithoutNullStreams);
		const report = child.stdio[3] as Readable;
		const admission = (child.stdio as unknown as (Writable | null)[])[4]!;
		let group: string | undefined;
		let admitted = false;
		let interrupted = 0;
		let failure: Error | undefined;
		// Set once every process in the cgroup was asked to stop; aborted once they no longer get time to.
		let signalled = false;
		const drain = new AbortController();
		const stop = () => {
			if (interrupted) return;
			interrupted = cancelled(cancel.signal);
			// The shell reads end-of-file and never starts the command.
			if (!admitted) return admission.destroy();
			if (!forwards(cancel.signal)) return;
			const name = requested(cancel.signal);
			signalled = true;
			try {
				signalGroup(group!, name);
			} catch (error) {
				// Such as EPERM from a process running as another user: signal what this process can.
				process.stderr.write(
					`quest: cannot signal every process in ${describe.name}, only its command: ${error}\n`,
				);
				child.kill(name);
				drain.abort();
			}
		};
		const terminate = () => {
			stop();
			// The enclosing owner kills this cgroup at its own second signal (see `bound`).
			if (describe.bound && received(cancel.signal)) return;
			drain.abort();
			if (group) kill(group);
		};
		const unfollow = follow(cancel, stop, terminate);
		const cleanup = () => {
			unfollow();
			own?.close();
		};

		admission.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code !== "EPIPE") failure = error;
		});
		let text = "";
		report.setEncoding("utf8");
		report.on("data", (data: string) => {
			text += data;
			if (group !== undefined || !text.endsWith("\n")) return;
			const path = text.slice(0, -1);
			// A unique name can never name a later cgroup, so this path stays this run's.
			if (!path.startsWith("/") || path.includes("\n") || !owns(path)) {
				failure = new Error(`${describe.unsupported}: the command ran outside its cgroup (${path})`);
				admission.destroy();
				return;
			}
			group = join("/sys/fs/cgroup", path);
			if (interrupted) return;
			admitted = true;
			admission.end("admitted\n");
		});

		child.once("error", (error) => {
			cleanup();
			reject(
				(error as NodeJS.ErrnoException).code === "ENOENT"
					? new Error(`${describe.unsupported}: ${describe.launcher} is missing`)
					: error,
			);
		});
		child.once("exit", async (code, signal) => {
			try {
				// Descendants that outlive the command are orphans of this run: stop them.
				if (group) {
					try {
						// Every process got the signal, so let each finish its own cleanup, even one that
						// outlives the wrappers that exited first, until a second signal kills them.
						if (signalled) await vacated(group, drain.signal);
						kill(group);
						await vacated(group);
						await describe.emptied();
					} catch (error) {
						throw new Retained(
							`cannot confirm that ${describe.name} stopped: ${error instanceof Error ? error.message : error}`,
						);
					}
				}
				if (failure) throw failure;
				if (!admitted && !interrupted)
					throw new Error(
						`${describe.unsupported}: ${describe.launcher} exited with ${code ?? signal} before the command started`,
					);
				resolve(interrupted || (code ?? 128 + constants.signals[signal!]));
			} catch (error) {
				reject(error);
			} finally {
				cleanup();
			}
		});
	});
}

/** Matches a Quest scope's unit as a component of a cgroup path. */
const QUEST_SCOPE = /\/(quest-[a-z]+-[0-9a-f-]+\.scope)(?=\/|$)/g;

/**
 * This process's unified cgroup and the innermost Quest scope holding it, which may be the cgroup
 * itself or an ancestor; undefined outside every Quest scope.
 */
export function questScope(self = "/proc/self/cgroup"): { unit: string; group: string } | undefined {
	const path = readFileSync(self, "utf8")
		.split("\n")
		.find((line) => line.startsWith("0::"))
		?.slice(3);
	const unit = path === undefined ? undefined : [...path.matchAll(QUEST_SCOPE)].at(-1)?.[1];
	return unit === undefined ? undefined : { unit, group: join("/sys/fs/cgroup", path!) };
}
