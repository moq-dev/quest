// The land daemons delete their finished logs after the retention window, never one a record still reads.
import { expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOG_RETENTION, pruneLogs } from "../src/cli/land-prune";

test("prunes expired logs of both daemons and keeps every cited or unrelated file", () => {
	const state = mkdtempSync(join(tmpdir(), "land-prune-"));
	try {
		const now = Date.now();
		const old = (now - LOG_RETENTION - 60_000) / 1000;
		const write = (name: string, body = "") => {
			writeFileSync(join(state, name), body);
			utimesSync(join(state, name), old, old);
		};
		const json = (name: string, value: unknown) => write(name, JSON.stringify(value));
		// Expired and unreferenced: serve's logs left in a watcher's directory, and a finished watcher's.
		const gone = [
			"base-1730000000000-0123456789ab.log",
			"check-1730000000000-12.log",
			"batch-1730000000000-12.log",
			"removal-7-20261101T000000Z.log",
			"conflict-7-0123456789ab.log",
			"fixer-input-7-abc123.log",
			"fix-job-fix-AAAAAA.json.log",
			"watch-job-old-7.json.log",
			// Records serve left no longer keep their logs, since nothing reads them.
			"base-1730000000001-aaaaaaaaaaaa.log",
			"batch-1730000000002-3.log",
		];
		for (const name of gone) write(name);
		json("removal-7.json", { failure: "x", taken: 1, log: join(state, "removal-7-20261101T000000Z.log") });
		// A removal waiting for a fixer slot across a restart keeps its log and its conflict log.
		write("removal-8-20261101T000000Z.log");
		write("conflict-8-fedcba987654.log");
		json("removal-8.json", {
			failure: "x",
			log: join(state, "removal-8-20261101T000000Z.log"),
			unmerged: "fedcba9876543210",
		});
		// A running job keeps its own log and the one it reads.
		write("fixer-input-9-xyz.log");
		json("watch-job-live-9.json", { log: join(state, "fixer-input-9-xyz.log") });
		write("watch-job-live-9.json.log");
		json("fix-base-fix-BBBBBB.json", { log: join(state, "base-1730000000001-aaaaaaaaaaaa.log") });
		json("failure.json", { log: join(state, "batch-1730000000002-3.log") });
		// Recent, unrelated, or not a regular file.
		writeFileSync(join(state, "check-1730000000003-4.log"), "");
		write("notes.log");
		write("removal-7-x.log.bak");
		mkdirSync(join(state, "check-AbC123"));
		mkdirSync(join(state, "fix-XyZ789"));
		mkdirSync(join(state, "codex-repro-1"));
		write(join("codex-repro-1", "failure.log"));
		mkdirSync(join(state, "batch-1730000000004-5.log"));

		expect(pruneLogs(state, now, (message) => expect.fail(message)).sort()).toEqual([...gone].sort());
		const left = readdirSync(state);
		for (const name of gone) expect(left).not.toContain(name);
		for (const name of [
			"removal-8-20261101T000000Z.log",
			"conflict-8-fedcba987654.log",
			"fixer-input-9-xyz.log",
			"watch-job-live-9.json.log",
			"check-1730000000003-4.log",
			"notes.log",
			"removal-7-x.log.bak",
			"check-AbC123",
			"fix-XyZ789",
			"codex-repro-1",
			"batch-1730000000004-5.log",
		])
			expect(left).toContain(name);
		expect(readdirSync(join(state, "codex-repro-1"))).toEqual(["failure.log"]);
	} finally {
		rmSync(state, { recursive: true, force: true });
	}
});

test("an unreadable record warns and deletes nothing", () => {
	const state = mkdtempSync(join(tmpdir(), "land-prune-"));
	try {
		writeFileSync(join(state, "check-1730000000000-12.log"), "");
		utimesSync(join(state, "check-1730000000000-12.log"), 0, 0);
		writeFileSync(join(state, "watch-job-fix-AAAAAA.json"), "{");
		const warnings: string[] = [];
		expect(pruneLogs(state, Date.now(), (message) => warnings.push(message))).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(readdirSync(state)).toContain("check-1730000000000-12.log");
	} finally {
		rmSync(state, { recursive: true, force: true });
	}
});
