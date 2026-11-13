import { expect, test } from "vitest";

import { checksState, contextOutcome, currentContexts, latestContexts, type WorkflowRun } from "../src/github/checks";

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
	expect(checksState(latestContexts(moq7325))).toBe("SUCCESS");
});

test("a newer run decides the check whatever order the rollup lists it in", () => {
	expect(checksState(latestContexts([run("test", 9, null), run("test", 3, "SUCCESS")]))).toBe("PENDING");
	expect(checksState(latestContexts([run("test", 3, "SUCCESS"), run("test", 9, "FAILURE")]))).toBe("FAILURE");
	expect(checksState(latestContexts([run("test", 9, "SUCCESS"), run("test", 3, "FAILURE")]))).toBe("SUCCESS");
});

test("the same name from two apps, or as a run and a status, counts as separate checks", () => {
	const twoApps = [run("test", 1, "FAILURE", 99), run("test", 2, "SUCCESS")];
	expect(latestContexts(twoApps)).toEqual(twoApps);
	expect(checksState(latestContexts(twoApps))).toBe("FAILURE");
	const runAndStatus = [run("deploy", 1, "SUCCESS"), status("deploy", "FAILURE", "2026-10-07T12:00:00Z")];
	expect(latestContexts(runAndStatus)).toEqual(runAndStatus);
	expect(checksState(latestContexts(runAndStatus))).toBe("FAILURE");
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

const job = (name: string, databaseId: number, conclusion: string, suite: number) => ({
	...run(name, databaseId, conclusion),
	checkSuite: { databaseId: suite, app: { databaseId: ACTIONS } },
});
const workflowRun = (id: number, started: string, workflow = 1): WorkflowRun => ({
	id,
	workflow_id: workflow,
	check_suite_id: id * 10,
	run_started_at: started,
});

// kixelated/token-max's head daaaadc: an `edited` run cancelled each `synchronize` run through
// `cancel-in-progress`, and the cancelled run's matrix job kept its unexpanded name, which the newest
// run never reports. GitHub's rollup state was FAILURE.
const tokenMax = {
	runs: [
		workflowRun(1, "2026-11-12T23:39:32Z"),
		workflowRun(2, "2026-11-12T23:39:42Z"),
		workflowRun(3, "2026-11-12T23:42:53Z"),
		workflowRun(4, "2026-11-12T23:42:56Z"),
	],
	contexts: [
		job("Tests (${{ matrix.os }})", 11, "SKIPPED", 10),
		job("Check", 12, "FAILURE", 10),
		job("Tests (${{ matrix.os }})", 21, "SKIPPED", 20),
		job("Check", 22, "FAILURE", 20),
		job("Tests (${{ matrix.os }})", 31, "CANCELLED", 30),
		job("Check", 32, "FAILURE", 30),
		job("Tests (macos-15)", 41, "SUCCESS", 40),
		job("Check", 42, "SUCCESS", 40),
	],
};

test("a cancelled check drops once a newer run of its workflow exists, as on kixelated/token-max's daaaadc", () => {
	expect(checksState(latestContexts(tokenMax.contexts))).toBe("FAILURE");
	const current = currentContexts(tokenMax.contexts, tokenMax.runs);
	expect(current.map((context) => context.databaseId)).toEqual([41, 42]);
	expect(checksState(current)).toBe("SUCCESS");
});

test("a cancelled check counts while nothing replaced its run, and other results always count", () => {
	const contexts = [job("test", 1, "CANCELLED", 10), job("lint", 2, "FAILURE", 10), job("build", 3, "CANCELLED", 20)];
	// Run 2 is another workflow, so it replaces nothing of run 1's.
	expect(
		checksState(
			currentContexts(contexts, [
				workflowRun(1, "2026-11-12T10:00:00Z"),
				workflowRun(2, "2026-11-12T11:00:00Z", 2),
			]),
		),
	).toBe("FAILURE");
	const replaced = currentContexts(contexts, [
		workflowRun(1, "2026-11-12T10:00:00Z"),
		workflowRun(9, "2026-11-12T11:00:00Z"),
	]);
	expect(replaced.map((context) => context.name)).toEqual(["lint", "build"]);
	// Another app's cancelled check has no workflow run to be replaced by.
	expect(currentContexts([run("deploy", 1, "CANCELLED", 99)], [workflowRun(1, "2026-11-12T10:00:00Z")])).toHaveLength(
		1,
	);
});

test("a rerun is newer than every run that started before its latest attempt", () => {
	// Run 1 was rerun after run 2 started, and its rerun cancelled run 2.
	const runs = [workflowRun(1, "2026-11-12T12:00:00Z"), workflowRun(2, "2026-11-12T11:00:00Z")];
	// The rerun reports anew, after the run it cancelled.
	const contexts = [job("test", 2, "CANCELLED", 20), job("test", 3, "SUCCESS", 10)];
	expect(currentContexts(contexts, runs)).toEqual([contexts[1]]);
	// Runs that started in the same second order by ID.
	const tied = [workflowRun(1, "2026-11-12T12:00:00Z"), workflowRun(2, "2026-11-12T12:00:00Z")];
	expect(currentContexts([job("test", 1, "CANCELLED", 10)], tied)).toEqual([]);
	expect(currentContexts([job("test", 1, "CANCELLED", 20)], tied)).toHaveLength(1);
});

test("a job keeps its latest report per workflow file, so another workflow's same-named job never hides it", () => {
	const inWorkflow = (databaseId: number, conclusion: string, repositoryName: string, path: string) => ({
		...run("build", databaseId, conclusion),
		checkSuite: { databaseId, app: { databaseId: ACTIONS }, workflowRun: { file: { path, repositoryName } } },
	});
	const ci = inWorkflow(1, "FAILURE", "example/project", ".github/workflows/ci.yml");
	const docs = inWorkflow(2, "SUCCESS", "example/project", ".github/workflows/docs.yml");
	const policy = inWorkflow(3, "SUCCESS", "example/policies", ".github/workflows/ci.yml");
	expect(latestContexts([ci, docs, policy])).toEqual([ci, docs, policy]);
	expect(checksState(latestContexts([ci, docs, policy]))).toBe("FAILURE");
	// A rerun in the same workflow still supersedes.
	const rerun = inWorkflow(4, "SUCCESS", "example/project", ".github/workflows/ci.yml");
	expect(latestContexts([ci, rerun])).toEqual([rerun]);
});
