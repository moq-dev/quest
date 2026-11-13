import { expect, test } from "vitest";
import { GitHub, type GitHubDependencies, held } from "../src/github";

const upstream = { owner: "example", repo: "project" };
const fork = { owner: "someone", repo: "project" };

/** A GitHub whose repositories hold `refs` and `pulls`, keyed by `owner/repo`, recording each path it serves. */
function github(world: {
	refs: Record<string, Record<string, string>>;
	open: Record<string, object[]>;
	closed: Record<string, object[]>;
}) {
	const requested: string[] = [];
	const deps: GitHubDependencies = {
		token: "test-token",
		now: () => 0,
		sleep: async () => undefined,
		warn: () => undefined,
		fetch: async (input) => {
			const url = new URL(String(input));
			requested.push(url.pathname + url.search);
			const [, , owner, repo, ...rest] = url.pathname.split("/");
			const name = `${owner}/${repo}`;
			if (rest.join("/") === "git/matching-refs/heads/quest/")
				return Response.json(
					Object.entries(world.refs[name] ?? {}).map(([ref, sha]) => ({ ref, object: { sha } })),
				);
			if (rest.join("/") === "pulls") {
				const state = url.searchParams.get("state");
				if (state === "open") return Response.json(world.open[name] ?? []);
				const head = url.searchParams.get("head");
				return Response.json(
					(world.closed[name] ?? []).filter((pull) => (pull as { label: string }).label === head),
				);
			}
			return new Response("not found", { status: 404 });
		},
	};
	return { client: new GitHub(deps), requested };
}

const pull = (n: number, ref: string, created: string) => ({
	number: n,
	head: { ref, repo: { full_name: "someone/project" } },
	draft: true,
	body: null,
	created_at: created,
	updated_at: created,
	html_url: `https://github.com/example/project/pull/${n}`,
});

test("held reads both sources' quest branches through GitHub when the caller passes no tips", async () => {
	const { client, requested } = github({
		refs: {
			"example/project": {
				"refs/heads/quest/m0/pushed": "a".repeat(40),
				"refs/heads/quest/m0/landed": "b".repeat(40),
			},
			"someone/project": { "refs/heads/quest/m0/forked": "c".repeat(40) },
		},
		open: {
			"someone/project": [pull(9, "quest/m0/opened", "2026-10-21T13:00:00Z")],
			"example/project": [pull(7, "quest/m0/opened", "2026-10-21T12:00:00Z")],
		},
		closed: {
			"example/project": [
				{
					label: "example:quest/m0/landed",
					head: { sha: "b".repeat(40) },
					merged_at: "2026-10-20T00:00:00Z",
					html_url: "https://github.com/example/project/pull/3",
				},
			],
		},
	});
	const found = await held(client, { upstream: { repository: upstream }, fork: { repository: fork } }, [
		"quest/m0/pushed",
		"quest/m0/landed",
		"quest/m0/forked",
		"quest/m0/opened",
		"quest/m0/free",
	]);
	expect(found.claims.map((claim) => [claim.branch, claim.url])).toEqual([
		["quest/m0/forked", null],
		// The earliest open PR holds the claim, whichever repository it opened in.
		["quest/m0/opened", "https://github.com/example/project/pull/7"],
		["quest/m0/pushed", null],
	]);
	// A merged PR's head upstream holds nothing, and only the fork's landed branches are the claim's to replace.
	expect(found.landed).toEqual(new Map());
	expect(requested).toContain("/repos/example/project/git/matching-refs/heads/quest/");
	expect(requested).toContain("/repos/someone/project/git/matching-refs/heads/quest/");
});

test("held reads no branches the caller already passed", async () => {
	const { client, requested } = github({ refs: {}, open: {}, closed: {} });
	const found = await held(client, { upstream: { repository: upstream, tips: new Map() } }, ["quest/m0/a"]);
	expect(found.claims).toEqual([]);
	expect(requested.some((path) => path.includes("matching-refs"))).toBe(false);
});
