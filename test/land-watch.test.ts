// `quest land watch` against a fake of the GitHub records it reads: merge queue events and `merge_group` builds.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, test, vi } from "vitest";

import type { GitHubDependencies } from "../src/cli/github";
import { readRemote } from "../src/cli/land";
import { COLLECTION_ATTEMPTS, FLAKY_LIMIT, history } from "../src/cli/land-fixer";
import { privateRepository } from "../src/cli/land-serve";
import { jobsSection, readRemoval, SETTLE, watchPass, watchPermissions } from "../src/cli/land-watch";
import type { FixContext } from "../src/cli/land-watch-fix";
import { configure, GIT_SETTINGS, initRepository, tempDir } from "./fixture";

// The fixer tests merge with the quest driver and run fixer wrappers, which take longer than vitest's default.
vi.setConfig({ testTimeout: 30_000 });

const REPOSITORY = { owner: "upstream", repo: "project" };
const BASE = "b".repeat(40);
/** The base the merge group was built on, which its branch names. */
const BUILT = "c".repeat(40);
const HEAD = "a".repeat(40);
/** A merge group commit, which a removal names as its `beforeCommit`. */
const GROUP = "9".repeat(40);
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
	/** Its head, unless the world has an upstream repository, where its branch holds it. */
	head: string;
	removals: Removed[];
	enqueues: Added[];
	state?: string;
	/** `mergeStateStatus`, CLEAN by default. */
	mergeState?: string;
	/** Its base branch, main by default. */
	base?: string;
	/** When it joined the merge queue, while it is in it. */
	queued?: string;
	/** When auto-merge was armed, while it is. */
	armed?: string;
	body?: string;
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
	/** Each mutation, as `name number head`. */
	mutations: string[];
	now: number;
	/** The upstream repository that holds each PR's branch, `branch-<number>`. */
	origin?: string;
	/** A comment GitHub refuses to post, once. */
	refuse?: (body: string) => boolean;
	/** A read of a PR's queue state that fails, once. */
	unreadable?: (pull: Pull) => boolean;
	/** PRs whose push activity GitHub has not listed yet. */
	unlisted?: number[];
}

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 1, 12, minutes)).toISOString().replace(".000", "");

function world(pulls: Pull[], runs: Run[] = []): World {
	return { pulls, runs, comments: {}, requests: [], mutations: [], now: Date.parse(at(0)) };
}

/** A PR's head: its branch in the upstream repository, when the world has one. */
function headOf(world: World, pull: Pull): string {
	return world.origin ? git(world.origin, "rev-parse", `refs/heads/branch-${pull.number}`) : pull.head;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function removalNode(event: Removed) {
	return {
		id: event.id,
		createdAt: event.createdAt,
		reason: event.reason,
		actor: { login: event.actor },
		enqueuer: event.enqueuer === undefined ? { login: "maintainer" } : { login: event.enqueuer },
		// GitHub's `beforeCommit` is the merge group's commit on the base, never the PR's head.
		beforeCommit: event.before === null ? null : { oid: GROUP },
	};
}

/**
 * The head branch's push activity, newest first, as GitHub's `/activity` lists it. Each removal's
 * dropped head (`before`) was pushed a second before the enqueue that preceded the removal; a current
 * head that is none of them was pushed after the last removal, as a push that ends the pick is.
 */
function pushes(world: World, pull: Pull) {
	const rows: { activity_type: string; after: string; timestamp: string }[] = [];
	const stamp = (time: number) => new Date(time).toISOString().replace(".000", "");
	for (const event of pull.removals) {
		const enqueued = pull.enqueues.filter((added) => added.createdAt <= event.createdAt).at(-1)?.createdAt;
		const time = Date.parse(enqueued ?? event.createdAt) - 1000;
		rows.push({ activity_type: "push", after: event.before ?? HEAD, timestamp: stamp(time) });
	}
	const current = headOf(world, pull);
	if (!rows.some((row) => row.after === current)) {
		const last = Math.max(Date.parse(at(-100)), ...pull.removals.map((event) => Date.parse(event.createdAt)));
		rows.push({ activity_type: "push", after: current, timestamp: stamp(last + 1000) });
	}
	return rows.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
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
				const pullOf = () => world.pulls.find((item) => `PR_${item.number}` === variables.id)!;
				const mutation = /^\s*mutation[^{]*\{\s*(\w+)/.exec(query)?.[1];
				if (mutation === "enqueuePullRequest" || mutation === "enablePullRequestAutoMerge") {
					const pull = pullOf();
					world.mutations.push(`${mutation} ${pull.number} ${variables.sha}`);
					if (variables.sha !== headOf(world, pull))
						return Response.json({ errors: [{ type: "UNPROCESSABLE", message: "head moved" }] });
					const now = new Date(world.now).toISOString().replace(".000", "");
					if (mutation === "enablePullRequestAutoMerge") pull.armed = now;
					else {
						pull.queued = now;
						pull.enqueues.push({ createdAt: now, actor: APP });
					}
					return Response.json({ data: { [mutation]: { clientMutationId: null } } });
				}
				if (query.includes("mergeStateStatus")) {
					const pull = pullOf();
					if (world.unreadable?.(pull)) {
						world.unreadable = undefined;
						return Response.json({ errors: [{ type: "INTERNAL", message: "unavailable" }] });
					}
					return Response.json({
						data: {
							node: {
								state: pull.state ?? "OPEN",
								baseRefName: pull.base ?? "main",
								headRefOid: headOf(world, pull),
								mergeStateStatus: pull.mergeState ?? "CLEAN",
								mergeQueueEntry: pull.queued ? { enqueuedAt: pull.queued } : null,
								autoMergeRequest: pull.armed ? { enabledAt: pull.armed } : null,
							},
						},
					});
				}
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
								ref: {
									target: {
										oid: world.origin ? git(world.origin, "rev-parse", "refs/heads/main") : BASE,
									},
								},
								pullRequests: {
									nodes: world.pulls.map((pull) => ({
										id: `PR_${pull.number}`,
										number: pull.number,
										url: `https://github.com/upstream/project/pull/${pull.number}`,
										title: `PR ${pull.number}`,
										headRefOid: headOf(world, pull),
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
			const pullPath = /^\/repos\/upstream\/project\/pulls\/(\d+)$/.exec(path);
			if (pullPath) {
				const pull = world.pulls.find((item) => item.number === Number(pullPath[1]))!;
				if (init?.method === "PATCH") pull.body = JSON.parse(String(init.body)).body;
				return Response.json({
					number: pull.number,
					head: { sha: headOf(world, pull) },
					body: pull.body ?? "",
				});
			}
			const comments = /^\/repos\/upstream\/project\/issues\/(\d+)\/comments$/.exec(path);
			if (comments) {
				const list = (world.comments[Number(comments[1])] ??= []);
				if (init?.method === "POST") {
					const comment = { user: { login: `${APP}[bot]` }, body: JSON.parse(String(init.body)).body };
					if (world.refuse?.(comment.body)) {
						world.refuse = undefined;
						return Response.json({ message: "refused" }, { status: 422 });
					}
					list.push(comment);
					return Response.json(comment, { status: 201 });
				}
				return Response.json(list);
			}
			const activity = /^\/repos\/upstream\/project\/activity$/.exec(path);
			if (activity) {
				const pull = world.pulls.find((item) => `branch-${item.number}` === url.searchParams.get("ref"))!;
				return Response.json(world.unlisted?.includes(pull.number) ? [] : pushes(world, pull));
			}
			throw new Error(`unexpected request: ${path}`);
		}) as typeof fetch,
	};
}

const failedRun = (number: number, created: string, built = BUILT): Run => ({
	id: 7,
	name: "Check",
	head_branch: `gh-readonly-queue/main/pr-${number}-${built}`,
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
	// The watcher put HEAD back in the queue in an earlier round of the maintainer's pick.
	writeFileSync(
		join(state, "fix-attempt-5.json"),
		JSON.stringify({
			pick: at(1),
			rounds: [{ job: "watch-job-1.json", outcome: "flaky", before: HEAD, after: HEAD, failure: "just test" }],
		}),
	);
	const github = world(
		[
			{
				number: 5,
				head: HEAD,
				enqueues: [
					{ createdAt: at(1), actor: "maintainer" },
					// The App re-enqueuing that head continues the maintainer's pick.
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

test("a removal whose enqueued head GitHub has not listed waits, then ends the pick unfixed", async () => {
	const state = tempDir();
	const github = world(
		[
			{
				number: 6,
				head: HEAD,
				enqueues: [{ createdAt: at(1), actor: "maintainer" }],
				removals: [{ id: "R1", createdAt: at(5), reason: "failed_checks", actor: "github-merge-queue" }],
			},
		],
		[failedRun(6, at(3))],
	);
	github.unlisted = [6];
	github.now = Date.parse(at(6));
	// Not handled yet: no comment, no record, and the next pass reads it again.
	expect(await watchPass(REPOSITORY, { state }, deps(github))).toEqual([]);
	expect(github.comments[6]).toBeUndefined();
	expect(readRemoval(state, 6)).toBeUndefined();
	github.now = Date.parse(at(14));
	expect(await watchPass(REPOSITORY, { state }, deps(github))).toEqual(["removed 6 failed_checks unknown"]);
	expect(github.comments[6][0].body).toContain("cannot tell which head entered the queue");
	expect(readRemoval(state, 6)!.failure).toBeUndefined();
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

test("the watcher's tokens ask for writes only with a fixer, and pushes for workflows only when they carry one", () => {
	expect(watchPermissions(false)).toEqual({ api: { contents: "read", pull_requests: "write", actions: "read" } });
	expect(watchPermissions(true)).toEqual({
		api: { contents: "write", pull_requests: "write", actions: "read", merge_queues: "write" },
		push: { contents: "write", pull_requests: "write" },
		pushWorkflows: { contents: "write", pull_requests: "write", workflows: "write" },
		read: { contents: "read" },
	});
});

test("failing jobs that do not fit the comment are counted instead", () => {
	expect(jobsSection(["a".repeat(50), "b".repeat(50)], 1000)).toBe("a".repeat(50) + "b".repeat(50));
	const cut = jobsSection(["a".repeat(500), "b".repeat(500), "c"], 800);
	expect(cut).toBe(`${"a".repeat(500)}\n\n2 more failing jobs do not fit in this comment.`);
	expect(cut.length).toBeLessThanOrEqual(800);
});

const bin = fileURLToPath(new URL("../src/cli/bin.ts", import.meta.url));
const bunfig = fileURLToPath(new URL("../bunfig.toml", import.meta.url));
const PATH = process.env.PATH;

const EPIC = (entries: string[]) =>
	`# Epic\n\n## Goal\n\nAn epic.\n\n## Required\n\n${entries.map((entry) => `- [${entry}](/quest/m0/${entry}.md)`).join("\n")}\n`;

/** github.com's `upstream/project` on disk: main, and each PR's branch `branch-<n>`, also at `refs/pull/<n>/head`. */
function upstream() {
	const dir = tempDir();
	const hub = join(dir, "github");
	const origin = initRepository(join(hub, "upstream", "project.git"), { bare: true });
	const work = initRepository(join(dir, "work"));
	const commit = (files: Record<string, string>, message: string) => {
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(join(work, path, ".."), { recursive: true });
			writeFileSync(join(work, path), content);
		}
		git(work, "add", ".");
		git(work, "commit", "--quiet", "-m", message);
		return git(work, "rev-parse", "HEAD");
	};
	commit(
		{
			".gitattributes": "quest/** merge=quest\n",
			"quest/README.md": "# Quests\n\n## Goal\n\nRoot.\n\n## Required\n\n- [M0](/quest/m0/README.md)\n",
			"quest/m0/README.md": EPIC(["a"]),
			"quest/m0/a.md": "# [S] A\n\n## Goal\n\nA.\n",
			"code.txt": "one\ntwo\nthree\n",
		},
		"base",
	);
	git(work, "push", "--quiet", origin, "HEAD:refs/heads/main");
	const main = () => git(origin, "rev-parse", "refs/heads/main");
	return {
		hub,
		origin,
		main,
		/** Open PR `number` on main as it is now. Returns its head. */
		pull(number: number, files: Record<string, string>): string {
			git(work, "checkout", "--quiet", "-B", `branch-${number}`, main());
			const head = commit(files, `PR ${number}`);
			git(
				work,
				"push",
				"--quiet",
				origin,
				`${head}:refs/heads/branch-${number}`,
				`${head}:refs/pull/${number}/head`,
			);
			return head;
		},
		/** A writer's push to PR `number`. */
		push(number: number, files: Record<string, string>): string {
			git(
				work,
				"checkout",
				"--quiet",
				"-B",
				`branch-${number}`,
				git(origin, "rev-parse", `refs/heads/branch-${number}`),
			);
			const head = commit(files, `more of PR ${number}`);
			git(work, "push", "--quiet", origin, `${head}:refs/heads/branch-${number}`);
			return head;
		},
		/** Land something else on main. Returns the new base. */
		advance(files: Record<string, string>): string {
			git(work, "checkout", "--quiet", "-B", "main", main());
			const head = commit(files, "advance main");
			git(work, "push", "--quiet", origin, "HEAD:refs/heads/main");
			return head;
		},
	};
}

/**
 * A fixer wrapper that runs `<tools>/round-<n>`, the test's script for the PR's next round, in the
 * fixer's checkout, recording each call's arguments and effort in `<tools>/calls`.
 */
function fixer(): {
	wrapper: string;
	tools: string;
	round: (number: number, script: string) => void;
	calls: () => string[];
} {
	const tools = tempDir();
	const wrapper = join(tools, "wrapper");
	writeFileSync(
		wrapper,
		`#!/bin/sh
set -eu
[ "$#" = 2 ]
printf '%s %s %s\\n' "$QUEST_LAND_FIXER_EFFORT" "$1" "$2" >> '${tools}/calls'
. '${tools}/round-'"$2"
`,
		{ mode: 0o755 },
	);
	return {
		wrapper,
		tools,
		round: (number, script) => writeFileSync(join(tools, `round-${number}`), script),
		calls: () =>
			existsSync(join(tools, "calls")) ? readFileSync(join(tools, "calls"), "utf8").trim().split("\n") : [],
	};
}

/** A fixer round that commits `file` on the PR's branch and reports it fixed, naming `failure`. */
const fixScript = (file: string, failure = "just test: queue.test.ts") => `git checkout -q "pr-$2"
printf 'fixed\\n' > '${file}'
git add '${file}'
git commit -qm 'mechanical fix'
printf '[{"number":%s,"action":"fixed","head":"%s","reason":"add the missing file","failure":"${failure}"}]' "$2" "$(git rev-parse HEAD)" > quest-land-result.json
`;
const flakyScript = `printf '[{"number":%s,"action":"requeue","reason":"healthy; flaky test","failure":"just test: render_timeout","comment":"render_timeout timed out under load."}]' "$2" > quest-land-result.json
`;

/** Wait for `count` fixer jobs to have exited. */
async function exited(state: string, count = 1): Promise<void> {
	for (let tries = 0; tries < 3000; tries++) {
		if (readdirSync(state).filter((name) => /^watch-job-.*\.json\.exit$/.test(name)).length >= count) return;
		await pause(10);
	}
	throw new Error("the fixer never exited");
}

// The fixer, like the daemon, needs Linux process identities.
describe.skipIf(process.platform === "win32")("the watcher's land fixer", () => {
	beforeEach(() => {
		// The merge driver runs `quest resolve` from PATH, as on the host.
		const tools = tempDir();
		writeFileSync(join(tools, "quest"), `#!/bin/sh\nexec bun --config='${bunfig}' '${bin}' "$@"\n`);
		chmodSync(join(tools, "quest"), 0o755);
		process.env.PATH = `${tools}:${PATH}`;
	});

	function setup(jobs = 2) {
		const repo = upstream();
		const state = tempDir();
		const root = privateRepository(state);
		configure(root, { [`url.${repo.hub}/.insteadOf`]: "https://github.com/", ...GIT_SETTINGS });
		const fix = fixer();
		const context: FixContext = {
			root,
			fixer: fix.wrapper,
			jobs,
			effort: "high",
			timeout: 60,
			token: async () => "token",
			read: readRemote,
		};
		return { repo, state, fix, context };
	}

	test("a failed build is fixed and re-enqueued, and the same failure right after the fix is handed back", async () => {
		const { repo, state, fix, context } = setup();
		const base = repo.main();
		const head = repo.pull(5, { "feature.txt": "new\n" });
		const pull: Pull = {
			number: 5,
			head,
			enqueues: [{ createdAt: at(1), actor: "maintainer" }],
			removals: [
				{ id: "R1", createdAt: at(5), reason: "failed_checks", actor: "github-merge-queue", before: head },
			],
			body: "A feature.\n\n## Review\n\nreviewed by Codex (head x)\n",
		};
		const github = { ...world([pull], [failedRun(5, at(3), base)]), origin: repo.origin };
		github.now = Date.parse(at(6));
		fix.round(5, fixScript("fixed.txt"));
		expect(await watchPass(REPOSITORY, { state }, deps(github), context)).toEqual([
			"removed 5 failed_checks fix",
			"fixing 5",
		]);
		expect(github.comments[5][0].body).toContain("The land fixer works on it in the background");
		await exited(state);
		// The wrapper got the removal's full log, the PR, and the effort.
		expect(fix.calls()).toEqual([`high ${readRemoval(state, 5)!.log} 5`]);

		github.now = Date.parse(at(10));
		// GitHub takes the head back, then fails the read that follows: the round may be in the queue, so it is
		// retried rather than handed back, and finds its own enqueue.
		github.unreadable = (pull) => pull.queued !== undefined;
		expect(await watchPass(REPOSITORY, { state }, deps(github), context)).toEqual([]);
		// Then GitHub refuses the outcome comment once: the round stays requeued, and only its comment is retried.
		github.refuse = (body) => body.includes("re-enqueued this pull request");
		expect(await watchPass(REPOSITORY, { state }, deps(github), context)).toEqual([]);
		const [line] = await watchPass(REPOSITORY, { state }, deps(github), context);
		const fixed = git(repo.origin, "rev-parse", "refs/heads/branch-5");
		expect(line).toBe(`requeued 5 ${fixed}`);
		expect(git(repo.origin, "rev-parse", `${fixed}^`)).toBe(head);
		expect(github.mutations).toEqual([`enqueuePullRequest 5 ${fixed}`]);
		expect(pull.body).toContain(`mechanical fix by Codex: \`add the missing file\` (head ${fixed})`);
		expect(github.comments[5].at(-1)!.body).toContain(
			`re-enqueued this pull request at ${fixed}, at the back of the merge queue`,
		);
		expect(history(state, 5)).toMatchObject({
			pick: at(1),
			rounds: [{ outcome: "fixed", before: head, after: fixed, failure: "just test: queue.test.ts" }],
		});
		// The job and its checkout are gone; the fixer's output log stays for diagnosis.
		expect(readdirSync(state).filter((name) => /^watch-job-.*\.json$|^fix-(?!attempt-)/.test(name))).toEqual([]);
		expect(readdirSync(state).filter((name) => name.endsWith(".json.log"))).toHaveLength(1);

		// The fixed head fails the same way: the App's re-enqueue continues the maintainer's pick, and the
		// fixer's second fix of the same failure is a repeat, handed back unpublished.
		pull.queued = undefined;
		pull.removals.push({
			id: "R2",
			createdAt: at(20),
			reason: "failed_checks",
			actor: "github-merge-queue",
			before: fixed,
		});
		github.runs.push({ ...failedRun(5, at(15), base), id: 8, head_sha: "f".repeat(40) });
		github.now = Date.parse(at(21));
		fix.round(5, fixScript("again.txt"));
		expect(await watchPass(REPOSITORY, { state }, deps(github), context)).toEqual([
			"removed 5 failed_checks fix",
			"fixing 5",
		]);
		expect(readRemoval(state, 5)!.pick).toEqual({ by: "maintainer", at: at(1) });
		await exited(state);
		expect(await watchPass(REPOSITORY, { state }, deps(github), context)).toEqual(["handback 5"]);
		expect(git(repo.origin, "rev-parse", "refs/heads/branch-5")).toBe(fixed);
		expect(github.mutations).toHaveLength(1);
		const handback = github.comments[5].at(-1)!.body;
		expect(handback).toContain("stop rule (repeated failure)");
		expect(handback).toContain("<!-- quest land: failed_checks -->");
		expect(history(state, 5)!.rounds.map((round) => round.outcome)).toEqual(["fixed", "handback"]);
		expect(history(state, 5)!.rounds[1].rule).toBe("repeated");
	});

	test("a quest-file conflict is merged with the quest driver, and a code conflict goes to the fixer", async () => {
		const { repo, state, fix, context } = setup(1);
		const quests = repo.pull(3, {
			"quest/m0/README.md": EPIC(["a", "c"]),
			"quest/m0/c.md": "# [S] C\n\n## Goal\n\nC.\n",
		});
		const code = repo.pull(4, { "code.txt": "one\nII\nthree\n" });
		const failing = repo.pull(6, { "feature.txt": "new\n" });
		const built = repo.main();
		const base = repo.advance({
			"quest/m0/README.md": EPIC(["a", "b"]),
			"quest/m0/b.md": "# [S] B\n\n## Goal\n\nB.\n",
			"code.txt": "one\n2\nthree\n",
		});
		const conflict = (number: number, head: string, minute: number): Pull => ({
			number,
			head,
			enqueues: [{ createdAt: at(1), actor: "maintainer" }],
			removals: [
				{
					id: `R${number}`,
					createdAt: at(minute),
					reason: "merge_conflict",
					actor: "github-merge-queue",
					before: head,
				},
			],
			// Its checks run again on the merge: auto-merge waits for them.
			mergeState: "BLOCKED",
		});
		const github = {
			...world(
				[
					conflict(3, quests, 4),
					conflict(4, code, 5),
					{
						number: 6,
						head: failing,
						enqueues: [{ createdAt: at(1), actor: "maintainer" }],
						removals: [
							{
								id: "R6",
								createdAt: at(6),
								reason: "failed_checks",
								actor: "github-merge-queue",
								before: failing,
							},
						],
					},
				],
				[failedRun(6, at(3), built)],
			),
			origin: repo.origin,
		};
		github.now = Date.parse(at(7));
		fix.round(
			4,
			`git checkout -q "pr-$2"
git merge -q base || true
printf 'one\\nII and 2\\nthree\\n' > code.txt
git add code.txt
git commit -qm 'preserve both sides'
printf '[{"number":%s,"action":"fixed","head":"%s","reason":"preserve both conflict sides"}]' "$2" "$(git rev-parse HEAD)" > quest-land-result.json
`,
		);
		fix.round(6, flakyScript);
		const merged = () => git(repo.origin, "rev-parse", "refs/heads/branch-3");
		const pull3Body = () => github.pulls.find((pull) => pull.number === 3)!.body;
		// One fixer slot: the quest-file conflict needs none, the code conflict takes it, and the failed build waits.
		expect(await watchPass(REPOSITORY, { state }, deps(github), context)).toEqual([
			"removed 3 merge_conflict fix",
			"removed 4 merge_conflict fix",
			"removed 6 failed_checks fix",
			`merged 3 ${merged()}`,
			"fixing 4",
			`requeued 3 ${merged()}`,
		]);
		expect(git(repo.origin, "show", `${merged()}:quest/m0/README.md`)).toBe(EPIC(["a", "b", "c"]).trim());
		expect(git(repo.origin, "rev-parse", `${merged()}^1`, `${merged()}^2`).split("\n")).toEqual([quests, base]);
		expect(github.mutations).toEqual([`enablePullRequestAutoMerge 3 ${merged()}`]);
		expect(github.comments[3].at(-1)!.body).toContain(
			`armed auto-merge on this pull request at ${merged()}, so it joins the back of the merge queue once its required checks pass, with main at ${base} merged in by the quest merge driver`,
		);
		expect(pull3Body()).toContain(
			`mechanical fix by quest land watch: \`merged main at ${base} with the quest merge driver\``,
		);
		expect(history(state, 3)!.rounds).toMatchObject([
			{ outcome: "merged", failure: `merge conflict with ${base}` },
		]);
		await exited(state);
		// The code conflict's fixer got the current base and the merge's conflict, never the build's base.
		const [call] = fix.calls();
		expect(call).toMatch(new RegExp(`^high .*/conflict-4-${base.slice(0, 12)}\\.log 4$`));
		expect(readFileSync(call.split(" ")[1], "utf8")).toContain("CONFLICT (content): Merge conflict in code.txt");

		github.now = Date.parse(at(8));
		const resolved = () => git(repo.origin, "rev-parse", "refs/heads/branch-4");
		expect(await watchPass(REPOSITORY, { state }, deps(github), context)).toEqual([
			`requeued 4 ${resolved()}`,
			"fixing 6",
		]);
		expect(git(repo.origin, "show", `${resolved()}:code.txt`)).toBe("one\nII and 2\nthree");
		await exited(state);
		expect(fix.calls()[1]).toBe(`high ${readRemoval(state, 6)!.log} 6`);
		expect(await watchPass(REPOSITORY, { state }, deps(github), context)).toEqual([`requeued 6 ${failing}`]);
		expect(github.mutations.slice(1)).toEqual([
			`enablePullRequestAutoMerge 4 ${resolved()}`,
			`enqueuePullRequest 6 ${failing}`,
		]);
		const [note, requeued] = github.comments[6].slice(-2).map((comment) => comment.body);
		expect(note).toContain("land fixer note:\n\n> render_timeout timed out under load.");
		expect(requeued).toContain(
			"unchanged, since the land fixer judged the failure flaky: `just test: render_timeout`",
		);
	});

	test("a Dependabot pick by the App is fixed like any other, until it is flaky three times in a row", async () => {
		const { repo, state, fix, context } = setup();
		const base = repo.main();
		const head = repo.pull(7, { "Cargo.lock": "bumped\n" });
		// Its workflow enqueues it with the App's token.
		const pull: Pull = { number: 7, head, enqueues: [{ createdAt: at(1), actor: APP }], removals: [] };
		const github = { ...world([pull], []), origin: repo.origin };
		fix.round(7, flakyScript);
		for (let round = 1; round <= FLAKY_LIMIT; round++) {
			const minute = round * 10;
			pull.queued = undefined;
			pull.removals.push({
				id: `R${round}`,
				createdAt: at(minute),
				reason: "failed_checks",
				actor: "github-merge-queue",
				before: head,
			});
			github.runs.push({ ...failedRun(7, at(minute - 2), base), id: round });
			github.now = Date.parse(at(minute + 1));
			expect(await watchPass(REPOSITORY, { state }, deps(github), context)).toEqual([
				"removed 7 failed_checks fix",
				"fixing 7",
			]);
			expect(readRemoval(state, 7)!.pick).toEqual({ by: `${APP}[bot]`, at: at(1) });
			await exited(state);
			github.now = Date.parse(at(minute + 2));
			expect(await watchPass(REPOSITORY, { state }, deps(github), context)).toEqual([
				round < FLAKY_LIMIT ? `requeued 7 ${head}` : "handback 7",
			]);
		}
		expect(github.mutations).toEqual([`enqueuePullRequest 7 ${head}`, `enqueuePullRequest 7 ${head}`]);
		expect(github.comments[7].at(-1)!.body).toContain("stop rule (flaky limit)");
		expect(history(state, 7)!.rounds.map((round) => round.outcome)).toEqual(["flaky", "flaky", "handback"]);

		// The handback ended the pick: the workflow's next enqueue, even of the same head, is a new one.
		pull.enqueues.push({ createdAt: at(50), actor: APP });
		pull.removals.push({
			id: "R9",
			createdAt: at(55),
			reason: "failed_checks",
			actor: "github-merge-queue",
			before: head,
		});
		github.now = Date.parse(at(56));
		expect(await watchPass(REPOSITORY, { state }, deps(github), context)).toEqual([
			"removed 7 failed_checks fix",
			"fixing 7",
		]);
		expect(readRemoval(state, 7)!.pick).toEqual({ by: `${APP}[bot]`, at: at(50) });
		expect(history(state, 7)).toEqual({ pick: at(50), rounds: [] });
		await exited(state);
	});

	test("a pick that ends while the fixer runs is left alone, and every handback ends the pick", async () => {
		const { repo, state, fix, context } = setup(5);
		const base = repo.main();
		const moved = repo.pull(8, { "feature.txt": "new\n" });
		const stuck = repo.pull(9, { "other.txt": "new\n" });
		const again = repo.pull(10, { "again.txt": "new\n" });
		const crashed = repo.pull(11, { "crash.txt": "new\n" });
		const retargeted = repo.pull(13, { "retarget.txt": "new\n" });
		const waiting = repo.pull(14, { "waiting.txt": "new\n" });
		const removed = (number: number, head: string): Pull => ({
			number,
			head,
			enqueues: [{ createdAt: at(1), actor: "maintainer" }],
			removals: [
				{
					id: `R${number}`,
					createdAt: at(5),
					reason: "failed_checks",
					actor: "github-merge-queue",
					before: head,
				},
			],
		});
		const pulls = [
			removed(8, moved),
			removed(9, stuck),
			removed(10, again),
			removed(11, crashed),
			removed(13, retargeted),
			// Retargeted before its fixer could start.
			{ ...removed(14, waiting), base: "release" },
		];
		const github = {
			...world(
				pulls,
				pulls.map((pull) => ({ ...failedRun(pull.number, at(3), base), id: pull.number })),
			),
			origin: repo.origin,
		};
		github.now = Date.parse(at(6));
		fix.round(8, fixScript("fixed.txt"));
		fix.round(
			9,
			`printf '[{"number":%s,"action":"handback","diagnosis":"the test asserts the old behavior","recommendation":"decide which behavior is right","log":[1,1]}]' "$2" > quest-land-result.json\n`,
		);
		fix.round(10, fixScript("fixed.txt"));
		fix.round(11, "echo 'agent crashed' >&2\nexit 3\n");
		fix.round(13, fixScript("fixed.txt"));
		expect(await watchPass(REPOSITORY, { state }, deps(github), context)).toEqual([
			"removed 8 failed_checks fix",
			"removed 9 failed_checks fix",
			"removed 10 failed_checks fix",
			"removed 11 failed_checks fix",
			"removed 13 failed_checks fix",
			"removed 14 failed_checks fix",
			"fixing 8",
			"fixing 9",
			"fixing 10",
			"fixing 11",
			"fixing 13",
			"dropped 14 retargeted",
		]);
		await exited(state, 5);
		// 13 was retargeted while its fixer ran.
		pulls[4].base = "release";
		// While the fixers ran, a writer pushed to 8, and a maintainer enqueued 10 again, which the queue
		// dropped again before the watcher collected the first round.
		const pushed = repo.push(8, { "feature.txt": "newer\n" });
		pulls[2].enqueues.push({ createdAt: at(7), actor: "maintainer" });
		pulls[2].removals.push({
			id: "R10b",
			createdAt: at(8),
			reason: "failed_checks",
			actor: "github-merge-queue",
			before: again,
		});
		github.runs.push({ ...failedRun(10, at(7), base), id: 100 });
		github.now = Date.parse(at(9));
		fix.round(10, flakyScript);
		expect((await watchPass(REPOSITORY, { state }, deps(github), context)).sort()).toEqual([
			"dropped 10 ended",
			"dropped 13 ended",
			"dropped 8 ended",
			"fixing 10",
			"handback 11",
			"handback 9",
			"removed 10 failed_checks fix",
		]);
		expect(git(repo.origin, "rev-parse", "refs/heads/branch-8")).toBe(pushed);
		expect(git(repo.origin, "rev-parse", "refs/heads/branch-10")).toBe(again);
		expect(github.mutations).toEqual([]);
		expect(github.comments[8].at(-1)!.body).toContain(`its head moved to ${pushed} while the fixer ran`);
		expect(github.comments[13].at(-1)!.body).toContain("it was retargeted to `release` while the fixer ran");
		expect(git(repo.origin, "rev-parse", "refs/heads/branch-13")).toBe(retargeted);
		expect(fix.calls().some((call) => call.endsWith(" 14"))).toBe(false);
		expect(github.comments[10].at(-1)!.body).toContain("the pick it was fixing ended");
		const handback = github.comments[9].at(-1)!.body;
		expect(handback).toContain(
			"Codex land fixer: `the test asserts the old behavior. Recommendation: decide which behavior is right`",
		);
		expect(handback).toContain("<pre>The merge queue removed");
		expect(history(state, 9)!.rounds).toMatchObject([{ outcome: "handback" }]);
		// A crash ends the pick too, with a round of its own.
		expect(github.comments[11].at(-1)!.body).toContain("fixer crashed (exit 3)");
		expect(history(state, 11)!.rounds).toMatchObject([
			{ outcome: "handback", before: crashed, failure: "Check / test: just test" },
		]);
		// The newer pick of 10 starts its own history and round; 8, 9 and 11 are not taken again.
		expect(history(state, 10)).toEqual({ pick: at(7), rounds: [] });
		await exited(state);
		github.now = Date.parse(at(10));
		expect(await watchPass(REPOSITORY, { state }, deps(github), context)).toEqual([`requeued 10 ${again}`]);
		expect(history(state, 10)!.rounds).toMatchObject([{ outcome: "flaky" }]);
		expect(await watchPass(REPOSITORY, { state }, deps(github), context)).toEqual([]);
	});

	test("a round whose handback GitHub keeps refusing is set aside, and frees its fixer slot", async () => {
		const { repo, state, fix, context } = setup(1);
		const base = repo.main();
		const removed = (number: number, minute: number): Pull => {
			const head = repo.pull(number, { [`feature-${number}.txt`]: "new\n" });
			return {
				number,
				head,
				enqueues: [{ createdAt: at(1), actor: "maintainer" }],
				removals: [
					{
						id: `R${number}`,
						createdAt: at(minute),
						reason: "failed_checks",
						actor: "github-merge-queue",
						before: head,
					},
				],
			};
		};
		const github = {
			...world(
				[removed(5, 4), removed(6, 5)],
				[failedRun(5, at(3), base), { ...failedRun(6, at(3), base), id: 8 }],
			),
			origin: repo.origin,
		};
		github.now = Date.parse(at(6));
		fix.round(
			5,
			`printf '[{"number":%s,"action":"handback","diagnosis":"the test asserts the old behavior","recommendation":"decide which behavior is right"}]' "$2" > quest-land-result.json\n`,
		);
		fix.round(6, flakyScript);
		// One fixer slot: 6 waits for 5's.
		expect(await watchPass(REPOSITORY, { state }, deps(github), context)).toEqual([
			"removed 5 failed_checks fix",
			"removed 6 failed_checks fix",
			"fixing 5",
		]);
		await exited(state);
		// GitHub refuses every comment on 5, so its handback never posts.
		const refusing = () => {
			const dependencies = deps(github);
			const original = dependencies.fetch;
			dependencies.fetch = (async (input, init) => {
				if (init?.method === "POST" && new URL(String(input)).pathname.endsWith("/issues/5/comments"))
					return Response.json({ message: "refused" }, { status: 422 });
				return original(input, init);
			}) as typeof fetch;
			return dependencies;
		};
		for (let pass = 1; pass < COLLECTION_ATTEMPTS; pass++)
			expect(await watchPass(REPOSITORY, { state }, refusing(), context)).toEqual([]);
		expect(fix.calls()).toHaveLength(1);
		expect(await watchPass(REPOSITORY, { state }, refusing(), context)).toEqual(["set aside 5", "fixing 6"]);
		expect(
			readdirSync(state).filter((name) => name.startsWith("watch-job-") && name.endsWith(".json")),
		).toHaveLength(1);
		await exited(state);
		expect(await watchPass(REPOSITORY, { state }, deps(github), context)).toEqual([
			`requeued 6 ${github.pulls[1].head}`,
		]);
	});
	test("a person's removal ends the pick, even of a round re-enqueued just before a restart", async () => {
		const { repo, state, fix, context } = setup();
		const base = repo.main();
		const head = repo.pull(12, { "Cargo.lock": "bumped\n" });
		const pull: Pull = {
			number: 12,
			head,
			enqueues: [{ createdAt: at(1), actor: APP }],
			removals: [
				{ id: "R1", createdAt: at(5), reason: "failed_checks", actor: "github-merge-queue", before: head },
			],
		};
		const github = { ...world([pull], [failedRun(12, at(3), base)]), origin: repo.origin };
		github.now = Date.parse(at(6));
		fix.round(12, flakyScript);
		await watchPass(REPOSITORY, { state }, deps(github), context);
		await exited(state);
		// The daemon re-enqueued the round's head, then stopped before it finished the job; a maintainer
		// removed the PR from the queue before it restarted.
		const [job] = readdirSync(state).filter((name) => /^watch-job-.*\.json$/.test(name));
		const record = JSON.parse(readFileSync(join(state, job), "utf8"));
		const result = JSON.parse(readFileSync(join(record.checkout, "quest-land-result.json"), "utf8"))[0];
		writeFileSync(join(state, job), JSON.stringify({ ...record, result, requeuing: head }));
		writeFileSync(
			join(state, "fix-attempt-12.json"),
			JSON.stringify({
				pick: at(1),
				rounds: [{ job, outcome: "flaky", before: head, after: head, failure: "just test: render_timeout" }],
			}),
		);
		pull.enqueues.push({ createdAt: at(7), actor: APP });
		pull.removals.push({ id: "R2", createdAt: at(8), reason: "manual", actor: "maintainer", before: head });
		github.now = Date.parse(at(9));
		expect(await watchPass(REPOSITORY, { state }, deps(github), context)).toEqual([
			"removed 12 manual removed",
			`requeued 12 ${head}`,
		]);
		// Nothing enqueued it again, and the pick's history is gone with it.
		expect(github.mutations).toEqual([]);
		expect(history(state, 12)).toBeUndefined();

		// The workflow's next enqueue of the same head is a new pick, with no flaky rounds behind it.
		pull.enqueues.push({ createdAt: at(20), actor: APP });
		pull.removals.push({
			id: "R3",
			createdAt: at(25),
			reason: "failed_checks",
			actor: "github-merge-queue",
			before: head,
		});
		github.runs.push({ ...failedRun(12, at(23), base), id: 13 });
		github.now = Date.parse(at(26));
		expect(await watchPass(REPOSITORY, { state }, deps(github), context)).toEqual([
			"removed 12 failed_checks fix",
			"fixing 12",
		]);
		expect(readRemoval(state, 12)!.pick).toEqual({ by: `${APP}[bot]`, at: at(20) });
		expect(history(state, 12)).toEqual({ pick: at(20), rounds: [] });
		await exited(state);
		github.now = Date.parse(at(27));
		expect(await watchPass(REPOSITORY, { state }, deps(github), context)).toEqual([`requeued 12 ${head}`]);
	});
});
