// `quest check --base`: a PR from a quest's branch deletes or edits its quest.

import { execFileSync } from "node:child_process";

import { expect, test, vi } from "vitest";

import { Tree } from "./fixture";

const FINDING = "neither deletes nor edits its quest since main";

// Each test spawns git up to a dozen times, which a busy Windows runner can stretch past 5 s.
vi.setConfig({ testTimeout: 30_000 });

/** The baseline tree committed on `main`, then checked out on `branch`. */
function repo(branch: string): Tree {
	const tree = Tree.baseline();
	git(tree, "init", "--quiet", "--initial-branch=main");
	commit(tree, "baseline");
	git(tree, "switch", "--quiet", "-c", branch);
	return tree;
}

function git(tree: Tree, ...args: string[]): string {
	return execFileSync("git", ["-C", tree.path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function commit(tree: Tree, message: string) {
	git(tree, "add", "--all");
	git(
		tree,
		"-c",
		"user.name=Quest",
		"-c",
		"user.email=quest@example.com",
		"commit",
		"--quiet",
		"--allow-empty",
		"-m",
		message,
	);
}

test("a quest branch that deletes its quest passes", () => {
	const tree = repo("quest/m0/epic/one");
	tree.remove("quest/m0/epic/one.md")
		.write(
			"quest/m0/epic/README.md",
			"# Epic\n\n## Goal\n\nAn epic.\n\n## Required\n\n- [Two](/quest/m0/epic/two.md)\n",
		)
		.write("quest/m0/epic/two.md", "# [S] Two\n\n## Goal\n\nAnother quest.\n");
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
	tree.append("quest/m0/epic/README.md", "- [Three](/quest/m0/epic/three.md)\n");
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
