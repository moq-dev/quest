import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { hostname } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { alive, startTime, systemdScopes } from "../src/cli/supervise";
import { created, tempDir } from "./fixture";
import { RUN, sweep } from "./scopes";

describe.runIf(process.platform === "linux")("the test run's scope sweep", () => {
	test("marks every test process with the live run it belongs to", () => {
		const [pid, start] = process.env[RUN]!.split(":");
		expect(alive({ host: hostname(), pid: Number(pid), start })).toBe(true);
	});

	/** Start `sleep` in a new Quest scope as a process of `run`, resolving once it runs there. */
	async function leave(run: string) {
		const dir = tempDir();
		const ready = join(dir, "ready");
		const unit = `quest-gate-${randomUUID()}.scope`;
		const child = spawn(
			"systemd-run",
			[
				"--user",
				"--scope",
				"--quiet",
				"--collect",
				`--unit=${unit}`,
				"/bin/sh",
				"-c",
				`: > ${JSON.stringify(ready)}; exec sleep 1000`,
			],
			{ env: { ...process.env, [RUN]: run }, stdio: "ignore" },
		);
		const exited = once(child, "exit");
		await created(ready);
		return { unit, exited };
	}

	test("stops a scope a dead run left and spares one of a live run", async () => {
		// This process's PID with a start time it never had names a run that has exited.
		const left = await leave(`${process.pid}:0`);
		const kept = await leave(process.env[RUN]!);
		await sweep();
		expect(systemdScopes.live(left.unit)).toBe(false);
		expect(systemdScopes.live(kept.unit)).toBe(true);
		expect(await left.exited).toEqual([null, "SIGKILL"]);
		await systemdScopes.stop(kept.unit);
		expect(await kept.exited).toEqual([null, "SIGKILL"]);
	});

	test("stops the scopes of the live run it names", async () => {
		// This worker names a live run other than the one every test belongs to.
		const run = `${process.pid}:${startTime(process.pid)}`;
		const left = await leave(run);
		await sweep(run);
		expect(systemdScopes.live(left.unit)).toBe(false);
		expect(await left.exited).toEqual([null, "SIGKILL"]);
	});
});
