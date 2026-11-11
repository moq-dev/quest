// Fails a test that spends more than CPU_BUDGET_MS of CPU, counting its hooks and the processes it
// spawned and waited for. A wall-clock limit would instead measure the host's load (see
// vitest.config.ts, whose wall timeout only catches hangs).

import { appendFileSync, readFileSync } from "node:fs";

import { afterEach, beforeEach } from "vitest";

/** The CPU one test may spend, several times the most any test spends today. */
export const CPU_BUDGET_MS = 20_000;

/**
 * This process's CPU time and that of every child it waited for, in milliseconds, from
 * `/proc/self/stat`. Children count once reaped, as when a test awaits them; Node offers only
 * its own time (`process.cpuUsage`).
 */
function spent(): number {
	const stat = readFileSync("/proc/self/stat", "utf8");
	// The command name, in parentheses, may hold spaces; utime, stime, cutime, and cstime follow it
	// as fields 14 to 17.
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	// Linux reports these in USER_HZ, 100 per second on every architecture Node supports.
	return fields.slice(11, 15).reduce((sum, ticks) => sum + Number(ticks), 0) * 10;
}

// Only Linux reports the CPU of reaped children, so elsewhere the wall timeout alone applies.
if (process.platform === "linux") {
	let start = 0;
	beforeEach(() => {
		start = spent();
	});
	afterEach((context) => {
		const used = spent() - start;
		if (process.env.CPU_LOG) appendFileSync(process.env.CPU_LOG, `${used}\t${context.task.file.name} > ${context.task.name}\n`);
		if (used > CPU_BUDGET_MS) throw new Error(`test spent ${used} ms of CPU, over its ${CPU_BUDGET_MS} ms budget`);
	});
}
