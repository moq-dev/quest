// `quest init` and `quest uninstall` in temporary repositories.

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { expect, test } from "vitest";

import { REFERENCE_LINE, init, uninstall } from "../src/cli/setup";
import { SKILLS } from "../src/cli/skills";
import { tempDir } from "./fixture";

const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");
const isFile = (dir: string, path: string) => existsSync(join(dir, path)) && lstatSync(join(dir, path)).isFile();
const isSymlink = (dir: string, path: string) => {
	try {
		return lstatSync(join(dir, path)).isSymbolicLink();
	} catch {
		return false;
	}
};

test("init creates the layout and is idempotent", () => {
	const dir = tempDir();
	expect(init(dir)).not.toEqual([]);
	expect(isFile(dir, ".claude/skills/quest-start/SKILL.md")).toBe(true);
	expect(existsSync(join(dir, ".agents/skills/quest-start/SKILL.md"))).toBe(true);
	expect(isFile(dir, "quest/README.md")).toBe(true);
	expect(existsSync(join(dir, ".gitignore"))).toBe(false);
	expect(read(dir, "AGENTS.md")).toContain(REFERENCE_LINE);
	expect(init(dir)).toEqual([]);
});

test("init refuses a skill that is not a stub", () => {
	const dir = tempDir();
	mkdirSync(join(dir, ".claude/skills/quest-start"), { recursive: true });
	writeFileSync(join(dir, ".claude/skills/quest-start/SKILL.md"), "# My workflow\n");
	expect(() => init(dir)).toThrow("not a Quest stub");
});

test("a refused init writes nothing", () => {
	const dir = tempDir();
	writeFileSync(join(dir, "CLAUDE.md"), "# Claude\n");
	mkdirSync(join(dir, ".claude/skills/quest-start"), { recursive: true });
	writeFileSync(join(dir, ".claude/skills/quest-start/SKILL.md"), "# My workflow\n");
	const before = snapshot(dir);
	expect(() => init(dir)).toThrow(".claude/skills/quest-start/SKILL.md is not a Quest stub");
	expect(snapshot(dir)).toEqual(before);
});

/** Capture paths, types, file bytes, and link targets without following symlinks. */
function snapshot(dir: string): unknown[] {
	return readdirSync(dir)
		.sort()
		.map((name) => {
			const path = join(dir, name);
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) return [name, "symlink", readlinkSync(path)];
			if (stat.isDirectory()) return [name, "directory", snapshot(path)];
			return [name, "file", readFileSync(path)];
		});
}

for (const [path, type] of [
	["quest", "file"],
	["quest", "symlink"],
	["quest/README.md", "directory"],
	["quest/README.md", "symlink"],
	[".agents", "file"],
	[".agents", "symlink"],
	[".claude", "file"],
	[".claude/skills/quest-start", "file"],
	[".claude/skills/quest-start", "symlink"],
	[".claude/skills/quest-start/SKILL.md", "directory"],
	[".claude/skills/quest-start/SKILL.md", "symlink"],
	["AGENTS.md", "directory"],
	["AGENTS.md", "symlink"],
])
	test.skipIf(type === "symlink" && process.platform === "win32")(
		`init refuses ${path} as a ${type} before writing anything`,
		() => {
			const dir = tempDir();
			const conflict = join(dir, path);
			mkdirSync(dirname(conflict), { recursive: true });
			if (type === "directory") mkdirSync(conflict);
			else if (type === "symlink") symlinkSync("missing.md", conflict);
			else writeFileSync(conflict, "Keep these bytes.\n");
			const before = snapshot(dir);
			expect(() => init(dir)).toThrow(`${path} is not a`);
			expect(snapshot(dir)).toEqual(before);
		},
	);

for (const type of ["directory", "symlink"])
	test.skipIf(type === "symlink" && process.platform === "win32")(
		`init uses CLAUDE.md when AGENTS.md is a ${type}`,
		() => {
			const dir = tempDir();
			writeFileSync(join(dir, "CLAUDE.md"), "# Claude\n");
			if (type === "directory") mkdirSync(join(dir, "AGENTS.md"));
			else symlinkSync("missing.md", join(dir, "AGENTS.md"));
			init(dir);
			expect(read(dir, "CLAUDE.md")).toContain(REFERENCE_LINE);
			expect(existsSync(join(dir, "missing.md"))).toBe(false);
			expect(lstatSync(join(dir, "AGENTS.md")).isDirectory()).toBe(type === "directory");
		},
	);

test("init appends to AGENTS.md, not CLAUDE.md, when both exist", () => {
	const dir = tempDir();
	writeFileSync(join(dir, "AGENTS.md"), "# Repo\n\nKeep this.\n");
	writeFileSync(join(dir, "CLAUDE.md"), "# Claude only\n");
	init(dir);
	expect(read(dir, "AGENTS.md")).toContain("Keep this.");
	expect(read(dir, "AGENTS.md")).toContain(REFERENCE_LINE);
	expect(read(dir, "CLAUDE.md")).not.toContain(REFERENCE_LINE);
});

test("init uses CLAUDE.md when only it exists", () => {
	const dir = tempDir();
	writeFileSync(join(dir, "CLAUDE.md"), "# Claude\n");
	init(dir);
	expect(read(dir, "CLAUDE.md")).toContain(REFERENCE_LINE);
	expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
});

test("an uninstall round trip preserves user content", () => {
	const dir = tempDir();
	writeFileSync(join(dir, "AGENTS.md"), "# Repo\n\nUser rule.\n");
	mkdirSync(join(dir, "quest/m0"), { recursive: true });
	writeFileSync(join(dir, "quest/m0/plan.md"), "# [S] Keep\n\n## Goal\n\nStay.\n");
	init(dir);
	uninstall(dir);
	expect(read(dir, "AGENTS.md")).toBe("# Repo\n\nUser rule.\n");
	expect(isFile(dir, "quest/m0/plan.md")).toBe(true);
	expect(existsSync(join(dir, ".claude"))).toBe(false);
	expect(existsSync(join(dir, ".agents"))).toBe(false);
});

test("a round trip with the Codex skills directory", () => {
	const dir = tempDir();
	mkdirSync(join(dir, ".agents/skills"), { recursive: true });
	init(dir);
	expect(isFile(dir, ".agents/skills/quest-start/SKILL.md")).toBe(true);
	expect(existsSync(join(dir, ".claude/skills/quest-start/SKILL.md"))).toBe(true);
	expect(lstatSync(join(dir, ".claude/skills")).isDirectory()).toBe(true);

	uninstall(dir);
	expect(existsSync(join(dir, ".agents/skills"))).toBe(false);
	expect(isSymlink(dir, ".claude/skills")).toBe(false);
});

test("init uses independent skill directories without creating symlinks", () => {
	const dir = tempDir();
	for (const skills of [".claude/skills", ".agents/skills"]) {
		mkdirSync(join(dir, skills, "custom"), { recursive: true });
		writeFileSync(join(dir, skills, "custom/SKILL.md"), `# ${skills} custom skill\n`);
	}
	init(dir);
	for (const skills of [".claude/skills", ".agents/skills"]) {
		expect(lstatSync(join(dir, skills)).isDirectory()).toBe(true);
		expect(isFile(dir, `${skills}/quest-start/SKILL.md`)).toBe(true);
	}
	expect(init(dir)).toEqual([]);
	uninstall(dir);
	for (const skills of [".claude/skills", ".agents/skills"]) {
		expect(read(dir, `${skills}/custom/SKILL.md`)).toBe(`# ${skills} custom skill\n`);
		expect(existsSync(join(dir, skills, "quest-start"))).toBe(false);
	}
});

test("conflicts in the second destination prevent writes to the first", () => {
	const dir = tempDir();
	mkdirSync(join(dir, ".agents/skills/quest-start"), { recursive: true });
	writeFileSync(join(dir, ".agents/skills/quest-start/SKILL.md"), "# User workflow\n");
	const before = snapshot(dir);
	expect(() => init(dir)).toThrow(".agents/skills/quest-start/SKILL.md is not a Quest stub");
	expect(snapshot(dir)).toEqual(before);
});

test("setup and removal preserve CRLF instructions and recognize CRLF stubs", () => {
	const dir = tempDir();
	const original = "# Repository rules\r\n\r\nKeep this rule.\r\n";
	writeFileSync(join(dir, "AGENTS.md"), original);
	init(dir);
	expect(read(dir, "AGENTS.md")).toBe(`${original}\r\n${REFERENCE_LINE}\r\n`);
	for (const skills of [".claude/skills", ".agents/skills"]) {
		for (const skill of readdirSync(join(dir, skills))) {
			const path = `${skills}/${skill}/SKILL.md`;
			writeFileSync(join(dir, path), read(dir, path).replaceAll("\n", "\r\n"));
		}
	}
	expect(init(dir)).toEqual([]);
	uninstall(dir);
	expect(read(dir, "AGENTS.md")).toBe(original);
	expect(existsSync(join(dir, ".agents"))).toBe(false);
	expect(existsSync(join(dir, ".claude"))).toBe(false);
});

test.skipIf(process.platform === "win32")("existing linked skills install once and uninstall cleanly", () => {
	const dir = tempDir();
	mkdirSync(join(dir, ".claude/skills"), { recursive: true });
	mkdirSync(join(dir, ".agents"));
	symlinkSync("../.claude/skills", join(dir, ".agents/skills"));
	const changed = init(dir);
	expect(changed.filter((path) => path.endsWith("SKILL.md"))).toHaveLength(SKILLS.length);
	expect(init(dir)).toEqual([]);
	uninstall(dir);
	expect(existsSync(join(dir, ".claude"))).toBe(false);
	expect(existsSync(join(dir, ".agents"))).toBe(false);
});

test.skipIf(process.platform === "win32")("uninstall preserves an unrelated dangling skills link", () => {
	const dir = tempDir();
	mkdirSync(join(dir, ".agents"));
	symlinkSync("../user-owned", join(dir, ".agents/skills"));
	uninstall(dir);
	expect(readlinkSync(join(dir, ".agents/skills"))).toBe("../user-owned");
});

test("uninstall is idempotent", () => {
	const dir = tempDir();
	init(dir);
	uninstall(dir);
	expect(uninstall(dir)).toEqual([]);
});

test("init keeps a reworded reference line", () => {
	const dir = tempDir();
	const custom = "Quests: run `quest guide` first; skills live upstream.";
	writeFileSync(join(dir, "AGENTS.md"), `# Repo\n\n${custom}\n`);
	init(dir);
	expect(read(dir, "AGENTS.md")).toBe(`# Repo\n\n${custom}\n`);

	uninstall(dir);
	expect(read(dir, "AGENTS.md")).toBe("# Repo\n");
});

/** The stub an earlier release installed for `/quest-ready`, before `/quest-review` replaced it. */
const READY_STUB =
	"---\nname: quest-ready\ndescription: Mark a draft PR ready for review, wait for an automated review, then decide whether to merge.\n---\n\nRun `quest skill ready` and follow its output.\nIf `quest` is not installed, follow https://github.com/kixelated/quest/blob/main/SETUP.md first.\n";

/** A current skill's stub as an earlier release wrote it, with another description and setup link. */
const OLD_AUDIT_STUB =
	"---\nname: quest-audit\ndescription: Audit outstanding quests for disagreements, then resolve them with /quest-plan.\n---\n\nRun `quest skill audit` and follow its output.\nIf `quest` is not installed, follow https://github.com/kixelated/quest/blob/main/SETUP.md first.\n";

function write(dir: string, path: string, content: string) {
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), content);
}

test("init removes stubs of retired skills and keeps older stubs of current ones", () => {
	const dir = tempDir();
	init(dir);
	for (const skills of [".claude/skills", ".agents/skills"]) {
		write(
			dir,
			`${skills}/quest-ready/SKILL.md`,
			READY_STUB.replaceAll("\n", skills === ".agents/skills" ? "\r\n" : "\n"),
		);
		write(dir, `${skills}/quest-audit/SKILL.md`, OLD_AUDIT_STUB);
	}
	expect(init(dir)).toEqual([".claude/skills/quest-ready/SKILL.md", ".agents/skills/quest-ready/SKILL.md"]);
	for (const skills of [".claude/skills", ".agents/skills"]) {
		expect(existsSync(join(dir, skills, "quest-ready"))).toBe(false);
		expect(read(dir, `${skills}/quest-audit/SKILL.md`)).toBe(OLD_AUDIT_STUB);
	}
	expect(init(dir)).toEqual([]);
});

test("init keeps a retired stub's directory when it holds other files", () => {
	const dir = tempDir();
	write(dir, ".claude/skills/quest-ready/SKILL.md", READY_STUB);
	write(dir, ".claude/skills/quest-ready/notes.md", "Mine.\n");
	expect(init(dir)).toContain(".claude/skills/quest-ready/SKILL.md");
	expect(readdirSync(join(dir, ".claude/skills/quest-ready"))).toEqual(["notes.md"]);
});

for (const [name, content] of [
	[
		"a user's own quest- skill",
		"---\nname: quest-ready\ndescription: My release checklist.\n---\n\nCheck the changelog.\n",
	],
	["a stub under another directory name", READY_STUB.replace("quest-ready", "quest-mine")],
	["a stub naming another skill", READY_STUB.replace("`quest skill ready`", "`quest skill mine`")],
	["a stub with added instructions", `${READY_STUB}Then tell the team.\n`],
] as const)
	test(`init and uninstall keep ${name}`, () => {
		const dir = tempDir();
		write(dir, ".claude/skills/quest-ready/SKILL.md", content);
		init(dir);
		uninstall(dir);
		expect(read(dir, ".claude/skills/quest-ready/SKILL.md")).toBe(content);
	});

test("init leaves a user's skill without the quest- prefix", () => {
	const dir = tempDir();
	const ready = READY_STUB.replace("name: quest-ready", "name: ready");
	write(dir, ".claude/skills/ready/SKILL.md", ready);
	init(dir);
	expect(read(dir, ".claude/skills/ready/SKILL.md")).toBe(ready);
});

test.skipIf(process.platform === "win32")("init and uninstall leave linked retired stubs", () => {
	const dir = tempDir();
	write(dir, "elsewhere/quest-ready/SKILL.md", READY_STUB);
	write(dir, "stub.md", READY_STUB);
	mkdirSync(join(dir, ".claude/skills/quest-other"), { recursive: true });
	symlinkSync("../../elsewhere/quest-ready", join(dir, ".claude/skills/quest-ready"));
	symlinkSync("../../../stub.md", join(dir, ".claude/skills/quest-other/SKILL.md"));
	init(dir);
	uninstall(dir);
	expect(read(dir, "elsewhere/quest-ready/SKILL.md")).toBe(READY_STUB);
	expect(isSymlink(dir, ".claude/skills/quest-ready")).toBe(true);
	expect(isSymlink(dir, ".claude/skills/quest-other/SKILL.md")).toBe(true);
});

test("uninstall removes stubs that older versions installed", () => {
	const dir = tempDir();
	for (const skills of [".claude/skills", ".agents/skills"]) {
		write(dir, `${skills}/quest-ready/SKILL.md`, READY_STUB);
		write(dir, `${skills}/quest-audit/SKILL.md`, OLD_AUDIT_STUB);
	}
	expect(uninstall(dir)).toEqual([
		".claude/skills/quest-audit/SKILL.md",
		".claude/skills/quest-ready/SKILL.md",
		".agents/skills/quest-audit/SKILL.md",
		".agents/skills/quest-ready/SKILL.md",
	]);
	expect(existsSync(join(dir, ".claude"))).toBe(false);
	expect(existsSync(join(dir, ".agents"))).toBe(false);
});
