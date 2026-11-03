// Shared native lifecycle: no shell, symlink privileges, remote writes, or agent login.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";

const input = resolve(process.argv[2]);
const expectedVersion =
	process.argv[3] ?? JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const work = mkdtempSync(join(tmpdir(), "quest lifecycle "));
const write = (root, path, text) => {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), text);
};
const read = (root, path) => readFileSync(join(root, path), "utf8");
const assertFile = (root, path, expected) => assert.equal(read(root, path), expected, `user content changed: ${path}`);
const skills = ["audit", "complete", "delete", "export", "import", "iterate", "merge", "plan", "spawn", "start"];
const destinations = [".claude/skills", ".agents/skills"];
try {
	// Run the caller's binary in place, so the cleanup below never deletes an executable it just ran:
	// on windows-11-arm, the hosted runner's agent briefly opens running executables without delete
	// sharing, and removing one then fails with EBUSY. Callers test a binary path with spaces.
	const javascript = extname(input) === ".js";
	const command = javascript ? process.execPath : input;
	const prefix = javascript ? [input] : [];
	const run = (root, ...args) =>
		execFileSync(command, [...prefix, "--root", root, ...args], {
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, NO_COLOR: "1" },
		});
	assert.equal(run(work, "--version").trim(), `quest ${expectedVersion}`);
	for (const layout of ["claude", "agents", "both"]) {
		const repository = join(work, `${layout} repository`);
		mkdirSync(repository);
		execFileSync("git", ["init", "--quiet", repository]);
		execFileSync("git", ["-C", repository, "config", "core.autocrlf", "false"]);
		const instructionFile = layout === "agents" ? "CLAUDE.md" : "AGENTS.md";
		const instructions = "# Repository rules\r\n\r\nKeep this rule.\r\n";
		write(repository, instructionFile, instructions);
		if (instructionFile !== "CLAUDE.md") write(repository, "CLAUDE.md", "# Separate Claude rules\r\n");
		const originalDirs = layout === "both" ? destinations : [`.${layout}/skills`];
		for (const dir of originalDirs) write(repository, `${dir}/custom/SKILL.md`, `# Custom ${dir} workflow\n`);
		// Work in an actual Git worktree with spaces, preserving tracked user content.
		execFileSync("git", ["-C", repository, "add", "."]);
		execFileSync("git", [
			"-C",
			repository,
			"-c",
			"user.name=Quest lifecycle",
			"-c",
			"user.email=lifecycle@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--quiet",
			"-m",
			"Lifecycle fixture",
		]);
		const root = join(work, `${layout} worktree`);
		execFileSync("git", ["-C", repository, "worktree", "add", "--quiet", "--detach", root]);
		run(root, "init");
		assert.equal(run(root, "init"), "");
		// The merge driver probes for `resolve` with `quest help resolve`, which fails for an unknown command.
		assertFile(root, ".gitattributes", "quest/** merge=quest\n");
		assert.match(
			execFileSync("git", ["-C", root, "config", "merge.quest.driver"], { encoding: "utf8" }),
			/resolve/,
		);
		run(root, "help", "resolve");
		assert.equal(spawnSync(command, [...prefix, "help", "unknown"]).status, 2);
		for (const dir of destinations) {
			assert(lstatSync(join(root, dir)).isDirectory(), `${dir} must not require symlink privileges`);
			for (const skill of skills)
				assertFile(root, `${dir}/quest-${skill}/SKILL.md`, run(root, "skill", skill, "--stub"));
		}
		write(
			root,
			"quest/README.md",
			"# Lifecycle\r\n\r\n## Goal\r\n\r\nKeep plans.\r\n\r\n## Required\r\n\r\n- [First](/quest/m0/README.md)\r\n",
		);
		write(
			root,
			"quest/m0/README.md",
			"# First\r\n\r\n## Goal\r\n\r\nA milestone.\r\n\r\n## Required\r\n\r\n- [One](/quest/m0/one.md)\r\n- [Two](/quest/m0/two.md)\r\n",
		);
		write(root, "quest/m0/one.md", "# [S] One\r\n\r\n## Goal\r\n\r\nFirst.\r\n");
		write(
			root,
			"quest/m0/two.md",
			"# [S] Two\r\n\r\n## Goal\r\n\r\nSecond.\r\n\r\n## Required\r\n\r\n- [One](/quest/m0/one.md)\r\n",
		);
		run(root, "check");
		assert.equal(run(root, "unblocked"), "1\tquest/m0/one.md\n");
		assert.equal(run(root, "unblocked", join(root, "quest", "m0", "one.md")), "");
		assert.equal(run(root, "unblocked", join("quest", "m0", "one.md")), "");
		assert.match(run(root, "unblocked", "quest/m0/two.md"), /quest\/m0\/one.md/);
		const plan = read(root, "quest/m0/one.md");
		const edited = `${read(root, ".claude/skills/quest-plan/SKILL.md")}\nUser customization.\n`;
		write(root, ".claude/skills/quest-plan/SKILL.md", edited);
		write(root, ".agents/skills/quest-start/notes.md", "User notes.\n");
		run(root, "uninstall");
		assertFile(root, instructionFile, instructions);
		if (instructionFile !== "CLAUDE.md") assertFile(root, "CLAUDE.md", "# Separate Claude rules\r\n");
		assertFile(root, "quest/m0/one.md", plan);
		assertFile(root, ".claude/skills/quest-plan/SKILL.md", edited);
		assertFile(root, ".agents/skills/quest-start/notes.md", "User notes.\n");
		assert(!existsSync(join(root, ".agents/skills/quest-start/SKILL.md")));
		assert(!existsSync(join(root, ".gitattributes")));
		assert.equal(spawnSync("git", ["-C", root, "config", "merge.quest.driver"]).status, 1);
		for (const dir of originalDirs) assertFile(root, `${dir}/custom/SKILL.md`, `# Custom ${dir} workflow\n`);
		run(root, "check");
		assert.equal(run(root, "uninstall"), "");
	}
	for (const dir of destinations) {
		const root = join(work, `${dir.startsWith(".claude") ? "claude" : "agents"} conflict`);
		write(root, "AGENTS.md", "# User instructions\r\n");
		write(root, `${dir}/quest-start/SKILL.md`, "# My own workflow\n");
		const refused = spawnSync(command, [...prefix, "--root", root, "init"], { encoding: "utf8" });
		assert.equal(refused.status, 1, refused.stderr);
		assert.match(refused.stderr, /is not a Quest stub/);
		assert(!existsSync(join(root, "quest")));
		assert.deepEqual(readdirSync(join(root, dir)), ["quest-start"]);
		assertFile(root, "AGENTS.md", "# User instructions\r\n");
		run(root, "uninstall");
		assertFile(root, `${dir}/quest-start/SKILL.md`, "# My own workflow\n");
	}
	console.log(
		"quest lifecycle: native commands, paths with spaces, Git worktrees, CRLF, ownership, and conflict refusal passed",
	);
} finally {
	rmSync(work, { recursive: true, force: true });
}
