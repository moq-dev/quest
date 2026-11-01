// `quest mv` and `quest rm`: the core edits, and the CLI's git and claim handling.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { move, remove } from "../src/core";
import { openPullRequests } from "../src/cli/claims";
import { GitHub, type GitHubDependencies } from "../src/cli/github";
import { main } from "../src/cli/main";
import { ROOT_README, Tree, tempDir } from "./fixture";

// Each test spawns git up to a dozen times, which a busy Windows runner can stretch past 5 s.
vi.setConfig({ testTimeout: 30_000 });

function git(dir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** `tree` as a git repository with everything committed. */
function committed(tree: Tree): Tree {
	git(tree.path, "init", "-q", "-b", "main");
	git(tree.path, "add", "-A");
	git(tree.path, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init");
	return tree;
}

async function quest(tree: Tree, ...args: string[]) {
	let stdout = "";
	let stderr = "";
	const code = await main(["--root", tree.path, ...args], {
		stdout: (text) => {
			stdout += text;
		},
		stderr: (text) => {
			stderr += text;
		},
	});
	return { code, stdout, stderr };
}

/** Staged changes, as `git status --short` prints them. */
function staged(tree: Tree): string[] {
	return git(tree.path, "status", "--short").split("\n").filter(Boolean).sort();
}

describe("move", () => {
	test("rewrites inline and reference links, keeping fragments and encoding names and parentheses", () => {
		const text =
			"# [S] A\n\n## Goal\n\nSee [b](/quest/b.md#plan) and [ref][b].\n\n" +
			"## Related\n\n- [/quest/b.md](/quest/b.md)\n\n[b]: /quest/b.md\n";
		const moved = move([{ path: "quest/a.md", text }], "quest/b.md", "quest/m1/new (name.md");
		expect(moved.missed).toEqual([]);
		expect(moved.texts.get("quest/a.md")).toBe(
			"# [S] A\n\n## Goal\n\nSee [b](/quest/m1/new%20%28name.md#plan) and [ref][b].\n\n" +
				"## Related\n\n- [/quest/b.md](/quest/m1/new%20%28name.md)\n\n[b]: /quest/m1/new%20%28name.md\n",
		);
	});

	test("moves an epic's documents as a prefix and keys them by their new path", () => {
		const moved = move(
			[
				{
					path: "quest/m0/README.md",
					text: "# M0\n\n## Goal\n\nG.\n\n## Required\n\n- [E](/quest/m0/e/README.md)\n",
				},
				{
					path: "quest/m0/e/README.md",
					text: "# E\n\n## Goal\n\nG.\n\n## Required\n\n- [A](/quest/m0/e/a.md)\n",
				},
				{ path: "quest/m0/e/a.md", text: "# [S] A\n\n## Goal\n\nG.\n" },
				{ path: "quest/m0/elsewhere.md", text: "# [S] X\n\n## Related\n\n- [E2](/quest/m0/e2.md)\n" },
			],
			"quest/m0/e",
			"quest/m1/e",
		);
		expect([...moved.texts.keys()]).toEqual(["quest/m0/README.md", "quest/m1/e/README.md"]);
		expect(moved.texts.get("quest/m0/README.md")).toContain("- [E](/quest/m1/e/README.md)\n");
		expect(moved.texts.get("quest/m1/e/README.md")).toContain("- [A](/quest/m1/e/a.md)\n");
	});

	test("reports a link whose destination is not written as parsed", () => {
		const text = "# [S] A\n\n## Goal\n\n[b](/quest/b&#46;md)\n";
		const moved = move([{ path: "quest/a.md", text }], "quest/b.md", "quest/c.md");
		expect(moved.texts.size).toBe(0);
		expect(moved.missed).toEqual([{ path: "quest/a.md", line: 5, target: "/quest/b.md" }]);
	});
});

describe("remove", () => {
	const gone = (path: string) => path === "quest/b.md";

	test("drops entries, and a section left empty with its heading", () => {
		const text =
			"# [S] A\n\n## Goal\n\nG.\n\n## Required\n\n- [B](/quest/b.md) - first\n\n" +
			"## Related\n\n- [C](/quest/c.md)\n- [B](/quest/b.md)\n  wrapped\n- [D](/quest/d.md)\n";
		expect(remove([{ path: "quest/a.md", text }], gone).get("quest/a.md")).toBe(
			"# [S] A\n\n## Goal\n\nG.\n\n## Related\n\n- [C](/quest/c.md)\n- [D](/quest/d.md)\n",
		);
	});

	test("keeps one blank line in a loose list and at the end of the file", () => {
		const loose =
			"# [S] A\n\n## Goal\n\nG.\n\n## Related\n\n- [C](/quest/c.md)\n\n- [B](/quest/b.md)\n\n- [D](/quest/d.md)\n";
		expect(remove([{ path: "quest/a.md", text: loose }], gone).get("quest/a.md")).toBe(
			"# [S] A\n\n## Goal\n\nG.\n\n## Related\n\n- [C](/quest/c.md)\n\n- [D](/quest/d.md)\n",
		);
		const last = "# [S] A\n\n## Goal\n\nG.\n\n## Required\n\n- [B](/quest/b.md)\n";
		expect(remove([{ path: "quest/a.md", text: last }], gone).get("quest/a.md")).toBe("# [S] A\n\n## Goal\n\nG.\n");
	});

	test("leaves prose, sections with other content, and other sections alone", () => {
		const text =
			"# [S] A\n\n## Goal\n\nAfter [B](/quest/b.md).\n\n- [B](/quest/b.md) in a goal list\n\n" +
			"## Related\n\nContext.\n\n- [B](/quest/b.md)\n";
		expect(remove([{ path: "quest/a.md", text }], gone).get("quest/a.md")).toBe(
			"# [S] A\n\n## Goal\n\nAfter [B](/quest/b.md).\n\n- [B](/quest/b.md) in a goal list\n\n## Related\n\nContext.\n",
		);
	});
	test("drops links to finished milestones until nothing changes, keeping the root's listing", () => {
		const root =
			"# Quests\n\n## Goal\n\nG.\n\n## Required\n\n- [M0](/quest/m0/README.md)\n- [M1](/quest/m1/README.md)\n";
		const sources = [
			{ path: "quest/README.md", text: root },
			// m0 finishes once b goes, which finishes m1, which only waited on m0.
			{ path: "quest/m0/README.md", text: "# M0\n\n## Goal\n\nG.\n\n## Required\n\n- [B](/quest/b.md)\n" },
			{
				path: "quest/m1/README.md",
				text: "# M1\n\n## Goal\n\nG.\n\n## Required\n\n- [M0](/quest/m0/README.md)\n",
			},
			{ path: "quest/b.md", text: "# [S] B\n\n## Goal\n\nG.\n" },
			{
				path: "quest/m1/a.md",
				text:
					"# [S] A\n\n## Goal\n\nG.\n\n## Required\n\n- [M1](/quest/m1/README.md)\n- [M2](/quest/m2/README.md)\n\n" +
					"## Related\n\n- [M0](/quest/m0/README.md)\n",
			},
			// m2 was already finished, so the link to it was already stale.
			{ path: "quest/m2/README.md", text: "# M2\n\n## Goal\n\nG.\n" },
		];
		const texts = remove(sources, gone);
		expect([...texts.keys()].sort()).toEqual(["quest/m0/README.md", "quest/m1/README.md", "quest/m1/a.md"]);
		expect(texts.get("quest/m0/README.md")).toBe("# M0\n\n## Goal\n\nG.\n");
		expect(texts.get("quest/m1/README.md")).toBe("# M1\n\n## Goal\n\nG.\n");
		expect(texts.get("quest/m1/a.md")).toBe(
			"# [S] A\n\n## Goal\n\nG.\n\n## Related\n\n- [M0](/quest/m0/README.md)\n",
		);
	});
});

describe("quest mv", () => {
	test("moves a quest, rewrites its links, and stages the change", async () => {
		const tree = committed(Tree.baseline());
		const out = await quest(tree, "mv", "/quest/m0/epic/one.md", "quest/m0/epic/first.md");
		expect(out).toEqual({
			code: 0,
			stdout: "R quest/m0/epic/one.md -> quest/m0/epic/first.md\nM quest/m0/epic/README.md\nM quest/m0/epic/two.md\n",
			stderr: "quest: no origin remote, so claims were not checked\n",
		});
		expect(tree.read("quest/m0/epic/two.md")).toContain("- [One](/quest/m0/epic/first.md) - must finish first");
		expect(staged(tree)).toEqual([
			"M  quest/m0/epic/README.md",
			"M  quest/m0/epic/two.md",
			"R  quest/m0/epic/one.md -> quest/m0/epic/first.md",
		]);
		tree.accepts();
	});

	test("moves an epic into a new directory", async () => {
		const tree = committed(Tree.baseline());
		const out = await quest(tree, "mv", "quest/m0/epic", "quest/m1/later/epic");
		expect(out.stdout).toBe(
			"R quest/m0/epic -> quest/m1/later/epic\nM quest/m0/README.md\nM quest/m1/later/epic/README.md\nM quest/m1/later/epic/two.md\n",
		);
		expect(tree.read("quest/m1/later/epic/README.md")).toContain("- [One](/quest/m1/later/epic/one.md)\n");
		// The epic left m0 for a directory with no README, which check reports rather than mv guessing.
		expect(out.code).toBe(1);
		expect(out.stderr).toContain("quest/m1/later/epic/README.md: not listed in quest/m1/later/README.md");
	});

	test("reports mentions it does not edit", async () => {
		const tree = Tree.baseline()
			.append("quest/m0/epic/two.md", "\n## Plan\n\nFollows `quest/m0/epic/one.md`.\n")
			.write("notes.md", "See quest/m0/epic/one.md.\n");
		committed(tree);
		const out = await quest(tree, "mv", "quest/m0/epic/one.md", "quest/m0/epic/first.md");
		expect(out.code).toBe(0);
		expect(out.stderr).toContain("quest: notes.md:1: mentions quest/m0/epic/one.md; update it by hand\n");
		expect(out.stderr).toContain(
			"quest: quest/m0/epic/two.md:13: mentions quest/m0/epic/one.md; update it by hand\n",
		);
	});

	test("reports mentions in untracked files but not ignored ones", async () => {
		const tree = committed(Tree.baseline().write(".gitignore", "ignored.md\n"));
		tree.write("draft.md", "See quest/m0/epic/one.md.\n").write("ignored.md", "See quest/m0/epic/one.md.\n");
		const out = await quest(tree, "mv", "quest/m0/epic/one.md", "quest/m0/epic/first.md");
		expect(out.code).toBe(0);
		expect(out.stderr).toBe(
			"quest: no origin remote, so claims were not checked\n" +
				"quest: draft.md:1: mentions quest/m0/epic/one.md; update it by hand\n",
		);
	});

	test("reports mentions of a moved epic's directory but not of its siblings", async () => {
		const tree = Tree.baseline().write(
			"notes.md",
			"See quest/m0/epic.\nRun `quest rm -r quest/m0/epic` first.\nNot quest/m0/epic-2 or quest/m0/epic.md.\n",
		);
		committed(tree);
		const out = await quest(tree, "mv", "quest/m0/epic", "quest/m0/feature");
		expect(out.code).toBe(0);
		expect(out.stderr).toBe(
			"quest: no origin remote, so claims were not checked\n" +
				"quest: notes.md:1: mentions quest/m0/epic; update it by hand\n" +
				"quest: notes.md:2: mentions quest/m0/epic; update it by hand\n",
		);
	});

	test("refuses the root epic and milestones", async () => {
		const tree = Tree.baseline().write("quest/m1/README.md", "# M1\n\n## Goal\n\nNext.\n");
		committed(tree);
		for (const path of ["quest", "quest/README.md", "quest/m0", "quest/m0/README.md"]) {
			const out = await quest(tree, "mv", path, "quest/m1/old");
			expect(out.code).toBe(1);
			expect(out.stderr).toBe(`quest: ${path} is permanent; the root epic and milestones never move\n`);
		}
		expect(staged(tree)).toEqual([]);
	});

	test("refuses a destination that exists", async () => {
		const tree = committed(Tree.baseline());
		const out = await quest(tree, "mv", "quest/m0/epic/one.md", "quest/m0/epic/two.md");
		expect(out).toEqual({ code: 1, stdout: "", stderr: "quest: quest/m0/epic/two.md already exists\n" });
		expect(staged(tree)).toEqual([]);
	});

	test("refuses a claimed quest", async () => {
		const tree = committed(Tree.baseline());
		const remote = tempDir();
		git(remote, "init", "-q", "--bare");
		git(tree.path, "remote", "add", "origin", remote);
		git(tree.path, "push", "-q", "origin", "HEAD:refs/heads/quest/m0/epic/two");
		const out = await quest(tree, "mv", "quest/m0/epic", "quest/m0/feature");
		expect(out.code).toBe(1);
		expect(out.stdout).toBe("");
		expect(out.stderr).toContain("quest: origin is not on GitHub, so only its branches were checked for claims\n");
		expect(out.stderr).toContain("quest: refusing to move claimed quests: quest/m0/epic/two;");
		expect(existsSync(join(tree.path, "quest/m0/epic/two.md"))).toBe(true);
		expect(staged(tree)).toEqual([]);
	});

	test("fails outside a git work tree", async () => {
		const out = await quest(Tree.baseline(), "mv", "quest/m0/epic/one.md", "quest/m0/epic/first.md");
		expect(out.code).toBe(1);
		expect(out.stderr).toContain("is not in a git work tree");
	});
});

describe("quest rm", () => {
	test("deletes a quest listed under several Required and Related sections", async () => {
		const tree = Tree.baseline()
			.append("quest/m0/epic/README.md", "- [Three](/quest/m0/epic/three.md)\n")
			.write(
				"quest/m0/epic/three.md",
				"# [S] Three\n\n## Goal\n\nMore.\n\n## Required\n\n- [Two](/quest/m0/epic/two.md)\n- [One](/quest/m0/epic/one.md)\n\n" +
					"## Related\n\n- [One](/quest/m0/epic/one.md) - similar\n",
			);
		committed(tree);
		const out = await quest(tree, "rm", "quest/m0/epic/one.md");
		expect(out).toEqual({
			code: 0,
			stdout: "D quest/m0/epic/one.md\nM quest/m0/epic/README.md\nM quest/m0/epic/three.md\nM quest/m0/epic/two.md\n",
			stderr: "",
		});
		expect(tree.read("quest/m0/epic/two.md")).toBe("# [S] Two\n\n## Goal\n\nAnother quest.\n");
		expect(tree.read("quest/m0/epic/three.md")).toBe(
			"# [S] Three\n\n## Goal\n\nMore.\n\n## Required\n\n- [Two](/quest/m0/epic/two.md)\n",
		);
		expect(staged(tree)).toContain("D  quest/m0/epic/one.md");
		tree.accepts();
	});

	test("drops links to the milestone it finishes while the root still lists it", async () => {
		const tree = Tree.baseline()
			.write("quest/README.md", `${ROOT_README}- [M1](/quest/m1/README.md)\n`)
			.write("quest/m1/README.md", "# M1\n\n## Goal\n\nNext.\n\n## Required\n\n- [Later](/quest/m1/later.md)\n")
			.write(
				"quest/m1/later.md",
				"# [S] Later\n\n## Goal\n\nAfter m0.\n\n## Required\n\n- [M0](/quest/m0/README.md)\n",
			);
		committed(tree);
		const out = await quest(tree, "rm", "-r", "quest/m0/epic");
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			"D quest/m0/epic/README.md\nD quest/m0/epic/one.md\nD quest/m0/epic/two.md\nM quest/m0/README.md\nM quest/m1/later.md\n",
		);
		expect(tree.read("quest/m0/README.md")).toBe("# M0\n\n## Goal\n\nA milestone.\n");
		expect(tree.read("quest/m1/later.md")).toBe("# [S] Later\n\n## Goal\n\nAfter m0.\n");
		expect(tree.read("quest/README.md")).toContain("- [M0](/quest/m0/README.md)\n");
		tree.accepts();
	});

	test("refuses an epic that holds quests without -r, by directory or README", async () => {
		const tree = committed(Tree.baseline());
		for (const path of ["quest/m0/epic", "quest/m0/epic/README.md"]) {
			const out = await quest(tree, "rm", path);
			expect(out.code).toBe(1);
			expect(out.stderr).toBe(
				`quest: ${path} is an epic holding 3 quest documents; pass -r to remove them all\n`,
			);
		}
		expect(staged(tree)).toEqual([]);
	});

	test("refuses the root epic and milestones", async () => {
		const tree = committed(Tree.baseline());
		for (const path of ["quest/m0", "quest/m0/README.md", "quest/README.md"]) {
			expect((await quest(tree, "rm", "-r", path)).stderr).toContain("is permanent");
		}
	});

	test("refuses a directory that holds no quest documents", async () => {
		const tree = committed(Tree.baseline().write("quest/m0/research/AGENTS.md", "Notes.\n"));
		const out = await quest(tree, "rm", "-r", "quest/m0/research");
		expect(out).toEqual({ code: 1, stdout: "", stderr: "quest: quest/m0/research holds no quest documents\n" });
		expect(existsSync(join(tree.path, "quest/m0/research/AGENTS.md"))).toBe(true);
		expect(staged(tree)).toEqual([]);
	});

	test("reports a prose link it does not edit, and the check that fails on it", async () => {
		const tree = Tree.baseline().append(
			"quest/m0/epic/two.md",
			"\n## Plan\n\nReuse [one](/quest/m0/epic/one.md).\n",
		);
		committed(tree);
		const out = await quest(tree, "rm", "quest/m0/epic/one.md");
		expect(out.code).toBe(1);
		expect(out.stderr).toContain(
			"quest: quest/m0/epic/two.md:9: mentions quest/m0/epic/one.md; update it by hand\n",
		);
		expect(out.stderr).toContain("quest: quest/m0/epic/two.md:9: link does not resolve: /quest/m0/epic/one.md\n");
	});
});

test("open pull requests come from every page, by head branch", async () => {
	const requested: string[] = [];
	const deps: GitHubDependencies = {
		token: "test-token",
		now: () => 0,
		sleep: async () => undefined,
		warn: () => undefined,
		fetch: async (input) => {
			const url = new URL(String(input));
			requested.push(url.pathname + url.search);
			const page = url.searchParams.get("page");
			// The first PR is from a fork and handed back; the second's fork was deleted.
			const pull = (ref: string, n: number, body: string | null) => ({
				number: n,
				head: { ref, repo: n === 1 ? { full_name: "someone/project" } : null },
				draft: n === 1,
				body,
				created_at: "2026-10-21T12:00:00Z",
				updated_at: "2026-10-21T13:00:00Z",
				html_url: `https://github.com/example/project/pull/${n}`,
			});
			return page === null
				? new Response(JSON.stringify([pull("quest/m0/a", 1, "Notes.\n\n## Decisions needed\n")]), {
						headers: {
							link: '<https://api.github.com/repos/example/project/pulls?state=open&page=2>; rel="next"',
						},
					})
				: new Response(JSON.stringify([pull("feature", 2, null)]));
		},
	};
	const times = { created: Date.parse("2026-10-21T12:00:00Z"), updated: Date.parse("2026-10-21T13:00:00Z") };
	expect(await openPullRequests(new GitHub(deps), { owner: "example", repo: "project" })).toEqual([
		{
			number: 1,
			url: "https://github.com/example/project/pull/1",
			branch: "quest/m0/a",
			head: "someone/project",
			draft: true,
			...times,
			handedBack: true,
		},
		{
			number: 2,
			url: "https://github.com/example/project/pull/2",
			branch: "feature",
			head: null,
			draft: false,
			...times,
			handedBack: false,
		},
	]);
	expect(requested).toEqual([
		"/repos/example/project/pulls?state=open&per_page=100",
		"/repos/example/project/pulls?state=open&page=2",
	]);
});
