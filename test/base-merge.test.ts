// The core's check that a head only merged the base since a review, against real merges and git's own.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { BaseMerges, merge, render } from "../src/core";
import { GitHubReader } from "../src/github/client";
import { history } from "../src/github/history";
import { commit, git, gitHistory, gitRoutes, repository } from "./git-history";

/** Numbered lines, with `edits` replacing some by number. */
const lines = (edits: Record<number, string> = {}) =>
	Array.from({ length: 20 }, (_, i) => `${edits[i + 1] ?? `line ${i + 1}`}\n`).join("");

/** Merge `main` into the current branch, without a commit when `stop` is set; whether it merged cleanly. */
function mergeMain(dir: string, stop = false): boolean {
	const args = ["-C", dir, "merge", "-q", "--no-edit", ...(stop ? ["--no-commit"] : []), "main"];
	return spawnSync("git", args, { encoding: "utf8" }).status === 0;
}

/** Commit an interrupted merge as it now stands in the work tree. */
function conclude(dir: string): string {
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "--no-edit");
	return git(dir, "rev-parse", "HEAD");
}

/** A PR branch `pr` that edits line 5 of `a.txt`, reviewed at its tip, and a base that edits line 7 since. */
function reviewed(): { dir: string; reviewed: string } {
	const dir = repository();
	commit(dir, { "a.txt": lines(), "b.txt": "b\n" });
	git(dir, "switch", "-q", "-c", "pr");
	const head = commit(dir, { "a.txt": lines({ 5: "ours" }) });
	git(dir, "switch", "-q", "main");
	commit(dir, { "a.txt": lines({ 7: "theirs" }) });
	git(dir, "switch", "-q", "pr");
	return { dir, reviewed: head };
}

const carries = (dir: string, reviewed: string, head = git(dir, "rev-parse", "HEAD")) =>
	new BaseMerges(gitHistory(dir), head).reaches(reviewed);

describe("a review carries", () => {
	test("across clean merges of the base next to the PR's lines, whose diff text changed", async () => {
		const { dir, reviewed: head } = reviewed();
		expect(mergeMain(dir)).toBe(true);
		expect(git(dir, "diff", "main...HEAD")).not.toBe(git(dir, "diff", `main...${head}`));
		expect(await carries(dir, head)).toBe(true);
		git(dir, "switch", "-q", "main");
		commit(dir, { "a.txt": lines({ 7: "theirs", 3: "again" }), "c.txt": "c\n" });
		git(dir, "switch", "-q", "pr");
		expect(mergeMain(dir)).toBe(true);
		expect(await carries(dir, head)).toBe(true);
	});

	test("across a clean merge where attributes the check cannot parse name only other files", async () => {
		const { dir, reviewed: head } = reviewed();
		git(dir, "switch", "-q", "main");
		commit(dir, { ".gitattributes": "images/*.[pP][nN][gG] binary\n" });
		git(dir, "switch", "-q", "pr");
		expect(mergeMain(dir)).toBe(true);
		expect(await carries(dir, head)).toBe(true);
	});

	test("across a clean merge of a file the base added under a directory the PR deleted", async () => {
		const dir = repository();
		commit(dir, { "d/a.txt": "a\n", "d/b.txt": "b\n", "e.txt": "e\n" });
		git(dir, "switch", "-q", "-c", "pr");
		const head = commit(dir, { "d/a.txt": null, "d/b.txt": null });
		git(dir, "switch", "-q", "main");
		commit(dir, { "d/c.txt": "c\n" });
		git(dir, "switch", "-q", "pr");
		expect(mergeMain(dir)).toBe(true);
		expect(await carries(dir, head)).toBe(true);
	});

	test("across a clean merge where both sides deleted a file and neither added one", async () => {
		const dir = repository();
		commit(dir, { "d/a.txt": "a\n", "d/b.txt": "b\n", "e.txt": "e\n" });
		git(dir, "switch", "-q", "-c", "pr");
		const head = commit(dir, { "d/a.txt": null, "d/b.txt": null });
		git(dir, "switch", "-q", "main");
		commit(dir, { "d/a.txt": null, "e.txt": "changed\n" });
		git(dir, "switch", "-q", "pr");
		expect(mergeMain(dir)).toBe(true);
		expect(await carries(dir, head)).toBe(true);
	});

	test("across a clean merge that keeps the base's mode change on a file the PR edited", async () => {
		const { dir, reviewed: head } = reviewed();
		git(dir, "switch", "-q", "main");
		chmodSync(join(dir, "a.txt"), 0o755);
		commit(dir, {});
		git(dir, "switch", "-q", "pr");
		expect(mergeMain(dir)).toBe(true);
		expect(await carries(dir, head)).toBe(true);
	});
});

describe("a merge both sides changed a file in", () => {
	/** A PR that writes `ours` over `base` in `a.txt`, reviewed, and a base that writes `theirs`, merged in. */
	function merged(ours: string, base: string, theirs: string) {
		const dir = repository();
		commit(dir, { "a.txt": base });
		git(dir, "switch", "-q", "-c", "pr");
		const head = commit(dir, { "a.txt": ours });
		git(dir, "switch", "-q", "main");
		commit(dir, { "a.txt": theirs });
		git(dir, "switch", "-q", "pr");
		return { dir, head, clean: mergeMain(dir) };
	}

	test("carries where git's histogram merge is clean, though merge-file's Myers merge conflicts", async () => {
		const [ours, base, theirs] = ["x\n}\n}\n\na\nb\n\n\n", "x\n}\n}\nb\n\nb\n\n", "}\n}\n}\nb\n\n\n"];
		expect(merge(ours, base, theirs).every((chunk) => Array.isArray(chunk))).toBe(false);
		const { dir, head, clean } = merged(ours, base, theirs);
		expect(clean).toBe(true);
		expect(await carries(dir, head)).toBe(true);
	});

	test("does not carry a conflict git's histogram merge left, resolved as Myers would have merged it", async () => {
		const [ours, base, theirs] = ["c\n\nc\n", "}\nc\nc\n", "c\nc\n}\n"];
		const myers = merge(ours, base, theirs);
		expect(myers.every((chunk) => Array.isArray(chunk))).toBe(true);
		const { dir, head, clean } = merged(ours, base, theirs);
		expect(clean).toBe(false);
		writeFileSync(join(dir, "a.txt"), render(myers, 7, false));
		conclude(dir);
		expect(await carries(dir, head)).toBe(false);
	});
});

describe("a review does not carry", () => {
	test("across a writer's commit after the merge", async () => {
		const { dir, reviewed: head } = reviewed();
		mergeMain(dir);
		commit(dir, { "b.txt": "changed\n" });
		expect(await carries(dir, head)).toBe(false);
	});

	test("across a merge of a branch the base does not reach", async () => {
		const { dir, reviewed: head } = reviewed();
		git(dir, "switch", "-q", "-c", "other", "main");
		commit(dir, { "c.txt": "c\n" });
		git(dir, "switch", "-q", "pr");
		git(dir, "merge", "-q", "--no-edit", "other");
		expect(await carries(dir, head)).toBe(false);
	});

	test("across a merge with a change of its own, to a file either side touched or neither", async () => {
		for (const edit of [{ "a.txt": lines({ 5: "ours", 7: "theirs", 9: "mine" }) }, { "b.txt": "evil\n" }]) {
			const { dir, reviewed: head } = reviewed();
			expect(mergeMain(dir, true)).toBe(true);
			for (const [path, text] of Object.entries(edit)) writeFileSync(join(dir, path), text);
			conclude(dir);
			expect(await carries(dir, head)).toBe(false);
		}
	});

	test("across a hand-resolved conflict, even one resolved to either side", async () => {
		for (const side of ["ours", "theirs", "both"]) {
			const { dir, reviewed: head } = reviewed();
			git(dir, "switch", "-q", "main");
			commit(dir, { "a.txt": lines({ 5: "clash", 7: "theirs" }) });
			git(dir, "switch", "-q", "pr");
			expect(mergeMain(dir)).toBe(false);
			if (side === "both") writeFileSync(join(dir, "a.txt"), lines({ 5: "ours clash", 7: "theirs" }));
			else git(dir, "checkout", `--${side}`, "a.txt");
			conclude(dir);
			expect(await carries(dir, head)).toBe(false);
		}
	});

	test("across a merge of a binary file both sides changed", async () => {
		const dir = repository();
		commit(dir, { "a.bin": new Uint8Array([0, 1, 2]) });
		git(dir, "switch", "-q", "-c", "pr");
		const head = commit(dir, { "a.bin": new Uint8Array([0, 1, 3]) });
		git(dir, "switch", "-q", "main");
		commit(dir, { "a.bin": new Uint8Array([0, 1, 4]) });
		git(dir, "switch", "-q", "pr");
		expect(mergeMain(dir)).toBe(false);
		git(dir, "checkout", "--theirs", "a.bin");
		conclude(dir);
		expect(await carries(dir, head)).toBe(false);
	});

	test("across a rename the base deleted the source of, resolved by keeping the PR's file", async () => {
		const dir = repository();
		commit(dir, { "quest/x.md": "# [S] X\n\n## Goal\n\nDo x.\n", "b.txt": "b\n" });
		git(dir, "switch", "-q", "-c", "pr");
		git(dir, "mv", "quest/x.md", "quest/y.md");
		const head = commit(dir, {});
		git(dir, "switch", "-q", "main");
		commit(dir, { "quest/x.md": null });
		git(dir, "switch", "-q", "pr");
		expect(mergeMain(dir)).toBe(false);
		git(dir, "add", "-A");
		conclude(dir);
		expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD")).toBe("b.txt\nquest/y.md");
		expect(await carries(dir, head)).toBe(false);
	});

	test("across a rename into another directory the base deleted the source of, both leaving the same directory", async () => {
		const dir = repository();
		commit(dir, { "quest/active/x.md": "# [S] X\n\n## Goal\n\nDo x.\n", "quest/active/y.md": "# [S] Y\n" });
		git(dir, "switch", "-q", "-c", "pr");
		git(dir, "mv", "quest/active/x.md", "quest/archive.md");
		const head = commit(dir, {});
		git(dir, "switch", "-q", "main");
		commit(dir, { "quest/active/x.md": null });
		git(dir, "switch", "-q", "pr");
		expect(mergeMain(dir)).toBe(false);
		git(dir, "add", "-A");
		conclude(dir);
		expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD")).toBe("quest/active/y.md\nquest/archive.md");
		expect(await carries(dir, head)).toBe(false);
	});

	test("across a clean merge of a file a POSIX bracket class in its attributes gives another merge", async () => {
		const attributes = "fixtures/[[:digit:]]*.txt -merge\n";
		const dir = repository();
		commit(dir, { ".gitattributes": attributes, "fixtures/1.txt": lines() });
		git(dir, "switch", "-q", "-c", "pr");
		const head = commit(dir, { "fixtures/1.txt": lines({ 5: "ours" }) });
		git(dir, "switch", "-q", "main");
		commit(dir, { "fixtures/1.txt": lines({ 7: "theirs" }) });
		git(dir, "switch", "-q", "pr");
		expect(mergeMain(dir)).toBe(false);
		writeFileSync(join(dir, "fixtures/1.txt"), lines({ 5: "ours", 7: "theirs" }));
		conclude(dir);
		expect(await carries(dir, head)).toBe(false);
	});

	test("across a clean merge the base renamed a file in, which a per-path merge cannot follow", async () => {
		const { dir, reviewed: head } = reviewed();
		git(dir, "switch", "-q", "main");
		git(dir, "mv", "a.txt", "moved.txt");
		commit(dir, {});
		git(dir, "switch", "-q", "pr");
		expect(mergeMain(dir)).toBe(true);
		expect(await carries(dir, head)).toBe(false);
	});

	test("across a clean merge of a file whose attributes name another merge", async () => {
		for (const attributes of [
			"a.txt -merge\n",
			"*.txt merge=union\n",
			"a.txt binary\n",
			"[attr]m merge=x\n* m\n",
		]) {
			const { dir, reviewed: head } = reviewed();
			git(dir, "switch", "-q", "main");
			commit(dir, { ".gitattributes": attributes });
			git(dir, "switch", "-q", "pr");
			commit(dir, { ".gitattributes": attributes });
			// Committed on both sides, so git reads them whichever tree it reads; the merge then takes the line merge.
			mergeMain(dir, true);
			writeFileSync(join(dir, "a.txt"), lines({ 5: "ours", 7: "theirs" }));
			conclude(dir);
			expect(await carries(dir, head)).toBe(false);
		}
	});
});

describe("GitHub's merge base", () => {
	const github = (dir: string) => {
		const routes = gitRoutes(dir);
		return new GitHubReader({
			readToken: "token",
			quota: "wait",
			now: () => 0,
			sleep: async () => {},
			warn: () => {},
			fetch: async (url, init) =>
				routes(new URL(String(url)), init) ?? Response.json({ message: "Not Found" }, { status: 404 }),
		});
	};
	const pr = { owner: "example", repo: "project", number: 1, base: "main" };

	test("is one GitHub names when it is the only one, and none when the parents have several", async () => {
		const dir = repository();
		const root = commit(dir, { "a.txt": "a\n" });
		git(dir, "switch", "-q", "-c", "left");
		const left = commit(dir, { "l.txt": "l\n" });
		git(dir, "switch", "-q", "-c", "right", root);
		const right = commit(dir, { "r.txt": "r\n" });
		const reader = history(github(dir), pr);
		expect(await reader.mergeBase(left, right)).toBe(root);
		// A criss-cross: each side merges the other's first commit.
		git(dir, "merge", "-q", "--no-edit", left);
		const crossed = git(dir, "rev-parse", "HEAD");
		git(dir, "switch", "-q", "left");
		git(dir, "merge", "-q", "--no-edit", right);
		const other = git(dir, "rev-parse", "HEAD");
		expect(git(dir, "merge-base", "--all", crossed, other).split("\n")).toHaveLength(2);
		expect(await reader.mergeBase(crossed, other)).toBeNull();
		expect(await reader.mergeBase(other, crossed)).toBeNull();
	});
});

describe("a quest file", () => {
	const quest = (plan: string, related: string[]) =>
		`# [S] Example\n\n## Goal\n\nDo it.\n\n## Plan\n\n${plan}\n\n## Related\n\n${related
			.map((name) => `- [${name}](/quest/${name}.md) - ${name}`)
			.join("\n")}\n`;
	const ATTRIBUTES = "* text=auto eol=lf\n\nquest/** merge=quest\n";

	/** A quest the PR and the base each edit, reviewed at the PR's edit. */
	function diverged(ours: string, theirs: string, attributes = ATTRIBUTES) {
		const dir = repository();
		commit(dir, { ".gitattributes": attributes, "quest/x.md": quest("First.\n\nSecond.", ["a", "b", "c"]) });
		git(dir, "switch", "-q", "-c", "pr");
		const head = commit(dir, { "quest/x.md": ours });
		git(dir, "switch", "-q", "main");
		commit(dir, { "quest/x.md": theirs });
		git(dir, "switch", "-q", "pr");
		return { dir, head };
	}

	test("carries across a clean merge of separate paragraphs", async () => {
		const { dir, head } = diverged(
			quest("First, ours.\n\nSecond.", ["a", "b", "c"]),
			quest("First.\n\nSecond, theirs.", ["a", "b", "c"]),
		);
		expect(mergeMain(dir)).toBe(true);
		expect(await carries(dir, head)).toBe(true);
	});

	test("carries across a merge whose only conflict is a link list the quest driver resolved", async () => {
		const ours = quest("First.\n\nSecond.", ["a", "b", "x", "c"]);
		const theirs = quest("First.\n\nSecond.", ["a", "c"]);
		const { dir, head } = diverged(ours, theirs);
		expect(mergeMain(dir)).toBe(true);
		expect(git(dir, "show", "HEAD:quest/x.md")).toBe(quest("First.\n\nSecond.", ["a", "x", "c"]).trimEnd());
		expect(await carries(dir, head)).toBe(true);
	});

	test("does not carry a merge no one way of merging explains: the driver's on one file, merge-ort's on another", async () => {
		// Merge-file's Myers merge settles the first and conflicts on the second; merge-ort's does the opposite.
		const [o1, b1, t1] = ["c\n\nc\n", "}\nc\nc\n", "c\nc\n}\n"];
		const [o2, b2, t2] = ["x\n}\n}\n\na\nb\n\n\n", "x\n}\n}\nb\n\nb\n\n", "}\n}\n}\nb\n\n\n"];
		const dir = repository();
		commit(dir, { ".gitattributes": ATTRIBUTES, "quest/a.md": b1, "quest/b.md": b2 });
		git(dir, "switch", "-q", "-c", "pr");
		const head = commit(dir, { "quest/a.md": o1, "quest/b.md": o2 });
		git(dir, "switch", "-q", "main");
		commit(dir, { "quest/a.md": t1, "quest/b.md": t2 });
		git(dir, "switch", "-q", "pr");
		expect(mergeMain(dir)).toBe(false);
		writeFileSync(join(dir, "quest/a.md"), render(merge(o1, b1, t1), 7, false));
		writeFileSync(join(dir, "quest/b.md"), render(merge(o2, b2, t2, "ort"), 7, false));
		conclude(dir);
		expect(await carries(dir, head)).toBe(false);
	});

	test("does not carry across a link-list conflict resolved otherwise, or without the quest driver", async () => {
		const ours = quest("First.\n\nSecond.", ["a", "b", "x", "c"]);
		const theirs = quest("First.\n\nSecond.", ["a", "c"]);
		for (const attributes of [ATTRIBUTES, "* text=auto eol=lf\n"]) {
			const { dir, head } = diverged(ours, theirs, attributes);
			git(dir, "config", "--unset", "merge.quest.driver");
			expect(mergeMain(dir)).toBe(false);
			writeFileSync(join(dir, "quest/x.md"), quest("First.\n\nSecond.", ["a", "c", "x"]));
			conclude(dir);
			expect(await carries(dir, head)).toBe(false);
		}
		// Resolved as the driver would, but on a path no attribute gives the driver.
		const { dir, head } = diverged(ours, theirs, "* text=auto eol=lf\n");
		expect(mergeMain(dir)).toBe(false);
		writeFileSync(join(dir, "quest/x.md"), quest("First.\n\nSecond.", ["a", "x", "c"]));
		conclude(dir);
		expect(await carries(dir, head)).toBe(false);
	});
});

/** A deterministic generator, so a failure reproduces from its seed. */
function random(seed: number): (n: number) => number {
	let state = seed >>> 0 || 1;
	return (n) => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) % n;
	};
}

const WORDS = ["", "a", "b", "c", "d", "}", "- [x](/quest/x.md)"];
const PATHS = ["a", "b", "c", "d/e", "d/f"];

/** Random file contents, null for an absent file. */
function file(next: (n: number) => number): string | null {
	if (next(6) === 0) return null;
	const words = Array.from({ length: next(8) }, () => WORDS[next(WORDS.length)]!);
	return words.join("\n") + (next(4) === 0 ? "" : "\n");
}

/** `base` with a few random edits: a file rewritten, edited by lines, added, deleted, or made executable. */
function edit(next: (n: number) => number, base: Record<string, string | null>): Record<string, string | null> {
	const out = { ...base };
	for (const path of PATHS) {
		const op = next(5);
		if (op === 0) out[path] = file(next);
		else if (op === 1 && out[path]) {
			const words = out[path]!.split("\n");
			words.splice(next(words.length), next(2), WORDS[next(WORDS.length)]!);
			out[path] = words.join("\n");
		}
	}
	return out;
}

/** Files, null for an absent one, and the paths among them that are executable. */
type Snapshot = { files: Record<string, string | null>; exec: Set<string> };

/** One `git fast-import` stream's commit of `snapshot` on the commits marked `parents`, marked `mark`. */
function fastImport(mark: number, { files, exec }: Snapshot, parents: number[]): string {
	const present = PATHS.filter((path) => files[path] != null);
	return [
		"commit refs/heads/main",
		`mark :${mark}`,
		"committer Quest test <test@example.invalid> 0 +0000",
		"data 6",
		"commit",
		...parents.map((parent, i) => `${i === 0 ? "from" : "merge"} :${parent}`),
		"deleteall",
		...present.flatMap((path) => [
			`M ${exec.has(path) ? "100755" : "100644"} inline ${path}`,
			`data ${Buffer.byteLength(files[path]!)}`,
			files[path]!,
		]),
		"",
	].join("\n");
}

/** Commits `root`, then `ours` and `theirs` on it, in one process, leaving `main` at `theirs`; their ids. */
function write(dir: string, root: Snapshot, ours: Snapshot, theirs: Snapshot): [string, string, string] {
	const marks = join(dir, ".git", "marks");
	// The reset makes the root a root, whatever `main` held before.
	const input = [
		"reset refs/heads/main\n",
		fastImport(1, root, []),
		fastImport(2, ours, [1]),
		fastImport(3, theirs, [1]),
	];
	execFileSync("git", ["-C", dir, "fast-import", "--quiet", "--force", `--export-marks=${marks}`], {
		input: input.join(""),
		stdio: ["pipe", "ignore", "inherit"],
	});
	const ids = new Map(
		readFileSync(marks, "utf8")
			.trim()
			.split("\n")
			.map((line) => line.split(" ") as [string, string]),
	);
	return [ids.get(":1")!, ids.get(":2")!, ids.get(":3")!];
}

test("judges a merge clean exactly when git merges its parents, without renames, into its tree", async () => {
	let clean = 0;
	let conflicted = 0;
	// One repository for every history: objects are content-addressed, and `main` moves to each history's base side.
	const dir = repository();
	const objects = gitHistory(dir);
	for (let seed = 1; seed <= 60; seed++) {
		const next = random(seed);
		const base = Object.fromEntries(PATHS.map((path) => [path, file(next)]));
		const execs = () => new Set(PATHS.filter(() => next(6) === 0));
		const side = (): Snapshot => ({ files: edit(next, base), exec: execs() });
		const [, ours, theirs] = write(dir, { files: base, exec: new Set() }, side(), side());
		const merged = spawnSync("git", ["-C", dir, "merge-tree", "--write-tree", "-X", "no-renames", ours, theirs], {
			encoding: "utf8",
		});
		expect(merged.status === 0 || merged.status === 1, merged.stderr).toBe(true);
		const tree = merged.stdout.split("\n")[0]!;
		if (merged.status === 0) clean++;
		else conflicted++;
		// Git's own merge, conflicted or not, and each parent's tree taken whole.
		const candidates = {
			merge: tree,
			ours: (await objects.commit(ours)).tree,
			theirs: (await objects.commit(theirs)).tree,
		};
		for (const [name, candidate] of Object.entries(candidates)) {
			const head = git(dir, "commit-tree", candidate, "-p", ours, "-p", theirs, "-m", "commit");
			const expected = merged.status === 0 && candidate === tree;
			expect(await new BaseMerges(gitHistory(dir), head).reaches(ours), `seed ${seed}, the ${name} tree`).toBe(
				expected,
			);
		}
	}
	// The histories cover both outcomes.
	expect(clean).toBeGreaterThan(5);
	expect(conflicted).toBeGreaterThan(5);
});
