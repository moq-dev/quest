// Stops the Quest scopes a test run leaves running. A scope outlives the process that started it,
// so a test that fails or times out before stopping one, a supervisor a test kills, or a run
// signalled mid-test (a cancelled `quest gate` signals every process in the run) would leave it.
// Every process the run starts, child CLIs and their scopes included, inherits the run's marker in
// its environment, so the sweep finds a scope by what runs in it rather than by who started it.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { alive, kill, members, startTime, systemdScopes } from "../src/cli/supervise";

/** Names the test run a process belongs to, as its main process's `<pid>:<start time>`. */
export const RUN = "QUEST_TEST_RUN";

/** Whether the test run `run` names has exited. */
function dead(run: string): boolean {
	const match = /^(\d+):(\d+)$/.exec(run);
	if (!match) throw new Error(`malformed ${RUN}: ${run}`);
	return !alive({ host: hostname(), pid: Number(match[1]), start: match[2] });
}

/**
 * The run `pid` belongs to, or undefined for a process outside every run, already gone, or hiding
 * its environment, as a setuid program another session runs does; no test runs one.
 */
function runOf(pid: number): string | undefined {
	try {
		const environ = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
		return environ.find((entry) => entry.startsWith(`${RUN}=`))?.slice(RUN.length + 1);
	} catch (error) {
		if (["ENOENT", "ESRCH", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
		throw error;
	}
}

/**
 * The cgroups of the Quest scopes holding a process of run `own` or of a run that has exited, but
 * never one holding this process, such as the gate's scope around `just test`.
 */
function strays(own?: string): Map<string, string> {
	const self = readFileSync("/proc/self/cgroup", "utf8")
		.split("\n")
		.find((line) => line.startsWith("0::"))!
		.slice(3);
	const show = execFileSync("systemctl", ["--user", "show", "--property=Id,ControlGroup", "quest-*.scope"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const found = new Map<string, string>();
	for (const entry of show.split("\n\n")) {
		const unit = /^Id=(.+)$/m.exec(entry)?.[1];
		const group = /^ControlGroup=(.+)$/m.exec(entry)?.[1];
		if (!unit || !group || self === group || self.startsWith(`${group}/`)) continue;
		const path = join("/sys/fs/cgroup", group);
		const runs = members(path).map(runOf);
		if (runs.some((run) => run !== undefined && (run === own || dead(run)))) found.set(unit, path);
	}
	return found;
}

/** Stop every scope a run that exited left running, and those of run `own`; resolves once each is empty. */
export async function sweep(own?: string): Promise<void> {
	const stops = await Promise.allSettled([...strays(own).keys()].map((unit) => systemdScopes.stop(unit)));
	const failed = stops.flatMap((stop) => (stop.status === "rejected" ? [stop.reason] : []));
	if (failed.length) throw new AggregateError(failed, `cannot stop ${failed.length} test scopes`);
}

/** Vitest's global setup: marks the run, clears what dead runs left, and stops this run's scopes when it ends. */
export default async function setup(): Promise<(() => Promise<void>) | undefined> {
	if (process.platform !== "linux") return undefined;
	const own = `${process.pid}:${startTime(process.pid)}`;
	// Set before the workers start, so they and everything they spawn inherit it.
	process.env[RUN] = own;
	// A run killed outright, such as by SIGKILL, never reached its teardown.
	await sweep();
	// A signalled run never reaches its teardown either.
	for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => {
			// One scope that cannot be killed must not spare the rest, nor keep the run alive.
			try {
				for (const [unit, group] of strays(own))
					try {
						kill(group);
					} catch (error) {
						process.stderr.write(`cannot kill test scope ${unit}: ${error}\n`);
					}
			} catch (error) {
				process.stderr.write(`cannot find the test scopes: ${error}\n`);
			}
			// Raised again once this listener is gone, the signal ends the run as it would have without
			// it: signal-exit, which Vite's bundler loads, re-raises a signal only when it listens alone.
			setImmediate(() => process.kill(process.pid, signal));
		});
	}
	return () => sweep(own);
}
