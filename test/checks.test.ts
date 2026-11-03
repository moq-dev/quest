import { expect, test } from "vitest";

import { checksState, contextOutcome, latestContexts } from "../src/github/checks";

const ACTIONS = 15368;
const run = (name: string, databaseId: number, conclusion: string | null, app = ACTIONS) => ({
	__typename: "CheckRun",
	databaseId,
	name,
	status: conclusion === null ? "QUEUED" : "COMPLETED",
	conclusion,
	checkSuite: { app: { databaseId: app } },
});
const status = (context: string, state: string, createdAt: string) => ({
	__typename: "StatusContext",
	context,
	state,
	createdAt,
});

// The shape of moq-dev/moq#7325's head a15652d: concurrency cancelled the older workflow run, whose
// gate then failed on purpose, while the newer run passed. GitHub's rollup state was FAILURE, yet its
// merge state was CLEAN.
const moq7325 = [
	run("Scope", 1, "CANCELLED"),
	run("Release gate", 2, "FAILURE"),
	run("Scope", 3, "SUCCESS"),
	run("Release gate", 4, "SUCCESS"),
];

test("only the latest run of each check counts, as on moq-dev/moq#7325", () => {
	expect(latestContexts(moq7325)).toEqual([moq7325[2], moq7325[3]]);
	expect(checksState(moq7325)).toBe("SUCCESS");
});

test("a newer run decides the check whatever order the rollup lists it in", () => {
	expect(checksState([run("test", 9, null), run("test", 3, "SUCCESS")])).toBe("PENDING");
	expect(checksState([run("test", 3, "SUCCESS"), run("test", 9, "FAILURE")])).toBe("FAILURE");
	expect(checksState([run("test", 9, "SUCCESS"), run("test", 3, "FAILURE")])).toBe("SUCCESS");
});

test("the same name from two apps, or as a run and a status, counts as separate checks", () => {
	const twoApps = [run("test", 1, "FAILURE", 99), run("test", 2, "SUCCESS")];
	expect(latestContexts(twoApps)).toEqual(twoApps);
	expect(checksState(twoApps)).toBe("FAILURE");
	const runAndStatus = [run("deploy", 1, "SUCCESS"), status("deploy", "FAILURE", "2026-10-07T12:00:00Z")];
	expect(latestContexts(runAndStatus)).toEqual(runAndStatus);
	expect(checksState(runAndStatus)).toBe("FAILURE");
});

test("a commit status counts by its newest report, and on a tie the one listed later", () => {
	const newest = status("ci", "SUCCESS", "2026-10-07T12:05:00Z");
	expect(latestContexts([newest, status("ci", "FAILURE", "2026-10-07T12:00:00Z")])).toEqual([newest]);
	const tied = status("ci", "PENDING", "2026-10-07T12:05:00Z");
	expect(latestContexts([newest, tied])).toEqual([tied]);
});

test("outcomes follow GitHub's passing results", () => {
	expect(["SUCCESS", "NEUTRAL", "SKIPPED"].map((c) => contextOutcome(run("x", 1, c)))).toEqual([
		"passed",
		"passed",
		"passed",
	]);
	expect(["CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].map((c) => contextOutcome(run("x", 1, c)))).toEqual([
		"failing",
		"failing",
		"failing",
	]);
	expect(contextOutcome(run("x", 1, null))).toBe("pending");
	expect(["PENDING", "EXPECTED", "SUCCESS", "ERROR"].map((s) => contextOutcome(status("x", s, "")))).toEqual([
		"pending",
		"pending",
		"passed",
		"failing",
	]);
	expect(checksState([])).toBe("SUCCESS");
});
