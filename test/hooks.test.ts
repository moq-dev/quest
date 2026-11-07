// `quest setup`'s user-level Claude Code hooks, and `quest hook`, which handles them.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import { REFERENCE_LINE } from "../src/core";
import { HOOKS, HOOK_COMMAND, hook, settingsPath, setup } from "../src/cli/hooks";
import { CONTEXT } from "../src/cli/skills";
import { tempDir } from "./fixture";

const ours = { type: "command", command: HOOK_COMMAND };
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("settings live in CLAUDE_CONFIG_DIR when set, else ~/.claude", () => {
	expect(settingsPath({ CLAUDE_CONFIG_DIR: "/profiles/work" })).toBe(join("/profiles/work", "settings.json"));
	expect(settingsPath({})).toMatch(/[/\\]\.claude[/\\]settings\.json$/);
});

test("setup creates the settings file with every hook, then changes nothing", () => {
	const path = join(tempDir(), "profile", "settings.json");
	expect(setup(path)).toBe(true);
	const settings = read(path);
	for (const { event, matcher } of HOOKS)
		expect(settings.hooks[event]).toEqual([{ ...(matcher ? { matcher } : {}), hooks: [ours] }]);
	const written = readFileSync(path, "utf8");
	expect(written.endsWith("}\n")).toBe(true);
	expect(setup(path)).toBe(false);
	expect(readFileSync(path, "utf8")).toBe(written);
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
	expect(setup(path, { remove: true })).toBe(true);
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
	expect(setup(path)).toBe(true);
	const settings = read(path);
	expect(settings.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [theirs] }]);
	expect(settings.hooks.SessionStart).toEqual([{ matcher: HOOKS[0]!.matcher, hooks: [ours] }]);
	expect(setup(path, { entries: [{ event: "Stop" }] })).toBe(true);
	expect(Object.keys(read(path).hooks)).toEqual(["PreToolUse", "Stop"]);
});

test("removing Quest's only hooks drops the hooks key", () => {
	const path = join(tempDir(), "settings.json");
	writeFileSync(path, JSON.stringify({ theme: "dark" }));
	setup(path);
	setup(path, { remove: true });
	expect(read(path)).toEqual({ theme: "dark" });
	expect(setup(path, { remove: true })).toBe(false);
});

test.each([
	["invalid JSON", "{ nope"],
	["a JSON array", "[]"],
	["hooks that are not an object", '{"hooks": []}'],
	["an event that is not an array", '{"hooks": {"SessionStart": {}}}'],
	["a group without handlers", '{"hooks": {"SessionStart": [{"matcher": "startup"}]}}'],
])("setup refuses settings with %s and leaves them unchanged", (_, content) => {
	const path = join(tempDir(), "settings.json");
	writeFileSync(path, content);
	expect(() => setup(path)).toThrow(path);
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
