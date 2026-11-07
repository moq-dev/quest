// `quest setup`'s user-level Claude Code settings, and `quest hook`, which handles its hooks.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import { REFERENCE_LINE } from "../src/core";
import { BASH_MAX_TIMEOUT_MS, HOOKS, HOOK_COMMAND, hook, settingsPath, setup } from "../src/cli/hooks";
import { CONTEXT } from "../src/cli/skills";
import { tempDir } from "./fixture";

const ours = { type: "command", command: HOOK_COMMAND };
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("settings live in CLAUDE_CONFIG_DIR when set, else ~/.claude", () => {
	expect(settingsPath({ CLAUDE_CONFIG_DIR: "/profiles/work" })).toBe(join("/profiles/work", "settings.json"));
	expect(settingsPath({})).toMatch(/[/\\]\.claude[/\\]settings\.json$/);
});

test("setup creates the settings file with the timeout and every hook, then changes nothing", () => {
	const path = join(tempDir(), "profile", "settings.json");
	expect(setup(path)).toEqual([
		`${path}: installed Quest's hooks`,
		`${path}: env.BASH_MAX_TIMEOUT_MS=${BASH_MAX_TIMEOUT_MS}`,
	]);
	const settings = read(path);
	expect(settings.env).toEqual({ BASH_MAX_TIMEOUT_MS });
	for (const { event, matcher } of HOOKS)
		expect(settings.hooks[event]).toEqual([{ ...(matcher ? { matcher } : {}), hooks: [ours] }]);
	const written = readFileSync(path, "utf8");
	expect(written.endsWith("}\n")).toBe(true);
	expect(setup(path)).toEqual([]);
	expect(readFileSync(path, "utf8")).toBe(written);
});

test("setup replaces a different timeout, and removal leaves the user's own", () => {
	const path = join(tempDir(), "settings.json");
	writeFileSync(path, JSON.stringify({ env: { FOO: "1", BASH_MAX_TIMEOUT_MS: "600000" } }));
	expect(setup(path)).toContain(`${path}: env.BASH_MAX_TIMEOUT_MS=${BASH_MAX_TIMEOUT_MS} (was "600000")`);
	expect(read(path).env).toEqual({ FOO: "1", BASH_MAX_TIMEOUT_MS });
	expect(setup(path, { remove: true })).toEqual([
		`${path}: removed Quest's hooks`,
		`${path}: removed env.BASH_MAX_TIMEOUT_MS`,
	]);
	expect(read(path)).toEqual({ env: { FOO: "1" } });

	writeFileSync(path, JSON.stringify({ env: { BASH_MAX_TIMEOUT_MS: "600000" } }));
	expect(setup(path, { remove: true })).toEqual([]);
	expect(read(path)).toEqual({ env: { BASH_MAX_TIMEOUT_MS: "600000" } });
});

test("setup keeps other settings and hooks in place", () => {
	const path = join(tempDir(), "settings.json");
	const theirs = { hooks: [{ type: "command", command: "dev-shell-hook claude", timeout: 600 }] };
	writeFileSync(path, JSON.stringify({ theme: "dark", hooks: { SessionStart: [theirs] }, env: { A: "1" } }));
	setup(path);
	const settings = read(path);
	expect(Object.keys(settings)).toEqual(["theme", "hooks", "env"]);
	expect(settings.hooks.SessionStart[0]).toEqual(theirs);
	expect(settings.hooks.SessionStart).toHaveLength(2);
	expect(setup(path, { remove: true })).toHaveLength(2);
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
	expect(setup(path)).toContain(`${path}: installed Quest's hooks`);
	const settings = read(path);
	expect(settings.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [theirs] }]);
	expect(settings.hooks.SessionStart).toEqual([{ matcher: HOOKS[0]!.matcher, hooks: [ours] }]);
	expect(setup(path, { entries: [{ event: "Stop" }] })).toEqual([`${path}: installed Quest's hooks`]);
	expect(Object.keys(read(path).hooks)).toEqual(["PreToolUse", "Stop"]);
});

test("removing Quest's only settings drops the hooks and env keys", () => {
	const path = join(tempDir(), "settings.json");
	writeFileSync(path, JSON.stringify({ theme: "dark" }));
	setup(path);
	setup(path, { remove: true });
	expect(read(path)).toEqual({ theme: "dark" });
	expect(setup(path, { remove: true })).toEqual([]);
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
	expect(() => setup(path)).toThrow(path);
	expect(() => setup(path, { remove: true })).toThrow(path);
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

test("hook refuses malformed input and events it does not handle", () => {
	expect(() => hook({ cwd: "/" })).toThrow("hook_event_name");
	expect(() => hook({ hook_event_name: "Stop", cwd: "/" })).toThrow("quest setup");
});
