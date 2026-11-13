import { describe, expect, test } from "vitest";

import type { GitHubDependencies } from "../src/cli/github";
import { main } from "../src/cli/main";
import { pullRequestStatus, statusLines } from "../src/cli/status";

const A = "a".repeat(40);
const B = "b".repeat(40);
const pr = { owner: "example", repo: "project", number: 1 };
const URL_ = "https://github.com/example/project/pull/1";

type Node = Record<string, unknown>;
const page = (nodes: Node[], next?: string) => ({
	pageInfo: { hasNextPage: next !== undefined, endCursor: next ?? null },
	nodes,
});

/** A recorded GraphQL response; omitted connections stand for ones the query skipped. */
const CI = ".github/workflows/ci.yml";

function pull(
	fields: {
		head?: string;
		checks?: ReturnType<typeof page> | null;
		reviews?: ReturnType<typeof page>;
		threads?: ReturnType<typeof page>;
		reactions?: Node[];
	} & Node = {},
) {
	const { head = A, checks, reviews, threads, reactions = [], ...rest } = fields;
	return {
		data: {
			repository: {
				pullRequest: {
					id: "PR_1",
					url: URL_,
					body: "Summary.",
					updatedAt: "2026-10-07T12:00:00Z",
					baseRefName: "main",
					isMergeQueueEnabled: false,
					labels: { nodes: [] },
					state: "OPEN",
					isDraft: false,
					headRefOid: head,
					mergeable: "MERGEABLE",
					mergeStateStatus: "BLOCKED",
					reviewDecision: "REVIEW_REQUIRED",
					autoMergeRequest: null,
					mergeQueueEntry: null,
					timelineItems: { nodes: [] },
					reactions: { nodes: reactions },
					commits: {
						nodes: [
							{
								commit: {
									oid: head,
									statusCheckRollup:
										checks === null
											? null
											: { state: "FAILURE", ...(checks ? { contexts: checks } : {}) },
								},
							},
						],
					},
					...(reviews ? { reviews } : {}),
					...(threads ? { reviewThreads: threads } : {}),
					...rest,
				},
			},
		},
	};
}

function run(name: string, status: string, conclusion: string | null, isRequired: boolean) {
	return {
		__typename: "CheckRun",
		name,
		status,
		conclusion,
		detailsUrl: `https://github.com/example/project/actions/runs/1/job/${name}`,
		isRequired,
	};
}

function review(login: string, state: string, commit: string | null, id: number, reactions: Node[] = []) {
	return {
		author: { login },
		state,
		submittedAt: `2026-10-07T12:0${id}:00Z`,
		url: `${URL_}#pullrequestreview-${id}`,
		commit: commit === null ? null : { oid: commit },
		reactions: { nodes: reactions },
	};
}

function thread(id: string, isResolved: boolean, line: number | null = 3, author = "reviewer") {
	return {
		id,
		isResolved,
		isOutdated: line === null,
		path: "src/a.ts",
		line,
		originalLine: 2,
		comments: { nodes: [{ author: { login: author }, url: `${URL_}#discussion_r${id}` }] },
	};
}

function setup(
	bodies: unknown[],
	options: {
		now?: number;
		holdFields?: Node;
		eventPages?: { rows: Node[]; next?: string }[];
		/** Pages of the head repository's activity, newest first. */
		activity?: { rows: Node[]; next?: string; status?: number }[];
		warnings?: string[];
		/** The base-to-head diff per compared head, or the status GitHub refuses it with. */
		diffs?: Record<string, string | number>;
		/** The base's active ruleset rules. */
		rules?: Node[];
		/** The base branch is gone, so reading it fails. */
		noBase?: boolean;
		/** The head's workflow runs, as `GET /actions/runs` lists them. */
		runs?: Node[];
	} = {},
) {
	const queries: Record<string, unknown>[] = [];
	const texts: string[] = [];
	const holdQueries: Record<string, unknown>[] = [];
	const eventRequests: string[] = [];
	let last: ReturnType<typeof pull> | undefined;
	const eventPages = [...(options.eventPages ?? [])];
	const activityPages = [...(options.activity ?? [])];
	const activityRequests: string[] = [];
	const deps: GitHubDependencies = {
		token: "test-token",
		now: () => options.now ?? 0,
		sleep: async () => {},
		warn: (message) => options.warnings?.push(message),
		fetch: async (url, init) => {
			const path = new URL(String(url));
			if (path.pathname === "/repos/fork/project/activity") {
				activityRequests.push(`${path.pathname}${path.search}`);
				const page = activityPages.shift();
				if (!page) return Response.json({ message: "Not Found" }, { status: 404 });
				if (page.status === 403)
					return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
				return Response.json(page.rows, { headers: page.next ? { Link: `<${page.next}>; rel="next"` } : {} });
			}
			if (path.pathname === "/repos/example/project/branches/main")
				return options.noBase
					? Response.json({ message: "Branch not found" }, { status: 404 })
					: Response.json({ protection: { enabled: false } });
			if (path.pathname === "/repos/example/project/rules/branches/main")
				return Response.json(options.rules ?? []);
			if (path.pathname === "/repos/example/project/actions/runs") {
				if (!options.runs) throw new Error("unexpected workflow run request");
				return Response.json({ total_count: options.runs.length, workflow_runs: options.runs });
			}
			const compare = /^\/repos\/example\/project\/compare\/main\.\.\.([0-9a-f]{40})$/.exec(path.pathname);
			if (compare) {
				expect(new Headers(init?.headers).get("Accept")).toBe("application/vnd.github.diff");
				const diff = options.diffs?.[compare[1]!];
				if (diff === undefined) throw new Error("unexpected compare request");
				return typeof diff === "number"
					? Response.json({ message: "No diff" }, { status: diff })
					: new Response(diff);
			}
			if (path.pathname !== "/graphql") {
				expect(path.pathname).toBe("/repos/example/project/issues/1/events");
				eventRequests.push(String(url));
				const page = eventPages.shift();
				if (!page) throw new Error("unexpected event request");
				return Response.json(page.rows, { headers: page.next ? { Link: `<${page.next}>; rel="next"` } : {} });
			}
			const request = JSON.parse(String(init?.body));
			if (request.query.includes("query HoldOwnership(")) {
				holdQueries.push(request.variables);
				if (!last) throw new Error("ownership read before PR state");
				const row = last.data.repository.pullRequest;
				const events = (row.timelineItems as { nodes: Node[] }).nodes.filter((event) =>
					["LabeledEvent", "AutoMergeEnabledEvent", "AddedToMergeQueueEvent"].includes(
						String(event.__typename),
					),
				);
				return Response.json({
					data: {
						repository: {
							pullRequest: { ...row, timelineItems: { nodes: events }, ...options.holdFields },
						},
					},
				});
			}
			queries.push(request.variables);
			texts.push(request.query);
			const body = bodies.shift();
			if (body === undefined) throw new Error("unexpected request");
			last = body as ReturnType<typeof pull>;
			return Response.json(body);
		},
	};
	return { deps, queries, texts, holdQueries, eventRequests, activityRequests };
}

test("reports checks by requiredness, each reviewer's latest review against the head, and open threads", async () => {
	const fixture = setup(
		[
			pull({
				checks: page([
					run("lint", "COMPLETED", "FAILURE", true),
					run("docs", "COMPLETED", "CANCELLED", false),
					run("test", "IN_PROGRESS", null, true),
					run("build", "COMPLETED", "SUCCESS", true),
					run("publish", "COMPLETED", "SKIPPED", false),
					{
						__typename: "StatusContext",
						context: "ci/legacy",
						state: "ERROR",
						targetUrl: null,
						isRequired: false,
					},
					{
						__typename: "StatusContext",
						context: "deploy",
						state: "EXPECTED",
						targetUrl: "",
						isRequired: true,
					},
				]),
				reviews: page([
					review("alice", "APPROVED", B, 1),
					review("bob", "CHANGES_REQUESTED", B, 2),
					review("alice", "COMMENTED", A, 3, [
						{ content: "THUMBS_UP", createdAt: "2026-10-07T12:04:00Z", user: { login: "codex[bot]" } },
					]),
					review("viewer", "PENDING", A, 4),
					review("gone", "COMMENTED", null, 5),
				]),
				threads: page([thread("T1", true), thread("T2", false), thread("T3", false, null, "author")]),
				reactions: [{ content: "EYES", createdAt: "2026-10-07T12:00:00Z", user: null }],
			}),
		],
		{ runs: [] },
	);
	const status = await pullRequestStatus(pr, fixture.deps);
	expect(fixture.queries).toHaveLength(1);
	expect(fixture.holdQueries).toHaveLength(1);
	expect(fixture.queries[0]).toMatchObject({ number: 1, moreChecks: true, moreReviews: true, moreThreads: true });
	expect(statusLines(status)).toEqual([
		`url ${URL_}`,
		"state open",
		"draft false",
		`head ${A}`,
		"mergeable mergeable",
		"merge-state blocked",
		"review-decision review_required",
		"review-record -",
		"auto-merge -",
		"merge-queue -",
		"landing-stopped -",
		"checks failure passed=2 failing=3 pending=2",
		"check failing required failure https://github.com/example/project/actions/runs/1/job/lint lint",
		"check failing optional cancelled https://github.com/example/project/actions/runs/1/job/docs docs",
		"check failing optional error - ci/legacy",
		"check pending required in_progress https://github.com/example/project/actions/runs/1/job/test test",
		"check pending required expected - deploy",
		`review stale changes_requested bob 2026-10-07T12:02:00Z ${URL_}#pullrequestreview-2`,
		`review current commented alice 2026-10-07T12:03:00Z ${URL_}#pullrequestreview-3`,
		`review stale commented gone 2026-10-07T12:05:00Z ${URL_}#pullrequestreview-5`,
		`reacted:eyes - 2026-10-07T12:00:00Z ${URL_}`,
		`reacted:thumbs_up codex[bot] 2026-10-07T12:04:00Z ${URL_}#pullrequestreview-3`,
		`thread T2 current reviewer ${URL_}#discussion_rT2 src/a.ts:3`,
		`thread T3 outdated author ${URL_}#discussion_rT3 src/a.ts:2`,
		"hold -",
	]);
});

test("a queued PR with auto-merge and no checks reports both, and JSON is deterministic", async () => {
	const body = pull({
		state: "OPEN",
		isDraft: true,
		reviewDecision: null,
		autoMergeRequest: {
			enabledAt: "2026-10-07T12:00:00Z",
			mergeMethod: "SQUASH",
			enabledBy: { login: "kixelated" },
		},
		mergeQueueEntry: { state: "AWAITING_CHECKS", position: 2, enqueuedAt: "2026-10-07T12:01:00Z" },
		checks: null,
		reviews: page([]),
		threads: page([]),
	});
	const status = await pullRequestStatus(pr, setup([body]).deps);
	expect(statusLines(status).slice(2, 12)).toEqual([
		"draft true",
		`head ${A}`,
		"mergeable mergeable",
		"merge-state blocked",
		"review-decision -",
		"review-record -",
		"auto-merge squash kixelated 2026-10-07T12:00:00Z -",
		"merge-queue awaiting_checks 2 2026-10-07T12:01:00Z",
		"landing-stopped -",
		"checks - passed=0 failing=0 pending=0",
	]);
	expect(JSON.stringify(await pullRequestStatus(pr, setup([body]).deps))).toBe(JSON.stringify(status));
	expect(status.mergeQueue).toEqual({ state: "awaiting_checks", position: 2, enqueuedAt: "2026-10-07T12:01:00Z" });
});

describe("the head auto-merge was enabled on", () => {
	const ENABLED = "2026-10-07T12:00:00Z";
	const push = (after: string, timestamp: string, activity_type = "push") => ({ after, timestamp, activity_type });
	const enabled = async (
		request: Node,
		activity: { rows: Node[]; next?: string; status?: number }[] = [],
		head = B,
		warnings?: string[],
	): Promise<{ line: string | undefined; requests: string[] }> => {
		const body = pull({
			head,
			checks: null,
			reviews: page([]),
			threads: page([]),
			headRefName: "feature/x",
			headRepository: { nameWithOwner: "fork/project" },
			autoMergeRequest: {
				enabledAt: ENABLED,
				mergeMethod: "MERGE",
				enabledBy: { login: "kixelated" },
				...request,
			},
		});
		const fixture = setup([body], { activity, warnings });
		const status = await pullRequestStatus(pr, fixture.deps);
		return {
			line: statusLines(status).find((line) => line.startsWith("auto-merge ")),
			requests: fixture.activityRequests,
		};
	};

	test("is the head a quest land pin names, without reading activity", async () => {
		const result = await enabled({ commitBody: `Quest-Land-Head: ${A}` });
		expect(result.line).toBe(`auto-merge merge kixelated ${ENABLED} ${A}`);
		expect(result.requests).toEqual([]);
	});

	test("is otherwise the last push before it was enabled, paging the head branch's activity", async () => {
		const result = await enabled({ commitBody: null }, [
			{
				rows: [push(B, "2026-10-07T12:05:00Z")],
				next: "https://api.github.com/repos/fork/project/activity?page=2",
			},
			{ rows: [push(A, "2026-10-07T11:59:00Z", "force_push"), push("c".repeat(40), "2026-10-07T11:00:00Z")] },
		]);
		expect(result.line).toBe(`auto-merge merge kixelated ${ENABLED} ${A}`);
		expect(result.requests).toEqual([
			"/repos/fork/project/activity?ref=feature%2Fx&per_page=100",
			"/repos/fork/project/activity?page=2",
		]);
	});

	test("counts a merge into the head branch as moving its head", async () => {
		const result = await enabled({}, [
			{
				rows: [
					push(B, "2026-10-07T12:05:00Z", "pr_merge"),
					push(A, "2026-10-07T11:59:00Z", "merge_queue_merge"),
				],
			},
		]);
		expect(result.line).toBe(`auto-merge merge kixelated ${ENABLED} ${A}`);
	});

	test("matches the head when no push followed", async () => {
		const result = await enabled({ commitBody: "" }, [{ rows: [push(B, "2026-10-07T11:59:59Z")] }]);
		expect(result.line).toBe(`auto-merge merge kixelated ${ENABLED} ${B}`);
	});

	test("is unknown until GitHub lists the current head's push, or when a push shares the second", async () => {
		expect((await enabled({}, [{ rows: [push(A, "2026-10-07T11:59:00Z")] }])).line).toBe(
			`auto-merge merge kixelated ${ENABLED} -`,
		);
		expect((await enabled({}, [{ rows: [push(B, ENABLED), push(A, "2026-10-07T11:59:00Z")] }])).line).toBe(
			`auto-merge merge kixelated ${ENABLED} -`,
		);
		// A head repository the token cannot see.
		expect((await enabled({}, [])).line).toBe(`auto-merge merge kixelated ${ENABLED} -`);
	});

	test("is unknown, with a warning, when the token may not read the activity, and status still prints", async () => {
		const warnings: string[] = [];
		const result = await enabled({}, [{ rows: [], status: 403 }], B, warnings);
		expect(result.line).toBe(`auto-merge merge kixelated ${ENABLED} -`);
		expect(warnings).toEqual([
			"cannot read fork/project's push activity, so the head auto-merge was enabled on is unknown: GitHub HTTP 403 for /repos/fork/project/activity; Resource not accessible by integration",
		]);
	});
});

test("reports why the latest landing stopped, from a merge queue or auto-merge", async () => {
	const stopped = async (node: Node) => {
		const body = pull({ checks: null, reviews: page([]), threads: page([]), timelineItems: { nodes: [node] } });
		return statusLines(await pullRequestStatus(pr, setup([body]).deps)).find((line) =>
			line.startsWith("landing-stopped "),
		);
	};
	expect(
		await stopped({
			createdAt: "2026-10-07T12:00:00Z",
			reason: "MERGE_CONFLICT",
			actor: { login: "github-merge-queue" },
		}),
	).toBe("landing-stopped merge_conflict github-merge-queue 2026-10-07T12:00:00Z");
	expect(
		await stopped({
			createdAt: "2026-10-07T12:01:00Z",
			reasonCode: "manually_disabled",
			actor: { login: "kixelated" },
		}),
	).toBe("landing-stopped manually_disabled kixelated 2026-10-07T12:01:00Z");
});

test("reports quest land's ejection after the auto-merge it disabled, ignoring other comments", async () => {
	const comment = (body: string, author: Node, authorAssociation = "NONE") => ({
		__typename: "IssueComment",
		createdAt: "2026-10-07T12:02:00Z",
		body,
		authorAssociation,
		author,
	});
	const ejected =
		"quest land removed this pull request from the queue: it conflicts.\n\n<!-- quest land: merge_conflict -->";
	const nodes = [
		{
			__typename: "AutoMergeDisabledEvent",
			createdAt: "2026-10-07T12:01:00Z",
			reasonCode: "manually_disabled",
			actor: { login: "gate[bot]" },
		},
		comment(ejected, { __typename: "Bot", login: "gate" }),
		comment("Thanks!", { __typename: "User", login: "kixelated" }, "OWNER"),
		comment(ejected, { __typename: "User", login: "drive-by" }),
	];
	const body = pull({ checks: null, reviews: page([]), threads: page([]), timelineItems: { nodes } });
	const status = await pullRequestStatus(pr, setup([body]).deps);
	expect(status.landingStopped).toEqual({ reason: "merge_conflict", actor: "gate", at: "2026-10-07T12:02:00Z" });
});

test("drops the landing exit once the PR enters the merge queue or auto-merge again", async () => {
	const disabled = {
		__typename: "AutoMergeDisabledEvent",
		createdAt: "2026-10-07T12:01:00Z",
		reasonCode: "manually_disabled",
		actor: { login: "kixelated" },
	};
	const removed = {
		__typename: "RemovedFromMergeQueueEvent",
		createdAt: "2026-10-07T12:01:00Z",
		reason: "MERGE_CONFLICT",
		actor: { login: "github-merge-queue" },
	};
	const ejected = {
		__typename: "IssueComment",
		createdAt: "2026-10-07T12:01:00Z",
		body: "quest land removed this pull request from the queue: it conflicts.\n\n<!-- quest land: merge_conflict -->",
		authorAssociation: "NONE",
		author: { __typename: "Bot", login: "gate" },
	};
	const autoMerge = (enabledAt: string) => ({ enabledAt, mergeMethod: "SQUASH", enabledBy: { login: "kixelated" } });
	const queue = (enqueuedAt: string) => ({ state: "QUEUED", position: 1, enqueuedAt });
	const stopped = async (node: Node, fields: Node) => {
		const body = pull({
			checks: null,
			reviews: page([]),
			threads: page([]),
			timelineItems: { nodes: [node] },
			...fields,
		});
		return (await pullRequestStatus(pr, setup([body]).deps)).landingStopped?.reason ?? null;
	};
	// `quest merge --land` disables auto-merge and enables it again, often within the same second.
	expect(await stopped(disabled, { autoMergeRequest: autoMerge("2026-10-07T12:01:00Z") })).toBeNull();
	expect(await stopped(ejected, { autoMergeRequest: autoMerge("2026-10-07T12:05:00Z") })).toBeNull();
	expect(await stopped(removed, { mergeQueueEntry: queue("2026-10-07T12:05:00Z") })).toBeNull();
	// An entry that began before the exit is not a new one.
	expect(await stopped(removed, { autoMergeRequest: autoMerge("2026-10-07T12:00:00Z") })).toBe("merge_conflict");
	expect(await stopped(ejected, { mergeQueueEntry: queue("2026-10-07T12:00:59Z") })).toBe("merge_conflict");
});

test("drops a cancelled check a newer run of its workflow replaced, as on kixelated/token-max#78", async () => {
	const job = (name: string, conclusion: string, databaseId: number, suite: number) => ({
		...run(name, "COMPLETED", conclusion, false),
		databaseId,
		checkSuite: { databaseId: suite, app: { databaseId: 15368 }, workflowRun: { file: { path: CI } } },
	});
	const runs = (started: string) => [
		{ id: 1, workflow_id: 7, check_suite_id: 10, run_started_at: "2026-11-12T23:42:53Z" },
		{ id: 2, workflow_id: 7, check_suite_id: 20, run_started_at: started },
	];
	const checks = () =>
		page([job("Tests (${{ matrix.os }})", "CANCELLED", 1, 10), job("Tests (macos-15)", "SUCCESS", 2, 20)]);
	const fixture = setup([pull({ checks: checks(), reviews: page([]), threads: page([]) })], {
		runs: runs("2026-11-12T23:42:56Z"),
	});
	const status = await pullRequestStatus(pr, fixture.deps);
	expect(status.checks).toEqual({ state: "success", passed: 1, failing: [], pending: [] });
	// A rerun of the cancelled run started later, so its run is the newest and its cancellation counts.
	const rerun = setup([pull({ checks: checks(), reviews: page([]), threads: page([]) })], {
		runs: runs("2026-11-12T23:40:00Z"),
	});
	expect((await pullRequestStatus(pr, rerun.deps)).checks.state).toBe("failure");
});

test("a required check or workflow nothing reports is pending, except the gate's own check", async () => {
	const job = (name: string, workflow: string) => ({
		...run(name, "COMPLETED", "SUCCESS", false),
		databaseId: 1,
		checkSuite: { databaseId: 10, app: { databaseId: 15368 }, workflowRun: { file: { path: workflow } } },
	});
	const rules = [
		{
			type: "required_status_checks",
			parameters: {
				required_status_checks: [{ context: "test" }, { context: "lint" }, { context: "quest land" }],
			},
		},
		{ type: "workflows", parameters: { workflows: [{ path: CI }, { path: ".github/workflows/pr.yml" }] } },
	];
	const fixture = setup([pull({ checks: page([job("test", CI)]), reviews: page([]), threads: page([]) })], {
		rules,
	});
	const status = await pullRequestStatus(pr, fixture.deps);
	expect(statusLines(status).filter((line) => line.startsWith("check"))).toEqual([
		"checks pending passed=1 failing=0 pending=2",
		"check pending required expected - lint",
		"check pending required expected - .github/workflows/pr.yml",
	]);
	// With no checks on the head at all, the requirements still leave it pending.
	const empty = setup([pull({ checks: null, reviews: page([]), threads: page([]) })], { rules });
	expect((await pullRequestStatus(pr, empty.deps)).checks.state).toBe("pending");
});

test("a required check from another app than its requirement names stays pending, and a closed PR reads no requirements", async () => {
	const rules = [
		{
			type: "required_status_checks",
			parameters: { required_status_checks: [{ context: "test", integration_id: 99 }] },
		},
	];
	const test = {
		...run("test", "COMPLETED", "SUCCESS", false),
		databaseId: 1,
		checkSuite: { databaseId: 10, app: { databaseId: 15368 }, workflowRun: { file: { path: CI } } },
	};
	const open = setup([pull({ checks: page([test]), reviews: page([]), threads: page([]) })], { rules });
	expect(statusLines(await pullRequestStatus(pr, open.deps)).filter((line) => line.startsWith("check"))).toEqual([
		"checks pending passed=1 failing=0 pending=1",
		"check pending required expected - test (from app 99)",
	]);
	// A merged PR's base may be gone, and nothing it requires can change the PR anymore.
	const merged = setup([pull({ state: "MERGED", checks: page([test]), reviews: page([]), threads: page([]) })], {
		rules: undefined,
		noBase: true,
	});
	expect((await pullRequestStatus(pr, merged.deps)).checks.state).toBe("success");
});

test("a replacing run that has not started yet stands in by its creation time", async () => {
	const job = {
		...run("Tests (${{ matrix.os }})", "COMPLETED", "CANCELLED", false),
		databaseId: 1,
		checkSuite: { databaseId: 10, app: { databaseId: 15368 }, workflowRun: { file: { path: CI } } },
	};
	const fixture = setup([pull({ checks: page([job]), reviews: page([]), threads: page([]) })], {
		runs: [
			{ id: 1, workflow_id: 7, check_suite_id: 10, run_started_at: "2026-11-12T23:42:53Z" },
			{ id: 2, workflow_id: 7, check_suite_id: 20, run_started_at: null, created_at: "2026-11-12T23:42:56Z" },
		],
	});
	expect((await pullRequestStatus(pr, fixture.deps)).checks).toEqual({
		state: "success",
		passed: 0,
		failing: [],
		pending: [],
	});
});

test("a job in a required workflow counts as required", async () => {
	const fixture = setup(
		[
			pull({
				checks: page([
					{
						...run("build", "COMPLETED", "FAILURE", false),
						databaseId: 1,
						checkSuite: { databaseId: 10, app: { databaseId: 15368 }, workflowRun: { file: { path: CI } } },
					},
				]),
				reviews: page([]),
				threads: page([]),
			}),
		],
		{ rules: [{ type: "workflows", parameters: { workflows: [{ path: CI }] } }] },
	);
	const status = await pullRequestStatus(pr, fixture.deps);
	expect(status.checks.failing.map((check) => [check.name, check.required])).toEqual([["build", true]]);
});

test("counts only each check's newest run from its app", async () => {
	const rerun = (name: string, conclusion: string, databaseId: number, app = 15368) => ({
		...run(name, "COMPLETED", conclusion, true),
		databaseId,
		checkSuite: { app: { databaseId: app } },
	});
	const fixture = setup([
		pull({
			checks: page([
				rerun("build", "SUCCESS", 7),
				rerun("build", "CANCELLED", 3),
				rerun("test", "SUCCESS", 4),
				rerun("test", "FAILURE", 8),
				rerun("lint", "SUCCESS", 5),
				rerun("lint", "FAILURE", 2, 99),
			]),
			reviews: page([]),
			threads: page([]),
		}),
	]);
	const status = await pullRequestStatus(pr, fixture.deps);
	// The fixture answers whatever is asked, so the query must ask for what tells runs apart.
	expect(fixture.texts[0].replace(/\s+/g, " ")).toContain(
		"... on CheckRun { databaseId name status conclusion detailsUrl isRequired(pullRequestNumber: $number) checkSuite { databaseId app { databaseId } workflowRun { file { path } } } }",
	);
	expect(status.checks.passed).toBe(2);
	expect(status.checks.failing.map((check) => check.name)).toEqual(["test", "lint"]);
	expect(status.checks.pending).toEqual([]);
});

test("judges checks by their latest runs, not the rollup's state, as on moq-dev/moq#7325", async () => {
	// A cancelled run's gate failed on purpose; the newer run of the same workflow passed, and GitHub's
	// merge state counted the pass while its rollup state stayed FAILURE.
	const latest = (name: string, conclusion: string, databaseId: number) => ({
		...run(name, "COMPLETED", conclusion, name === "Release gate"),
		databaseId,
		checkSuite: { app: { databaseId: 15368 } },
	});
	const body = pull({
		checks: page([
			latest("Scope", "CANCELLED", 1),
			latest("Release gate", "FAILURE", 2),
			latest("Scope", "SUCCESS", 3),
			latest("Release gate", "SUCCESS", 4),
		]),
		reviews: page([]),
		threads: page([]),
	});
	const fixture = setup([body]);
	const status = await pullRequestStatus(pr, fixture.deps);
	expect(statusLines(status)).toContain("checks success passed=2 failing=0 pending=0");
	expect(fixture.texts[0].replace(/\s+/g, " ")).toContain("... on StatusContext { context state createdAt targetUrl");
});

test("long lists page only the connections that have more, keeping the first page's PR fields", async () => {
	const fixture = setup([
		pull({
			checks: page([run("one", "COMPLETED", "FAILURE", true)], "c1"),
			reviews: page([review("alice", "APPROVED", B, 1)], "r1"),
			threads: page([thread("T1", false)]),
			reactions: [{ content: "HEART", createdAt: "2026-10-07T12:00:00Z", user: { login: "x" } }],
		}),
		pull({
			checks: page([run("two", "QUEUED", null, false)]),
			reviews: page([review("alice", "APPROVED", A, 2)], "r2"),
			reactions: [{ content: "HEART", createdAt: "2026-10-07T12:00:00Z", user: { login: "x" } }],
		}),
		pull({ reviews: page([review("bob", "COMMENTED", A, 3)]) }),
	]);
	const status = await pullRequestStatus(pr, fixture.deps);
	expect(
		fixture.queries.map(({ checks, reviews, threads, moreChecks, moreReviews, moreThreads }) => ({
			checks,
			reviews,
			threads,
			moreChecks,
			moreReviews,
			moreThreads,
		})),
	).toEqual([
		{ checks: null, reviews: null, threads: null, moreChecks: true, moreReviews: true, moreThreads: true },
		{ checks: "c1", reviews: "r1", threads: null, moreChecks: true, moreReviews: true, moreThreads: false },
		{ checks: null, reviews: "r2", threads: null, moreChecks: false, moreReviews: true, moreThreads: false },
	]);
	expect(status.checks.failing.map((check) => check.name)).toEqual(["one"]);
	expect(status.checks.pending.map((check) => check.name)).toEqual(["two"]);
	expect(status.reviews.map((r) => [r.reviewer, r.current])).toEqual([
		["alice", true],
		["bob", true],
	]);
	expect(status.reactions).toHaveLength(1);
	expect(status.threads.map((t) => t.id)).toEqual(["T1"]);
});

test("a push between pages, a GraphQL error, or a missing PR fails instead of mixing heads", async () => {
	const moved = setup([
		pull({ checks: page([], "c1"), reviews: page([]), threads: page([]) }),
		pull({ head: B, checks: page([]) }),
	]);
	await expect(pullRequestStatus(pr, moved.deps)).rejects.toThrow("head changed");
	const errored = setup([{ errors: [{ message: "Field 'isRequired' is missing" }] }]);
	await expect(pullRequestStatus(pr, errored.deps)).rejects.toThrow("GitHub GraphQL error: Field 'isRequired'");
	const missing = setup([{ data: { repository: { pullRequest: null } } }]);
	await expect(pullRequestStatus(pr, missing.deps)).rejects.toThrow("is not a pull request");
});

test("an invalid PR argument is a usage error before authentication", () => {
	const errors: string[] = [];
	const output = { stdout: () => {}, stderr: (text: string) => errors.push(text) };
	expect(main(["status", "https://evil.example/example/project/pull/1"], output)).toBe(2);
	expect(errors.join("")).toContain("GitHub pull request URL");
});

const holdEvent = (id: string, label: string, at = "2026-10-07T11:00:00Z") => ({
	__typename: "LabeledEvent",
	id,
	createdAt: at,
	label: { name: label },
});

test("reports the latest acquisition, age, and verified paged event URL for each hold label", async () => {
	const label = "quest:active";
	const body = pull({
		checks: null,
		reviews: page([]),
		threads: page([]),
		labels: { nodes: [{ name: "bug" }, { name: label }] },
	});
	const eventUrl = "https://api.github.com/repos/example/project/issues/events/23";
	const next = "https://api.github.com/repos/example/project/issues/1/events?per_page=100&page=2";
	const fixture = setup([body], {
		now: Date.parse("2026-10-07T12:00:00Z"),
		holdFields: { timelineItems: { nodes: [holdEvent("old", label), holdEvent("new", label)] } },
		eventPages: [
			{ rows: [{ node_id: "old", event: "labeled", label: { name: label }, url: "old-url" }], next },
			{ rows: [{ node_id: "new", event: "labeled", label: { name: label }, url: eventUrl }] },
		],
	});
	const status = await pullRequestStatus(pr, fixture.deps);
	expect(status.holds).toEqual([
		{ label, token: "new", takenAt: "2026-10-07T11:00:00.000Z", age: "1 hour ago", eventUrl },
	]);
	expect(statusLines(status)).toContain(`hold ${label} new 2026-10-07T11:00:00.000Z ${eventUrl} 1 hour ago`);
	expect(fixture.eventRequests).toHaveLength(2);
	expect(status.starterHold).toBeNull();
});

test("retains a hold fact when its acquisition is outside the available timeline", async () => {
	const fixture = setup([
		pull({ checks: null, reviews: page([]), threads: page([]), labels: { nodes: [{ name: "quest:active" }] } }),
	]);
	const status = await pullRequestStatus(pr, fixture.deps);
	expect(status.holds).toEqual([{ label: "quest:active", token: null, takenAt: null, age: null, eventUrl: null }]);
	expect(statusLines(status)).toContain("hold quest:active - - - unknown age");
	expect(fixture.eventRequests).toEqual([]);
});

test("never attaches a URL from a different label or event to a hold token", async () => {
	const body = pull({
		checks: null,
		reviews: page([]),
		threads: page([]),
		// Older quest versions' quest:merge holds nothing, so it reports no hold.
		labels: { nodes: [{ name: "quest:merge" }, { name: "quest:active" }] },
	});
	const fixture = setup([body], {
		holdFields: { timelineItems: { nodes: [holdEvent("token", "quest:active")] } },
		eventPages: [{ rows: [{ node_id: "token", event: "labeled", label: { name: "bug" }, url: "wrong" }] }],
	});
	const { holds } = await pullRequestStatus(pr, fixture.deps);
	expect(holds.map((hold) => [hold.label, hold.eventUrl])).toEqual([["quest:active", null]]);
});

test("reports draft starter ownership as last activity, and does not invent its acquisition time", async () => {
	const draft = pull({
		checks: null,
		reviews: page([]),
		threads: page([]),
		isDraft: true,
		updatedAt: "2026-10-07T11:00:00Z",
	});
	const status = await pullRequestStatus(pr, setup([draft], { now: Date.parse("2026-10-07T12:00:00Z") }).deps);
	expect(status.starterHold).toEqual({ lastActive: "2026-10-07T11:00:00Z", age: "1 hour ago", url: URL_ });
	expect(statusLines(status)).toContain(`starter-hold 2026-10-07T11:00:00Z ${URL_} last active 1 hour ago`);
	for (const change of [{ body: "## Waiting\n\nChoose one." }, { state: "CLOSED" }, { state: "MERGED" }]) {
		const copy = structuredClone(draft);
		Object.assign(copy.data.repository.pullRequest, change);
		expect((await pullRequestStatus(pr, setup([copy]).deps)).starterHold).toBeNull();
	}
});

test("refuses a head moved between the paged state and ownership read", async () => {
	const fixture = setup([pull({ checks: null, reviews: page([]), threads: page([]) })], {
		holdFields: { headRefOid: B },
	});
	await expect(pullRequestStatus(pr, fixture.deps)).rejects.toThrow("head changed while reading its holds");
});

describe("the review record", () => {
	const C = "c".repeat(40);
	const line = async (body: string, options: Parameters<typeof setup>[1] = {}) => {
		const fixture = setup([pull({ body, checks: null, reviews: page([]), threads: page([]) })], options);
		return statusLines(await pullRequestStatus(pr, fixture.deps)).find((l) => l.startsWith("review-record "));
	};

	test("is current when the section's last full SHA is the head, without comparing", async () => {
		expect(await line(`## Review\n\n- Head: ${B}\n- Low findings fixed at ${A}`)).toBe(
			`review-record current ${A}`,
		);
	});

	test("carries across a head whose diff from the base matches the reviewed head's, and not otherwise", async () => {
		const body = `## Review\n\n- Head: ${B}`;
		expect(await line(body, { diffs: { [A]: "same", [B]: "same" } })).toBe(`review-record diff-identical ${B}`);
		expect(await line(body, { diffs: { [A]: "new", [B]: "old" } })).toBe(`review-record stale ${B}`);
	});

	test("is unknown, with a warning, when GitHub cannot compare a head", async () => {
		for (const status of [406, 403]) {
			const warnings: string[] = [];
			expect(await line(`## Review\n\n- Head: ${B}`, { diffs: { [A]: status }, warnings })).toBe(
				`review-record unknown ${B}`,
			);
			expect(warnings).toHaveLength(1);
		}
	});

	test("reads only the Review section, so a SHA elsewhere names no review", async () => {
		expect(await line(`Fixes ${A}.\n\n## Review\n\nSkipped.\n\n## Models\n\n${C}`)).toBe("review-record -");
	});
});

describe("checkpoint", () => {
	const C = "c".repeat(40);
	const bot = (login: string, state: string, commit: string, minute: number) => ({
		author: { __typename: "Bot", login },
		state,
		submittedAt: `2026-10-07T12:${String(minute).padStart(2, "0")}:00Z`,
		url: `${URL_}#pullrequestreview-${minute}`,
		commit: { oid: commit },
		reactions: { nodes: [] },
	});
	const line = async (reviews: Node[]) =>
		statusLines(
			await pullRequestStatus(
				pr,
				setup([
					pull({
						checks: null,
						reviews: page(reviews),
						threads: page([]),
					}),
				]).deps,
			),
		).filter((entry) => entry.startsWith("checkpoint "));

	test("falls due when an approving reviewer's third round leaves findings on the head", async () => {
		const rounds = [
			bot("pullfrog", "CHANGES_REQUESTED", B, 1),
			bot("pullfrog", "CHANGES_REQUESTED", C, 2),
			bot("pullfrog", "CHANGES_REQUESTED", A, 3),
		];
		expect(await line(rounds)).toEqual([`checkpoint pullfrog round 3 ${URL_}#pullrequestreview-3`]);
		// An approval or a dismissed review of the head, a second review of one commit, or an unreviewed head is none.
		expect(await line([...rounds.slice(0, 2), bot("pullfrog", "APPROVED", A, 3)])).toEqual([]);
		expect(await line([...rounds.slice(0, 2), bot("pullfrog", "DISMISSED", A, 3)])).toEqual([]);
		expect(await line([...rounds.slice(0, 2), bot("pullfrog", "CHANGES_REQUESTED", C, 3)])).toEqual([]);
		expect(await line([...rounds, bot("pullfrog", "COMMENTED", A, 4)])).toEqual([
			`checkpoint pullfrog round 3 ${URL_}#pullrequestreview-4`,
		]);
		// A reviewer whose only approval a push dismissed still gates, and a comment after approving the head is none.
		const dismissed = [
			bot("pullfrog", "DISMISSED", B, 1),
			bot("pullfrog", "COMMENTED", C, 2),
			bot("pullfrog", "COMMENTED", A, 3),
		];
		expect(await line(dismissed)).toEqual([`checkpoint pullfrog round 3 ${URL_}#pullrequestreview-3`]);
		expect(
			await line([...rounds.slice(0, 2), bot("pullfrog", "APPROVED", A, 3), bot("pullfrog", "COMMENTED", A, 4)]),
		).toEqual([]);
		// The latest verdict on the head wins: a change request after an approval of it is due.
		expect(
			await line([
				...rounds.slice(0, 2),
				bot("pullfrog", "APPROVED", A, 3),
				bot("pullfrog", "CHANGES_REQUESTED", A, 4),
			]),
		).toEqual([`checkpoint pullfrog round 3 ${URL_}#pullrequestreview-4`]);
		// Every reviewer due on the head is named.
		const other = [B, C, A].map((commit, index) => bot("other", "CHANGES_REQUESTED", commit, index + 5));
		expect(await line([...rounds, ...other])).toEqual([
			`checkpoint pullfrog round 3 ${URL_}#pullrequestreview-3`,
			`checkpoint other round 3 ${URL_}#pullrequestreview-7`,
		]);
	});

	test("ignores reviewers that only comment, and people", async () => {
		const commented = [B, C, A].map((commit, index) => bot("coderabbitai", "COMMENTED", commit, index + 1));
		expect(await line(commented)).toEqual([]);
		const person = [B, C, A].map((commit, index) => ({
			...bot("alice", "CHANGES_REQUESTED", commit, index + 1),
			author: { __typename: "User", login: "alice" },
		}));
		expect(await line(person)).toEqual([]);
	});
});
