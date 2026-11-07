// The bundled skills and the stubs this repository installs.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import { SKILL_DIRS } from "../src/core";
import { CONTEXT_LIMIT } from "../src/cli/hooks";
import { CONTEXT, GUIDE_SECTIONS, INLINE_LIMIT, SKILLS, guideSections, skill } from "../src/cli/skills";

test.each(SKILLS.map((skill) => [skill.name, skill] as const))("%s frontmatter is complete", (_, skill) => {
	expect(skill.description).not.toBe("");
	// The stub copies the description as a plain YAML scalar, where ": " is invalid.
	expect(skill.description).not.toContain(": ");
	expect(skill.body.trim()).not.toBe("");
});

test("skills are sorted and unique", () => {
	const names = SKILLS.map((skill) => skill.name);
	expect(names).toEqual([...new Set(names)].sort());
});

/**
 * The contract is no longer a file an adopter has, and what a skill builds on
 * arrives with it, so a skill pointing at either sends the agent looking again.
 */
test.each(SKILLS.map((skill) => [skill.name, skill] as const))("%s loads nothing itself", (_, skill) => {
	expect(skill.body).not.toContain("AGENTS.md");
	expect(skill.body).not.toMatch(/`quest (guide|skill)\b/);
	expect(skill.body).not.toMatch(/`quest context`'s/);
});

/**
 * This repository installs the same stubs as everyone else, so a skill added or
 * renamed here without its stub fails rather than going unused.
 */
test.each(SKILL_DIRS)("the repository's %s stubs are current", (path) => {
	const dir = join(import.meta.dirname, "..", path);
	expect(readdirSync(dir).sort()).toEqual(SKILLS.map((skill) => skill.installed));
	for (const skill of SKILLS) {
		expect(
			readFileSync(join(dir, skill.installed, "SKILL.md"), "utf8"),
			`${skill.name} stub is stale; regenerate it with \`quest init\``,
		).toBe(skill.stubs[path]);
	}
});

test("Claude Code's stub inlines the skill and pre-approves only its own call, in either shell", () => {
	const start = skill("start")!;
	expect(start.stubs[".claude/skills"]).toMatch(
		/^---\nname: quest-start\ndescription: Start work on a quest\.\nallowed-tools: Bash\(quest skill start\) PowerShell\(quest skill start\)\n---\n\n!`quest skill start; echo "[^"`$]*SETUP\.md[^"`$]*"`\n$/,
	);
	expect(start.stubs[".agents/skills"]).toContain("Run `quest skill start` and follow its output.");
});

test("a skill prints its own instructions first, then what it builds on, each once", () => {
	const plan = skill("plan")!;
	const text = skill("audit")!.instructions;
	expect(text.startsWith(skill("audit")!.body.trim())).toBe(true);
	// audit builds on plan, which builds on grill: each appears once, in that order.
	const planAt = text.indexOf(`# /quest-plan\n\n${plan.body.trim()}`);
	const grillAt = text.indexOf(`# /quest-grill\n\n${skill("grill")!.body.trim()}`);
	expect(planAt).toBeGreaterThan(0);
	expect(grillAt).toBeGreaterThan(planAt);
	expect(text.split("# /quest-grill").length).toBe(2);
	// The guide follows with every section any of them names, once and in the guide's order.
	const sections = [...new Set([...skill("audit")!.guide, ...plan.guide, ...skill("grill")!.guide])];
	expect(text.endsWith(`# Quest guide\n\n${guideSections(sections)}\n`)).toBe(true);
	expect(text.split("\n## Questions\n").length).toBe(2);
});

test("a skill drops the skills and guide sections it omits from what it builds on", () => {
	const afk = skill("afk")!;
	expect(afk.omit).toEqual(["grill", "Creation", "Questions"]);
	const text = afk.instructions;
	expect(text).toContain(`# /quest-complete\n\n${skill("complete")!.body.trim()}`);
	expect(text).toContain(`# /quest-merge\n\n${skill("merge")!.body.trim()}`);
	expect(text).not.toContain("# /quest-grill");
	expect(text).not.toContain("\n## Creation\n");
	expect(text).not.toContain("\n## Questions\n");
	expect(text).toContain("\n## Execution\n");
	// The omission applies only when afk is the skill composed.
	expect(skill("complete")!.instructions).toContain("# /quest-grill");
});

/** Claude Code inlines the stub's whole output: the composed skill, then the setup line it echoes. */
test.each(SKILLS.map((skill) => [skill.name, skill] as const))("%s fits inline in Claude Code", (_, skill) => {
	const echoed = /; echo "([^"]*)"`/.exec(skill.stubs[".claude/skills"])![1]!;
	expect(skill.instructions.length + echoed.length + 1).toBeLessThanOrEqual(INLINE_LIMIT);
});

test("a skill that builds on nothing prints only its own instructions and guide sections", () => {
	const del = skill("delete")!;
	expect(del.skills).toEqual([]);
	expect(del.instructions).toBe(`${del.body.trim()}\n\n# Quest guide\n\n${guideSections(del.guide)}\n`);
});

test("the guide splits at its own headings, not the format example's", () => {
	expect(GUIDE_SECTIONS).toContain("Format");
	expect(GUIDE_SECTIONS).not.toContain("Goal");
	expect(guideSections(["format"])).toContain("## Goal\n\nThe observable outcome");
	expect(() => guideSections(["Nope"])).toThrow("no guide section named Nope");
});

/** The hook adds the rules to every session, and Claude Code shows only a preview of longer context. */
test("the rules every task loads fit in one hook's context", () => {
	expect(CONTEXT.length).toBeLessThanOrEqual(CONTEXT_LIMIT);
});
