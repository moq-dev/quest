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
function pull(
	fields: {
		head?: string;
		checks?: ReturnType<typeof page> | null;
		reviews?: ReturnType<typeof page>;
		threads?: ReturnType<typeof page>;
		comments?: ReturnType<typeof page>;
		reactions?: Node[];
	} & Node = {},
) {
	const { head = A, checks, reviews, threads, comments = page([]), reactions = [], ...rest } = fields;
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
					comments,
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
	} = {},
) {
	const queries: Record<string, unknown>[] = [];
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
			const body = bodies.shift();
			if (body === undefined) throw new Error("unexpected request");
			last = body as ReturnType<typeof pull>;
			return Response.json(body);
		},
	};
	return { deps, queries, holdQueries, eventRequests, activityRequests };
}

test("reports checks by requiredness, each reviewer's latest review against the head, and open threads", async () => {
	const fixture = setup([
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
				{ __typename: "StatusContext", context: "deploy", state: "EXPECTED", targetUrl: "", isRequired: true },
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
	]);
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
		"auto-merge -",
		"merge-queue -",
		"landing-stopped -",
		"checks failure passed=2 failing=3 pending=2",
		"check failing required failure https://github.com/example/project/actions/runs/1/job/lint lint",
		"check failing optional cancelled https://github.com/example/project/actions/runs/1/job/docs docs",
		"check failing optional error - ci/legacy",
		"check pending required in_progress https://github.com/example/project/actions/runs/1/job/test test",
		"check pending required expected - deploy",
		"review-rounds 2 -",
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
	expect(statusLines(status).slice(2, 11)).toEqual([
		"draft true",
		`head ${A}`,
		"mergeable mergeable",
		"merge-state blocked",
		"review-decision -",
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

test("review rounds count distinct submitted commits since the latest design marker across every comment page", async () => {
	const marker = (id: number, time: string, body = "Design change: simpler boundary") => ({
		body,
		createdAt: time,
		url: `${URL_}#issuecomment-${id}`,
		author: { login: "maintainer" },
	});
	const fixture = setup([
		pull({
			checks: null,
			threads: page([]),
			reviews: page([
				review("alice", "APPROVED", A, 1),
				review("bob", "COMMENTED", B, 4),
				review("alice", "COMMENTED", B, 5),
				review("pending", "PENDING", A, 6),
			]),
			comments: page([marker(1, "2026-10-07T12:00:00Z")], "comments-next"),
		}),
		pull({
			comments: page([marker(2, "2026-10-07T12:03:00Z"), marker(3, "2026-10-07T12:06:00Z", "A normal comment")]),
		}),
	]);
	const status = await pullRequestStatus(pr, fixture.deps);
	expect(status.reviewRounds).toEqual({
		count: 1,
		since: { at: "2026-10-07T12:03:00Z", actor: "maintainer", url: `${URL_}#issuecomment-2` },
	});
	expect(statusLines(status)).toContain(`review-rounds 1 2026-10-07T12:03:00Z maintainer ${URL_}#issuecomment-2`);
	expect(fixture.queries[1]).toMatchObject({
		comments: "comments-next",
		moreComments: true,
		moreReviews: false,
		moreChecks: false,
		moreThreads: false,
	});
});

const holdEvent = (id: string, label: string, at = "2026-10-07T11:00:00Z") => ({
	__typename: "LabeledEvent",
	id,
	createdAt: at,
	label: { name: label },
});

test("reports the latest acquisition, age, and verified paged event URL for each hold label", async () => {
	const label = "quest:iterate";
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
		pull({ checks: null, reviews: page([]), threads: page([]), labels: { nodes: [{ name: "quest:ready" }] } }),
	]);
	const status = await pullRequestStatus(pr, fixture.deps);
	expect(status.holds).toEqual([{ label: "quest:ready", token: null, takenAt: null, age: null, eventUrl: null }]);
	expect(statusLines(status)).toContain("hold quest:ready - - - unknown age");
	expect(fixture.eventRequests).toEqual([]);
});

test("never attaches a URL from a different label or event to a hold token", async () => {
	const body = pull({
		checks: null,
		reviews: page([]),
		threads: page([]),
		labels: { nodes: [{ name: "quest:merge" }] },
	});
	const fixture = setup([body], {
		holdFields: { timelineItems: { nodes: [holdEvent("token", "quest:merge")] } },
		eventPages: [{ rows: [{ node_id: "token", event: "labeled", label: { name: "bug" }, url: "wrong" }] }],
	});
	expect((await pullRequestStatus(pr, fixture.deps)).holds[0].eventUrl).toBeNull();
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
	for (const change of [{ body: "## Decisions needed\n\nChoose one." }, { state: "CLOSED" }, { state: "MERGED" }]) {
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
