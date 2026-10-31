import { describe, expect, test } from "vitest";

import { GitHub, GitHubDeadline, type GitHubDependencies } from "../src/cli/github";

const repo = "/repos/example/project";
const HEAD = "a".repeat(40);
const SQUASH = "b".repeat(40);

/** One request as the fake saw it. */
interface Call {
	method: string;
	path: string;
	body?: { query?: string; variables?: Record<string, unknown> } & Record<string, unknown>;
}

type Reply = Response | Error | ((call: Call) => Response | Error);

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers });
}

const bad = (status: number, headers: Record<string, string> = {}) =>
	json({ message: "Server Error" }, status, headers);
const dropped = () => new TypeError("fetch failed: connection reset");

/** A client whose fetch answers each request with the next reply, on a clock only its sleeps advance. */
function fixture(replies: Reply[], deadline = Infinity) {
	let now = Date.parse("2026-10-31T12:00:00Z");
	const calls: Call[] = [];
	const sleeps: number[] = [];
	const warnings: string[] = [];
	const deps: GitHubDependencies = {
		token: "token",
		now: () => now,
		sleep: async (milliseconds) => {
			sleeps.push(milliseconds);
			now += milliseconds;
		},
		warn: (text) => warnings.push(text),
		fetch: (async (input, init) => {
			const url = new URL(String(input));
			const call: Call = {
				method: init?.method ?? "GET",
				path: url.pathname + url.search,
				...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
			};
			calls.push(call);
			const next = replies.shift();
			if (next === undefined) throw new Error(`unexpected ${call.method} ${call.path}`);
			const reply = typeof next === "function" ? next(call) : next;
			if (reply instanceof Error) throw reply;
			return reply;
		}) as typeof fetch,
	};
	const github = new GitHub(deps, deadline === Infinity ? Infinity : now + deadline);
	return { github, calls, sleeps, warnings, now: () => now };
}

describe("transient failures", () => {
	test("a read retries a 5xx with backoff and returns the next success", async () => {
		const { github, calls, sleeps, warnings } = fixture([bad(502), bad(500), json({ ok: true })]);
		const response = await github.request(`${repo}/pulls/1`);
		expect(await response.json()).toEqual({ ok: true });
		expect(calls).toHaveLength(3);
		expect(sleeps).toEqual([1000, 2000]);
		expect(warnings[0]).toBe(`GitHub HTTP 502 for ${repo}/pulls/1; Server Error; retrying in 1 seconds`);
	});

	test("a persistent 5xx fails with the last error after bounded retries", async () => {
		const { github, calls, sleeps } = fixture([bad(502), bad(502), bad(502), bad(502), json({}, 503)]);
		await expect(github.request(`${repo}/pulls/1`)).rejects.toThrow(
			`GitHub HTTP 503 for ${repo}/pulls/1; GitHub server error`,
		);
		expect(calls).toHaveLength(5);
		expect(sleeps).toEqual([1000, 2000, 4000, 8000]);
	});

	test("a dropped connection retries, and a persistent one rethrows its error", async () => {
		const recovered = fixture([dropped(), json([])]);
		await recovered.github.request(`${repo}/pulls`);
		expect(recovered.sleeps).toEqual([1000]);

		const persistent = fixture(Array.from({ length: 5 }, dropped));
		await expect(persistent.github.request(`${repo}/pulls`)).rejects.toThrow("connection reset");
		expect(persistent.calls).toHaveLength(5);
	});

	test("a 5xx honours Retry-After", async () => {
		const { github, sleeps } = fixture([bad(503, { "retry-after": "30" }), json({})]);
		await github.request(`${repo}/pulls/1`);
		expect(sleeps).toEqual([30_000]);
	});

	test("a 4xx is not retried", async () => {
		const { github, calls, sleeps } = fixture([json({ message: "Not Found" }, 404)]);
		await expect(github.request(`${repo}/pulls/1`)).rejects.toThrow("GitHub HTTP 404");
		expect(calls).toHaveLength(1);
		expect(sleeps).toEqual([]);
	});

	test("the deadline cuts a backoff short", async () => {
		const { github, sleeps } = fixture([bad(502)], 500);
		await expect(github.request(`${repo}/pulls/1`)).rejects.toBeInstanceOf(GitHubDeadline);
		expect(sleeps).toEqual([500]);
	});

	test("PUT, PATCH, DELETE, and adding labels repeat", async () => {
		const { github, calls } = fixture([
			bad(502),
			json({}),
			dropped(),
			json({}),
			bad(504),
			new Response(null, { status: 204 }),
			bad(502),
			json([]),
		]);
		await github.request(`${repo}/pulls/1/update-branch`, { method: "PUT", body: {} });
		await github.request(`${repo}/pulls/1`, { method: "PATCH", body: { state: "closed" } });
		await github.request(`${repo}/issues/1/labels/x`, { method: "DELETE" });
		await github.request(`${repo}/issues/1/labels`, { body: { labels: ["x"] } });
		expect(calls.map(({ method }) => method)).toEqual([
			"PUT",
			"PUT",
			"PATCH",
			"PATCH",
			"DELETE",
			"DELETE",
			"POST",
			"POST",
		]);
	});

	test("a rate-limited POST repeats, since GitHub refused it unprocessed", async () => {
		const { github, calls } = fixture([
			json({ message: "secondary rate limit" }, 403, { "retry-after": "60" }),
			json({}),
		]);
		await github.request(`${repo}/dispatches`, { body: {} });
		expect(calls).toHaveLength(2);
	});

	test("any other POST never repeats after a 5xx or a dropped connection", async () => {
		for (const failure of [bad(502), dropped()]) {
			const { github, calls, sleeps } = fixture([failure]);
			await expect(github.request(`${repo}/dispatches`, { body: {} })).rejects.toThrow();
			expect(calls).toHaveLength(1);
			expect(sleeps).toEqual([]);
		}
	});
});

describe("confirmed writes", () => {
	const text = "landed by quest land";

	test("a comment whose response was lost is found by its body and not posted again", async () => {
		const { github, calls } = fixture([
			bad(502),
			json([
				{ id: 1, body: "older" },
				{ id: 2, body: text },
			]),
		]);
		const response = await github.request(`${repo}/issues/1/comments`, { body: { body: text } });
		expect(await response.json()).toEqual({ id: 2, body: text });
		expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
			`POST ${repo}/issues/1/comments`,
			// A minute before the first attempt, for GitHub's clock.
			`GET ${repo}/issues/1/comments?since=2026-10-31T11:59:00.000Z&per_page=100`,
		]);
	});

	test("a comment that did not post is posted again", async () => {
		const { github, calls } = fixture([dropped(), json([{ id: 1, body: "older" }]), json({ id: 2 }, 201)]);
		await github.request(`${repo}/issues/1/comments`, { body: { body: text } });
		expect(calls.map(({ method }) => method)).toEqual(["POST", "GET", "POST"]);
	});

	test("a pull request whose response was lost is found by its branch", async () => {
		const created = { number: 7, created_at: "2026-10-31T12:00:00Z" };
		const { github, calls } = fixture([
			bad(502),
			json([{ number: 3, created_at: "2026-10-01T00:00:00Z" }, created]),
		]);
		const response = await github.request(`${repo}/pulls`, { body: { head: "quest/m0/a", base: "main" } });
		expect(await response.json()).toEqual(created);
		expect(calls[1].path).toBe(`${repo}/pulls?state=open&head=example%3Aquest%2Fm0%2Fa&per_page=100`);
	});

	test("a merge whose response was lost is confirmed from the PR at its pinned head", async () => {
		const merged = { merged: true, merge_commit_sha: SQUASH, head: { sha: HEAD } };
		const { github, calls } = fixture([bad(502), json(merged)]);
		const response = await github.request(`${repo}/pulls/1/merge`, {
			method: "PUT",
			body: { merge_method: "squash", sha: HEAD },
			allow: [405, 409],
		});
		expect(await response.json()).toMatchObject({ merged: true, sha: SQUASH });
		expect(calls.map(({ method }) => method)).toEqual(["PUT", "GET"]);
	});

	test("a merge not confirmed at its pinned head is sent again, for GitHub to merge or refuse", async () => {
		for (const pull of [
			{ merged: false, merge_commit_sha: null, head: { sha: HEAD } },
			{ merged: true, merge_commit_sha: SQUASH, head: { sha: "c".repeat(40) } },
		]) {
			const refusal = json({ message: "Pull Request is not mergeable" }, 405);
			const { github, calls } = fixture([dropped(), json(pull), refusal]);
			const response = await github.request(`${repo}/pulls/1/merge`, {
				method: "PUT",
				body: { merge_method: "squash", sha: HEAD },
				allow: [405, 409],
			});
			expect(response.status).toBe(405);
			expect(calls.map(({ method }) => method)).toEqual(["PUT", "GET", "PUT"]);
		}
	});
});

describe("GraphQL", () => {
	const disable =
		"mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }";

	test("a query repeats", async () => {
		const { github, calls } = fixture([bad(502), json({ data: { viewer: { login: "bot" } } })]);
		expect(await github.graphql("query { viewer { login } }", {})).toEqual({ viewer: { login: "bot" } });
		expect(calls).toHaveLength(2);
	});

	test("a pull request mutation confirmed to have taken effect is not sent again", async () => {
		const { github, calls } = fixture([bad(502), json({ data: { node: { autoMergeRequest: null } } })]);
		expect(await github.graphql(disable, { id: "PR_1" })).toEqual({});
		expect(calls).toHaveLength(2);
		expect(calls[1].body?.query).toContain(
			"node(id: $id) { ... on PullRequest { autoMergeRequest { enabledAt } } }",
		);
		expect(calls[1].body?.variables).toEqual({ id: "PR_1" });
	});

	test("a pull request mutation confirmed missing is sent again", async () => {
		const { github, calls } = fixture([
			dropped(),
			json({ data: { node: { autoMergeRequest: { enabledAt: "2026-10-31T11:00:00Z" } } } }),
			json({ data: { disablePullRequestAutoMerge: { clientMutationId: null } } }),
		]);
		await github.graphql(disable, { id: "PR_1" });
		expect(calls.map(({ body }) => body?.query?.split("(")[0])).toEqual(["mutation", "query", "mutation"]);
	});

	test.each([
		["mergePullRequest", { merged: true }],
		["enablePullRequestAutoMerge", { merged: false, autoMergeRequest: null, mergeQueueEntry: { state: "QUEUED" } }],
		["markPullRequestReadyForReview", { isDraft: false }],
	])("%s is confirmed from the pull request", async (mutation, node) => {
		const { github, calls } = fixture([bad(502), json({ data: { node } })]);
		await github.graphql(
			`mutation($id: ID!, $sha: GitObjectID!) { ${mutation}(input: { pullRequestId: $id, expectedHeadOid: $sha }) { clientMutationId } }`,
			{ id: "PR_1", sha: HEAD },
		);
		expect(calls).toHaveLength(2);
	});

	test("a mutation without a confirmation never repeats", async () => {
		const { github, calls } = fixture([bad(502)]);
		await expect(
			github.graphql(
				'mutation($id: ID!) { addComment(input: { subjectId: $id, body: "x" }) { clientMutationId } }',
				{
					id: "PR_1",
				},
			),
		).rejects.toThrow("GitHub HTTP 502");
		expect(calls).toHaveLength(1);
	});
});
