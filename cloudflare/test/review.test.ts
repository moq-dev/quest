import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type Reads, unreviewed } from "../src/github/review";

const APP = 123;
const sha = (name: string) => createHash("sha1").update(name).digest("hex");
const short = (name: string) => sha(name).slice(0, 7);
/** Commits by name: their parents, and their files as `path: content`. */
type Commits = Record<string, { parents: string[]; files: Record<string, string> }>;

/**
 * A repository whose default branch `main` is at `main`, whose pull request #1
 * is at `head`, and whose reviews, check runs, and rules are as given.
 */
function reads(
	commits: Commits,
	pull: {
		head: string;
		main: string;
		approved?: string[];
		checked?: string[];
		rules?: unknown[];
		bypass?: string;
		truncated?: boolean;
		/** The pull request's body, last edited by `editor` when given. */
		body?: string;
		editor?: string;
		/** The author's permission on the repository. */
		permission?: string;
		/** Commits GitHub attributes to an App's bot. */
		bots?: string[];
	},
): Reads {
	const ids = new Map(Object.keys(commits).map((name) => [sha(name), name]));
	const ancestors = (name: string, seen = new Set<string>()): Set<string> => {
		if (seen.has(name)) return seen;
		seen.add(name);
		for (const parent of commits[name]!.parents) ancestors(parent, seen);
		return seen;
	};
	const tree = (name: string) => sha(`tree ${name}`);
	const named = (id: string) => [...ids.values()].find((name) => tree(name) === id);
	return {
		async graphql<T>() {
			return {
				data: {
					repository: {
						pullRequest: {
							state: "OPEN",
							headRefOid: sha(pull.head),
							baseRefName: "main",
							body: pull.body ?? "",
							author: { __typename: "User", login: "author" },
							userContentEdits: {
								nodes: pull.editor ? [{ editor: { __typename: "User", login: pull.editor } }] : [],
							},
							latestOpinionatedReviews: {
								nodes: (pull.approved ?? []).map((name) => ({
									state: "APPROVED",
									author: { __typename: "User", login: "maintainer" },
									commit: { oid: sha(name) },
								})),
							},
						},
					},
				},
			} as T;
		},
		async get<T>(path: string) {
			const url = new URL(path, "https://api.github.test");
			let match: RegExpMatchArray | null;
			if (url.pathname === "/rules/branches/main") return (pull.rules ?? []) as T;
			if ((match = url.pathname.match(/^\/rulesets\/(\d+)$/)))
				return { current_user_can_bypass: pull.bypass ?? "never" } as T;
			if ((match = url.pathname.match(/^\/commits\/(\w+)\/check-runs$/))) {
				const name = ids.get(match[1]!)!;
				return {
					check_runs: (pull.checked ?? []).includes(name)
						? [
								{
									name: "quest review",
									head_sha: match[1],
									status: "completed",
									conclusion: "success",
									app: { id: APP },
								},
							]
						: [],
				} as T;
			}
			if (url.pathname === "/collaborators/author/permission")
				return { permission: pull.permission ?? "write" } as T;
			if ((match = url.pathname.match(/^\/commits\/(\w+)$/))) {
				const bot = (pull.bots ?? []).includes(ids.get(match[1]!)!);
				return { committer: bot ? { login: "kix[bot]", type: "Bot" } : { login: "author", type: "User" } } as T;
			}
			if ((match = url.pathname.match(/^\/git\/commits\/(\w+)$/))) {
				const name = ids.get(match[1]!)!;
				return {
					sha: match[1],
					tree: { sha: tree(name) },
					parents: commits[name]!.parents.map((parent) => ({ sha: sha(parent) })),
				} as T;
			}
			if ((match = url.pathname.match(/^\/compare\/(\w+)\.\.\.(\w+)$/))) {
				const from = ids.get(match[1]!)!;
				const to = match[2] === "main" ? pull.main : ids.get(match[2]!)!;
				const status =
					from === to
						? "identical"
						: ancestors(to).has(from)
							? "ahead"
							: ancestors(from).has(to)
								? "behind"
								: "diverged";
				const common = [...ancestors(from)].filter((name) => ancestors(to).has(name));
				const nearest = common.find(
					(name) => !common.some((other) => other !== name && ancestors(other).has(name)),
				);
				return { status, merge_base_commit: { sha: sha(nearest!) } } as T;
			}
			if ((match = url.pathname.match(/^\/git\/trees\/(\w+)$/))) {
				const name = named(match[1]!)!;
				return {
					truncated: !!pull.truncated,
					tree: [
						{ path: "src", type: "tree", mode: "040000", sha: "d".repeat(40) },
						...Object.entries(commits[name]!.files).map(([path, content]) => ({
							path,
							type: "blob",
							mode: "100644",
							sha: sha(`blob ${content}`),
						})),
					],
				} as T;
			}
			throw new Error(`Unexpected read ${path}`);
		},
	};
}

/** Base `o`; the pull request's reviewed commit `pr` changed `a`; `main` moved on, changing `b` and `c`. */
const history = (merged: Record<string, string>, pr: Record<string, string> = { a: "1", b: "0", c: "0" }): Commits => ({
	o: { parents: [], files: { a: "0", b: "0", c: "0" } },
	pr: { parents: ["o"], files: pr },
	main: { parents: ["o"], files: { a: "0", b: "2", c: "2" } },
	merge: { parents: ["pr", "main"], files: merged },
});
const landing = (head: string) => ({ owner: "o", name: "r", pull: 1, head: sha(head), branch: "main", app: APP });
const carried = `kix lands only a reviewed head.`;

describe("the review a landing needs", () => {
	it("counts an approval or the App's check on the exact head", async () => {
		const commits = history({});
		expect(
			await unreviewed(reads(commits, { head: "pr", main: "main", approved: ["pr"] }), landing("pr")),
		).toBeNull();
		expect(
			await unreviewed(reads(commits, { head: "pr", main: "main", checked: ["pr"] }), landing("pr")),
		).toBeNull();
		expect(await unreviewed(reads(commits, { head: "pr", main: "main" }), landing("pr"))).toBe(
			`No review counts on ${short("pr")} yet. kix lands only a reviewed head. Approve ${short("pr")} on GitHub as someone with write access other than the pull request's author, have a runner's \`quest review\` check pass on it, or, as its author with write access, name it in the body's \`## Review\` record if no App committed it.`,
		);
	});

	it("carries a review across a merge of the base that resolved no conflict", async () => {
		const commits = history({ a: "1", b: "2", c: "2" });
		for (const review of [{ approved: ["pr"] }, { checked: ["pr"] }])
			expect(
				await unreviewed(reads(commits, { head: "merge", main: "main", ...review }), landing("merge")),
			).toBeNull();
		// The same merge is unverifiable when GitHub truncates a tree.
		expect(
			await unreviewed(
				reads(commits, { head: "merge", main: "main", approved: ["pr"], truncated: true }),
				landing("merge"),
			),
		).toContain(carried);
	});

	it.each([
		["slips in a change neither side made", { a: "1", b: "2", c: "2", d: "new" }],
		["reverts the base's change", { a: "1", b: "0", c: "2" }],
		["drops the reviewed change", { a: "0", b: "2", c: "2" }],
	])("does not carry a review across a merge that %s", async (_, merged) => {
		const read = reads(history(merged), { head: "merge", main: "main", approved: ["pr"] });
		expect(await unreviewed(read, landing("merge"))).toBe(
			`The approval of ${short("pr")} does not carry to ${short("merge")}: what changed since is more than conflict-free merges of main. kix lands only a reviewed head. Approve ${short("merge")} on GitHub as someone with write access other than the pull request's author, have a runner's \`quest review\` check pass on it, or, as its author with write access, name it in the body's \`## Review\` record if no App committed it.`,
		);
	});

	it("does not carry a review across a conflict resolved by hand, whichever side it keeps", async () => {
		// The pull request also changed `b`, which the base changed differently.
		for (const b of ["1", "2", "3"]) {
			const commits = history({ a: "1", b, c: "2" }, { a: "1", b: "1", c: "0" });
			expect(
				await unreviewed(reads(commits, { head: "merge", main: "main", approved: ["pr"] }), landing("merge")),
			).toContain(carried);
		}
	});

	it("does not carry a review across a merge of commits the default branch does not hold", async () => {
		const commits: Commits = {
			...history({ a: "1", b: "2", c: "2" }),
			main: { parents: ["o"], files: { a: "0", b: "2", c: "2" } },
			trunk: { parents: ["o"], files: { a: "0", b: "0", c: "0" } },
		};
		const read = reads(commits, { head: "merge", main: "trunk", approved: ["pr"] });
		expect(await unreviewed(read, landing("merge"))).toContain(carried);
	});

	it("defers to a ruleset only when it enforces a review of the current head and binds the App", async () => {
		const commits = history({});
		const rule = (parameters: Record<string, unknown>) => [{ type: "pull_request", ruleset_id: 1, parameters }];
		const enforced = rule({ required_approving_review_count: 1, dismiss_stale_reviews_on_push: true });
		expect(
			await unreviewed(reads(commits, { head: "pr", main: "main", rules: enforced }), landing("pr")),
		).toBeNull();
		for (const [rules, bypass] of [
			[enforced, "always"],
			[enforced, "pull_requests_only"],
			[rule({ required_approving_review_count: 1 }), "never"],
			[rule({ required_approving_review_count: 0, require_last_push_approval: true }), "never"],
		] as const)
			expect(
				await unreviewed(reads(commits, { head: "pr", main: "main", rules, bypass }), landing("pr")),
			).toContain(carried);
	});

	describe("the author's own Review record", () => {
		const record = (name: string) =>
			`Summary\n\n## Review\n\nRound 1 on head ${sha(name)}: no findings.\n\n(written by a model)`;

		it("counts when a writer names the exact head in the body they last edited", async () => {
			const commits = history({});
			for (const editor of [undefined, "author", "Author"])
				expect(
					await unreviewed(
						reads(commits, { head: "pr", main: "main", body: record("pr"), editor }),
						landing("pr"),
					),
				).toBeNull();
		});

		it.each([
			["the author cannot write", { permission: "read" }],
			["someone else last edited the body", { editor: "maintainer" }],
			["an App committed the head", { bots: ["pr"] }],
			["it names another commit", { body: record("o") }],
			["it names no commit, as a skip does", { body: "## Review\n\nSkipped: trivial." }],
			[
				"the SHA is outside the Review section",
				{ body: `${sha("pr")}\n\n## Review\n\nDone.\n\n## Next\n\n${sha("pr")}` },
			],
		])("does not count when %s", async (_, overrides) => {
			const read = reads(history({}), { head: "pr", main: "main", body: record("pr"), ...overrides });
			expect(await unreviewed(read, landing("pr"))).toContain(carried);
		});

		it("carries across a merge of the base that resolved no conflict, unless an App committed the merge", async () => {
			const commits = history({ a: "1", b: "2", c: "2" });
			const merged = (bots: string[]) =>
				unreviewed(reads(commits, { head: "merge", main: "main", body: record("pr"), bots }), landing("merge"));
			expect(await merged([])).toBeNull();
			expect(await merged(["merge"])).toContain(carried);
		});
	});
});
