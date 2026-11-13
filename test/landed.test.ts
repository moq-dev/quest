// `quest check --base`: a PR from a quest's branch deletes or edits its quest.

import { execFileSync } from "node:child_process";

import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, expect, test } from "vitest";

import { landingCheck } from "../src/cli/landed";
import { Tree, initRepository, tempDir } from "./fixture";

const FINDING = "neither deletes nor edits its quest since main";

/** The baseline tree committed on `main`, then checked out on `branch`. */
function repo(branch: string): Tree {
	const tree = Tree.committed();
	git(tree, "switch", "--quiet", "-c", branch);
	return tree;
}

function git(tree: Tree, ...args: string[]): string {
	return execFileSync("git", ["-C", tree.path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function commit(tree: Tree, message: string) {
	git(tree, "add", "--all");
	git(tree, "commit", "--quiet", "--allow-empty", "-m", message);
}

test("a quest branch that deletes its quest passes", () => {
	const tree = repo("quest/m0/epic/one");
	// Finishing a quest edits only what it blocked, never its epic's README.
	tree.remove("quest/m0/epic/one.md").write("quest/m0/epic/two.md", "# [S] Two\n\n## Goal\n\nAnother quest.\n");
	commit(tree, "finish one");
	expect(tree.run("check", "--base", "main")).toEqual({ code: 0, stdout: "quest: 4 documents ok\n", stderr: "" });
});

test("a quest branch that edits its quest passes", () => {
	const tree = repo("quest/m0/epic/one");
	tree.append("quest/m0/epic/one.md", "\n## Plan\n\nWhat remains.\n");
	commit(tree, "trim one");
	expect(tree.run("check", "--base", "main").code).toBe(0);
});

test("a quest branch that leaves its quest untouched is a finding", () => {
	const tree = repo("quest/m0/epic/one");
	tree.write("src.ts", "work\n");
	commit(tree, "work");
	const out = tree.run("check", "--base", "main");
	expect(out.code).toBe(1);
	expect(out.stderr).toBe(
		`quest: quest/m0/epic/one.md: branch quest/m0/epic/one ${FINDING}; a PR that finishes a quest deletes it and ` +
			"every link to it, and one that leaves work rewrites it to what remains (`quest guide`, Execution)\n",
	);
	// A plain check is unchanged.
	expect(tree.run("check").code).toBe(0);
});

test("the working tree counts, before it is committed", () => {
	const tree = repo("quest/m0/epic/one");
	expect(tree.run("check", "--base", "main").stderr).toContain(FINDING);
	tree.append("quest/m0/epic/one.md", "\nMore.\n");
	expect(tree.run("check", "--base", "main").code).toBe(0);
});

test("an epic's branch, its README's path without .md, is checked against its README", () => {
	const tree = repo("quest/m0/epic/README");
	expect(tree.run("check", "--base", "main").stderr).toContain(
		`quest/m0/epic/README.md: branch quest/m0/epic/README ${FINDING}`,
	);
	tree.append("quest/m0/epic/README.md", "\nMore.\n");
	expect(tree.run("check", "--base", "main").code).toBe(0);
});

test("an epic's directory is not its branch", () => {
	expect(repo("quest/m0/epic").run("check", "--base", "main").code).toBe(0);
});

test("a branch that is not a quest branch adds no finding", () => {
	const tree = repo("fix/typo");
	expect(tree.run("check", "--base", "main").code).toBe(0);
});

test("a branch naming no quest at the merge base adds no finding", () => {
	const tree = repo("quest/m0/epic/three");
	tree.write("quest/m0/epic/three.md", "# [S] Three\n\n## Goal\n\nNew.\n");
	commit(tree, "plan three");
	expect(tree.run("check", "--base", "main").code).toBe(0);
});

test("--branch overrides the current branch", () => {
	const tree = repo("local-name");
	expect(tree.run("check", "--base", "main").code).toBe(0);
	expect(tree.run("check", "--base", "main", "--branch", "quest/m0/epic/two").stderr).toContain(
		`quest/m0/epic/two.md: branch quest/m0/epic/two ${FINDING}`,
	);
});

test("the base is compared from its merge base, not its tip", () => {
	const tree = repo("quest/m0/epic/two");
	// main moves on and edits the quest; the branch itself never touched it.
	git(tree, "switch", "--quiet", "main");
	tree.append("quest/m0/epic/two.md", "\nUpstream.\n");
	commit(tree, "upstream");
	git(tree, "switch", "--quiet", "quest/m0/epic/two");
	expect(tree.run("check", "--base", "main").stderr).toContain(FINDING);
});

test("a detached HEAD needs --branch", () => {
	const tree = repo("quest/m0/epic/one");
	git(tree, "switch", "--quiet", "--detach");
	const out = tree.run("check", "--base", "main");
	expect(out.code).toBe(1);
	expect(out.stderr).toContain("HEAD is not on a branch; pass --branch");
});

test("an unknown base fails", () => {
	const out = repo("quest/m0/epic/one").run("check", "--base", "nope");
	expect(out.code).toBe(1);
	expect(out.stderr).toContain("no merge base between nope and HEAD");
});

test("--branch without --base is a usage error", () => {
	expect(Tree.baseline().run("check", "--branch", "quest/m0/epic/one").code).toBe(2);
});

describe("quest merge's landing check", () => {
	/** Check `branch`'s tip in `tree` as `quest merge` would, fetching from `tree` into `root`. */
	function inspect(tree: Tree, branch: string, root = tempDir()) {
		const sha = git(tree, "rev-parse", branch).trim();
		return landingCheck(root)({ remote: tree.path, base: "main", branch, sha, token: "token" });
	}

	test("finds a head that leaves its quest untouched, against the fetched base", async () => {
		const tree = repo("quest/m0/epic/one");
		tree.write("src.ts", "work\n");
		commit(tree, "work");
		const findings = await inspect(tree, "quest/m0/epic/one");
		expect(findings.map((finding) => [finding.path, finding.message])).toEqual([
			["quest/m0/epic/one.md", expect.stringContaining("neither deletes nor edits its quest since origin/main")],
		]);
	});

	test("passes a head that edits its quest, borrowing a checkout's objects", async () => {
		const tree = repo("quest/m0/epic/one");
		tree.append("quest/m0/epic/one.md", "\n## Plan\n\nWhat remains.\n");
		commit(tree, "trim one");
		expect(await inspect(tree, "quest/m0/epic/one", tree.path)).toEqual([]);
	});

	test("reads the committed head, not a working tree", async () => {
		const tree = repo("quest/m0/epic/one");
		commit(tree, "nothing");
		// An uncommitted edit in the remote's own checkout is not part of the head.
		tree.append("quest/m0/epic/one.md", "\nMore.\n");
		expect(await inspect(tree, "quest/m0/epic/one")).toHaveLength(1);
	});

	test("reports a structural finding in the head's tree", async () => {
		const tree = repo("fix/link");
		tree.append("quest/m0/epic/one.md", "\n## Related\n\n- [Gone](/quest/m0/gone.md) - missing\n");
		commit(tree, "dangling link");
		const findings = await inspect(tree, "fix/link");
		expect(findings.map((finding) => finding.path)).toEqual(["quest/m0/epic/one.md"]);
	});

	test("skips a finding the base already has", async () => {
		const tree = Tree.committed();
		tree.append("quest/m0/epic/one.md", "\n## Related\n\n- [Gone](/quest/m0/gone.md) - missing\n");
		commit(tree, "dangling link on main");
		git(tree, "switch", "--quiet", "-c", "fix/other");
		tree.append("quest/m0/epic/two.md", "\n## Related\n\n- [Lost](/quest/m0/lost.md) - missing\n");
		commit(tree, "another dangling link");
		const findings = await inspect(tree, "fix/other");
		expect(findings.map((finding) => finding.path)).toEqual(["quest/m0/epic/two.md"]);
	});

	test("a head that removes every quest is a finding", async () => {
		const tree = repo("fix/purge");
		git(tree, "rm", "--quiet", "-r", "quest");
		commit(tree, "purge");
		const findings = await inspect(tree, "fix/purge");
		expect(findings).toEqual([
			{ path: "quest", line: null, message: expect.stringContaining("no quest documents") },
		]);
	});

	test("a base without quests does not use them", async () => {
		const path = initRepository();
		const tree = new Tree(path);
		tree.write("README.md", "hi\n");
		commit(tree, "init");
		git(tree, "switch", "--quiet", "-c", "quest/m0/anything");
		tree.write("src.ts", "work\n");
		commit(tree, "work");
		expect(await inspect(tree, "quest/m0/anything")).toEqual([]);
	});

	test("fails on a head the remote does not have, and leaves no scratch repository", async () => {
		const tree = repo("quest/m0/epic/one");
		const before = readdirSync(tmpdir()).filter((name) => name.startsWith("quest-merge-")).length;
		const check = landingCheck(tempDir())({
			remote: tree.path,
			base: "main",
			branch: "quest/m0/epic/one",
			sha: "c".repeat(40),
			token: "token",
		});
		await expect(check).rejects.toThrow("git fetch failed");
		expect(readdirSync(tmpdir()).filter((name) => name.startsWith("quest-merge-")).length).toBe(before);
	});
});
