// `quest resolve`, the merge driver, and its registration by `quest init`.

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { chunks, render, resolveLists } from "../src/core";
import { type ResolveOptions, resolveFile } from "../src/cli/resolve";
import { heal, init, uninstall } from "../src/cli/setup";
import { tempDir } from "./fixture";

/** Merge three versions with the driver; the merged text and how many conflicts remain. */
function merge(
	base: string,
	ours: string,
	theirs: string,
	options: ResolveOptions = {},
): { text: string; conflicts: number } {
	const dir = tempDir();
	const [o, b, t] = ["ours", "base", "theirs"].map((name) => join(dir, name));
	writeFileSync(o, ours);
	writeFileSync(b, base);
	writeFileSync(t, theirs);
	const conflicts = resolveFile(o, b, t, options);
	return { text: readFileSync(o, "utf8"), conflicts };
}

const quest = (required: string[], plan = "Plan.") =>
	`# [S] Quest\n\n## Goal\n\nGoal.\n\n## Plan\n\n${plan}\n\n## Required\n\n${required.join("\n")}\n`;
const item = (name: string, note = name) => `- [${name}](/quest/m1/${name}.md) - ${note}`;

describe("resolve", () => {
	test("keeps an insert beside entries the other side deleted", () => {
		const base = quest(["a", "b", "c", "d"].map((n) => item(n)));
		// main finished b and c while the branch inserted x next to them.
		const ours = quest(["a", "d"].map((n) => item(n)));
		const theirs = quest(["a", "b", "x", "c", "d"].map((n) => item(n)));
		expect(merge(base, ours, theirs)).toEqual({ text: quest(["a", "x", "d"].map((n) => item(n))), conflicts: 0 });
	});

	test("orders inserts at the same place ours first", () => {
		const base = quest(["a", "b"].map((n) => item(n)));
		const ours = quest(["a", "x", "y", "b"].map((n) => item(n)));
		const theirs = quest(["a", "z", "b"].map((n) => item(n)));
		expect(merge(base, ours, theirs)).toEqual({
			text: quest(["a", "x", "y", "z", "b"].map((n) => item(n))),
			conflicts: 0,
		});
	});

	test("inserts the same entry once and keeps a one-sided edit", () => {
		const base = quest(["a", "b", "c"].map((n) => item(n)));
		const ours = quest([item("a", "edited"), item("x"), item("c")]);
		const theirs = quest([item("a"), item("x"), item("b")]);
		expect(merge(base, ours, theirs)).toEqual({ text: quest([item("a", "edited"), item("x")]), conflicts: 0 });
	});

	test("merges wrapped entries whole", () => {
		const wrapped = (name: string) => `${item(name)}\n  that wraps onto a second line`;
		const base = quest([wrapped("a"), wrapped("b"), item("c")]);
		const ours = quest([wrapped("a"), item("c")]);
		const theirs = quest([wrapped("a"), wrapped("b"), wrapped("x"), item("c")]);
		expect(merge(base, ours, theirs)).toEqual({
			text: quest([wrapped("a"), wrapped("x"), item("c")]),
			conflicts: 0,
		});
	});

	test("resolves CRLF lists", () => {
		const crlf = (text: string) => text.replaceAll("\n", "\r\n");
		const base = crlf(quest(["a", "b", "c"].map((n) => item(n))));
		const ours = crlf(quest(["a", "c"].map((n) => item(n))));
		const theirs = crlf(quest(["a", "b", "x", "c"].map((n) => item(n))));
		expect(merge(base, ours, theirs)).toEqual({
			text: crlf(quest(["a", "x", "c"].map((n) => item(n)))),
			conflicts: 0,
		});
	});

	for (const [name, ours, theirs] of [
		["an entry both sides changed", [item("a", "ours"), item("b")], [item("a", "theirs"), item("c")]],
		["an entry one side changed and the other removed", [item("a", "edited"), item("b")], [item("c")]],
		["an entry without a link", ["- plain text", item("b")], [item("a"), item("c")]],
	] as const) {
		test(`keeps markers for ${name}`, () => {
			const base = quest([item("a"), item("b")]);
			const { text, conflicts } = merge(base, quest([...ours]), quest([...theirs]));
			expect(conflicts).toBe(1);
			expect(text).toContain("<<<<<<< ours\n");
			expect(text).toContain(">>>>>>> theirs\n");
		});
	}

	test("keeps markers for an entry whose reference definition one side changed", () => {
		// The definition merges cleanly, so the conflict alone cannot tell that theirs re-targeted a.
		const doc = (required: string[], target: string) =>
			`${quest(required)}\n## Related\n\n${item("r")}\n\n[a]: ${target}\n`;
		const base = doc(["- [a][a] - a", item("b")], "/quest/m1/a.md");
		const ours = doc([item("b")], "/quest/m1/a.md");
		const theirs = doc(["- [a][a] - a", item("x"), item("b")], "/quest/m1/replacement.md");
		const { text, conflicts } = merge(base, ours, theirs);
		expect(conflicts).toBe(1);
		expect(text).toContain("[a]: /quest/m1/replacement.md\n");
	});

	test("keeps a conflict whose sides reorder the entries they share", () => {
		const lines = (names: string[]) => names.map((n) => item(n));
		const conflict = { ours: lines(["b", "a"]), base: lines(["a", "b"]), theirs: lines(["a", "b", "c"]) };
		const merged = [["# [S] Quest", "", "## Goal", "", "Goal.", "", "## Required", ""], conflict, [""]];
		expect(resolveLists("quest/q.md", merged)).toEqual(merged);
		// Git's line merge keeps a move it can apply, leaving only the inserts to conflict.
		expect(merge(quest(lines(["a", "b"])), quest(lines(["b", "a"])), quest(lines(["a", "b", "c"])))).toEqual({
			text: quest(lines(["b", "a", "c"])),
			conflicts: 0,
		});
	});

	test("diff3 output round trips through chunks and render", () => {
		const text = "a\n<<<<<<< ours\nb\n||||||| base\nc\n=======\nd\n>>>>>>> theirs\ne\n";
		expect(render(chunks(text, 7), 7, true)).toBe(text);
		expect(render(chunks(text, 7), 7, false)).toBe("a\n<<<<<<< ours\nb\n=======\nd\n>>>>>>> theirs\ne\n");
	});

	test("preserves requested labels and marker length while resolving list conflicts", () => {
		const base = quest(
			["a", "b", "c"].map((n) => item(n)),
			"Base plan.",
		);
		const ours = quest(
			["a", "c"].map((n) => item(n)),
			"Our plan.",
		);
		const theirs = quest(
			["a", "b", "x", "c"].map((n) => item(n)),
			"Their plan.",
		);
		const result = merge(base, ours, theirs, {
			markerSize: 11,
			oursLabel: "HEAD",
			baseLabel: "ancestor",
			theirsLabel: "topic's-head",
		});
		expect(result.conflicts).toBe(1);
		expect(result.text).toContain("<<<<<<<<<<< HEAD\n");
		expect(result.text).toContain(">>>>>>>>>>> topic's-head\n");
		expect(result.text).toContain(["a", "x", "c"].map((n) => item(n)).join("\n"));
	});

	test("rejects multiline labels before a conflict could be mistaken for clean text", () => {
		expect(() => merge("base\n", "ours\n", "theirs\n", { oursLabel: "one\ntwo" })).toThrow("single lines");
	});

	test("resolves the list and keeps markers for prose", () => {
		const base = quest(["a", "b", "c"].map((n) => item(n)));
		const ours = quest(
			["a", "c"].map((n) => item(n)),
			"Our plan.",
		);
		const theirs = quest(
			["a", "b", "x", "c"].map((n) => item(n)),
			"Their plan.",
		);
		const { text, conflicts } = merge(base, ours, theirs);
		expect(conflicts).toBe(1);
		expect(text).toContain("<<<<<<< ours\nOur plan.\n=======\nTheir plan.\n>>>>>>> theirs\n");
		expect(text).toContain(["a", "x", "c"].map((n) => item(n)).join("\n"));
	});

	test("keeps markers for a conflict that spans a heading", () => {
		const base = `# [S] Quest\n\n## Goal\n\nGoal.\n\n## Required\n\n${item("a")}\n`;
		const ours = `# [S] Quest\n\n## Goal\n\nGoal.\n`;
		const theirs = `# [S] Quest\n\n## Goal\n\nGoal.\n\n## Required\n\n${item("a")}\n${item("x")}\n`;
		expect(merge(base, ours, theirs).conflicts).toBe(1);
	});

	test("lists outside link sections are prose", () => {
		const doc = (lines: string[]) => `# [S] Quest\n\n## Goal\n\nGoal.\n\n## Plan\n\n${lines.join("\n")}\n`;
		const base = doc([item("a"), item("b")]);
		expect(merge(base, doc([item("b")]), doc([item("a"), item("x"), item("b")])).conflicts).toBe(1);
	});

	test("content that looks like markers stays content", () => {
		const base = quest(
			["a", "b"].map((n) => item(n)),
			"Title\n=======",
		);
		const ours = quest([item("b")], "Title\n=======");
		const theirs = quest(
			["a", "x", "b"].map((n) => item(n)),
			"Title\n=======",
		);
		expect(merge(base, ours, theirs)).toEqual({
			text: quest(
				["x", "b"].map((n) => item(n)),
				"Title\n=======",
			),
			conflicts: 0,
		});
	});
});

const bin = fileURLToPath(new URL("../src/cli/bin.ts", import.meta.url));
const bunfig = fileURLToPath(new URL("../bunfig.toml", import.meta.url));

function git(dir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A repository whose quest file has diverged on `main` and `branch`. */
function diverged(prose = false): string {
	const dir = tempDir();
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.name", "Quest test");
	git(dir, "config", "user.email", "test@example.invalid");
	const write = (text: string) => {
		mkdirSync(join(dir, "quest"), { recursive: true });
		writeFileSync(join(dir, "quest/README.md"), text);
		git(dir, "add", "-A");
		git(dir, "commit", "-q", "-m", "edit");
	};
	write(
		quest(
			["a", "b", "c"].map((n) => item(n)),
			prose ? "Base plan." : "Plan.",
		),
	);
	git(dir, "switch", "-q", "-c", "branch");
	write(
		quest(
			(prose ? ["a", "b", "c"] : ["a", "b", "x", "c"]).map((n) => item(n)),
			prose ? "Our plan." : "Plan.",
		),
	);
	git(dir, "switch", "-q", "main");
	write(
		quest(
			(prose ? ["a", "b", "c"] : ["a", "c"]).map((n) => item(n)),
			prose ? "Their plan." : "Plan.",
		),
	);
	git(dir, "switch", "-q", "branch");
	return dir;
}

/** Merge `main` into the branch with `path` as PATH. */
function mergeMain(dir: string, path: string, branch = "main") {
	return spawnSync("git", ["-C", dir, "merge", "-q", "--no-edit", branch], {
		encoding: "utf8",
		env: { ...process.env, PATH: path },
	});
}

describe.skipIf(process.platform === "win32")("the merge driver", () => {
	test("init registers it, and a local merge resolves link lists", () => {
		const dir = diverged();
		init(dir);
		expect(readFileSync(join(dir, ".gitattributes"), "utf8")).toBe("quest/** merge=quest\n");
		expect(git(dir, "config", "--get", "merge.quest.driver")).toContain("quest resolve %A %O %B");
		git(dir, "add", "-A");
		git(dir, "commit", "-q", "-m", "init");

		const tools = tempDir();
		writeFileSync(join(tools, "quest"), `#!/bin/sh\nexec bun --config='${bunfig}' '${bin}' "$@"\n`);
		chmodSync(join(tools, "quest"), 0o755);
		const merged = mergeMain(dir, `${tools}:${process.env.PATH}`);
		expect(merged.status, merged.stderr).toBe(0);
		expect(readFileSync(join(dir, "quest/README.md"), "utf8")).toBe(quest(["a", "x", "c"].map((n) => item(n))));
	});

	test("falls back to git's conflict markers without quest on PATH", () => {
		const dir = diverged();
		init(dir);
		git(dir, "add", "-A");
		git(dir, "commit", "-q", "-m", "init");
		const tools = tempDir();
		for (const tool of ["git", "sh"]) {
			const found = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
			writeFileSync(join(tools, tool), `#!/bin/sh\nexec '${found}' "$@"\n`);
			chmodSync(join(tools, tool), 0o755);
		}
		const merged = mergeMain(dir, tools);
		expect(merged.status).toBe(1);
		expect(readFileSync(join(dir, "quest/README.md"), "utf8")).toContain("<<<<<<< HEAD\n");
		expect(merged.stderr).toContain(
			"quest: no quest resolve on PATH, so link lists in quest/README.md were not auto-resolved\n",
		);
	});

	for (const mode of ["quest", "missing", "older"] as const) {
		test(`matches native diff3 labels and custom marker size with ${mode} quest`, () => {
			const dir = diverged(true);
			init(dir);
			writeFileSync(join(dir, ".gitattributes"), "quest/** merge=quest conflict-marker-size=13\n");
			git(dir, "config", "merge.conflictStyle", "diff3");
			git(dir, "add", "-A");
			git(dir, "commit", "-q", "-m", "init");
			git(dir, "branch", "-m", "main", "their'branch");
			// Capture git's built-in output for exactly these commits, then replay with our driver.
			const attributes = join(dir, ".git/info/attributes");
			writeFileSync(attributes, "quest/** merge=text\n");
			expect(mergeMain(dir, process.env.PATH!, "their'branch").status).toBe(1);
			const expected = readFileSync(join(dir, "quest/README.md"), "utf8");
			git(dir, "merge", "--abort");
			writeFileSync(attributes, "");
			const tools = tempDir();
			for (const tool of ["git", "sh"]) {
				const found = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
				writeFileSync(join(tools, tool), `#!/bin/sh\nexec '${found}' "$@"\n`);
				chmodSync(join(tools, tool), 0o755);
			}
			if (mode !== "missing") {
				writeFileSync(
					join(tools, "quest"),
					mode === "older"
						? '#!/bin/sh\nif [ "$1" = help ]; then exit 0; fi\nexit 2\n'
						: `#!/bin/sh\nexec '${process.execPath}' --config='${bunfig}' '${bin}' "$@"\n`,
				);
				chmodSync(join(tools, "quest"), 0o755);
			}
			const result = mergeMain(dir, mode === "quest" ? `${tools}:${process.env.PATH}` : tools, "their'branch");
			expect(result.status, result.stderr).toBe(1);
			expect(readFileSync(join(dir, "quest/README.md"), "utf8")).toBe(expected);
			const reason = { quest: null, missing: "no quest resolve on PATH", older: "quest resolve failed" }[mode];
			const warning = "so link lists in quest/README.md were not auto-resolved";
			if (reason === null) expect(result.stderr).not.toContain(warning);
			else expect(result.stderr).toContain(`quest: ${reason}, ${warning}\n`);
		});
	}

	test("any command registers a driver .gitattributes names, and uninstall removes it", () => {
		const dir = diverged();
		writeFileSync(join(dir, ".gitattributes"), "* text=auto\nquest/** merge=quest\n");
		heal(dir);
		expect(git(dir, "config", "--get", "merge.quest.driver")).toContain("quest resolve");
		git(dir, "config", "merge.quest.driver", "custom");
		heal(dir);
		expect(git(dir, "config", "--get", "merge.quest.driver")).toBe("custom");

		uninstall(dir);
		expect(readFileSync(join(dir, ".gitattributes"), "utf8")).toBe("* text=auto\n");
		expect(spawnSync("git", ["-C", dir, "config", "--get", "merge.quest.driver"]).status).toBe(1);
	});

	test("nothing registers without attributes or outside a work tree", () => {
		const dir = diverged();
		heal(dir);
		expect(spawnSync("git", ["-C", dir, "config", "--get", "merge.quest.driver"]).status).toBe(1);

		const plain = tempDir();
		writeFileSync(join(plain, ".gitattributes"), "quest/** merge=quest\n");
		heal(plain);
		init(plain);
		expect(readFileSync(join(plain, ".gitattributes"), "utf8")).toBe("quest/** merge=quest\n");
	});
});
