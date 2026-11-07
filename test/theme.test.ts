// Themed output on a terminal. Piped output is the plain contract, pinned in
// cli.test.ts; these cover only what a terminal sees.

import { describe, expect, test } from "vitest";

import { detect } from "../src/cli/theme";
import { M0_README, ROOT_README, Tree, tempDir, runOn } from "./fixture";

const COLOUR = { colour: true };
const NO_COLOUR = { colour: false };

/** `text` in SGR colour `sgr`, as the theme writes it. */
const sgr = (code: string, text: string) => `\x1b[${code}m${text}\x1b[0m`;

/** One quest of every size under one epic, none blocked. */
function sizes(): Tree {
	return new Tree()
		.write("quest/README.md", ROOT_README)
		.write("quest/m0/README.md", M0_README)
		.write("quest/m0/epic/README.md", "# Epic\n\n## Goal\n\nAn epic.\n")
		.write("quest/m0/epic/xs.md", "# [XS] Tiny\n\n## Goal\n\nA quest.\n")
		.write("quest/m0/epic/s.md", "# [S] Small\n\n## Goal\n\nA quest.\n")
		.write("quest/m0/epic/m.md", "# [M] Medium\n\n## Goal\n\nA quest.\n")
		.write("quest/m0/epic/l.md", "# [L] Large\n\n## Goal\n\nA quest.\n")
		.write("quest/m0/epic/xl.md", "# [XL] Huge\n\n## Goal\n\nA quest.\n");
}

describe("detect", () => {
	test("a pipe is not a terminal", () => {
		expect(detect(undefined, {})).toBeUndefined();
		expect(detect(false, {})).toBeUndefined();
	});

	test("a terminal is coloured unless NO_COLOR is set and non-empty", () => {
		expect(detect(true, {})).toEqual({ colour: true });
		expect(detect(true, { NO_COLOR: "" })).toEqual({ colour: true });
		expect(detect(true, { NO_COLOR: "1" })).toEqual({ colour: false });
	});
});

describe("unblocked <path>", () => {
	test.each([
		["xs", "90", "[XS]"],
		["s", "32", "[S]"],
		["m", "34", "[M]"],
		["l", "35", "[L]"],
		["xl", "33", "[XL]"],
	])("size %s takes its colour", (name, code, label) => {
		expect(sizes().runOn(COLOUR, "unblocked", `quest/m0/epic/${name}.md`).stdout).toMatch(
			new RegExp(`^${sgr("33", "!").replace(/\[/g, "\\[")} ${sgr(code, label).replace(/\[/g, "\\[")} `),
		);
	});

	test("a title cannot send escape sequences to the terminal", () => {
		const tree = Tree.baseline().write(
			"quest/m0/epic/one.md",
			"# [S] One \x1b]0;pwned\x07 \x1b[2J\n\n## Goal\n\nA quest.\n",
		);
		expect(tree.runOn(NO_COLOUR, "unblocked", "quest/m0/epic/one.md").stdout).toBe(
			"! [S] One �]0;pwned� �[2J  quest/m0/epic/one.md\n  Ready\n",
		);
	});

	test("a ready quest", () => {
		expect(Tree.baseline().runOn(COLOUR, "unblocked", "quest/m0/epic/one.md")).toEqual({
			code: 0,
			stdout: `${sgr("33", "!")} ${sgr("32", "[S]")} One  quest/m0/epic/one.md\n  Ready\n`,
			stderr: "",
		});
	});

	test("a blocked quest shows a grey marker and what it requires", () => {
		const out = Tree.baseline().runOn(COLOUR, "unblocked", "/quest/m0/epic/two.md");
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			`${sgr("90", "!")} ${sgr("32", "[S]")} Two    quest/m0/epic/two.md\n` +
				"  Required:\n" +
				`    ${sgr("32", "[S]")} One  quest/m0/epic/one.md\n`,
		);
		// The log names the blockers, so stderr keeps only the advice.
		expect(out.stderr).not.toContain("blocked by");
		expect(out.stderr).toContain("quest: /quest/m0/epic/two.md is blocked;");
	});

	test("a required epic expands into the quests it still holds", () => {
		const out = Tree.baseline().runOn(NO_COLOUR, "unblocked", "quest/m0/README.md");
		expect(out.stdout).toBe(
			"! M0           quest/m0/README.md\n" +
				"  Required:\n" +
				"    Epic       quest/m0/epic/README.md\n" +
				"      [S] One  quest/m0/epic/one.md\n" +
				"      [S] Two  quest/m0/epic/two.md\n",
		);
	});

	test("a legacy Claim section has no terminal status", () => {
		const tree = Tree.baseline().append(
			"quest/m0/epic/one.md",
			"\n## Claim\n\n- Jane Doe (github:jdoe) on jdoe/quest since 2026-10-02\n",
		);
		expect(tree.runOn(NO_COLOUR, "unblocked", "quest/m0/epic/one.md").stdout).toBe(
			"! [S] One  quest/m0/epic/one.md\n  Ready\n",
		);
	});

	test("an entry that is not a quest prints as written", () => {
		const tree = Tree.baseline().append("quest/m0/epic/one.md", "\n## Required\n\n- the design review\n");
		expect(tree.runOn(NO_COLOUR, "unblocked", "quest/m0/epic/one.md").stdout).toBe(
			"! [S] One  quest/m0/epic/one.md\n  Required:\n    the design review\n",
		);
	});
});

test("check speaks in the quest-log voice", () => {
	expect(Tree.baseline().runOn(COLOUR, "check")).toEqual({
		code: 0,
		stdout: "The quest log is in order: 5 documents checked.\n",
		stderr: "",
	});
});

test("init and uninstall say what changed", () => {
	const root = tempDir();
	const init = runOn(NO_COLOUR, "--root", root, "init").stdout.split("\n");
	expect(init[0]).toBe("Quest is set up for you and your agents. Changed:");
	expect(init).toContain("  quest/README.md");
	expect(init).toContain("  AGENTS.md");
	expect(init.at(-2)).toBe("Next: plan a quest with /quest-plan in Claude Code or $quest-plan in Codex.");
	expect(runOn(NO_COLOUR, "--root", root, "init").stdout).toBe("Quest is already set up; nothing changed.\n");

	const uninstall = runOn(NO_COLOUR, "--root", root, "uninstall").stdout.split("\n");
	expect(uninstall[0]).toBe("Quest has packed up. Changed:");
	expect(uninstall).toContain("  AGENTS.md");
	expect(uninstall.at(-2)).toBe("Your quest log under quest/ stays.");
	expect(runOn(NO_COLOUR, "--root", root, "uninstall").stdout).toBe("Nothing of Quest's left to remove.\n");
});
