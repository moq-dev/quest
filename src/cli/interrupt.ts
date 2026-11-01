// Cancellation and signal forwarding for a command Quest runs, shared by `quest gate` and
// `quest worktree run`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants } from "node:os";

/** How a caller cancels a running command: `signal` asks it to stop, and `kill` stops it outright. */
export interface Cancellation {
	/** Aborted with the name of the signal to deliver; any other reason asks for SIGTERM. */
	signal: AbortSignal;
	kill: AbortSignal;
}

/**
 * Follow Quest's own SIGINT, SIGTERM, and SIGHUP until closed: the first aborts `signal` with its
 * name, and any later one aborts `kill`.
 */
export function interrupts(): Cancellation & { close(): void } {
	const signal = new AbortController();
	const kill = new AbortController();
	const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(
		(name) => [name, () => (signal.signal.aborted ? kill.abort() : signal.abort(name))] as const,
	);
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

/**
 * Set for a command whose session Quest's group owner leads. The owner stands in for the session's
 * terminal and delivers every SIGINT to the whole group, so it already reaches the child.
 */
export const GROUP = "QUEST_GATE_GROUP";

/**
 * Whether to pass on the signal an aborted `Cancellation.signal` asks for. An
 * abort without a signal's name came from the caller, not a signal the child
 * may also have received, so it always passes. A terminal's Ctrl-C sends
 * SIGINT to the whole foreground process group, child included, so forwarding
 * it would deliver it twice; so does Quest's group owner (see `GROUP`). SIGHUP
 * and SIGTERM may be sent to Quest alone, so they always pass; so does SIGINT
 * while Quest is in the background. A SIGINT sent with `kill` to a foreground
 * Quest alone is therefore not forwarded. Windows delivers Ctrl-C to every
 * process on the console and has no signal to forward: `child.kill()`
 * terminates the child outright.
 */
export function forwards(signal: AbortSignal, env = process.env): boolean {
	const name = signal.reason;
	if (typeof name !== "string" || !(name in constants.signals)) return true;
	if (process.platform === "win32") return false;
	return name !== "SIGINT" || !(env[GROUP] === "1" || foreground());
}
