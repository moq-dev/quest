import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { checkout, snapshot } from "../src/cli/tree";
import { check, formatFinding } from "../src/core";
import { GIT_SETTINGS, Tree, configure, initRepository, run, tempDir, template } from "./fixture";

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

/** A note callback that records what it is called with. */
function notes(): { note: (message: string) => void; seen: string[] } {
	const seen: string[] = [];
	return { note: (message) => seen.push(message), seen };
}

const LINK = "quest/m0/epic/one.md:11: link does not resolve: ../../../dependency/missing.md";
const SKIPPED = "skipped links into submodule dependency: no local git directory holds its pinned commit";

describe("committed submodule links", () => {
	test("snapshot validation resolves links inside an initialized gitlink", () => {
		const { tree, head } = fixture();
		tree.accepts();
		const { note, seen } = notes();
		const at = snapshot(tree.path, head, note);
		expect(check(at.docs, at.exists).map(formatFinding)).toEqual([]);
		expect(at.exists("dependency")).toBe(true);
		expect(at.exists("dependency/missing.md")).toBe(false);
		tree.append("quest/m0/epic/one.md", "\nMissing [source](../../../dependency/missing.md).\n");
		const missing = snapshot(tree.path, commit(tree.path), note);
		expect(check(missing.docs, missing.exists).map(formatFinding)).toEqual([LINK]);
		expect(seen).toEqual([]);
	});

	test("uses the snapshot's pin rather than a different or dirty checkout", () => {
		const { tree, head, module } = fixture();
		rmSync(join(module, "README.md"));
		writeFileSync(join(module, "later.md"), "# Later\n");
		commit(module);
		writeFileSync(join(module, "dirty.md"), "# Local only\n");
		const at = snapshot(tree.path, head, () => {});
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
		const at = snapshot(tree.path, head, () => {});
		expect(at.exists("dependency/nested/README.md")).toBe(true);
		expect(at.exists("dependency/nested/missing.md")).toBe(false);
		expect(check(at.docs, at.exists)).toEqual([]);
	});

	test("reads a deinitialized submodule from the git directory kept for it", () => {
		const { tree, head, module } = fixture();
		rmSync(join(module, ".git"));
		const at = snapshot(tree.path, head, () => {});
		expect(at.exists("dependency/README.md")).toBe(true);
		expect(at.exists("dependency/missing.md")).toBe(false);
	});

	test("notes and skips a submodule no local git directory holds", () => {
		const { tree, head, module, pin } = fixture();
		rmSync(join(module, ".git"));
		rmSync(join(tree.path, ".git", "modules"), { recursive: true });
		const { note, seen } = notes();
		const at = snapshot(tree.path, head, note);
		expect(at.exists("dependency/README.md")).toBe(true);
		expect(at.exists("dependency/missing.md")).toBe(true);
		expect(seen).toEqual([`${SKIPPED} ${pin}; run git submodule update --init --recursive to check them`]);
	});

	test("notes and skips a pinned commit absent from an initialized submodule", () => {
		const { tree, dependency } = fixture();
		writeFileSync(join(dependency, "new.md"), "# Not fetched\n");
		const pin = commit(dependency);
		git(tree.path, "update-index", "--cacheinfo", `160000,${pin},dependency`);
		git(tree.path, "commit", "-q", "-m", "pin newer source");
		const { note, seen } = notes();
		const at = snapshot(tree.path, git(tree.path, "rev-parse", "HEAD"), note);
		expect(at.exists("dependency/new.md")).toBe(true);
		expect(at.exists("dependency/missing.md")).toBe(true);
		expect(seen).toEqual([`${SKIPPED} ${pin}; run git submodule update --init --recursive to check them`]);
	});
});

describe("checkout submodule links", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	test("reads a checked-out submodule from disk", () => {
		const { tree, module } = fixture();
		writeFileSync(join(module, "dirty.md"), "# Local only\n");
		const { note, seen } = notes();
		const at = checkout(tree.path, note);
		expect(at.exists("dependency/dirty.md")).toBe(true);
		tree.append("quest/m0/epic/one.md", "\nMissing [source](../../../dependency/missing.md).\n");
		const missing = checkout(tree.path, note);
		expect(check(missing.docs, missing.exists).map(formatFinding)).toEqual([LINK]);
		expect(seen).toEqual([]);
	});

	test("resolves an uninitialized submodule in a fresh worktree at its pin", () => {
		const { tree } = fixture();
		tree.append("quest/m0/epic/one.md", "\nMissing [source](../../../dependency/missing.md).\n");
		commit(tree.path);
		const worktree = join(tempDir(), "worktree");
		git(tree.path, "worktree", "add", "-q", worktree);
		const { note, seen } = notes();
		const at = checkout(worktree, note);
		expect(at.exists("dependency")).toBe(true);
		expect(at.exists("dependency/README.md")).toBe(true);
		expect(check(at.docs, at.exists).map(formatFinding)).toEqual([LINK]);
		expect(seen).toEqual([]);
	});

	test("resolves an uninitialized submodule nested in a checked-out one", () => {
		const { tree, module } = fixture();
		const nested = initRepository();
		writeFileSync(join(nested, "README.md"), "# Nested\n");
		commit(nested);
		git(module, "-c", "protocol.file.allow=always", "submodule", "add", "-q", nested, "nested");
		commit(module);
		commit(tree.path);
		git(module, "submodule", "deinit", "-q", "-f", "nested");
		rmSync(join(module, "nested"), { recursive: true });
		const { note, seen } = notes();
		const at = checkout(tree.path, note);
		expect(at.exists("dependency/nested/README.md")).toBe(true);
		expect(at.exists("dependency/nested/missing.md")).toBe(false);
		expect(seen).toEqual([]);
	});

	test("ignores the repository location a Git hook exports", () => {
		const { tree, module } = fixture();
		const nested = initRepository();
		writeFileSync(join(nested, "README.md"), "# Nested\n");
		commit(nested);
		git(module, "-c", "protocol.file.allow=always", "submodule", "add", "-q", nested, "nested");
		commit(module);
		git(module, "submodule", "deinit", "-q", "-f", "nested");
		tree.append(
			"quest/m0/epic/one.md",
			"\n[Nested](../../../dependency/nested/README.md) and [missing](../../../dependency/nested/missing.md).\n",
		);
		commit(tree.path);
		// A pre-commit hook in the superproject runs `quest check` with these set.
		const store = join(tree.path, ".git");
		vi.stubEnv("GIT_DIR", store);
		vi.stubEnv("GIT_WORK_TREE", tree.path);
		vi.stubEnv("GIT_INDEX_FILE", join(store, "index"));
		const result = run("--root", tree.path, "check");
		expect(result.stderr).toBe(
			"quest: quest/m0/epic/one.md:11: link does not resolve: ../../../dependency/nested/missing.md\n",
		);
	});

	test("finds a deinitialized submodule's git directory by its name", () => {
		const { tree } = fixture();
		git(tree.path, "submodule", "deinit", "-q", "-f", "dependency");
		renameSync(join(tree.path, ".git", "modules", "dependency"), join(tree.path, ".git", "modules", "renamed"));
		const gitmodules = join(tree.path, ".gitmodules");
		writeFileSync(gitmodules, readFileSync(gitmodules, "utf8").replace('"dependency"', '"renamed"'));
		const { note, seen } = notes();
		const at = checkout(tree.path, note);
		expect(at.exists("dependency/.git")).toBe(false);
		expect(at.exists("dependency/README.md")).toBe(true);
		expect(at.exists("dependency/missing.md")).toBe(false);
		expect(seen).toEqual([]);
	});

	test("notes and skips an uninitialized submodule whose commit is unavailable", () => {
		const { tree, pin } = fixture();
		tree.append("quest/m0/epic/one.md", "\nMissing [source](../../../dependency/missing.md).\n");
		git(tree.path, "submodule", "deinit", "-q", "-f", "dependency");
		rmSync(join(tree.path, ".git", "modules"), { recursive: true });
		// A relative root, which git must not resolve twice once it runs there.
		const cwd = process.cwd();
		process.chdir(dirname(tree.path));
		let result: ReturnType<typeof run>;
		try {
			result = run("--root", basename(tree.path), "check");
		} finally {
			process.chdir(cwd);
		}
		expect(result.code).toBe(0);
		expect(result.stderr).toContain(`${SKIPPED} ${pin}; run git submodule update --init --recursive to check them`);
	});
});
