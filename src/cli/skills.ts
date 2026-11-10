// The agent skills, the quest guide, and the shared engineering context, bundled into the CLI.
//
// A repository installs only a stub per skill. Claude Code's stub inlines
// `quest skill <name>` when the skill is invoked; the stub other agents read
// asks them to run it. Either way the binary a repository pins decides which
// instructions its agents follow. `quest skill` prints the skill with the guide
// sections and the other skills it builds on, so one invocation holds them all.
// Upgrading rewrites only the stubs themselves, when they changed and nobody
// edited them.

import { PREFIX, type SkillDir } from "../core";
import guide from "../../assets/AGENTS.md";
import context from "../../assets/CONTEXT.md";
import afk from "../../assets/skills/afk.md";
import audit from "../../assets/skills/audit.md";
import del from "../../assets/skills/delete.md";
import exportSkill from "../../assets/skills/export.md";
import grill from "../../assets/skills/grill.md";
import importSkill from "../../assets/skills/import.md";
import iterate from "../../assets/skills/iterate.md";
import merge from "../../assets/skills/merge.md";
import plan from "../../assets/skills/plan.md";
import recurring from "../../assets/skills/recurring.md";
import review from "../../assets/skills/review.md";
import run from "../../assets/skills/run.md";
import start from "../../assets/skills/start.md";
import unblock from "../../assets/skills/unblock.md";

/** The quest contract: the format, workflow, and rules every skill builds on. */
export const GUIDE: string = guide;

/** The engineering rules every task follows, shared across repositories so each keeps only its own. */
export const CONTEXT: string = context;

/** Where an agent without the CLI learns to install it. */
const SETUP = "https://github.com/moq-dev/quest/blob/main/SETUP.md";

/** The guide's `##` sections by heading, each with its heading; headings inside code fences belong to their section. */
const SECTIONS: ReadonlyMap<string, string> = (() => {
	const found = new Map<string, string[]>();
	let current: string[] | undefined;
	let fenced = false;
	for (const line of GUIDE.split("\n")) {
		if (line.startsWith("```")) fenced = !fenced;
		if (!fenced && line.startsWith("## ")) {
			current = [];
			found.set(line.slice(3).trim(), current);
		}
		current?.push(line);
	}
	return new Map([...found].map(([heading, lines]) => [heading, lines.join("\n").trim()]));
})();

/** The guide's section headings, in order. */
export const GUIDE_SECTIONS: readonly string[] = [...SECTIONS.keys()];

/** The guide sections named `names`, matched case-insensitively and printed in the guide's order. */
export function guideSections(names: readonly string[]): string {
	const wanted = new Set(names.map((name) => sectionHeading(name)));
	return GUIDE_SECTIONS.filter((heading) => wanted.has(heading))
		.map((heading) => SECTIONS.get(heading)!)
		.join("\n\n");
}

/** The guide heading `name` names, ignoring case; throws for one the guide lacks. */
export function sectionHeading(name: string): string {
	const heading = GUIDE_SECTIONS.find((h) => h.toLowerCase() === name.trim().toLowerCase());
	if (heading === undefined) throw new Error(`no guide section named ${name} (have: ${GUIDE_SECTIONS.join(", ")})`);
	return heading;
}

/** One skill: YAML frontmatter, then the instructions. */
export class Skill {
	/** The one-line summary agents match a request against. */
	readonly description: string;
	/** The guide sections it builds on, by heading. */
	readonly guide: readonly string[];
	/** The other skills it builds on, by name, in the order they follow it. */
	readonly skills: readonly string[];
	/**
	 * Skills and guide sections, by name or heading, that it drops from what
	 * those skills build on when it is the skill composed, such as an
	 * interview for a skill that asks nothing.
	 */
	readonly omit: readonly string[];
	/** Its own instructions, without what it builds on. */
	readonly body: string;

	constructor(
		/** The name `quest skill <name>` takes. */
		readonly name: string,
		text: string,
	) {
		const match = /^---\n([\s\S]*?)\n---\n\n*([\s\S]*)$/.exec(text);
		if (!match) throw new Error(`skill ${name} does not open with frontmatter`);
		const fields = new Map<string, string>();
		for (const line of match[1].split("\n")) {
			const field = /^(description|guide|skills|omit): (.+)$/.exec(line);
			if (!field || fields.has(field[1]))
				throw new Error(`skill ${name} has an unknown frontmatter line: ${line}`);
			fields.set(field[1], field[2]);
		}
		const list = (key: string) =>
			fields
				.get(key)
				?.split(",")
				.map((item) => item.trim()) ?? [];
		this.description = fields.get("description") ?? "";
		this.guide = list("guide");
		this.skills = list("skills");
		this.omit = list("omit");
		this.body = match[2];
	}

	/** The name an agent invokes it by, which is also its installed directory. */
	get installed(): string {
		return `${PREFIX}${this.name}`;
	}

	/**
	 * The `SKILL.md` each skill directory installs. Claude Code runs the
	 * stub's command when the skill is invoked and reads its output in place,
	 * so the skill arrives whole and survives compaction as an invoked skill.
	 * It runs the command through Bash, or PowerShell where Bash is missing,
	 * so the stub pre-approves it in both. A failed command would abort the
	 * skill, and PowerShell refuses to pre-approve a command chained with
	 * `||`, so the stub always echoes the setup pointer after it instead,
	 * which also keeps a missing `quest`'s error. Other agents, and a skill
	 * both directories read through a link, get a pointer to run the command
	 * themselves.
	 */
	get stubs(): Readonly<Record<SkillDir, string>> {
		const pointer = `Run \`quest skill ${this.name}\` and follow its output.\nIf \`quest\` is not installed, follow ${SETUP} first.\n`;
		const inline = `!\`quest skill ${this.name}; echo "If quest skill ${this.name} printed an error instead of instructions, install quest as ${SETUP} describes, then run quest skill ${this.name} and follow its output."\`\n`;
		const head = `---\nname: ${this.installed}\ndescription: ${this.description}\n`;
		const allowed = `allowed-tools: Bash(quest skill ${this.name}) PowerShell(quest skill ${this.name})\n`;
		return {
			".claude/skills": `${head}${allowed}---\n\n${inline}`,
			".agents/skills": `${head}---\n\n${pointer}`,
		};
	}

	/** What `quest skill <name>` prints: this skill composed with what it builds on. */
	get instructions(): string {
		return compose([this]);
	}
}

/**
 * Claude Code passes a command's output inline only up to about this many
 * characters; past it, an inlined skill arrives as a file path and a
 * 2,000-character preview, so every composed skill stays within it.
 */
export const INLINE_LIMIT = 30_000;

/**
 * The first skill's own instructions, first since compaction keeps only the
 * start of a long skill, then each other skill and every skill they build on,
 * depth first and once, then the guide sections any of them use, leaving out
 * whatever the given skills omit.
 */
export function compose(skills: readonly Skill[]): string {
	const omitted = skills.flatMap((s) => s.omit);
	const order: Skill[] = [];
	const visit = (s: Skill) => {
		if (order.includes(s) || omitted.includes(s.name)) return;
		order.push(s);
		for (const name of s.skills) visit(skill(name)!);
	};
	for (const s of skills) visit(s);
	const parts = [order[0]!.body.trim()];
	for (const s of order.slice(1)) parts.push(`# /${s.installed}\n\n${s.body.trim()}`);
	const dropped = new Set(omitted.filter((name) => !skill(name)).map(sectionHeading));
	const sections = [...new Set(order.flatMap((s) => s.guide).map(sectionHeading))].filter((h) => !dropped.has(h));
	if (sections.length > 0) parts.push(`# Quest guide\n\n${guideSections(sections)}`);
	return `${parts.join("\n\n")}\n`;
}

/** Every skill, sorted by name. */
export const SKILLS: readonly Skill[] = Object.entries({
	afk,
	audit,
	delete: del,
	export: exportSkill,
	grill,
	import: importSkill,
	iterate,
	merge,
	plan,
	recurring,
	review,
	run,
	start,
	unblock,
}).map(([name, text]) => new Skill(name, text));

/** The skill called `name`, if this version ships one. */
export function skill(name: string): Skill | undefined {
	return SKILLS.find((s) => s.name === name);
}

// A misnamed section or skill would silently drop or keep part of a skill, so it fails every command.
for (const s of SKILLS) {
	for (const name of s.guide) sectionHeading(name);
	for (const name of s.skills) if (!skill(name)) throw new Error(`skill ${s.name} builds on missing skill ${name}`);
	for (const name of s.omit) if (!skill(name)) sectionHeading(name);
}
