// `quest land watch` against a fake of the GitHub records it reads: merge queue events and `merge_group` builds.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import type { GitHubDependencies } from "../src/cli/github";
import { jobsSection, readRemoval, SETTLE, watchPass } from "../src/cli/land-watch";
import { tempDir } from "./fixture";

const REPOSITORY = { owner: "upstream", repo: "project" };
const BASE = "b".repeat(40);
/** The base the merge group was built on, which its branch names. */
const BUILT = "c".repeat(40);
const HEAD = "a".repeat(40);
const PUSHED = "d".repeat(40);
const APP = "moq-bot";

interface Removed {
	id: string;
	createdAt: string;
	reason: string;
	actor: string;
	enqueuer?: string;
	before?: string | null;
}
interface Added {
	createdAt: string;
	actor: string;
}
interface Pull {
	number: number;
	head: string;
	removals: Removed[];
	enqueues: Added[];
}
interface Job {
	id: number;
	name: string;
	status: string;
	conclusion: string | null;
	steps?: { name: string; conclusion: string | null }[];
	log?: string;
}
interface Run {
	id: number;
	name: string;
	head_branch: string;
	head_sha: string;
	created_at: string;
	conclusion: string | null;
	jobs: Job[];
}
interface World {
	pulls: Pull[];
	runs: Run[];
	comments: Record<number, { user: { login: string }; body: string }[]>;
	/** Requests the fake answered, as `METHOD path`. */
	requests: string[];
	now: number;
}

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 1, 12, minutes)).toISOString().replace(".000", "");

function world(pulls: Pull[], runs: Run[] = []): World {
	return { pulls, runs, comments: {}, requests: [], now: Date.parse(at(0)) };
}

function removalNode(event: Removed) {
	return {
		id: event.id,
		createdAt: event.createdAt,
		reason: event.reason,
		actor: { login: event.actor },
		enqueuer: event.enqueuer === undefined ? { login: "maintainer" } : { login: event.enqueuer },
		beforeCommit: event.before === null ? null : { oid: event.before ?? HEAD },
	};
}

/** Removals since `since`, paged two at a time so a PR's further pages are read by node. */
function removalPage(pull: Pull, since: string, after: unknown) {
	const all = pull.removals.filter((event) => event.createdAt >= since);
	const start = typeof after === "string" ? Number(after) : 0;
	const end = Math.min(start + 2, all.length);
	return {
		nodes: all.slice(start, end).map(removalNode),
		pageInfo: { hasNextPage: end < all.length, endCursor: String(end) },
	};
}

function deps(world: World): GitHubDependencies {
	return {
		token: "fake",
		now: () => world.now,
		sleep: async () => {},
		warn: () => {},
		fetch: (async (input, init) => {
			const url = new URL(String(input));
			const path = url.pathname;
			world.requests.push(`${init?.method ?? "GET"} ${path}`);
			if (path === "/graphql") {
				const { query, variables } = JSON.parse(String(init?.body));
				if (query.includes("viewer")) return Response.json({ data: { viewer: { login: `${APP}[bot]` } } });
				if (query.includes("defaultBranchRef"))
					return Response.json({ data: { repository: { defaultBranchRef: { name: "main" } } } });
				if (query.includes("ADDED_TO_MERGE_QUEUE_EVENT")) {
					const pull = world.pulls.find((item) => `PR_${item.number}` === variables.id)!;
					const nodes = pull.enqueues.map((event) => ({
						createdAt: event.createdAt,
						actor: { login: event.actor },
						enqueuer: { login: event.actor === APP ? `${APP}[bot]` : event.actor },
					}));
					return Response.json({ data: { node: { timelineItems: { nodes } } } });
				}
				if (query.includes("node(id: $id)")) {
					const pull = world.pulls.find((item) => `PR_${item.number}` === variables.id)!;
					return Response.json({
						data: { node: { removals: removalPage(pull, variables.since, variables.after) } },
					});
				}
				if (query.includes("pullRequests(states: OPEN")) {
					expect(variables.base).toBe("main");
					return Response.json({
						data: {
							repository: {
								ref: { target: { oid: BASE } },
								pullRequests: {
									nodes: world.pulls.map((pull) => ({
										id: `PR_${pull.number}`,
										number: pull.number,
										url: `https://github.com/upstream/project/pull/${pull.number}`,
										title: `PR ${pull.number}`,
										headRefOid: pull.head,
										headRefName: `branch-${pull.number}`,
										maintainerCanModify: false,
										headRepository: { nameWithOwner: "upstream/project" },
										removals: removalPage(pull, variables.since, null),
									})),
									pageInfo: { hasNextPage: false, endCursor: null },
								},
							},
						},
					});
				}
				throw new Error(`unexpected query: ${query}`);
			}
			if (path === "/repos/upstream/project/actions/runs") {
				expect(url.searchParams.get("event")).toBe("merge_group");
				const [from, to] = url.searchParams.get("created")!.split("..");
				return Response.json({
					workflow_runs: world.runs
						.filter((run) => run.created_at >= from && run.created_at <= to)
						.map(({ jobs: _, ...run }) => ({ ...run, status: "completed" })),
				});
			}
			const jobs = /^\/repos\/upstream\/project\/actions\/runs\/(\d+)\/jobs$/.exec(path);
			if (jobs) {
				// Two jobs a page, so a failing job past the first page is read only by following its link.
				const run = world.runs.find((item) => item.id === Number(jobs[1]))!;
				const page = Number(url.searchParams.get("page") ?? 1);
				const more = run.jobs.length > page * 2;
				return Response.json(
					{
						jobs: run.jobs.slice((page - 1) * 2, page * 2).map(({ log: _, ...job }) => ({
							...job,
							html_url: `https://github.com/upstream/project/actions/runs/${run.id}/job/${job.id}`,
						})),
					},
					more ? { headers: { Link: `<https://api.github.com${path}?page=${page + 1}>; rel="next"` } } : {},
				);
			}
			const logs = /^\/repos\/upstream\/project\/actions\/jobs\/(\d+)\/logs$/.exec(path);
			if (logs) {
				const job = world.runs.flatMap((run) => run.jobs).find((item) => item.id === Number(logs[1]));
				return job?.log === undefined ? new Response("missing", { status: 404 }) : new Response(job.log);
			}
			const comments = /^\/repos\/upstream\/project\/issues\/(\d+)\/comments$/.exec(path);
			if (comments) {
				const list = (world.comments[Number(comments[1])] ??= []);
				if (init?.method === "POST") {
					const comment = { user: { login: `${APP}[bot]` }, body: JSON.parse(String(init.body)).body };
					list.push(comment);
					return Response.json(comment, { status: 201 });
				}
				return Response.json(list);
			}
			throw new Error(`unexpected request: ${path}`);
		}) as typeof fetch,
	};
}

const failedRun = (number: number, created: string): Run => ({
	id: 7,
	name: "Check",
	head_branch: `gh-readonly-queue/main/pr-${number}-${BUILT}`,
	head_sha: "e".repeat(40),
	created_at: created,
	conclusion: "failure",
	jobs: [
		{ id: 68, name: "fmt", status: "completed", conclusion: "success", log: "fine" },
		{ id: 69, name: "build", status: "completed", conclusion: "skipped", log: "fine" },
		{ id: 70, name: "lint", status: "completed", conclusion: "success", log: "fine" },
		{
			id: 71,
			name: "test",
			status: "completed",
			conclusion: "failure",
			steps: [
				{ name: "Set up job", conclusion: "success" },
				{ name: "just test", conclusion: "failure" },
			],
			log: "﻿2026-11-01T12:03:00.1234567Z running tests\n2026-11-01T12:04:00.1234567Z FAIL queue.test.ts\n",
		},
	],
});

test("a failed merge_group build is commented with its failing job's log and recorded for the fixer", async () => {
	const state = tempDir();
	const github = world(
		[
			{
				number: 5,
				head: HEAD,
				enqueues: [
					{ createdAt: at(1), actor: "maintainer" },
					// The App re-enqueuing a fix continues the maintainer's pick.
					{ createdAt: at(2), actor: APP },
				],
				removals: [{ id: "R1", createdAt: at(5), reason: "failed_checks", actor: "github-merge-queue" }],
			},
		],
		[failedRun(5, at(3)), { ...failedRun(5, at(6)), id: 8, conclusion: "success", jobs: [] }],
	);
	expect(await watchPass(REPOSITORY, { state }, deps(github))).toEqual(["removed 5 failed_checks fix"]);

	const [comment] = github.comments[5];
	expect(github.comments[5]).toHaveLength(1);
	expect(comment.body).toContain(`removed this pull request at ${HEAD} because its \`merge_group\` build failed`);
	expect(comment.body).toContain("`Check / test`");
	expect(comment.body).toContain("at step `just test`");
	expect(comment.body).toContain("<pre>running tests\nFAIL queue.test.ts</pre>");
	expect(comment.body).not.toContain("lint");
	expect(comment.body).toContain(`<!-- quest land fixer: ${at(1)} removed R1 -->`);

	const removal = readRemoval(state, 5)!;
	expect(removal).toMatchObject({
		event: "R1",
		reason: "failed_checks",
		verdict: "fix",
		head: HEAD,
		pick: { by: "maintainer", at: at(1) },
		jobs: [{ workflow: "Check", name: "test", conclusion: "failure", step: "just test" }],
	});
	expect(removal.failure).toMatchObject({
		plan: { repository: "upstream/project", base: { ref: "main", sha: BUILT } },
		numbers: [5],
		blame: [5],
		tip: HEAD,
		reason: "failed_checks",
		log: removal.log,
	});
	expect(removal.failure!.plan.queue[0]).toMatchObject({ number: 5, head: HEAD, enabledAt: at(1) });
	expect(readFileSync(removal.log, "utf8")).toContain("== Check / test: failure at step just test");
	expect(readFileSync(removal.log, "utf8")).toContain("FAIL queue.test.ts");
});

test("a restart neither repeats nor misses a removal", async () => {
	const state = tempDir();
	const pull: Pull = {
		number: 3,
		head: HEAD,
		enqueues: [{ createdAt: at(1), actor: "maintainer" }],
		removals: [{ id: "R1", createdAt: at(2), reason: "merge_conflict", actor: "github-merge-queue", before: null }],
	};
	const github = world([pull]);
	github.now = Date.parse(at(3));
	expect(await watchPass(REPOSITORY, { state }, deps(github))).toEqual(["removed 3 merge_conflict fix"]);
	expect(readRemoval(state, 3)!.failure).toMatchObject({
		reason: "merge_conflict",
		plan: { base: { sha: BASE } },
	});

	// A second daemon, as after a restart, finds nothing new.
	github.now = Date.parse(at(4));
	expect(await watchPass(REPOSITORY, { state }, deps(github))).toEqual([]);

	// Removals while the daemon was down, more than a page of them, are each handled once.
	pull.enqueues.push({ createdAt: at(30), actor: "maintainer" });
	pull.removals.push(
		{ id: "R2", createdAt: at(40), reason: "manual", actor: "maintainer" },
		{ id: "R3", createdAt: at(40), reason: "merged", actor: "github-merge-queue" },
		{ id: "R4", createdAt: at(50), reason: "merge_conflict", actor: "github-merge-queue", before: null },
	);
	github.now = Date.parse(at(55));
	expect(await watchPass(REPOSITORY, { state }, deps(github))).toEqual([
		"removed 3 manual removed",
		"removed 3 merge_conflict fix",
	]);
	expect(github.comments[3]).toHaveLength(3);
	expect(github.comments[3][1].body).toContain("`maintainer` removed it");
	expect(github.comments[3][1].body).toContain("A person's removal ends the pick");
	expect(readRemoval(state, 3)).toMatchObject({ event: "R4", pick: { at: at(30) } });
	expect(github.requests.some((request) => request.endsWith("/actions/runs"))).toBe(false);

	github.now = Date.parse(at(56));
	expect(await watchPass(REPOSITORY, { state }, deps(github))).toEqual([]);
	expect(github.comments[3]).toHaveLength(3);
});

test("a removal GitHub shows late, after a newer one, is still handled once", async () => {
	const state = tempDir();
	const pull: Pull = {
		number: 11,
		head: HEAD,
		enqueues: [{ createdAt: at(1), actor: "maintainer" }],
		removals: [{ id: "R2", createdAt: at(5), reason: "merge_conflict", actor: "github-merge-queue", before: null }],
	};
	const github = world([pull]);
	github.now = Date.parse(at(6));
	expect(await watchPass(REPOSITORY, { state }, deps(github))).toEqual(["removed 11 merge_conflict fix"]);
	pull.removals.unshift({ id: "R1", createdAt: at(3), reason: "manual", actor: "maintainer" });
	github.now = Date.parse(at(7));
	expect(await watchPass(REPOSITORY, { state }, deps(github))).toEqual(["removed 11 manual removed"]);
	// The record keeps the newer removal.
	expect(readRemoval(state, 11)).toMatchObject({ event: "R2" });
	github.now = Date.parse(at(8));
	expect(await watchPass(REPOSITORY, { state }, deps(github))).toEqual([]);
	expect(github.comments[11]).toHaveLength(2);
	// Once a removal is out of every later pass's window, it is forgotten.
	github.now = Date.parse(at(5)) + SETTLE + 2 * 60_000;
	await watchPass(REPOSITORY, { state }, deps(github));
	github.now += 60_000;
	await watchPass(REPOSITORY, { state }, deps(github));
	expect(JSON.parse(readFileSync(join(state, "watch.json"), "utf8")).handled).toEqual({});
});

test("a comment already posted before a crash is not posted again", async () => {
	const state = tempDir();
	const github = world([
		{
			number: 4,
			head: HEAD,
			enqueues: [{ createdAt: at(1), actor: "maintainer" }],
			removals: [
				{ id: "R1", createdAt: at(2), reason: "merge_conflict", actor: "github-merge-queue", before: null },
			],
		},
	]);
	await watchPass(REPOSITORY, { state }, deps(github));
	// The daemon died after commenting, before it recorded the removal as handled.
	writeFileSync(join(state, "watch.json"), JSON.stringify({ since: at(0), handled: {} }));
	expect(await watchPass(REPOSITORY, { state }, deps(github))).toEqual(["removed 4 merge_conflict fix"]);
	expect(github.comments[4]).toHaveLength(1);
});

test("a push since the removal ends the pick, and merges and the App's own removals say nothing", async () => {
	const state = tempDir();
	const github = world(
		[
			{
				number: 6,
				head: PUSHED,
				enqueues: [{ createdAt: at(1), actor: "maintainer" }],
				removals: [{ id: "R1", createdAt: at(5), reason: "failed_checks", actor: "github-merge-queue" }],
			},
			{
				number: 7,
				head: HEAD,
				enqueues: [{ createdAt: at(1), actor: APP }],
				removals: [
					{ id: "R2", createdAt: at(2), reason: "manual", actor: APP },
					{ id: "R3", createdAt: at(3), reason: "merged", actor: "github-merge-queue" },
				],
			},
			{
				number: 8,
				head: HEAD,
				enqueues: [{ createdAt: at(1), actor: "maintainer" }],
				removals: [{ id: "R4", createdAt: at(2), reason: "queue_cleared", actor: "github-merge-queue" }],
			},
		],
		[failedRun(6, at(3))],
	);
	expect(await watchPass(REPOSITORY, { state }, deps(github))).toEqual([
		"removed 6 failed_checks pushed",
		"removed 8 queue_cleared unrecognized",
	]);
	expect(github.comments[6][0].body).toContain(`Its head has moved to ${PUSHED} since`);
	expect(github.comments[6][0].body).toContain("FAIL queue.test.ts");
	expect(readRemoval(state, 6)!.failure).toBeUndefined();
	expect(github.comments[7]).toBeUndefined();
	expect(readRemoval(state, 7)).toBeUndefined();
	expect(github.comments[8][0].body).toContain("because of `queue_cleared`");
	expect(github.comments[8][0].body).toContain("does not recognize this reason");
});

test("a failed build with no failing job found, or a job with no log, still comments", async () => {
	const state = tempDir();
	const run = failedRun(9, at(3));
	delete run.jobs.find((job) => job.name === "test")!.log;
	const github = world(
		[
			{
				number: 9,
				head: HEAD,
				enqueues: [{ createdAt: at(1), actor: "maintainer" }],
				removals: [{ id: "R1", createdAt: at(5), reason: "failed_checks", actor: "github-merge-queue" }],
			},
			{
				number: 10,
				head: HEAD,
				enqueues: [{ createdAt: at(1), actor: "maintainer" }],
				removals: [{ id: "R2", createdAt: at(5), reason: "checks_timed_out", actor: "github-merge-queue" }],
			},
		],
		[
			run,
			{
				...failedRun(10, at(2)),
				id: 9,
				conclusion: null,
				jobs: [{ id: 90, name: "build", status: "in_progress", conclusion: null }],
			},
		],
	);
	await watchPass(REPOSITORY, { state }, deps(github));
	expect(github.comments[9][0].body).toContain("GitHub has no log for this job: HTTP 404");
	expect(github.comments[10][0].body).toContain("checks timed out");
	expect(github.comments[10][0].body).toContain("`Check / build` ([job]");
	expect(github.comments[10][0].body).toContain("in_progress.");
	expect(readRemoval(state, 10)).toMatchObject({ verdict: "fix", jobs: [{ conclusion: "in_progress" }] });
	expect(github.requests.filter((request) => request.includes("/actions/jobs/90/logs"))).toEqual([]);
});

test("the first pass reads removals from SETTLE before it, and forgets closed PRs", async () => {
	const state = tempDir();
	const pull: Pull = {
		number: 2,
		head: HEAD,
		enqueues: [{ createdAt: at(1), actor: "maintainer" }],
		removals: [
			{ id: "OLD", createdAt: at(1), reason: "manual", actor: "maintainer" },
			{ id: "R1", createdAt: at(20), reason: "manual", actor: "maintainer" },
		],
	};
	const github = world([pull]);
	// The first pass reads back to SETTLE before it: R1, but not OLD.
	github.now = Date.parse(at(20)) + SETTLE - 60_000;
	expect(await watchPass(REPOSITORY, { state }, deps(github))).toEqual(["removed 2 manual removed"]);
	expect(JSON.parse(readFileSync(join(state, "watch.json"), "utf8")).handled).toHaveProperty("2");
	github.pulls = [];
	await watchPass(REPOSITORY, { state }, deps(github));
	expect(JSON.parse(readFileSync(join(state, "watch.json"), "utf8")).handled).toEqual({});
});

test("failing jobs that do not fit the comment are counted instead", () => {
	expect(jobsSection(["a".repeat(50), "b".repeat(50)], 1000)).toBe("a".repeat(50) + "b".repeat(50));
	const cut = jobsSection(["a".repeat(500), "b".repeat(500), "c"], 800);
	expect(cut).toBe(`${"a".repeat(500)}\n\n2 more failing jobs do not fit in this comment.`);
	expect(cut.length).toBeLessThanOrEqual(800);
});
