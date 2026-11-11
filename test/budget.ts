// Fails a test that spends more than CPU_BUDGET_MS of CPU, counting its hooks and the processes it
// spawned and waited for. A wall-clock limit would instead measure the host's load, so the wall
// timeout in vitest.config.ts only catches hangs.

import { readFileSync } from "node:fs";

import { afterEach, beforeEach } from "vitest";

/** The CPU one test may spend, five times the most any test spent on Linux (1.9 s, 2026-11-11). */
const CPU_BUDGET_MS = 10_000;

/**
 * This process's CPU time and that of every child it waited for, in milliseconds. A child counts
 * once reaped, as when a test awaits it. Node reports only its own time (`process.cpuUsage`).
 */
function spent(): number {
	const stat = readFileSync("/proc/self/stat", "utf8");
	// The command name, in parentheses, may hold spaces; utime, stime, cutime, and cstime follow it
	// as fields 14 to 17.
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	// Linux reports these in USER_HZ, 100 per second on every architecture Node supports.
	return fields.slice(11, 15).reduce((sum, ticks) => sum + Number(ticks), 0) * 10;
}

// Only Linux exposes its children's CPU (`/proc`), so elsewhere the wall timeout alone applies.
if (process.platform === "linux") {
	let start = 0;
	beforeEach(() => {
		start = spent();
	});
	afterEach(() => {
		const used = spent() - start;
		if (used > CPU_BUDGET_MS) throw new Error(`test spent ${used} ms of CPU, over its ${CPU_BUDGET_MS} ms budget`);
	});
}
