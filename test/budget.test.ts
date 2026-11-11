import { spawnSync } from "node:child_process";

import { expect, test } from "vitest";

import { spent } from "./budget";

test.runIf(process.platform === "linux")("a test's CPU counts a child it waited for", () => {
	const before = spent();
	// The child spins until it has spent 400 ms of CPU, however long a loaded host takes to give it that.
	const spin = "while (process.cpuUsage().user + process.cpuUsage().system < 400_000);";
	expect(spawnSync(process.execPath, ["-e", spin]).status).toBe(0);
	// Each of the four tick counters may round down by one tick.
	expect(spent() - before).toBeGreaterThanOrEqual(400 - 40);
});
