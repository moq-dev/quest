// The agent skills and the quest guide, bundled into the CLI.
//
// A repository installs only a stub per skill, which asks the agent to run
// `quest skill <name>`. The stub only points at the binary, so the version a
// repository pins decides which instructions its agents follow, and upgrading
// never rewrites repository files.

import guide from "../../assets/AGENTS.md";
import afk from "../../assets/skills/afk.md";
import audit from "../../assets/skills/audit.md";
import complete from "../../assets/skills/complete.md";
import del from "../../assets/skills/delete.md";
import exportSkill from "../../assets/skills/export.md";
import grill from "../../assets/skills/grill.md";
import importSkill from "../../assets/skills/import.md";
import iterate from "../../assets/skills/iterate.md";
import merge from "../../assets/skills/merge.md";
import plan from "../../assets/skills/plan.md";
import recurring from "../../assets/skills/recurring.md";
import review from "../../assets/skills/review.md";
import spawn from "../../assets/skills/spawn.md";
import start from "../../assets/skills/start.md";

/** The quest contract: the format, workflow, and rules every skill builds on. */
export const GUIDE: string = guide;

/** Where an agent without the CLI learns to install it. */
const SETUP = "https://github.com/moq-dev/quest/blob/main/SETUP.md";

/** Installed skills carry this prefix so they don't collide with a repository's own. */
export const PREFIX = "quest-";

/** One skill: YAML frontmatter, then the instructions. */
export class Skill {
	/** The frontmatter, fences excluded. */
	readonly frontmatter: string;
	/** The instructions `quest skill <name>` prints. */
	readonly body: string;

	constructor(
		/** The name `quest skill <name>` takes. */
		readonly name: string,
		text: string,
	) {
		const match = /^---\n([\s\S]*?)\n---\n\n*([\s\S]*)$/.exec(text);
		if (!match) throw new Error(`skill ${name} does not open with frontmatter`);
		this.frontmatter = match[1];
		this.body = match[2];
	}

	/** The one-line summary agents match a request against. */
	get description(): string {
		const line = this.frontmatter.split("\n").find((l) => l.startsWith("description: "));
		return line?.slice("description: ".length) ?? "";
	}

	/** The name an agent invokes it by, which is also its installed directory. */
	get installed(): string {
		return `${PREFIX}${this.name}`;
	}

	/** The `SKILL.md` a repository installs: the frontmatter, and a pointer back to this CLI for everything else. */
	get stub(): string {
		return `---\nname: ${this.installed}\n${this.frontmatter}\n---\n\nRun \`quest skill ${this.name}\` and follow its output.\nIf \`quest\` is not installed, follow ${SETUP} first.\n`;
	}
}

/** Every skill, sorted by name. */
export const SKILLS: readonly Skill[] = Object.entries({
	afk,
	audit,
	complete,
	delete: del,
	export: exportSkill,
	grill,
	import: importSkill,
	iterate,
	merge,
	plan,
	recurring,
	review,
	spawn,
	start,
}).map(([name, text]) => new Skill(name, text));

/** The skill called `name`, if this version ships one. */
export function skill(name: string): Skill | undefined {
	return SKILLS.find((s) => s.name === name);
}
