// Linux process ownership for supervised checkout commands and gated ones. Each run gets its own
// systemd user scope, named once and never reused, so its cgroup holds every descendant that does
// not ask another service manager to start it. Other hosts fail explicitly; only the gate settles
// for a process group there (see `group` in gate.ts).
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, constants as fs, openSync, readFileSync, watch, writeSync } from "node:fs";
import { constants, hostname } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { type Cancellation, cancelled, follow, forwards, interrupts, requested } from "./interrupt";

/** A process, identified so that a reused PID never looks like its predecessor. */
export interface Owner {
	host: string;
	pid: number;
	/** Linux start time in clock ticks since boot. */
	start?: string;
}

/** Field 22 of /proc/<pid>/stat; the command name in parentheses may hold spaces. */
function startTime(pid: number): string | undefined {
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
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
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
	 * Asking stops a command that has not started, and otherwise forwards the requested signal (see
	 * `forwards`), so the command's own handling of it runs; killing stops the whole scope. Without
	 * it, the run follows Quest's own signals (see `interrupts`).
	 */
	cancel?: Cancellation;
	/** Pipes the command's streams to a protocol consumer instead of inheriting them. */
	spawned?(child: ChildProcessWithoutNullStreams): void;
}

export interface Scopes {
	/** Throws on a platform this backend cannot own processes on. */
	check(): void;
	/** Whether any process may still run in the scope. */
	live(unit: string): boolean;
	/** Kill every process left in the scope and resolve once it is empty, including when it is already gone. */
	stop(unit: string): Promise<void>;
	/**
	 * Run a command in a new scope, then stop its remaining descendants. Resolves with the command's
	 * exit status, or the cancelled status once asked to stop, only once the scope is empty. Rejects
	 * with `Retained` when that cannot be confirmed, and otherwise only when the command never started.
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

/** Resolves once the cgroup has no process left, including when it is already gone. */
function vacated(group: string): Promise<void> {
	return new Promise((resolve, reject) => {
		let watcher: ReturnType<typeof watch> | undefined;
		let finished = false;
		const finish = (error?: unknown) => {
			if (finished) return;
			finished = true;
			watcher?.close();
			if (error) reject(error);
			else resolve();
		};
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

/** The scope's cgroup directory, or undefined once systemd no longer knows the unit. */
function scopeGroup(unit: string): string | undefined {
	const group = execFileSync("systemctl", ["--user", "show", "--property=ControlGroup", "--value", unit], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
	if (!group) return undefined;
	if (!group.endsWith(`/${unit}`)) throw new Error(`unexpected cgroup for ${unit}: ${group}`);
	return join("/sys/fs/cgroup", group);
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
		return group !== undefined && populated(group);
	},

	async stop(unit) {
		const group = scopeGroup(unit);
		if (group === undefined) return;
		kill(group);
		await vacated(group);
	},

	run(unit, cwd, command, options = {}) {
		return new Promise((resolve, reject) => {
			const own = options.cancel ? undefined : interrupts();
			const cancel = options.cancel ?? own!;
			const pipe = options.spawned ? "pipe" : "inherit";
			const child = spawn(
				"systemd-run",
				[
					"--user",
					"--scope",
					"--quiet",
					"--collect",
					`--unit=${unit}`,
					"--expand-environment=no",
					"--",
					"/bin/sh",
					"-c",
					handshake,
					"quest-worktree",
					...command,
				],
				{
					cwd,
					env: options.env,
					stdio: [pipe, pipe, pipe, "pipe", "pipe"],
				},
			);
			options.spawned?.(child as ChildProcessWithoutNullStreams);
			const report = child.stdio[3] as Readable;
			const admission = (child.stdio as unknown as (Writable | null)[])[4]!;
			let group: string | undefined;
			let admitted = false;
			let interrupted = 0;
			let failure: Error | undefined;
			const stop = () => {
				if (interrupted) return;
				interrupted = cancelled(cancel.signal);
				if (admitted) {
					if (forwards(cancel.signal)) child.kill(requested(cancel.signal));
				} else admission.destroy(); // The shell reads end-of-file and never starts the command.
			};
			const terminate = () => {
				stop();
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
				// A unique unit name can never name a later scope, so this path stays this run's.
				if (!path.startsWith("/") || path.includes("\n") || !path.endsWith(`/${unit}`)) {
					failure = new Error(`${UNSUPPORTED}: the command ran outside its scope (${path})`);
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
						? new Error(`${UNSUPPORTED}: systemd-run is missing`)
						: error,
				);
			});
			child.once("exit", async (code, signal) => {
				try {
					// Descendants that outlive the command are orphans of this run: stop them.
					if (group) {
						try {
							kill(group);
							await vacated(group);
						} catch (error) {
							throw new Retained(
								`cannot confirm that ${unit} stopped: ${error instanceof Error ? error.message : error}`,
							);
						}
					}
					if (failure) throw failure;
					if (!admitted && !interrupted)
						throw new Error(
							`${UNSUPPORTED}: systemd-run exited with ${code ?? signal} before the command started`,
						);
					resolve(interrupted || (code ?? 128 + constants.signals[signal!]));
				} catch (error) {
					reject(error);
				} finally {
					cleanup();
				}
			});
		});
	},
};
