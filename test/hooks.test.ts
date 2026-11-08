// `quest setup`'s user-level Claude Code settings, and `quest hook`, which handles its hooks.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import { REFERENCE_LINE } from "../src/core";
import {
	BASH_MAX_TIMEOUT_MS,
	CLAUDE_HOOKS,
	CODEX_HOOKS,
	CONTEXT_LIMIT,
	HOOK_COMMAND,
	type Target,
	WORKTREE_COMMAND,
	WORKTREE_HOOKS,
	hook,
	settingsPath,
	setup,
	targets,
} from "../src/cli/hooks";
import { CONTEXT } from "../src/cli/skills";
import { tempDir } from "./fixture";

const ours = { type: "command", command: HOOK_COMMAND };
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const claude = (path: string): Target => ({ name: "Claude Code", path, hooks: CLAUDE_HOOKS, claude: true });

test("settings live in CLAUDE_CONFIG_DIR when set, else ~/.claude", () => {
	expect(settingsPath({ CLAUDE_CONFIG_DIR: "/profiles/work" })).toBe(join("/profiles/work", "settings.json"));
	expect(settingsPath({})).toMatch(/[/\\]\.claude[/\\]settings\.json$/);
});

test("setup creates the settings file with the timeout and every hook, then changes nothing", () => {
	const path = join(tempDir(), "profile", "settings.json");
	expect(setup(claude(path))).toEqual([
		`${path}: installed Quest's hooks`,
		`${path}: env.BASH_MAX_TIMEOUT_MS=${BASH_MAX_TIMEOUT_MS}`,
	]);
	const settings = read(path);
	expect(settings.env).toEqual({ BASH_MAX_TIMEOUT_MS });
	for (const { event, matcher } of CLAUDE_HOOKS)
		expect(settings.hooks[event]).toEqual([{ ...(matcher ? { matcher } : {}), hooks: [ours] }]);
	const written = readFileSync(path, "utf8");
	expect(written.endsWith("}\n")).toBe(true);
	expect(setup(claude(path))).toEqual([]);
	expect(readFileSync(path, "utf8")).toBe(written);
});

test("setup replaces a different timeout, and removal leaves the user's own", () => {
	const path = join(tempDir(), "settings.json");
	writeFileSync(path, JSON.stringify({ env: { FOO: "1", BASH_MAX_TIMEOUT_MS: "600000" } }));
	expect(setup(claude(path))).toContain(`${path}: env.BASH_MAX_TIMEOUT_MS=${BASH_MAX_TIMEOUT_MS} (was "600000")`);
	expect(read(path).env).toEqual({ FOO: "1", BASH_MAX_TIMEOUT_MS });
	expect(setup(claude(path), { remove: true })).toEqual([
		`${path}: removed Quest's hooks`,
		`${path}: removed env.BASH_MAX_TIMEOUT_MS`,
	]);
	expect(read(path)).toEqual({ env: { FOO: "1" } });

	writeFileSync(path, JSON.stringify({ env: { BASH_MAX_TIMEOUT_MS: "600000" } }));
	expect(setup(claude(path), { remove: true })).toEqual([]);
	expect(read(path)).toEqual({ env: { BASH_MAX_TIMEOUT_MS: "600000" } });
});

test("setup keeps other settings and hooks in place", () => {
	const path = join(tempDir(), "settings.json");
	const theirs = { hooks: [{ type: "command", command: "dev-shell-hook claude", timeout: 600 }] };
	writeFileSync(path, JSON.stringify({ theme: "dark", hooks: { SessionStart: [theirs] }, env: { A: "1" } }));
	setup(claude(path));
	const settings = read(path);
	expect(Object.keys(settings)).toEqual(["theme", "hooks", "env"]);
	expect(settings.hooks.SessionStart[0]).toEqual(theirs);
	expect(settings.hooks.SessionStart).toHaveLength(2);
	expect(setup(claude(path), { remove: true })).toHaveLength(2);
	expect(read(path)).toEqual({ theme: "dark", hooks: { SessionStart: [theirs] }, env: { A: "1" } });
});

test("setup replaces an earlier version's entries, including one sharing a group", () => {
	const path = join(tempDir(), "settings.json");
	const theirs = { type: "command", command: "other" };
	writeFileSync(
		path,
		JSON.stringify({
			hooks: {
				SessionStart: [{ matcher: "startup", hooks: [ours] }],
				PreToolUse: [{ matcher: "Bash", hooks: [theirs, ours] }],
			},
		}),
	);
	expect(setup(claude(path))).toContain(`${path}: installed Quest's hooks`);
	const settings = read(path);
	expect(settings.hooks.PreToolUse).toEqual([
		{ matcher: "Bash", hooks: [theirs] },
		{ matcher: CLAUDE_HOOKS[2]!.matcher, hooks: [ours] },
	]);
	expect(settings.hooks.SessionStart).toEqual([{ matcher: CLAUDE_HOOKS[0]!.matcher, hooks: [ours] }]);
	expect(setup({ ...claude(path), hooks: [{ event: "Stop" }] })).toEqual([`${path}: installed Quest's hooks`]);
	expect(Object.keys(read(path).hooks)).toEqual(["PreToolUse", "Stop"]);
});

test("Codex's hooks file gets its hooks and their settings, but no timeout", () => {
	const path = join(tempDir(), "hooks.json");
	const codex: Target = { name: "Codex", path, hooks: CODEX_HOOKS, claude: false };
	expect(setup(codex)).toEqual([`${path}: installed Quest's hooks`]);
	const settings = read(path);
	expect(settings.env).toBeUndefined();
	expect(settings.hooks.SessionStart).toEqual([
		{ matcher: CODEX_HOOKS[0]!.matcher, hooks: [{ ...ours, additionalContextLimit: CONTEXT_LIMIT }] },
	]);
	expect(setup(codex)).toEqual([]);
	// A changed handler setting is an earlier version's entry, replaced.
	expect(setup({ ...codex, hooks: [{ event: "SessionStart", settings: { additionalContextLimit: 1 } }] })).toEqual([
		`${path}: installed Quest's hooks`,
	]);
	expect(setup(codex, { remove: true })).toEqual([`${path}: removed Quest's hooks`]);
	expect(read(path)).toEqual({});
});

test("setup configures Codex only where its home exists", () => {
	const home = tempDir();
	const env = { CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex") };
	expect(targets(env).map((target) => target.name)).toEqual(["Claude Code"]);
	mkdirSync(env.CODEX_HOME);
	expect(targets(env).map((target) => target.path)).toEqual([
		join(home, "claude", "settings.json"),
		join(home, "codex", "hooks.json"),
	]);
});

test("removing Quest's only settings drops the hooks and env keys", () => {
	const path = join(tempDir(), "settings.json");
	writeFileSync(path, JSON.stringify({ theme: "dark" }));
	setup(claude(path));
	setup(claude(path), { remove: true });
	expect(read(path)).toEqual({ theme: "dark" });
	expect(setup(claude(path), { remove: true })).toEqual([]);
});

test("setup installs the worktree hooks on request, keeps them on rerun, and replaces pasted ones", () => {
	const path = join(tempDir(), "settings.json");
	const pasted = { type: "command", command: `command -v quest >/dev/null || exit 1; ${WORKTREE_COMMAND}` };
	const worktree = { type: "command", command: WORKTREE_COMMAND };
	writeFileSync(
		path,
		JSON.stringify({
			hooks: { WorktreeCreate: [{ hooks: [pasted] }], SessionEnd: [{ hooks: [{ ...pasted, timeout: 60 }] }] },
		}),
	);
	setup(claude(path));
	const settings = read(path);
	expect(settings.hooks.WorktreeCreate).toEqual([{ hooks: [worktree] }]);
	expect(settings.hooks.SessionEnd).toEqual([{ hooks: [{ ...worktree, timeout: 60 }] }]);
	expect(settings.hooks.SessionStart).toEqual([
		{ matcher: CLAUDE_HOOKS[0]!.matcher, hooks: [ours] },
		{ hooks: [worktree] },
	]);
	expect(Object.keys(settings.hooks).sort()).toEqual(
		[...new Set([...CLAUDE_HOOKS, ...WORKTREE_HOOKS].map((h) => h.event))].sort(),
	);
	expect(setup(claude(path))).toEqual([]);
	expect(setup(claude(path), { worktrees: true })).toEqual([]);

	expect(setup(claude(path), { worktrees: false })).toEqual([`${path}: installed Quest's hooks`]);
	expect(Object.keys(read(path).hooks)).toEqual(CLAUDE_HOOKS.map((h) => h.event));
	expect(setup(claude(path))).toEqual([]);
	expect(setup(claude(path), { worktrees: true })).toEqual([`${path}: installed Quest's hooks`]);
	setup(claude(path), { remove: true });
	expect(read(path)).toEqual({});

	const codex = join(tempDir(), "hooks.json");
	setup({ name: "Codex", path: codex, hooks: CODEX_HOOKS, claude: false }, { worktrees: true });
	expect(Object.keys(read(codex).hooks)).toEqual(CODEX_HOOKS.map((h) => h.event));
});

test.each([
	["invalid JSON", "{ nope"],
	["a JSON array", "[]"],
	["env that is not an object", '{"env": "x"}'],
	["env that is not an object, with valid hooks", '{"env": [], "hooks": {}}'],
	["hooks that are not an object", '{"hooks": []}'],
	["hooks that are malformed, with a valid env", '{"env": {}, "hooks": {"SessionStart": [1]}}'],
	["an event that is not an array", '{"hooks": {"SessionStart": {}}}'],
	["a group without handlers", '{"hooks": {"SessionStart": [{"matcher": "startup"}]}}'],
])("setup refuses settings with %s and leaves them unchanged", (_, content) => {
	const path = join(tempDir(), "settings.json");
	writeFileSync(path, content);
	expect(() => setup(claude(path))).toThrow(path);
	expect(() => setup(claude(path), { remove: true })).toThrow(path);
	expect(readFileSync(path, "utf8")).toBe(content);
});

/** A checkout whose root instructions hold `instructions`, with a nested working directory. */
function checkout(instructions: string | null): string {
	const dir = tempDir();
	mkdirSync(join(dir, ".git"));
	mkdirSync(join(dir, "src", "deep"), { recursive: true });
	if (instructions !== null) writeFileSync(join(dir, "AGENTS.md"), instructions);
	return join(dir, "src", "deep");
}

test.each(["SessionStart", "SubagentStart"])("%s adds the rules in a repository that uses Quest", (event) => {
	const cwd = checkout(`# Agents\n\n${REFERENCE_LINE}\n`);
	expect(JSON.parse(hook({ hook_event_name: event, cwd, source: "compact" }))).toEqual({
		hookSpecificOutput: { hookEventName: event, additionalContext: CONTEXT },
	});
});

test("SessionStart adds nothing where the repository does not use Quest", () => {
	expect(hook({ hook_event_name: "SessionStart", cwd: checkout("# Agents\n\nRun the tests.\n") })).toBe("");
	expect(hook({ hook_event_name: "SessionStart", cwd: checkout(null) })).toBe("");
	expect(hook({ hook_event_name: "SessionStart", cwd: tempDir() })).toBe("");
});

test("PreToolUse denies a call that breaks a checked rule, only where the repository uses Quest", () => {
	const cwd = checkout(`${REFERENCE_LINE}\n`);
	const call = { hook_event_name: "PreToolUse", cwd, tool_name: "Bash", tool_input: { command: "git push" } };
	const output = JSON.parse(hook(call));
	expect(output.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
	expect(output.hookSpecificOutput.permissionDecisionReason).toContain("refspec");
	expect(hook({ ...call, tool_input: { command: "git push origin refs/heads/a:refs/heads/a" } })).toBe("");
	expect(hook({ ...call, cwd: checkout(null) })).toBe("");
	expect(() => hook({ hook_event_name: "PreToolUse", cwd })).toThrow("tool_name");
});

test("hook refuses malformed input and events it does not handle", () => {
	expect(() => hook({ cwd: "/" })).toThrow("hook_event_name");
	expect(() => hook({ hook_event_name: "Stop", cwd: "/" })).toThrow("quest setup");
});
