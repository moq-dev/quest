// The command line's own contract: output streams, exit codes, and arguments.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import { version } from "../package.json";
import { Tree, run, tempDir } from "./fixture";

test("check reports the document count", () => {
	expect(Tree.baseline().run("check")).toEqual({ code: 0, stdout: "quest: 5 documents ok\n", stderr: "" });
});

test("check prints findings on stderr and fails", () => {
	const out = Tree.baseline().append("quest/m0/epic/one.md", "\n## Requires\n").run("check");
	expect(out.code).toBe(1);
	expect(out.stdout).toBe("");
	expect(out.stderr).toContain("quest: quest/m0/epic/one.md:7: unknown '## Requires'");
});

// Blocked or not, unblocked <path> exits 0: the blocker list on stdout is the result.
test("unblocked with a path prints blockers on stdout and explains on stderr", () => {
	const out = Tree.baseline().run("unblocked", "/quest/m0/epic/two.md");
	expect(out.code).toBe(0);
	expect(out.stdout).toBe("quest/m0/epic/one.md\n");
	expect(out.stderr).toContain("quest: blocked by quest/m0/epic/one.md\n");
	expect(out.stderr).toContain("quest: /quest/m0/epic/two.md is blocked;");
});

test("unblocked with a ready quest prints nothing", () => {
	expect(Tree.baseline().run("unblocked", "quest/m0/epic/one.md")).toEqual({ code: 0, stdout: "", stderr: "" });
});

test("unblocked accepts a filesystem path", () => {
	const tree = Tree.baseline();
	expect(tree.run("unblocked", `${tree.path}/quest/m0/epic/two.md`).stdout).toBe("quest/m0/epic/one.md\n");
});

test("waiting lists the maintainer's items first, one per line", () => {
	const tree = Tree.baseline()
		.append("quest/m0/epic/one.md", "\n## Waiting\n\n- moq-dev/moq: a release carries the fix.\n")
		.append("quest/m0/epic/two.md", "\n## Waiting\n\n- Maintainer: pick a name.\n");
	expect(tree.run("waiting")).toEqual({
		code: 0,
		stdout:
			"0\tblocked\tquest/m0/epic/two.md\tMaintainer: pick a name.\n" +
			"1\tready\tquest/m0/epic/one.md\tmoq-dev/moq: a release carries the fix.\n",
		stderr: "",
	});
	expect(tree.run("waiting", "--maintainer").stdout).toBe(
		"0\tblocked\tquest/m0/epic/two.md\tMaintainer: pick a name.\n",
	);
	expect(JSON.parse(tree.run("waiting", "--json", "--limit", "1").stdout)).toEqual([
		{
			path: "quest/m0/epic/two.md",
			dependents: 0,
			ready: false,
			waits: [{ line: expect.any(Number), party: "Maintainer", text: "pick a name." }],
		},
	]);
});

test("unblocked rejects a path that is not a quest", () => {
	const out = Tree.baseline().run("unblocked", "nope.md");
	expect(out.code).toBe(1);
	expect(out.stderr).toMatch(/^quest: nope.md is not a quest document under .*\/quest\n$/);
});

test("unblocked rejects ranking options with a path", () => {
	for (const option of ["--json", "--unclaimed", "--limit=1"]) {
		expect(Tree.baseline().run("unblocked", "quest/m0/epic/one.md", option).code).toBe(2);
	}
});

test("the ready command is gone", () => {
	expect(Tree.baseline().run("ready").code).toBe(2);
});

test("the root option is accepted after the command", () => {
	const tree = Tree.baseline();
	expect(run("unblocked", "--root", tree.path).stdout).toBe("1\tquest/m0/epic/one.md\n");
});

test("init and uninstall print each changed path and nothing else", () => {
	const root = tempDir();
	const init = run("--root", root, "init");
	expect(init.code).toBe(0);
	expect(init.stdout).toMatch(/^(\S+\n)+$/);
	expect(init.stdout).toContain("quest/README.md\nAGENTS.md\n");
	expect(init.stderr).toBe("");
	expect(run("--root", root, "init").stdout).toBe("");
	expect(run("--root", root, "uninstall").stdout).toMatch(/^(\S+\n)+$/);
	expect(run("--root", root, "uninstall").stdout).toBe("");
});

test("init names each hook entry it removes on stderr", () => {
	const root = tempDir();
	mkdirSync(join(root, ".claude"));
	const hook = { hooks: [{ type: "command", command: 'nix run ".#quest" -- worktree hook' }] };
	writeFileSync(join(root, ".claude/settings.json"), JSON.stringify({ hooks: { WorktreeCreate: [hook] } }));
	const init = run("--root", root, "init");
	expect(init.code).toBe(0);
	expect(init.stdout).toContain(".claude/settings.json\n");
	expect(init.stderr).toBe(
		'quest: removed the WorktreeCreate hook `nix run ".#quest" -- worktree hook` from .claude/settings.json; ' +
			"Quest's worktree hooks are now opt-in in your own Claude settings (see the README)\n",
	);
});

test("version", () => {
	expect(run("--version")).toEqual({ code: 0, stdout: `quest ${version}\n`, stderr: "" });
});

test("skill lists every skill", () => {
	const out = run("skill");
	expect(out.code).toBe(0);
	expect(out.stdout).toMatch(/^start - /m);
});

test("skill rejects an unknown name", () => {
	const out = run("skill", "nope");
	expect(out.code).toBe(1);
	expect(out.stderr).toMatch(/^quest: no skill named nope \(have: afk, audit, /);
});

test("usage errors exit 2", () => {
	expect(run("bogus").code).toBe(2);
	expect(run("skill", "--stub").code).toBe(2);
	expect(run("unblocked", "a", "b").code).toBe(2);
	expect(run().code).toBe(2);
});

test("an empty root is a usage error", () => {
	expect(run("--root", "", "check").code).toBe(2);
});

test("a missing tree names the directory as given", () => {
	const out = run("--root", "./nonexistent", "check");
	expect(out.code).toBe(1);
	expect(out.stderr).toMatch(/^quest: scanning \.\/nonexistent\/quest: ENOENT/);
});

test("a document that is not UTF-8 is an error", () => {
	const tree = Tree.baseline();
	writeFileSync(join(tree.path, "quest/m0/epic/one.md"), Buffer.from([0x23, 0x20, 0xff, 0x0a]));
	const out = tree.run("check");
	expect(out.code).toBe(1);
	expect(out.stderr).toMatch(/^quest: reading quest\/m0\/epic\/one\.md: /);
});

test("unblocked prints ranked counts and paths, with deterministic JSON and a limit", () => {
	const tree = Tree.baseline();
	expect(tree.run("unblocked")).toEqual({ code: 0, stdout: "1\tquest/m0/epic/one.md\n", stderr: "" });
	expect(tree.run("unblocked", "--json", "--limit", "1")).toEqual({
		code: 0,
		stdout: '[{"path":"quest/m0/epic/one.md","dependents":1}]\n',
		stderr: "",
	});
	tree.write("quest/m0/epic/two.md", "# [S] Two\n\n## Goal\n\nWork.\n");
	expect(JSON.parse(tree.run("unblocked", "--json", "--limit", "1").stdout)).toHaveLength(1);
	expect(JSON.parse(tree.run("unblocked", "--json").stdout)).toHaveLength(2);
});

test("unblocked explains the count on a terminal, including NO_COLOR", () => {
	const result = Tree.baseline().runOn({ colour: false }, "unblocked");
	expect(result.code).toBe(0);
	expect(result.stdout).toContain("other prerequisites may remain");
	expect(result.stdout).toContain("1\tquest/m0/epic/one.md\n");
});

test("unblocked returns an empty JSON array for an empty milestone", () => {
	const tree = Tree.baseline().remove("quest/m0/epic").write("quest/m0/README.md", "# M0\n\n## Goal\n\nWork.\n");
	expect(tree.run("unblocked", "--json")).toEqual({ code: 0, stdout: "[]\n", stderr: "" });
});

test("unblocked fails without output for invalid trees and unresolved links", () => {
	const tree = Tree.baseline().append("quest/m0/epic/one.md", "\n## Required\n\n- [Two](/quest/m0/epic/two.md)\n");
	const cycle = tree.run("unblocked", "--json");
	expect(cycle.code).toBe(1);
	expect(cycle.stdout).toBe("");
	expect(cycle.stderr).toContain("Required cycle");
	const missing = Tree.baseline().append("quest/m0/epic/one.md", "\n[Missing](/missing.txt)\n").run("unblocked");
	expect(missing.code).toBe(1);
	expect(missing.stdout).toBe("");
	expect(missing.stderr).toContain("link does not resolve");
});

test.each(["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992"])("unblocked rejects invalid limit %s", (limit) => {
	const result = Tree.baseline().run("unblocked", "--limit", limit);
	expect(result.code).toBe(2);
	expect(result.stdout).toBe("");
	expect(result.stderr).toContain("limit must be a positive safe integer");
});
