// Stops the land fixers a test starts. The watcher spawns each fixer's wrapper detached, in its own
// process group, so neither a test that fails or is aborted nor the run's exit reaches it, and a fake
// agent blocked on its fifo would wait forever. test/scopes.ts does the same for the gate's scopes.
// A group is found by its `quest-fixer` leader running a wrapper path only one test created.

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Names the directory where each test worker lists the fixer wrappers it tracked, for the run's own teardown. */
const REGISTRY = "QUEST_TEST_FIXERS";

/** The wrappers the current test tracks. */
const wrappers = new Set<string>();

/** Tracks the fixer wrapper at `path`, so teardown stops the fixers that run it. */
export function track(path: string): string {
	const registry = process.env[REGISTRY];
	if (!registry) throw new Error(`${REGISTRY} is unset: run the tests through vitest.config.ts`);
	appendFileSync(join(registry, String(process.pid)), `${path}\n`);
	wrappers.add(path);
	return path;
}

/** The leader of each running fixer group of one of `tracked`, and whether anything besides it still runs. */
function groups(tracked: string[]): { leader: number; running: boolean }[] {
	if (!tracked.length) return [];
	// The leader runs `sh -c <script> quest-fixer <exit> <wrapper> <log> <numbers...>` (src/cli/land-fixer.ts).
	// pgrep prints only PIDs: every process's arguments, on a busy host, would overflow a buffer.
	const escaped = tracked.map((wrapper) => wrapper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const found = spawnSync("pgrep", ["-f", "--", ` quest-fixer .* (${escaped.join("|")}) `], { encoding: "utf8" });
	// pgrep exits 1 when nothing matches.
	if (found.status === 1) return [];
	if (found.status !== 0) throw new Error(`pgrep failed: ${found.error ?? found.stderr}`);
	const matched = new Set(found.stdout.split("\n").filter(Boolean).map(Number));
	const processes = execFileSync("ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8" })
		.split("\n")
		.flatMap((line) => {
			const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
			// A zombie has exited and only waits for its parent to reap it.
			return match && !match[3].startsWith("Z") ? [{ pid: Number(match[1]), group: Number(match[2]) }] : [];
		});
	const leaders = processes.filter((entry) => entry.pid === entry.group && matched.has(entry.pid));
	const members = processes.filter(
		(entry) => entry.pid !== entry.group && leaders.some((leader) => leader.pid === entry.group),
	);
	// Once the wrapper returns, the leader only records its status with `mv` and exits, so neither is a leak.
	const running = new Set<number>();
	if (members.length) {
		// ps exits 1 when a listed process has gone since, which is no leak either.
		const listed = spawnSync(
			"ps",
			["-ww", "-o", "pid=,stat=,args=", "-p", members.map((entry) => entry.pid).join(",")],
			{ encoding: "utf8" },
		);
		for (const line of listed.stdout.split("\n")) {
			const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
			if (match && !match[2].startsWith("Z") && !/^mv (.+\.exit)\.new \1$/.test(match[3]))
				running.add(Number(match[1]));
		}
	}
	return leaders.map((leader) => ({
		leader: leader.pid,
		running: members.some((entry) => entry.group === leader.pid && running.has(entry.pid)),
	}));
}

/** Kill the process group of every running fixer of one of `tracked`, returning those still running a wrapper. */
function stop(tracked: string[]): number[] {
	const found = groups(tracked);
	for (const { leader } of found)
		try {
			process.kill(-leader, "SIGKILL");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// macOS refuses to signal a group whose every member is a zombie.
			const exited =
				code === "EPERM" &&
				process.platform === "darwin" &&
				!groups(tracked).some((group) => group.leader === leader);
			if (code !== "ESRCH" && !exited) throw error;
		}
	return found.filter((group) => group.running).map((group) => group.leader);
}

/** Stops the current test's fixers, for a test that leaves one running on purpose. */
export function stopFixers(): void {
	stop([...wrappers]);
	wrappers.clear();
}

/** Each test's teardown: stops its fixers, and fails if one was still running. */
export function checkFixers(): void {
	const leaked = stop([...wrappers]);
	wrappers.clear();
	if (leaked.length) throw new Error(`a land fixer outlived its test: process groups ${leaked.join(", ")}`);
}

/** Every wrapper the run's workers tracked. */
function registered(registry: string): string[] {
	return readdirSync(registry).flatMap((file) =>
		readFileSync(join(registry, file), "utf8").split("\n").filter(Boolean),
	);
}

/**
 * Kill the run's workers, this process's children, so none launches a fixer it tracked after the
 * signal's sweep: a killed worker runs no more code.
 */
function killWorkers(): void {
	if (process.platform === "win32") return;
	for (const line of execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).split("\n")) {
		const [pid, parent] = line.trim().split(/\s+/).map(Number);
		if (parent !== process.pid) continue;
		try {
			process.kill(pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
}

/** Vitest's global setup: gives the workers a registry, and stops every fixer they tracked when the run ends or is signalled. */
export default function setup(): () => void {
	const registry = mkdtempSync(join(tmpdir(), "quest-fixers-"));
	// Set before the workers start, so they inherit it.
	process.env[REGISTRY] = registry;
	const sweep = () => {
		try {
			stop(registered(registry));
		} finally {
			rmSync(registry, { recursive: true, force: true });
		}
	};
	// A signalled run never reaches per-test teardown, and a worker the run stops never reaches its own.
	for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const)
		process.once(signal, () => {
			try {
				killWorkers();
				sweep();
			} catch (error) {
				process.stderr.write(`cannot stop the test run's land fixers: ${error}\n`);
			}
			// Raised again once this listener is gone, the signal ends the run as it would have without it.
			setImmediate(() => process.kill(process.pid, signal));
		});
	// A worker that crashed never reached its teardown.
	return sweep;
}
