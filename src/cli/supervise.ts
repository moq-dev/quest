// Linux process ownership for supervised checkout commands and gated ones. Each run gets its own
// systemd user scope, named once and never reused, so its cgroup holds every descendant that does
// not ask another service manager to start it. The scope is delegated, so a gate inside it owns its
// command through a child cgroup of its own (see `nest`). Other hosts fail explicitly; only the
// gate settles for a process group there (see `group` in gate.ts).
import { type ChildProcessWithoutNullStreams, execFile, execFileSync, spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	constants as fs,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	watch,
	writeSync,
} from "node:fs";
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

/** Whether the cgroup still holds a process, or `otherwise` when that cannot be read. */
function populatedOr(group: string, otherwise: boolean): boolean {
	try {
		return populated(group);
	} catch {
		return otherwise;
	}
}

/**
 * Send `signal` to every process in the scope, as systemd's default `KillMode=control-group` stops
 * a unit, then call `done`. cgroup v2 offers only SIGKILL (`cgroup.kill`) itself.
 */
function signalScope(unit: string, signal: NodeJS.Signals, done: (error?: string) => void): void {
	execFile(
		"systemctl",
		["--user", "kill", "--kill-whom=all", `--signal=${signal}`, unit],
		{ encoding: "utf8" },
		(error, _stdout, stderr) => done(error ? stderr.trim() || error.message : undefined),
	);
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
				// A gate inside the scope runs its command in a child cgroup of its own (see `nest`).
				"--property=Delegate=yes",
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
				signal: (_group, name, done) => signalScope(unit, name, done),
				inside: false,
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
	/** Send `name` to every process in the cgroup `group`, then call `done`, with why when it could not. */
	signal(group: string, name: NodeJS.Signals, done: (error?: string) => void): void;
	/**
	 * Whether the cgroup lies within an enclosing Quest scope, whose owner delivers each signal it
	 * receives to every process in the scope, this cgroup's included. A signal this process received
	 * then already reached them all, so it is not delivered again, and they get to finish their
	 * cleanup as if it had been.
	 */
	inside: boolean;
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
			if (!(describe.inside ? forwards(cancel.signal, true) : forwards(cancel.signal))) {
				// The enclosing scope's owner already signalled every process here (see `inside`).
				signalled = describe.inside;
				return;
			}
			const name = requested(cancel.signal);
			signalled = true;
			describe.signal(group!, name, (error) => {
				// The cgroup empties once its last process exits, which leaves nothing to signal.
				if (!error || !group || !populatedOr(group, true)) return;
				process.stderr.write(
					`quest: cannot signal every process in ${describe.name}, only its command: ${error}\n`,
				);
				child.kill(name);
				drain.abort();
			});
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

/** Remove an empty cgroup and any empty child cgroups left in it; one already gone is fine. */
function prune(group: string): void {
	let entries;
	try {
		entries = readdirSync(group, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for (const entry of entries) if (entry.isDirectory()) prune(join(group, entry.name));
	try {
		rmdirSync(group);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/**
 * Send `signal` to every process in the cgroup and its children, until a pass finds none it has not
 * signalled yet, as systemd does for a unit, then call `done`.
 */
function signalGroup(group: string, signal: NodeJS.Signals, done: (error?: string) => void): void {
	const sent = new Set<number>();
	const pass = (dir: string): boolean => {
		let found = false;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
			for (const line of readFileSync(join(dir, "cgroup.procs"), "utf8").split("\n")) {
				const pid = Number(line);
				if (!line || sent.has(pid)) continue;
				sent.add(pid);
				found = true;
				try {
					process.kill(pid, signal);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
			}
		} catch (error) {
			// The cgroup was removed while it was read.
			if (["ENOENT", "ENODEV"].includes((error as NodeJS.ErrnoException).code ?? "")) return found;
			throw error;
		}
		for (const entry of entries) if (entry.isDirectory() && pass(join(dir, entry.name))) found = true;
		return found;
	};
	try {
		while (pass(group));
	} catch (error) {
		return done(error instanceof Error ? error.message : String(error));
	}
	done();
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

/**
 * Whether systemd delegated the scope's cgroup subtree, so its processes may create child cgroups.
 * A scope from a Quest that predates delegation, or a manager that cannot be asked, is not.
 */
export function delegated(unit: string): boolean {
	try {
		return (
			execFileSync("systemctl", ["--user", "show", "--property=Delegate", "--value", unit], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim() === "yes"
		);
	} catch {
		return false;
	}
}

/**
 * Run a command in a new child cgroup of `parent`, inside a delegated Quest scope, like a scope of
 * its own (see `Scopes.run`): every descendant stays in the child, which the enclosing scope's
 * `cgroup.kill` also reaches, and the child is removed once empty. The handshake shell moves itself
 * into the child before it reports, so nothing it starts runs outside it.
 */
export async function nest(
	parent: string,
	name: string,
	cwd: string,
	command: string[],
	options: RunOptions = {},
): Promise<number> {
	const group = join(parent, name);
	const unsupported = `quest gate cannot run the command in a child cgroup of its Quest scope (${group})`;
	mkdirSync(group);
	let status: number;
	try {
		status = await contain(
			// Writing 0 to cgroup.procs moves the writing process, the shell itself.
			["/bin/sh", "-c", `echo 0 >"$0/cgroup.procs" || exit 125; ${handshake}`, group],
			(path) => join("/sys/fs/cgroup", path) === group,
			{ name: group, unsupported, launcher: "/bin/sh", signal: signalGroup, inside: true, bound: true },
			cwd,
			command,
			options,
		);
	} catch (error) {
		// The cgroup may still hold processes.
		if (!(error instanceof Retained)) prune(group);
		throw error;
	}
	prune(group);
	return status;
}
