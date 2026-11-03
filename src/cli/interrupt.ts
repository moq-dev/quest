// Cancellation and signal forwarding for a command Quest runs, shared by `quest gate` and
// `quest worktree run`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants } from "node:os";
import { basename } from "node:path";

/** How a caller cancels a running command: `signal` asks it to stop, and `kill` stops it outright. */
export interface Cancellation {
	/** Aborted with the name of the signal to deliver; any other reason asks for SIGTERM. */
	signal: AbortSignal;
	kill: AbortSignal;
}

/**
 * Follow Quest's own SIGINT, SIGTERM, and SIGHUP until closed: the first aborts `signal` with its
 * name, and any later one aborts `kill`. When the first is a SIGTERM that Just may also forward (see
 * `relayedByJust`), one more SIGTERM is taken as that copy rather than as a second signal.
 */
export function interrupts(): Cancellation & { close(): void } {
	const signal = new AbortController();
	const kill = new AbortController();
	let copy = false; // Whether one more SIGTERM may still be Just's copy of the first.
	const handle = (name: NodeJS.Signals) => {
		if (!signal.signal.aborted) {
			copy = name === "SIGTERM" && relayedByJust();
			signal.abort(name);
		} else if (copy && name === "SIGTERM") copy = false;
		else kill.abort();
	};
	const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((name) => [name, () => handle(name)] as const);
	for (const [name, handler] of handlers) process.on(name, handler);
	return {
		signal: signal.signal,
		kill: kill.signal,
		close() {
			for (const [name, handler] of handlers) process.off(name, handler);
		},
	};
}

/**
 * Call `stop` once asked to cancel and `terminate` once killed, even if that already happened, and
 * return the function that stops following.
 */
export function follow(cancel: Cancellation, stop: () => void, terminate: () => void): () => void {
	cancel.signal.addEventListener("abort", stop, { once: true });
	cancel.kill.addEventListener("abort", terminate, { once: true });
	if (cancel.kill.aborted) terminate();
	else if (cancel.signal.aborted) stop();
	return () => {
		cancel.signal.removeEventListener("abort", stop);
		cancel.kill.removeEventListener("abort", terminate);
	};
}

/** The signal an aborted `Cancellation.signal` asks to deliver. */
export function requested(signal: AbortSignal): NodeJS.Signals {
	const name = signal.reason;
	return typeof name === "string" && name in constants.signals ? (name as NodeJS.Signals) : "SIGTERM";
}

/** The status a shell reports for a command that the requested signal stopped. */
export function cancelled(signal: AbortSignal): number {
	return 128 + constants.signals[requested(signal)];
}

/** Whether /proc/<pid>/stat's process group (field 5) is its terminal's foreground group (field 8). */
export function foregroundStat(stat: string): boolean {
	// The command name in parentheses may hold spaces.
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	return fields[2] === fields[5];
}

/** Whether this process is in its controlling terminal's foreground process group. */
function foreground(): boolean {
	if (process.platform === "linux") return foregroundStat(readFileSync("/proc/self/stat", "utf8"));
	try {
		const [terminal, group] = execFileSync("ps", ["-o", "tpgid=,pgid=", "-p", String(process.pid)], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		})
			.trim()
			.split(/\s+/);
		return terminal === group;
	} catch {
		return false; // Forward, as for a process without a terminal.
	}
}

/** The command name and process group in a /proc/<pid>/stat line. */
export function statProcess(stat: string): { name: string; group: string } {
	// The command name in parentheses may hold spaces.
	const end = stat.lastIndexOf(")");
	return { name: stat.slice(stat.indexOf("(") + 1, end), group: stat.slice(end + 2).split(" ")[2] };
}

/** The command name and process group of each running process in `pids`, by PID. */
function processes(pids: number[]): Map<number, { name: string; group: string }> {
	const found = new Map<number, { name: string; group: string }>();
	if (process.platform === "linux") {
		for (const pid of pids) {
			try {
				found.set(pid, statProcess(readFileSync(`/proc/${pid}/stat`, "utf8")));
			} catch {} // Gone.
		}
		return found;
	}
	try {
		const ps = execFileSync("ps", ["-o", "pid=,pgid=,comm=", "-p", pids.join(",")], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		for (const line of ps.trim().split("\n")) {
			const [pid, group, ...command] = line.trim().split(/\s+/);
			found.set(Number(pid), { name: basename(command.join(" ")), group });
		}
	} catch {} // None of them run.
	return found;
}

/**
 * Whether Just is this process's parent and shares its process group. Just forwards each SIGTERM it
 * gets to the command it runs, so a SIGTERM sent to that group reaches this process twice: once
 * directly, and once as Just's copy.
 */
function relayedByJust(): boolean {
	if (process.platform === "win32") return false;
	const found = processes([process.pid, process.ppid]);
	const self = found.get(process.pid);
	const parent = found.get(process.ppid);
	return parent?.name === "just" && parent.group === self?.group;
}

/**
 * Set for a command whose session Quest's group owner leads. The owner stands in for the session's
 * terminal and delivers every SIGINT, SIGTERM, and SIGHUP to the whole group, so it already reaches
 * the child.
 */
export const GROUP = "QUEST_GATE_GROUP";

/** Whether an aborted `Cancellation.signal` names a signal Quest received, not a caller's own abort. */
export function received(signal: AbortSignal): boolean {
	const name = signal.reason;
	return typeof name === "string" && name in constants.signals;
}

/**
 * Whether to pass on the signal an aborted `Cancellation.signal` asks for. An abort without a
 * signal's name came from the caller, not a signal the child may also have received, so it always
 * passes. Otherwise the signal is held back wherever it already reached the child, since a nested
 * Quest that receives it twice treats the second as a kill:
 *
 * - `held`: an enclosing owner that signals everything it holds also holds the child. Quest's group
 *   owner (see `GROUP`) delivers SIGINT, SIGTERM, and SIGHUP to its whole process group, and a
 *   Quest scope's owner to every process in the scope.
 * - SIGINT while Quest is in its terminal's foreground process group, since a terminal's Ctrl-C
 *   reaches that whole group.
 *
 * SIGTERM and SIGHUP, and SIGINT while Quest is in the background, may otherwise have been sent to
 * Quest alone, so they pass. The trade-off: a signal sent with `kill` to a Quest whose child it is
 * held back from is not forwarded, so that child stops only once the enclosing owner, or the
 * terminal, is signalled. Windows delivers Ctrl-C to every process on the console and has no
 * signal to forward: `child.kill()` terminates the child outright.
 */
export function forwards(signal: AbortSignal, held = process.env[GROUP] === "1"): boolean {
	if (!received(signal)) return true;
	if (process.platform === "win32" || held) return false;
	return signal.reason !== "SIGINT" || !foreground();
}
