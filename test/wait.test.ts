import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { main } from "../src/cli/main";
import { type GitHubDependencies, GitHubInputError, pullRequest } from "../src/cli/github";
import { waitForActivity, WaitTimeout } from "../src/cli/wait";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const POINT = "2026-10-07T12:00:00Z";
const pr = { owner: "example", repo: "project", number: 1 };
const base = "/repos/example/project";
const timeline = `${base}/issues/1/timeline?per_page=100`;
/** The GitHub Actions app, which reports workflow check runs. */
const ACTIONS = 15368;

function response(body: unknown, headers?: Record<string, string>, status = 200): Response {
	return new Response(status === 304 ? null : JSON.stringify(body), { status, headers });
}

function pull(headRepo: unknown = { full_name: "contributor/fork" }, sha = A) {
	return response({ base: { sha: C }, head: { sha, ref: "feature/a", repo: headRepo } });
}

function pushed(after = A, time = POINT, type = "push") {
	return { activity_type: type, after, timestamp: time, actor: { login: "author" } };
}

function committed(sha: string) {
	return {
		event: "committed",
		sha,
		committer: { name: "A Person", date: "2000-01-01T00:00:00Z" },
		html_url: `https://github.com/example/project/commit/${sha}`,
	};
}

function reviewed(id = 1, time = POINT) {
	return {
		event: "reviewed",
		id,
		submitted_at: time,
		user: { login: "reviewer" },
		html_url: `https://github.com/example/project/pull/1#pullrequestreview-${id}`,
	};
}

function reactions(
	pull: unknown[] = [],
	reviews: unknown[] = [],
	page: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null },
) {
	return response({
		data: {
			viewer: { login: "waiter" },
			repository: { pullRequest: { reactions: { nodes: pull }, reviews: { pageInfo: page, nodes: reviews } } },
		},
	});
}

function reacted(id: string, time = POINT, login = "codex[bot]", content = "THUMBS_UP") {
	return { id, content, createdAt: time, user: { login } };
}

function replied(id: number, time = POINT, login = "reviewer", inReplyTo: number | null = 1) {
	return {
		id,
		in_reply_to_id: inReplyTo,
		created_at: time,
		user: { login },
		html_url: `https://github.com/example/project/pull/1#discussion_r${id}`,
	};
}

interface CheckFixture {
	name: string;
	required?: boolean;
	/** A check run's conclusion, or a commit status's state; omitted while it runs. */
	result?: string;
	time?: string;
	status?: boolean;
	/** The workflow file a job runs in, and whether its run is still going, so it may yet create jobs. */
	workflow?: string;
	running?: boolean;
}

/** The head's checks; `null` means the head has no checks at all. */
function checks(
	contexts: CheckFixture[] | null = null,
	head = A,
	page: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null },
	listed = head,
	extra: Record<string, unknown> = {},
) {
	const node = (entry: CheckFixture) =>
		entry.status
			? {
					__typename: "StatusContext",
					context: entry.name,
					state: entry.result ?? "PENDING",
					createdAt: entry.time ?? POINT,
					targetUrl: null,
					isRequired: entry.required ?? false,
				}
			: {
					__typename: "CheckRun",
					name: entry.name,
					status: entry.result ? "COMPLETED" : "IN_PROGRESS",
					conclusion: entry.result ?? null,
					completedAt: entry.result ? (entry.time ?? POINT) : null,
					detailsUrl: `https://github.com/example/project/actions/runs/1/job/${entry.name.length}`,
					isRequired: entry.required ?? false,
					checkSuite: {
						status: entry.result && !entry.running ? "COMPLETED" : "IN_PROGRESS",
						workflowRun: { file: { path: entry.workflow ?? ".github/workflows/check.yml" } },
					},
				};
	return response({
		data: {
			repository: {
				pullRequest: {
					baseRefName: "main",
					headRefOid: head,
					...extra,
					commits: {
						nodes: [
							{
								commit: {
									oid: listed,
									statusCheckRollup: contexts && {
										contexts: { pageInfo: page, nodes: contexts.map(node) },
									},
								},
							},
						],
					},
				},
			},
		},
	});
}

/**
 * Review comments, reactions, and checks come from their own queues, empty once drained.
 * The base branch requires `protected` through branch protection and `ruled` through rulesets,
 * reported by GitHub Actions. `rules` adds further rules on a second page.
 */
function setup(
	responses: Response[],
	baseline = [A],
	side: {
		comments?: Response[];
		edits?: Response[];
		graphql?: Response[];
		checks?: Response[];
		protected?: string[];
		/** Classic protection that lists only `contexts`, without `checks`. */
		contextsOnly?: boolean;
		ruled?: string[];
		rules?: unknown[];
	} = {},
) {
	let now = Date.parse("2026-10-07T12:10:00Z");
	const calls: { path: string; headers: Headers }[] = [];
	const sideCalls: { path: string; headers: Headers; body?: unknown }[] = [];
	const checkCalls: { path: string; headers: Headers; body?: unknown }[] = [];
	const editCalls: { path: string; headers: Headers }[] = [];
	const ruleCalls: { path: string; headers: Headers }[] = [];
	const sleeps: number[] = [];
	const warnings: string[] = [];
	const deps: GitHubDependencies = {
		token: "test-token",
		now: () => now,
		sleep: async (ms) => {
			sleeps.push(ms);
			now += ms;
		},
		warn: (text) => warnings.push(text),
		fetch: async (url, init) => {
			const parsed = new URL(String(url));
			const call = { path: parsed.pathname + parsed.search, headers: new Headers(init?.headers) };
			if (parsed.pathname.endsWith("/issues/1/comments")) {
				editCalls.push(call);
				return side.edits?.shift() ?? response([]);
			}
			if (parsed.pathname.endsWith("/pulls/1/comments")) {
				sideCalls.push(call);
				return side.comments?.shift() ?? response([]);
			}
			if (parsed.pathname === "/graphql") {
				const body = JSON.parse(String(init?.body)) as { query: string };
				if (body.query.includes("statusCheckRollup")) {
					checkCalls.push({ ...call, body });
					return side.checks?.shift() ?? checks();
				}
				sideCalls.push({ ...call, body });
				return side.graphql?.shift() ?? reactions();
			}
			if (parsed.pathname === `${base}/branches/main`) {
				ruleCalls.push(call);
				const contexts = side.protected ?? [];
				const checks = contexts.map((context) => ({ context, app_id: null }));
				const level = contexts.length ? "everyone" : "off";
				return response({
					protection: {
						enabled: contexts.length > 0,
						required_status_checks: side.contextsOnly
							? { enforcement_level: level, contexts }
							: { enforcement_level: level, checks },
					},
				});
			}
			if (parsed.pathname === `${base}/rules/branches/main`) {
				ruleCalls.push(call);
				if (parsed.searchParams.get("page") === "2") return response(side.rules);
				const checks = (side.ruled ?? []).map((context) => ({ context, integration_id: ACTIONS }));
				const next = `<https://api.github.com${base}/rules/branches/main?per_page=100&page=2>; rel="next"`;
				return response(
					[
						{ type: "deletion" },
						...(checks.length
							? [{ type: "required_status_checks", parameters: { required_status_checks: checks } }]
							: []),
					],
					side.rules ? { link: next } : undefined,
				);
			}
			calls.push(call);
			if (parsed.pathname.endsWith("/commits")) return response(baseline.map((sha) => ({ sha })));
			const next = responses.shift();
			if (!next) throw new Error(`unexpected request: ${parsed.pathname + parsed.search}`);
			return next;
		},
	};
	return { deps, calls, sideCalls, checkCalls, editCalls, ruleCalls, sleeps, warnings, responses };
}

function graphql(fixture: ReturnType<typeof setup>) {
	return fixture.sideCalls
		.filter((call) => call.path === "/graphql")
		.map((call) => call.body as { variables: Record<string, unknown> });
}

function cursor(lines: string[]): string {
	return lines.at(-1)!.split(" ").at(-1)!;
}

test("default point includes reviews already submitted on the current head and uses the fork's push time", async () => {
	const fixture = setup([pull(), response([pushed()]), response([committed(A), reviewed()])]);
	const lines = await waitForActivity(pr, {}, fixture.deps);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(
		/^2026-10-07T12:00:00Z reviewed reviewer https:\/\/github.com\/example\/project\/pull\/1#pullrequestreview-1 q1\./,
	);
	expect(fixture.calls.map((call) => call.path)).toEqual([
		`${base}/pulls/1`,
		`${base}/pulls/1/commits?per_page=100`,
		"/repos/contributor/fork/activity?ref=feature%2Fa&per_page=100",
		timeline,
	]);
	expect(fixture.calls.every((call) => call.headers.get("authorization") === "Bearer test-token")).toBe(true);
	expect(fixture.sleeps).toEqual([]);
});

test("a plain push is detected by new SHA regardless of git dates, with conditional polling", async () => {
	const fixture = setup(
		[
			pull(),
			response([pushed()]),
			response([committed(A)], { etag: '"old"' }),
			response(null, {}, 304),
			response([committed(A), committed(B)]),
		],
		[A],
	);
	const lines = await waitForActivity(pr, {}, fixture.deps);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(new RegExp(`^${B} committed A_Person `));
	expect(fixture.sleeps).toEqual([300_000, 300_000]);
	expect(fixture.calls[4].headers.get("if-none-match")).toBe('"old"');
	expect(fixture.calls[5].headers.get("if-none-match")).toBe('"old"');
});

test("force pushes, comments, inline comments, merges, closes and dequeues are printed without reviewer policy", async () => {
	const event = (event: string, id: number) => ({ event, id, created_at: POINT, actor: { login: "bot[bot]" } });
	const fixture = setup([
		pull(),
		response([pushed()]),
		response([
			event("head_ref_force_pushed", 1),
			event("commented", 2),
			{
				event: "line-commented",
				comments: [
					{
						id: 3,
						created_at: POINT,
						user: { login: "person" },
						html_url: "https://github.com/example/project/pull/1#discussion_r3",
					},
				],
			},
			{ event: "commit-commented", comments: [{ id: 4, created_at: POINT, user: null }] },
			event("merged", 5),
			event("closed", 6),
			event("removed_from_merge_queue", 7),
			event("auto_merge_disabled", 8),
			event("added_to_merge_queue", 9),
			event("auto_merge_enabled", 10),
		]),
	]);
	const lines = await waitForActivity(pr, {}, fixture.deps);
	expect(lines.map((line) => line.split(" ")[1])).toEqual([
		"head_ref_force_pushed",
		"commented",
		"line-commented",
		"commit-commented",
		"merged",
		"closed",
		"removed_from_merge_queue",
		"auto_merge_disabled",
	]);
});

test("label changes wake the waiter by label name, except the waiter's own", async () => {
	const label = (event: string, id: number, name: string, login: string) => ({
		event,
		id,
		created_at: POINT,
		actor: { login },
		label: { name, color: "ffffff" },
	});
	const fixture = setup([
		pull(),
		response([pushed()]),
		response([label("labeled", 1, "merge", "waiter")], { etag: '"t"' }),
		response([
			label("labeled", 1, "merge", "waiter"),
			label("unlabeled", 2, "merge", "github-actions[bot]"),
			label("labeled", 3, "needs review", "person"),
		]),
	]);
	const lines = await waitForActivity(pr, {}, fixture.deps);
	expect(lines.map((line) => line.split(" ").slice(0, 4).join(" "))).toEqual([
		"2026-10-07T12:00:00Z unlabeled:merge github-actions[bot] https://github.com/example/project/pull/1",
		"2026-10-07T12:00:00Z labeled:needs_review person https://github.com/example/project/pull/1",
	]);
	expect(fixture.sleeps).toEqual([300_000]);
});

test("a resume cursor catches same-second activity without replaying events or commits", async () => {
	const first = setup([pull(), response([pushed()]), response([committed(A), reviewed(1)])]);
	const point = cursor(await waitForActivity(pr, {}, first.deps));
	const second = setup([response([committed(A), reviewed(1), reviewed(2), committed(B)])]);
	const lines = await waitForActivity(pr, { since: point }, second.deps);
	expect(lines).toHaveLength(2);
	expect(lines[0].split(" ")).toHaveLength(4);
	expect(lines[1].split(" ")).toHaveLength(5);
	expect(lines.some((line) => line.includes("review-1"))).toBe(false);
	expect(lines.some((line) => line.startsWith(B))).toBe(true);
	const third = setup([response([committed(A), reviewed(1), reviewed(2), committed(B), committed(C)])]);
	const later = await waitForActivity(pr, { since: cursor(lines) }, third.deps);
	expect(later).toHaveLength(1);
	expect(later[0]).toMatch(new RegExp(`^${C} committed `));
});

test("historical timestamp and SHA starts detect pushes through repository activity, not git dates", async () => {
	for (const since of [POINT, A.slice(0, 7)]) {
		const fixture = setup(
			[
				pull(undefined, B),
				response([pushed(B, "2026-10-07T12:05:00Z"), pushed(A, "2026-10-07T11:59:00Z")]),
				response([committed(A), committed(B)]),
			],
			[A, B],
		);
		const lines = await waitForActivity(pr, { since }, fixture.deps);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(
			`2026-10-07T12:05:00Z pushed author https://github.com/contributor/fork/commit/${B}`,
		);
	}
});

test("an explicit timestamp includes a push at that instant", async () => {
	const fixture = setup([pull(undefined, B), response([pushed(B)]), response([committed(A), committed(B)])], [A, B]);
	const lines = await waitForActivity(pr, { since: POINT }, fixture.deps);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain(`${POINT} pushed author https://github.com/contributor/fork/commit/${B}`);
});

function forcePushed(sha: string, time: string) {
	return { event: "head_ref_force_pushed", id: 9, commit_id: sha, created_at: time, actor: { login: "author" } };
}

test("a historical force push prints once, from the timeline", async () => {
	const fixture = setup(
		[
			pull(undefined, B),
			response([pushed(B, "2026-10-07T12:05:00Z", "force_push"), pushed(A, "2026-10-07T11:59:00Z")]),
			response([committed(B), forcePushed(B, "2026-10-07T12:05:02Z")]),
		],
		[B],
	);
	const lines = await waitForActivity(pr, { since: POINT }, fixture.deps);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(/^2026-10-07T12:05:02Z head_ref_force_pushed author /);
});

test("the force push that created the starting head is not activity, even after resuming", async () => {
	const later = reviewed(2, "2026-10-07T12:06:00Z");
	const first = setup(
		[
			pull(undefined, B),
			response([pushed(B, "2026-10-07T12:05:00Z", "force_push")]),
			response([committed(B), reviewed(1, "2026-10-07T12:05:01Z"), forcePushed(B, "2026-10-07T12:05:02Z")]),
		],
		[B],
	);
	const lines = await waitForActivity(pr, {}, first.deps);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain("review-1");
	const second = setup([
		response([committed(B), reviewed(1, "2026-10-07T12:05:01Z"), forcePushed(B, "2026-10-07T12:05:02Z"), later]),
	]);
	const resumed = await waitForActivity(pr, { since: cursor(lines) }, second.deps);
	expect(resumed).toHaveLength(1);
	expect(resumed[0]).toContain("review-2");
});

test("a timed-out wait prints a cursor that still reports a push landing before the retry", async () => {
	const first = setup([pull(), response([pushed()]), response([committed(A)])]);
	const timeout = await waitForActivity(pr, { timeout: 10 }, first.deps).catch((error: unknown) => error);
	expect(timeout).toBeInstanceOf(WaitTimeout);
	const point = (timeout as WaitTimeout).cursor!;
	expect(point).toMatch(/^q1\./);
	// Rerunning without the cursor would take B as its starting head and stay silent.
	const second = setup([response([committed(A), committed(B)])]);
	const lines = await waitForActivity(pr, { since: point }, second.deps);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(new RegExp(`^${B} committed `));
	expect(second.calls.map((call) => call.path)).toEqual([timeline]);
});

test("a wait timed out during setup resumes from the head it read, so a later push is reported", async () => {
	const first = setup([pull(), response({ message: "rate limit" }, { "retry-after": "120" }, 429)]);
	const timeout = await waitForActivity(pr, { timeout: 10 }, first.deps).catch((error: unknown) => error);
	expect(timeout).toMatchObject({ cursor: A });
	const second = setup(
		[
			pull(undefined, B),
			response([pushed(B, "2026-10-07T12:05:00Z"), pushed()]),
			response([committed(A), committed(B)]),
		],
		[A, B],
	);
	const lines = await waitForActivity(pr, { since: (timeout as WaitTimeout).cursor }, second.deps);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(/^2026-10-07T12:05:00Z pushed author /);
});

test("a later force push back to a SHA pushed before the starting point is activity", async () => {
	const fixture = setup(
		[
			pull(undefined, B),
			response([
				pushed(B, "2026-10-07T12:05:00Z", "force_push"),
				pushed(A, "2026-10-07T11:00:00Z", "force_push"),
			]),
			response([
				committed(B),
				forcePushed(A, "2026-10-07T11:00:01Z"),
				forcePushed(B, "2026-10-07T12:05:02Z"),
				{ ...forcePushed(A, "2026-10-07T12:30:00Z"), id: 10 },
			]),
		],
		[B],
	);
	const lines = await waitForActivity(pr, { since: "2026-10-07T11:30:00Z" }, fixture.deps);
	expect(lines.map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual([
		"2026-10-07T12:05:02Z head_ref_force_pushed",
		"2026-10-07T12:30:00Z head_ref_force_pushed",
	]);
});

test("a push racing setup prints once, as a push", async () => {
	const fixture = setup([
		pull(),
		response([pushed(B, "2026-10-07T12:05:00Z"), pushed()]),
		response([committed(A), committed(B)]),
	]);
	const lines = await waitForActivity(pr, {}, fixture.deps);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(/^2026-10-07T12:05:00Z pushed author /);
});

test("all initial timeline pages are read, and the last known page is polled before following rollover", async () => {
	const page2 = `https://api.github.com${timeline}&page=2`;
	const page3 = `https://api.github.com${timeline}&page=3`;
	const fixture = setup([
		pull(),
		response([pushed()]),
		response([committed(A)], { link: `<${page2}>; rel="next", <${page2}>; rel="last"` }),
		response([], { etag: '"tail"' }),
		response([], { link: `<${page3}>; rel="next"` }),
		response([reviewed()]),
	]);
	const lines = await waitForActivity(pr, {}, fixture.deps);
	expect(lines).toHaveLength(1);
	expect(fixture.calls.slice(3).map((call) => call.path)).toEqual([
		timeline,
		`${timeline}&page=2`,
		`${timeline}&page=2`,
		`${timeline}&page=3`,
	]);
	expect(fixture.calls.at(-1)!.headers.has("if-none-match")).toBe(false);
});

test("a full last page is reread whole, since a 304 cannot show that a next page appeared", async () => {
	const subscribed = Array.from({ length: 99 }, (_, id) => ({ event: "subscribed", id, created_at: POINT }));
	const full = [committed(A), ...subscribed];
	const page2 = `https://api.github.com${timeline}&page=2`;
	const fixture = setup([
		pull(),
		response([pushed()]),
		response(full, { etag: '"full"' }),
		response(full, { etag: '"full"', link: `<${page2}>; rel="next"` }),
		response([reviewed(1, "2026-10-07T12:12:00Z")]),
	]);
	const lines = await waitForActivity(pr, {}, fixture.deps);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(/^2026-10-07T12:12:00Z reviewed /);
	expect(fixture.calls[4].headers.has("if-none-match")).toBe(false);
});

test("a review landing after the last scheduled poll is reported by a final poll before the timeout", async () => {
	// 540 s polls at 0 and 300 s; the final poll at 510 s reads a review from 480 s.
	const fixture = setup([
		pull(),
		response([pushed()]),
		response([committed(A)], { etag: '"e"' }),
		response(null, {}, 304),
		response([committed(A), reviewed(1, "2026-10-07T12:18:00Z")]),
	]);
	const lines = await waitForActivity(pr, { timeout: 540 }, fixture.deps);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(/^2026-10-07T12:18:00Z reviewed /);
	expect(fixture.sleeps).toEqual([300_000, 210_000]);
});

test("a review landing after the final poll is left for the timeout's cursor, never dropped", async () => {
	const first = setup([
		pull(),
		response([pushed()]),
		response([committed(A)], { etag: '"e"' }),
		response(null, {}, 304),
		response(null, {}, 304),
	]);
	const timeout = await waitForActivity(pr, { timeout: 540 }, first.deps).catch((error: unknown) => error);
	expect(timeout).toBeInstanceOf(WaitTimeout);
	expect(first.sleeps).toEqual([300_000, 210_000, 30_000]);
	const second = setup([response([committed(A), reviewed(1, "2026-10-07T12:18:50Z")])]);
	const lines = await waitForActivity(pr, { since: (timeout as WaitTimeout).cursor }, second.deps);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(/^2026-10-07T12:18:50Z reviewed /);
});

test("older initial pages are not skipped even when the last page has no recent activity", async () => {
	const page2 = `https://api.github.com${timeline}&page=2`;
	const fixture = setup(
		[
			pull(),
			response([pushed()]),
			response([reviewed(), committed(A)], { link: `<${page2}>; rel="next"` }),
			response([committed(B)]),
		],
		[B, A],
	);
	const lines = await waitForActivity(pr, {}, fixture.deps);
	expect(lines).toHaveLength(1);
	expect(fixture.calls).toHaveLength(5);
});

test("GitHub errors and malformed successful bodies never become activity", async () => {
	for (const bad of [
		response({ message: "bad credentials" }, {}, 401),
		response({ message: "not an array" }),
		response([{ event: "reviewed", id: 1, submitted_at: "yesterday" }]),
	]) {
		const fixture = setup([pull(), response([pushed()]), bad]);
		await expect(waitForActivity(pr, {}, fixture.deps)).rejects.toThrow();
		expect(fixture.sleeps).toEqual([]);
	}
});

test("rate limits honor Retry-After and then exponentially back off", async () => {
	const fixture = setup([
		response({ message: "rate limit exceeded" }, { "retry-after": "120" }, 429),
		response({ message: "secondary rate limit" }, {}, 403),
		pull(),
		response([pushed()]),
		response([reviewed()]),
	]);
	await waitForActivity(pr, {}, fixture.deps);
	expect(fixture.sleeps).toEqual([120_000, 120_000]);
	expect(fixture.warnings).toHaveLength(2);
});

test("primary rate limit reset and server poll intervals are honored", async () => {
	const reset = Date.parse("2026-10-07T12:11:00Z") / 1000;
	const fixture = setup([
		response(
			{ message: "API rate limit exceeded" },
			{ "x-ratelimit-remaining": "0", "x-ratelimit-reset": `${reset}` },
			403,
		),
		pull(),
		response([pushed()]),
		response([], { "x-poll-interval": "600" }),
		response([reviewed()]),
	]);
	await waitForActivity(pr, {}, fixture.deps);
	expect(fixture.sleeps).toEqual([60_000, 600_000]);
});

test("a server poll interval past the final poll skips it rather than polling early", async () => {
	// A 600 s X-Poll-Interval outlasts a 540 s timeout, so no final poll runs at 510 s.
	const fixture = setup([pull(), response([pushed()]), response([], { "x-poll-interval": "600" })]);
	await expect(waitForActivity(pr, { timeout: 540 }, fixture.deps)).rejects.toBeInstanceOf(WaitTimeout);
	expect(fixture.sleeps).toEqual([540_000]);
});

test("persistent rate limiting eventually fails loudly instead of masking an error", async () => {
	const fixture = setup(Array.from({ length: 7 }, () => response({ message: "secondary rate limit" }, {}, 403)));
	await expect(waitForActivity(pr, {}, fixture.deps)).rejects.toThrow("rate limit persisted");
	expect(fixture.sleeps).toEqual([60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000]);
});

test("a permission-denied 403 fails without rate-limit retries", async () => {
	const fixture = setup([response({ message: "Resource not accessible by integration" }, {}, 403)]);
	await expect(waitForActivity(pr, {}, fixture.deps)).rejects.toThrow("HTTP 403");
	expect(fixture.sleeps).toEqual([]);
});

test("timeout is distinct and limits both poll sleeps and rate-limit waits", async () => {
	for (const responses of [
		[pull(), response([pushed()]), response([])],
		[response({ message: "rate limit" }, { "retry-after": "120" }, 429)],
	]) {
		const fixture = setup(responses);
		await expect(waitForActivity(pr, { timeout: 10 }, fixture.deps)).rejects.toBeInstanceOf(WaitTimeout);
		expect(fixture.sleeps).toEqual([10_000]);
	}
	// A deadline before the PR is read can only hand back the starting point it was given.
	const setupLimited = setup([response({ message: "rate limit" }, { "retry-after": "120" }, 429)]);
	await expect(waitForActivity(pr, { since: POINT, timeout: 10 }, setupLimited.deps)).rejects.toMatchObject({
		cursor: POINT,
	});
});

test("a head GitHub has yet to list is waited for, then starts at its listed push time", async () => {
	const fixture = setup([
		pull(),
		response([pushed(B, "2026-10-07T11:50:00Z")]),
		response([pushed(B, "2026-10-07T11:50:00Z")]),
		response([pushed(), pushed(B, "2026-10-07T11:50:00Z")]),
		response([committed(A), reviewed(1, "2026-10-07T11:55:00Z"), reviewed(2)]),
	]);
	const lines = await waitForActivity(pr, {}, fixture.deps);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain("pullrequestreview-2 q1.");
	expect(fixture.sleeps).toEqual([15_000, 15_000]);
	expect(fixture.warnings).toEqual([`GitHub has not listed the push of ${A} yet; waiting for it`]);
});

test("a timeout while GitHub has yet to list the head resumes from that head", async () => {
	const fixture = setup([pull(), response([]), response([])]);
	const timeout = await waitForActivity(pr, { timeout: 20 }, fixture.deps).catch((error: unknown) => error);
	expect(timeout).toBeInstanceOf(WaitTimeout);
	expect(timeout).toMatchObject({ cursor: A });
});

test("unresolvable pushed SHA fails with a timestamp recommendation", async () => {
	const fixture = setup([pull(), response([pushed()])]);
	await expect(waitForActivity(pr, { since: B }, fixture.deps)).rejects.toThrow("pass a timestamp with --since");
});

test("SHA lookup paginates repository activity", async () => {
	const fixture = setup(
		[
			pull(undefined, B),
			response([pushed(B, "2026-10-07T12:05:00Z")], {
				link: '<https://api.github.com/repos/contributor/fork/activity?page=2>; rel="next"',
			}),
			response([pushed()]),
			response([committed(A), committed(B)]),
		],
		[A, B],
	);
	const lines = await waitForActivity(pr, { since: A }, fixture.deps);
	expect(lines[0]).toContain("pushed author");
	expect(fixture.calls[3].path).toBe("/repos/contributor/fork/activity?page=2");
});

test("deleted forks accept timestamps but cannot guess SHA push times", async () => {
	const missing = setup([pull(null)]);
	await expect(waitForActivity(pr, {}, missing.deps)).rejects.toThrow("pass a timestamp");
	const timestamp = setup([pull(null), response([reviewed()])]);
	expect(await waitForActivity(pr, { since: POINT }, timestamp.deps)).toHaveLength(1);
});

test("untrusted pagination cannot leak an authorization token", async () => {
	const fixture = setup([
		pull(),
		response([pushed()]),
		response([], { link: '<https://evil.example/timeline>; rel="next"' }),
	]);
	await expect(waitForActivity(pr, {}, fixture.deps)).rejects.toThrow("pagination URL");
	expect(fixture.calls).toHaveLength(4);
});

test("malformed and wrong-PR cursors fail without requests", async () => {
	const first = setup([pull(), response([pushed()]), response([reviewed()])]);
	const other = cursor(await waitForActivity(pr, {}, first.deps));
	for (const point of ["q1.garbage", other]) {
		const fixture = setup([]);
		await expect(waitForActivity({ ...pr, number: 2 }, { since: point }, fixture.deps)).rejects.toThrow(
			"invalid --since cursor",
		);
		expect(fixture.calls).toEqual([]);
	}
	const recased = setup([]);
	await expect(waitForActivity(pr, { since: `Q1.${other.slice(3)}` }, recased.deps)).rejects.toThrow(
		"cursors start with lower-case q1.",
	);
	expect(recased.calls).toEqual([]);
});

test("PR URL parsing and timeout usage fail before authentication", () => {
	expect(pullRequest("https://github.com/example/project/pull/123", ".")).toEqual({
		owner: "example",
		repo: "project",
		number: 123,
	});
	expect(() => pullRequest("https://evil.example/example/project/pull/1", ".")).toThrow("GitHub pull request");
	for (const timeout of ["0", "-1", "NaN", "Infinity", "2147484"]) {
		const output = { stdout: () => {}, stderr: () => {} };
		expect(main(["wait", "1", "--timeout", timeout], output)).toBe(2);
	}
});

test("a bare PR number outside a checkout says to pass the URL instead", () => {
	const outside = mkdtempSync(join(tmpdir(), "quest-wait-"));
	try {
		expect(() => pullRequest("1", outside)).toThrow(GitHubInputError);
		expect(() => pullRequest("1", outside)).toThrow("pass the full GitHub PR URL, or run inside a checkout");
	} finally {
		rmSync(outside, { recursive: true });
	}
});

test("auto-merge left on a moved head wakes the wait once per head, naming the head it was enabled on", async () => {
	const pinned = (head: string) =>
		checks([], head, undefined, head, {
			headRefName: "feature/a",
			headRepository: { nameWithOwner: "contributor/fork" },
			autoMergeRequest: {
				enabledAt: POINT,
				commitBody: `Quest-Land-Head: ${A}`,
				enabledBy: { login: "kixelated" },
			},
		});
	const first = setup([pull(undefined, B), response([pushed(B)]), response([committed(A), committed(B)])], [A, B], {
		checks: [pinned(B)],
	});
	const moved = await waitForActivity(pr, {}, first.deps);
	expect(moved).toHaveLength(1);
	expect(moved[0]).toMatch(
		new RegExp(
			`^2026-10-07T12:10:00.000Z auto-merge:moved kixelated https://github.com/example/project/pull/1/commits/${A} q1\\.`,
		),
	);
	// Resuming reports other activity, not the same moved head again.
	const next = setup([response([committed(A), committed(B), reviewed(2, LATEST)])], [A, B], { checks: [pinned(B)] });
	const lines = await waitForActivity(pr, { since: cursor(moved) }, next.deps);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(/ reviewed reviewer /);
});

test("auto-merge on the current head is not activity", async () => {
	const current = () =>
		checks([], A, undefined, A, {
			autoMergeRequest: {
				enabledAt: POINT,
				commitBody: `Quest-Land-Head: ${A}`,
				enabledBy: { login: "kixelated" },
			},
		});
	const fixture = setup([pull(), response([pushed()]), response([committed(A)]), response([committed(A)])], [A], {
		checks: [current(), current()],
	});
	await expect(waitForActivity(pr, { timeout: 60 }, fixture.deps)).rejects.toBeInstanceOf(WaitTimeout);
});

test("a push racing initial setup is not swallowed by the baseline", async () => {
	const fixture = setup([pull(), response([pushed()]), response([committed(A), committed(B)])]);
	const lines = await waitForActivity(pr, {}, fixture.deps);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(new RegExp(`^${B} committed `));
	expect(fixture.sleeps).toEqual([]);
});

test("a changed head during the commit listing fails rather than swallowing a push", async () => {
	const fixture = setup([pull()], [A, B]);
	await expect(waitForActivity(pr, {}, fixture.deps)).rejects.toThrow("head changed during setup");
	expect(fixture.calls).toHaveLength(2);
});

test("malformed timestamps and unexpected 304 responses fail without phantom activity", async () => {
	const invalid = setup([]);
	await expect(waitForActivity(pr, { since: "yesterday" }, invalid.deps)).rejects.toThrow("invalid timestamp");
	expect(invalid.calls).toHaveLength(0);
	const cached = setup([pull(), response([pushed()]), response(null, {}, 304)]);
	await expect(waitForActivity(pr, {}, cached.deps)).rejects.toThrow("without a cached response");
});

test("a clean review's reaction on the PR body ends the wait", async () => {
	const fixture = setup([pull(), response([pushed()]), response([committed(A)])], [A], {
		graphql: [reactions([reacted("r1", "2026-10-07T12:05:00Z")])],
	});
	const lines = await waitForActivity(pr, {}, fixture.deps);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(
		/^2026-10-07T12:05:00Z reacted:thumbs_up codex\[bot\] https:\/\/github.com\/example\/project\/pull\/1 q1\./,
	);
	expect(graphql(fixture)[0]).toMatchObject({ variables: { owner: "example", repo: "project", number: 1 } });
});

test("reactions on reviews are read from every page of reviews", async () => {
	const review = (id: number, nodes: unknown[]) => ({
		url: `https://github.com/example/project/pull/1#pullrequestreview-${id}`,
		reactions: { nodes },
	});
	const fixture = setup([pull(), response([pushed()]), response([committed(A)])], [A], {
		graphql: [
			reactions([], [review(1, [])], { hasNextPage: true, endCursor: "next" }),
			reactions([], [review(2, [reacted("r2", POINT, "author", "EYES")])]),
		],
	});
	const lines = await waitForActivity(pr, {}, fixture.deps);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain("reacted:eyes author https://github.com/example/project/pull/1#pullrequestreview-2");
	expect(graphql(fixture).map((body) => body.variables.after)).toEqual([null, "next"]);
});

test("a review-thread reply wakes the waiter, but its own activity and a thread's first comment do not", async () => {
	const fixture = setup([pull(), response([pushed()]), response([committed(A)]), response([committed(A)])], [A], {
		comments: [
			response([replied(1, POINT, "reviewer", null), replied(2, POINT, "waiter")], { etag: '"c"' }),
			response([replied(1, POINT, "reviewer", null), replied(2, POINT, "waiter"), replied(3)]),
		],
		graphql: [reactions([reacted("r1", POINT, "waiter")]), reactions([reacted("r1", POINT, "waiter")])],
	});
	const lines = await waitForActivity(pr, {}, fixture.deps);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(
		/^2026-10-07T12:00:00Z replied reviewer https:\/\/github.com\/example\/project\/pull\/1#discussion_r3 q1\./,
	);
	expect(fixture.sleeps).toEqual([300_000]);
	const comments = fixture.sideCalls.filter((call) => call.path.includes("/comments"));
	expect(comments.map((call) => call.path)).toEqual([
		`${base}/pulls/1/comments?per_page=100&since=2026-10-07T11:59:59.000Z`,
		`${base}/pulls/1/comments?per_page=100&since=2026-10-07T11:59:59.000Z`,
	]);
	expect(comments[1].headers.get("if-none-match")).toBe('"c"');
});

test("resuming tracks replies and reactions separately, so neither replays nor hides the other", async () => {
	const first = setup([pull(), response([pushed()]), response([committed(A)])], [A], {
		graphql: [reactions([reacted("r1", "2026-10-07T12:05:00Z")])],
	});
	const point = cursor(await waitForActivity(pr, {}, first.deps));
	// A reply older than the reaction, first visible after the waiter returned.
	const second = setup([response([committed(A)])], [A], {
		comments: [response([replied(2, "2026-10-07T12:03:00Z")])],
		graphql: [reactions([reacted("r1", "2026-10-07T12:05:00Z")])],
	});
	const lines = await waitForActivity(pr, { since: point }, second.deps);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(/^2026-10-07T12:03:00Z replied reviewer /);
	expect(second.sideCalls[0].path).toContain("since=2026-10-07T11:59:59.000Z");
	const third = setup([response([committed(A)]), response([committed(A)])], [A], {
		comments: [response([replied(2, "2026-10-07T12:03:00Z")]), response([replied(2, "2026-10-07T12:03:00Z")])],
		graphql: [
			reactions([reacted("r1", "2026-10-07T12:05:00Z")]),
			reactions([reacted("r1", "2026-10-07T12:05:00Z"), reacted("r2", "2026-10-07T12:05:00Z")]),
		],
	});
	const later = await waitForActivity(pr, { since: cursor(lines) }, third.deps);
	expect(later).toHaveLength(1);
	expect(later[0]).toContain("reacted:thumbs_up");
	expect(third.sleeps).toEqual([300_000]);
	expect(third.sideCalls[0].path).toContain("since=2026-10-07T12:02:59.000Z");
});

test("GraphQL errors fail loudly instead of hiding reactions", async () => {
	const fixture = setup([pull(), response([pushed()]), response([committed(A)])], [A], {
		graphql: [response({ errors: [{ message: "Could not resolve to a PullRequest" }] })],
	});
	await expect(waitForActivity(pr, {}, fixture.deps)).rejects.toThrow("GitHub GraphQL error");
});

const LATER = "2026-10-07T12:05:00Z";
const LATEST = "2026-10-07T12:08:00Z";

test("a required failure wakes the wait, naming the check and linking its details", async () => {
	const fixture = setup([pull(), response([pushed()]), response([committed(A)])], [A], {
		checks: [
			checks([
				{ name: "lint", result: "FAILURE", time: LATER },
				{ name: "build and test", required: true, result: "TIMED_OUT", time: LATEST },
				{ name: "check", required: true },
			]),
		],
		protected: ["build and test", "check"],
	});
	const lines = await waitForActivity(pr, {}, fixture.deps);
	expect(lines).toHaveLength(2);
	expect(lines[0]).toContain("check:failed lint");
	expect(lines[1]).toMatch(
		/^2026-10-07T12:08:00Z checks:failed build_and_test https:\/\/github.com\/example\/project\/actions\/runs\/1\/job\/14 q1\./,
	);
	expect(fixture.checkCalls[0].body).toMatchObject({ variables: { owner: "example", repo: "project", number: 1 } });
});

test("an optional failure wakes separately, and resuming still waits for all checks before reporting a required pass", async () => {
	const first = setup([pull(), response([pushed()]), response([committed(A)])], [A], {
		checks: [
			checks([
				{ name: "lint", result: "FAILURE", time: LATER },
				{ name: "check", required: true, result: "SUCCESS", time: LATER },
				{ name: "test", required: true },
			]),
		],
		ruled: ["check", "test"],
	});
	const failed = await waitForActivity(pr, {}, first.deps);
	expect(failed).toHaveLength(1);
	expect(failed[0]).toMatch(/^2026-10-07T12:05:00Z check:failed lint /);
	const next = setup([response([committed(A)]), response([committed(A)])], [A], {
		checks: [
			checks([
				{ name: "lint", result: "FAILURE", time: LATER },
				{ name: "check", required: true, result: "SUCCESS", time: LATER },
				{ name: "test", required: true, result: "SKIPPED", time: LATEST },
				{ name: "slow" },
			]),
			checks([
				{ name: "lint", result: "FAILURE", time: LATER },
				{ name: "check", required: true, result: "SUCCESS", time: LATER },
				{ name: "test", required: true, result: "SKIPPED", time: LATEST },
				{ name: "slow", result: "SUCCESS", time: LATER },
			]),
		],
		ruled: ["check", "test"],
	});
	const lines = await waitForActivity(pr, { since: cursor(failed) }, next.deps);
	expect(next.sleeps).toEqual([300_000]);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(/^2026-10-07T12:08:00Z checks:passed test /);
	// Every wait reads the base's requirements just once.
	expect(next.ruleCalls.map((call) => call.path)).toEqual([
		`${base}/branches/main`,
		`${base}/rules/branches/main?per_page=100`,
	]);
});

test("classic protection that lists only contexts still names required checks", async () => {
	const fixture = setup([pull(), response([pushed()]), response([committed(A)]), response([committed(A)])], [A], {
		checks: [
			checks([{ name: "check", required: true, result: "SUCCESS", time: LATER }]),
			checks([
				{ name: "check", required: true, result: "SUCCESS", time: LATER },
				{ name: "gate", required: true, result: "SUCCESS", time: LATEST },
			]),
		],
		protected: ["check", "gate"],
		contextsOnly: true,
	});
	const lines = await waitForActivity(pr, {}, fixture.deps);
	expect(fixture.sleeps).toEqual([300_000]);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(/^2026-10-07T12:08:00Z checks:passed gate /);
});

test("a gated base's quest land check, which no head carries, never holds back checks:passed", async () => {
	const fixture = setup([pull(), response([pushed()]), response([committed(A)])], [A], {
		checks: [checks([{ name: "check", required: true, result: "SUCCESS", time: LATER }])],
		ruled: ["check", "quest land"],
	});
	const lines = await waitForActivity(pr, {}, fixture.deps);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(/^2026-10-07T12:05:00Z checks:passed check /);
});

test("optional checks never stand in for required checks that have not started", async () => {
	const fixture = setup(
		[pull(), response([pushed()]), response([committed(A)]), response([committed(A)]), response([committed(A)])],
		[A],
		{
			checks: [
				checks([{ name: "lint", result: "FAILURE", time: "2026-10-07T11:59:00Z" }]),
				checks([
					{ name: "lint", result: "FAILURE", time: "2026-10-07T11:59:00Z" },
					{ name: "check", required: true, result: "SUCCESS", time: LATER },
				]),
				checks([
					{ name: "lint", result: "FAILURE", time: "2026-10-07T11:59:00Z" },
					{ name: "check", required: true, result: "SUCCESS", time: LATER },
					{ name: "gate", required: true, result: "SUCCESS", time: LATEST },
				]),
			],
			protected: ["check"],
			ruled: ["gate"],
		},
	);
	const lines = await waitForActivity(pr, {}, fixture.deps);
	expect(fixture.sleeps).toEqual([300_000, 300_000]);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(/^2026-10-07T12:08:00Z checks:passed gate /);
});

test("a required check named on a later page of rules holds back checks:passed", async () => {
	const fixture = setup([pull(), response([pushed()]), response([committed(A)]), response([committed(A)])], [A], {
		checks: [
			checks([{ name: "check", required: true, result: "SUCCESS", time: LATER }]),
			checks([
				{ name: "check", required: true, result: "SUCCESS", time: LATER },
				{ name: "deploy", required: true, result: "SUCCESS", time: LATEST },
			]),
		],
		ruled: ["check"],
		rules: [
			{
				type: "required_status_checks",
				parameters: { required_status_checks: [{ context: "deploy", integration_id: 42 }] },
			},
		],
	});
	const lines = await waitForActivity(pr, {}, fixture.deps);
	expect(fixture.sleeps).toEqual([300_000]);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(/^2026-10-07T12:08:00Z checks:passed deploy /);
	expect(fixture.ruleCalls.map((call) => call.path)).toEqual([
		`${base}/branches/main`,
		`${base}/rules/branches/main?per_page=100`,
		`${base}/rules/branches/main?per_page=100&page=2`,
	]);
});

const CI = ".github/workflows/ci.yml";
const workflowRule = { type: "workflows", parameters: { workflows: [{ path: CI, repository_id: 1 }] } };

test("a required workflow requires its jobs, keeps optional checks optional, and holds back checks:passed until its run finishes", async () => {
	const fixture = setup(
		[pull(), response([pushed()]), response([committed(A)]), response([committed(A)]), response([committed(A)])],
		[A],
		{
			checks: [
				checks([{ name: "lint", result: "FAILURE", time: "2026-10-07T11:59:00Z" }]),
				// The run's next job has not been created yet.
				checks([
					{ name: "lint", result: "FAILURE", time: "2026-10-07T11:59:00Z" },
					{ name: "build", result: "SUCCESS", time: LATER, workflow: CI, running: true },
				]),
				checks([
					{ name: "lint", result: "FAILURE", time: "2026-10-07T11:59:00Z" },
					{ name: "build", result: "SUCCESS", time: LATER, workflow: CI },
					{ name: "gate", result: "SUCCESS", time: LATEST, workflow: CI },
				]),
			],
			rules: [workflowRule],
		},
	);
	const lines = await waitForActivity(pr, {}, fixture.deps);
	expect(fixture.sleeps).toEqual([300_000, 300_000]);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(/^2026-10-07T12:08:00Z checks:passed gate /);
});

test("a failing job in a required workflow wakes the wait", async () => {
	const fixture = setup([pull(), response([pushed()]), response([committed(A)])], [A], {
		checks: [
			checks([
				{ name: "lint", result: "SUCCESS", time: LATER },
				{ name: "build", result: "FAILURE", time: LATEST, workflow: CI, running: true },
			]),
		],
		rules: [workflowRule],
	});
	const lines = await waitForActivity(pr, {}, fixture.deps);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(/^2026-10-07T12:08:00Z checks:failed build /);
});

test("checks:passed is dated when the head goes idle, after required checks finished before the start", async () => {
	const fixture = setup([pull(), response([pushed()]), response([committed(A)]), response([committed(A)])], [A], {
		checks: [
			checks([{ name: "check", required: true, result: "SUCCESS", time: POINT }, { name: "slow" }]),
			checks([
				{ name: "check", required: true, result: "SUCCESS", time: POINT },
				{ name: "slow", result: "SUCCESS", time: LATEST },
			]),
		],
		protected: ["check"],
	});
	const lines = await waitForActivity(pr, { since: LATER }, fixture.deps);
	expect(fixture.sleeps).toEqual([300_000]);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(/^2026-10-07T12:08:00Z checks:passed check /);
});

test("with no required checks, an unfinished workflow run holds back checks:passed", async () => {
	const fixture = setup([pull(), response([pushed()]), response([committed(A)]), response([committed(A)])], [A], {
		checks: [
			checks([{ name: "build", result: "SUCCESS", time: LATER, running: true }]),
			checks([
				{ name: "build", result: "SUCCESS", time: LATER },
				{ name: "gate", result: "SUCCESS", time: LATEST },
			]),
		],
	});
	const lines = await waitForActivity(pr, {}, fixture.deps);
	expect(fixture.sleeps).toEqual([300_000]);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(/^2026-10-07T12:08:00Z checks:passed gate /);
});

test("a repository with no required checks requires every check, commit statuses included", async () => {
	const fixture = setup(
		[pull(), response([pushed()]), response([committed(A)]), response([committed(A)]), response([committed(A)])],
		[A],
		{
			checks: [
				checks([]),
				checks([
					{ name: "check", result: "NEUTRAL", time: LATER },
					{ name: "ci/legacy", status: true },
				]),
				checks([
					{ name: "check", result: "NEUTRAL", time: LATER },
					{ name: "ci/legacy", status: true, result: "ERROR", time: LATEST },
				]),
			],
		},
	);
	const lines = await waitForActivity(pr, {}, fixture.deps);
	expect(fixture.sleeps).toEqual([300_000, 300_000]);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(
		/^2026-10-07T12:08:00Z checks:failed ci\/legacy https:\/\/github.com\/example\/project\/pull\/1\/checks q1\./,
	);
});

test("results reached before an explicit starting point are not reported", async () => {
	const fixture = setup([pull(), response([pushed()]), response([committed(A)])], [A], {
		checks: [checks([{ name: "check", required: true, result: "FAILURE", time: LATER }])],
		protected: ["check"],
	});
	const timeout = await waitForActivity(pr, { since: LATEST, timeout: 10 }, fixture.deps).catch(
		(error: unknown) => error,
	);
	expect(timeout).toBeInstanceOf(WaitTimeout);
});

test("a resumed wait never replays a reported result, but a push starts over for the new head", async () => {
	const failing = (head: string, time = LATER) =>
		checks([{ name: "check", required: true, result: "FAILURE", time }], head);
	const protect = { protected: ["check"] };
	const first = setup([pull(), response([pushed()]), response([committed(A)])], [A], {
		checks: [failing(A)],
		...protect,
	});
	const reported = await waitForActivity(pr, {}, first.deps);
	expect(reported[0]).toContain("checks:failed check");
	// The same failure is not reported again; the push is.
	const second = setup([response([committed(A)]), response([committed(A), committed(B)])], [A], {
		checks: [failing(A), failing(A)],
		...protect,
	});
	const pushedLines = await waitForActivity(pr, { since: cursor(reported) }, second.deps);
	expect(second.sleeps).toEqual([300_000]);
	expect(pushedLines).toHaveLength(1);
	expect(pushedLines[0]).toMatch(new RegExp(`^${B} committed `));
	// The new head's failure is reported even though the old head's was.
	const third = setup([response([committed(A), committed(B)])], [A], { checks: [failing(B, LATEST)], ...protect });
	const again = await waitForActivity(pr, { since: cursor(pushedLines) }, third.deps);
	expect(again).toHaveLength(1);
	expect(again[0]).toMatch(/^2026-10-07T12:08:00Z checks:failed check /);
	// A later pass on that head is still reported once.
	const fourth = setup([response([committed(A), committed(B)])], [A], {
		checks: [checks([{ name: "check", required: true, result: "SUCCESS", time: "2026-10-07T12:09:00Z" }], B)],
		...protect,
	});
	const passed = await waitForActivity(pr, { since: cursor(again) }, fourth.deps);
	expect(passed).toHaveLength(1);
	expect(passed[0]).toContain("checks:passed check");
});

test("a timed-out wait's cursor still reports a result reached during the first wait", async () => {
	const first = setup([pull(), response([pushed()]), response([committed(A)])], [A], {
		checks: [checks([{ name: "check", required: true }])],
		protected: ["check"],
	});
	const timeout = await waitForActivity(pr, { timeout: 10 }, first.deps).catch((error: unknown) => error);
	const second = setup([response([committed(A)])], [A], {
		checks: [checks([{ name: "check", required: true, result: "SUCCESS", time: LATER }])],
		protected: ["check"],
	});
	const lines = await waitForActivity(pr, { since: (timeout as WaitTimeout).cursor }, second.deps);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain("checks:passed check");
});

test("checks are read from every page, and a head racing the read waits for the next poll", async () => {
	const page = { hasNextPage: true, endCursor: "next" };
	const fixture = setup([pull(), response([pushed()]), response([committed(A)]), response([committed(A)])], [A], {
		checks: [
			checks([{ name: "check", required: true, result: "FAILURE", time: LATER }], A, undefined, B),
			checks([{ name: "check", required: true, result: "SUCCESS", time: LATER }], A, page),
			checks([{ name: "test", required: true, result: "FAILURE", time: LATEST }]),
		],
		protected: ["check", "test"],
	});
	const lines = await waitForActivity(pr, {}, fixture.deps);
	expect(fixture.sleeps).toEqual([300_000]);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(/^2026-10-07T12:08:00Z checks:failed test /);
	expect(fixture.checkCalls.map((call) => (call.body as { variables: { after: unknown } }).variables.after)).toEqual([
		null,
		null,
		"next",
	]);
});

function edited(id: number, updated = LATER, body = "Review completed", login = "codex[bot]") {
	return {
		id,
		body,
		created_at: "2026-10-06T12:00:00Z",
		updated_at: updated,
		user: { login },
		html_url: `https://github.com/example/project/pull/1#issuecomment-${id}`,
	};
}

test("edited bot comments wake once, including different edits in the same second", async () => {
	const first = setup([pull(), response([pushed()]), response([committed(A)])], [A], {
		edits: [response([edited(1)])],
	});
	const lines = await waitForActivity(pr, {}, first.deps);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(/^2026-10-07T12:05:00Z edited codex\[bot\] /);
	expect(Buffer.from(cursor(lines).slice(3), "base64url").toString()).not.toContain("Review completed");
	const resumed = setup([response([committed(A)]), response([committed(A)])], [A], {
		edits: [response([edited(1)]), response([edited(1, LATER, "Security review completed")])],
	});
	const changed = await waitForActivity(pr, { since: cursor(lines) }, resumed.deps);
	expect(resumed.sleeps).toEqual([300_000]);
	expect(changed[0]).toContain(" edited codex[bot] ");
});

test("edits reread every creation-ordered page, so an old first-page comment can change", async () => {
	const page2 = `${base}/issues/1/comments?per_page=100&page=2`;
	const untouched = { ...edited(1, POINT), created_at: POINT };
	const fixture = setup([pull(), response([pushed()]), response([committed(A)]), response([committed(A)])], [A], {
		edits: [
			response([untouched], { link: `<https://api.github.com${page2}>; rel="next"` }),
			response([]),
			response([edited(1)]),
		],
	});
	expect((await waitForActivity(pr, {}, fixture.deps))[0]).toContain(" edited codex[bot] ");
	expect(fixture.editCalls.map((call) => call.path)).toEqual([
		`${base}/issues/1/comments?per_page=100&since=2026-10-07T11:59:59.000Z`,
		page2,
		`${base}/issues/1/comments?per_page=100&since=2026-10-07T11:59:59.000Z`,
	]);
});

test("a later reaction does not hide an older edit, and old cursors learn the edit source", async () => {
	const first = setup([pull(), response([pushed()]), response([committed(A)])], [A], {
		graphql: [reactions([reacted("r1", LATEST)])],
	});
	const previous = JSON.parse(
		Buffer.from(cursor(await waitForActivity(pr, {}, first.deps)).slice(3), "base64url").toString(),
	);
	delete previous.marks.edits;
	const old = `q1.${Buffer.from(JSON.stringify(previous)).toString("base64url")}`;
	const next = setup([response([committed(A)])], [A], {
		edits: [response([edited(1), edited(2, LATEST, "My reply", "waiter")])],
	});
	const lines = await waitForActivity(pr, { since: old }, next.deps);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain(" edited codex[bot] ");
});

test("a later failing optional check cannot name the aggregate required pass", async () => {
	const fixture = setup([pull(), response([pushed()]), response([committed(A)])], [A], {
		protected: ["check"],
		checks: [
			checks([
				{ name: "check", required: true, result: "SUCCESS", time: LATER },
				{ name: "optional", result: "FAILURE", time: LATEST },
			]),
		],
	});
	const lines = await waitForActivity(pr, {}, fixture.deps);
	expect(lines).toHaveLength(2);
	expect(lines[0]).toMatch(/^2026-10-07T12:08:00Z check:failed optional /);
	expect(lines[1]).toMatch(/^2026-10-07T12:08:00Z checks:passed check /);
});
