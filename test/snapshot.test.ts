import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { snapshot } from "../src/cli/tree";
import { check, formatFinding } from "../src/core";
import { GIT_SETTINGS, Tree, configure, initRepository, template } from "./fixture";

function git(root: string, ...args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
}

function commit(root: string): string {
	git(root, "add", ".");
	git(root, "commit", "-q", "-m", "fixture");
	return git(root, "rev-parse", "HEAD");
}

/**
 * A dependency repository, and the baseline tree with it as an initialized
 * submodule linked from a quest. The submodule's origin is the template's own
 * dependency, so commits there go to the per-test `dependency` instead.
 */
const fixtures = template((dir) => {
	const dependency = initRepository(join(dir, "dependency"));
	writeFileSync(join(dependency, "README.md"), "# Dependency\n");
	const pin = commit(dependency);
	const tree = join(dir, "tree");
	Tree.baseline()
		.append(
			"quest/m0/epic/one.md",
			"\n## Related\n\n- [Dependency](../../../dependency/README.md) - the committed source\n",
		)
		.copy(tree);
	initRepository(tree);
	git(tree, "-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "dependency");
	configure(join(tree, ".git", "modules", "dependency"), GIT_SETTINGS);
	const head = commit(tree);
	writeFileSync(join(dir, "commits.json"), JSON.stringify({ head, pin }));
});

function fixture() {
	const dir = fixtures();
	const { head, pin } = JSON.parse(readFileSync(join(dir, "commits.json"), "utf8")) as { head: string; pin: string };
	const tree = new Tree(join(dir, "tree"));
	return { tree, head, pin, dependency: join(dir, "dependency"), module: join(tree.path, "dependency") };
}

// Cases run up to ~35 real Git processes. Process creation on the Windows ARM runner
// costs ~80-250 ms while other test files start, so the 5 s unit-test default is too short.
describe("committed submodule links", { timeout: 20_000 }, () => {
	test("snapshot validation resolves links inside an initialized gitlink", () => {
		const { tree, head } = fixture();
		tree.accepts();
		const at = snapshot(tree.path, head);
		expect(check(at.docs, at.exists).map(formatFinding)).toEqual([]);
		expect(at.exists("dependency")).toBe(true);
		expect(at.exists("dependency/missing.md")).toBe(false);
		tree.append("quest/m0/epic/one.md", "\nMissing [source](../../../dependency/missing.md).\n");
		const missing = snapshot(tree.path, commit(tree.path));
		expect(check(missing.docs, missing.exists).map(formatFinding)).toEqual([
			"quest/m0/epic/one.md:11: link does not resolve: ../../../dependency/missing.md",
		]);
	});

	test("uses the snapshot's pin rather than a different or dirty checkout", () => {
		const { tree, head, module } = fixture();
		rmSync(join(module, "README.md"));
		writeFileSync(join(module, "later.md"), "# Later\n");
		commit(module);
		writeFileSync(join(module, "dirty.md"), "# Local only\n");
		const at = snapshot(tree.path, head);
		expect(at.exists("dependency/README.md")).toBe(true);
		expect(at.exists("dependency/later.md")).toBe(false);
		expect(at.exists("dependency/dirty.md")).toBe(false);
		expect(check(at.docs, at.exists)).toEqual([]);
	});

	test("resolves nested gitlinks without importing their quests", () => {
		const { tree, module } = fixture();
		const nested = initRepository();
		mkdirSync(join(nested, "quest"));
		writeFileSync(join(nested, "quest", "README.md"), "not a valid quest\n");
		writeFileSync(join(nested, "README.md"), "# Nested\n");
		commit(nested);
		git(module, "-c", "protocol.file.allow=always", "submodule", "add", "-q", nested, "nested");
		commit(module);
		const head = commit(tree.path);
		const at = snapshot(tree.path, head);
		expect(at.exists("dependency/nested/README.md")).toBe(true);
		expect(at.exists("dependency/nested/missing.md")).toBe(false);
		expect(check(at.docs, at.exists)).toEqual([]);
	});

	test("refuses an unavailable object database instead of trusting checkout files", () => {
		const { tree, head, module, pin } = fixture();
		rmSync(join(module, ".git"));
		const at = snapshot(tree.path, head);
		expect(() => at.exists("dependency/README.md")).toThrow(`submodule dependency at ${pin}`);
		expect(() => at.exists("dependency/README.md")).toThrow("git submodule update --init --recursive");
	});

	test("refuses a pinned commit absent from an initialized submodule", () => {
		const { tree, dependency } = fixture();
		writeFileSync(join(dependency, "new.md"), "# Not fetched\n");
		const pin = commit(dependency);
		git(tree.path, "update-index", "--cacheinfo", `160000,${pin},dependency`);
		git(tree.path, "commit", "-q", "-m", "pin newer source");
		const at = snapshot(tree.path, git(tree.path, "rev-parse", "HEAD"));
		expect(() => at.exists("dependency/README.md")).toThrow(`submodule dependency at ${pin}`);
		expect(() => at.exists("dependency/new.md")).toThrow("git submodule update --init --recursive");
	});
});
