// Quest's settings in the user's own Claude Code and Codex settings: what
// `quest setup` writes, and `quest hook`, which handles every hook it installs.
// Repositories write no hooks, since their settings would bind every
// contributor, so a user opts in once for all their repositories. Every rule
// hook runs the same command and the handler dispatches on the event, so a new
// hook is one more row in an agent's hooks and one more case in `hook`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { version } from "../../package.json";
import { type StopInput, broken, questRoot, runningGates, usesQuest } from "./rules";
import { stubFindings } from "./setup";
import { CONTEXT } from "./skills";
import { HOOK_EVENTS } from "./worktree-hook";

/** The command the rule hooks run. */
export const HOOK_COMMAND = "quest hook";

/** The command the worktree hooks run; README-pasted entries ending in it are recognized too. */
export const WORKTREE_COMMAND = "quest worktree hook";

/** Claude Code truncates longer hook context to a preview and a file path it never asks Claude to read. */
export const CONTEXT_LIMIT = 10_000;

/**
 * One installed entry: the event, the matcher narrowing it, if any, the
 * command (`HOOK_COMMAND` by default), and the handler's settings beyond its
 * command, such as its timeout.
 */
export interface HookEntry {
	event: string;
	matcher?: string;
	command?: string;
	settings?: Record<string, unknown>;
}

/** When a session starts, resumes, or clears, and after compaction, which summarizes earlier output away; a fork already holds the rules. */
const SESSION = "startup|resume|clear|compact";

/**
 * The entries `quest setup` installs for Claude Code. SessionStart prints the
 * rules; SubagentStart gives each subagent the same rules, since it starts
 * without the session's. PreToolUse blocks the calls that break a rule a
 * program can check. Stop and SubagentStop refuse to end a turn while a gate
 * the agent started still runs in the background.
 */
export const CLAUDE_HOOKS: readonly HookEntry[] = [
	{ event: "SessionStart", matcher: SESSION },
	{ event: "SubagentStart" },
	{ event: "PreToolUse", matcher: "Bash|Write|Edit|MultiEdit" },
	{ event: "Stop" },
	{ event: "SubagentStop" },
];

/**
 * The same for Codex, whose shell commands match as Bash and whose file edits
 * are `apply_patch`. Codex spills hook context beyond a token limit, about
 * 2,500 by default, to a file; the rules' character cap bounds their tokens.
 */
export const CODEX_HOOKS: readonly HookEntry[] = [
	{ event: "SessionStart", matcher: SESSION, settings: { additionalContextLimit: CONTEXT_LIMIT } },
	{ event: "PreToolUse", matcher: "Bash|apply_patch" },
];

/**
 * A settings file `quest setup` writes: its path, its hooks, and whether it is
 * Claude Code's, which also holds the foreground timeouts and takes the
 * worktree hooks.
 */
export interface Target {
	name: string;
	path: string;
	hooks: readonly HookEntry[];
	claude: boolean;
}

/**
 * The settings `quest setup` configures: Claude Code's always, and Codex's
 * `hooks.json` when its home directory exists, in `CODEX_HOME` when set, else
 * `~/.codex`.
 */
export function targets(env: NodeJS.ProcessEnv = process.env): Target[] {
	const claude = { name: "Claude Code", path: settingsPath(env), hooks: CLAUDE_HOOKS, claude: true };
	const codexHome = env.CODEX_HOME || join(homedir(), ".codex");
	if (!existsSync(codexHome)) return [claude];
	return [claude, { name: "Codex", path: join(codexHome, "hooks.json"), hooks: CODEX_HOOKS, claude: false }];
}

/**
 * The entries `quest setup --worktrees` adds, handing Claude Code's worktrees,
 * and the subagent and session lifecycles that hold them, to `quest worktree`.
 * Claude Code gives SessionEnd hooks at most a minute, which its timeout asks for.
 */
export const WORKTREE_HOOKS: readonly HookEntry[] = HOOK_EVENTS.map((event) => ({
	event,
	command: WORKTREE_COMMAND,
	...(event === "SessionEnd" ? { settings: { timeout: 60 } } : {}),
}));

/**
 * Claude Code's cap on a foreground command's timeout: 55 minutes, just under the
 * 1h prompt-cache TTL, so a blocking wait returns while the session's cache is warm.
 */
export const BASH_MAX_TIMEOUT_MS = "3300000";

/**
 * The environment `quest setup` sets in Claude Code's settings: the cap, and the
 * same as the default timeout, so a long foreground command runs to the end
 * without the agent passing a timeout or backgrounding it.
 */
export const CLAUDE_ENV: Readonly<Record<string, string>> = {
	BASH_MAX_TIMEOUT_MS,
	BASH_DEFAULT_TIMEOUT_MS: BASH_MAX_TIMEOUT_MS,
};

/** The user settings file Claude Code reads: in `CLAUDE_CONFIG_DIR` when set, else `~/.claude`. */
export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
	const dir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
	return join(dir, "settings.json");
}

type Json = Record<string, unknown>;

/**
 * Set Quest's settings in `target`'s file: its hooks, and in Claude Code's
 * `CLAUDE_ENV` and the worktree hooks when `worktrees` is true, or when it is
 * unset and the file already has them. With `remove`, take Quest's hooks out,
 * and each `CLAUDE_ENV` variable that still holds Quest's value. Keeps every other setting and
 * hook, and writes once. Returns a line per change. A file that is not a JSON
 * object, or whose `env` or `hooks` is malformed, throws before anything is
 * written.
 */
export function setup(target: Target, options: { remove?: boolean; worktrees?: boolean } = {}): string[] {
	const { path } = target;
	const { remove = false } = options;
	const original = existsSync(path) ? readFileSync(path, "utf8") : null;
	let settings: unknown = {};
	if (original !== null) {
		try {
			settings = JSON.parse(original);
		} catch (error) {
			throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (!isObject(settings)) throw new Error(`${path} does not hold a JSON object`);
	const env = settings.env ?? {};
	if (!isObject(env)) throw new Error(`${path}: env is not an object`);
	const worktrees = target.claude && (options.worktrees ?? hasWorktreeHooks(settings));
	const entries = worktrees ? [...target.hooks, ...WORKTREE_HOOKS] : target.hooks;
	const hooked = withHooks(settings, remove ? [] : entries, path);

	const changes: string[] = [];
	let updated = hooked;
	if (hooked !== settings) changes.push(`${path}: ${remove ? "removed" : "installed"} Quest's hooks`);
	// Only Claude Code's settings hold the timeouts.
	const next: Json = { ...env };
	for (const [key, value] of Object.entries(target.claude ? CLAUDE_ENV : {})) {
		const current = env[key];
		if (remove) {
			if (current !== value) continue;
			delete next[key];
			changes.push(`${path}: removed env.${key}`);
		} else if (current !== value) {
			next[key] = value;
			const was = current === undefined ? "" : ` (was ${JSON.stringify(current)})`;
			changes.push(`${path}: env.${key}=${value}${was}`);
		} else continue;
		updated = { ...updated, env: next };
		if (Object.keys(next).length === 0) delete updated.env;
	}
	if (changes.length === 0) return [];
	mkdirSync(dirname(path), { recursive: true });
	// Written in place, so a settings file linked from dotfiles stays linked.
	writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`);
	return changes;
}

/**
 * `settings` with exactly `entries` as Quest's hooks, each in its own matcher
 * group, or `settings` itself when it already has them. Entries other tools or
 * the user wrote stay where they are; a group or event Quest's removal empties
 * goes with it.
 */
function withHooks(settings: Json, entries: readonly HookEntry[], path: string): Json {
	const hooks = settings.hooks ?? {};
	if (!isObject(hooks)) throw new Error(`${path}: hooks is not an object`);
	const installed: HookEntry[] = [];
	let scattered = false;
	const kept: Json = {};
	for (const [event, groups] of Object.entries(hooks)) {
		if (!Array.isArray(groups)) throw new Error(`${path}: hooks.${event} is not an array`);
		const left = groups.flatMap((group: unknown) => {
			if (!isObject(group) || !Array.isArray(group.hooks))
				throw new Error(`${path}: hooks.${event} holds a group without a hooks array`);
			const handlers = group.hooks.filter((handler: unknown) => !isOurs(handler));
			if (handlers.length === group.hooks.length) return [group];
			const only =
				group.hooks.length === 1 && Object.keys(group).every((key) => ["matcher", "hooks"].includes(key));
			if (only && (group.matcher === undefined || typeof group.matcher === "string")) {
				const { type: _, command, ...settings } = group.hooks[0] as Json & { command: string };
				installed.push({
					event,
					...(group.matcher === undefined ? {} : { matcher: group.matcher as string }),
					command,
					...(Object.keys(settings).length === 0 ? {} : { settings }),
				});
			} else scattered = true;
			return handlers.length > 0 ? [{ ...group, hooks: handlers }] : [];
		});
		if (left.length > 0 || groups.length === 0) kept[event] = left;
	}
	if (!scattered && sameEntries(installed, entries)) return settings;
	for (const { event, matcher, command = HOOK_COMMAND, settings: extra } of entries) {
		const group = {
			...(matcher === undefined ? {} : { matcher }),
			hooks: [{ type: "command", command, ...extra }],
		};
		kept[event] = [...((kept[event] as unknown[] | undefined) ?? []), group];
	}
	if (Object.keys(kept).length > 0) return { ...settings, hooks: kept };
	const rest = { ...settings };
	delete rest.hooks;
	return rest;
}

/** Whether a hook handler is Quest's: one `quest setup` wrote, or a worktree entry pasted from an older README. */
function isOurs(handler: unknown): handler is Json & { command: string } {
	return (
		isObject(handler) &&
		handler.type === "command" &&
		typeof handler.command === "string" &&
		(handler.command === HOOK_COMMAND || handler.command.endsWith(WORKTREE_COMMAND))
	);
}

/** Whether `settings` holds any of Quest's worktree hooks. */
function hasWorktreeHooks(settings: Json): boolean {
	if (!isObject(settings.hooks)) return false;
	return Object.values(settings.hooks).some(
		(groups) =>
			Array.isArray(groups) &&
			groups.some(
				(group) =>
					isObject(group) &&
					Array.isArray(group.hooks) &&
					group.hooks.some((handler) => isOurs(handler) && handler.command.endsWith(WORKTREE_COMMAND)),
			),
	);
}

function sameEntries(a: readonly HookEntry[], b: readonly HookEntry[]): boolean {
	const key = (entry: HookEntry) =>
		[
			entry.event,
			entry.matcher ?? "",
			entry.command ?? HOOK_COMMAND,
			JSON.stringify(Object.entries(entry.settings ?? {}).sort()),
		].join("\0");
	const left = a.map(key).sort();
	const right = b.map(key).sort();
	return left.length === right.length && left.every((value, i) => value === right[i]);
}

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The fields of a Claude Code or Codex hook's JSON input that `quest hook` reads. */
interface HookInput {
	hook_event_name: string;
	cwd: string;
	tool_name?: string;
	tool_input?: Record<string, unknown>;
}

/** What a Stop or SubagentStop refusal tells the agent, after the gates it names. */
const BLOCK_ON_GATES =
	"Block on each with the harness's wait until it ends, then end your turn. A subagent's background commands stop when it ends, and a session that ends its turn on one leaves its result unread.";

/**
 * What `quest hook` prints for the Claude Code or Codex hook event in `input`,
 * or "" when it adds nothing, in a repository whose root instructions carry
 * Quest's reference line. SessionStart and SubagentStart add `quest context`
 * to the session's context, so its agents never run the command themselves.
 * PreToolUse denies a tool call that breaks a rule `broken` checks, giving the
 * rule as the reason. Stop and SubagentStop refuse to end the turn while a gate
 * the agent started runs in the background (see `runningGates`).
 */
export function hook(input: unknown): string {
	const value = input as Partial<HookInput> | null;
	if (typeof value?.hook_event_name !== "string" || typeof value.cwd !== "string")
		throw new Error("expected a Claude Code hook's JSON input with hook_event_name and cwd");
	const event = value.hook_event_name;
	switch (event) {
		case "SessionStart":
		case "SubagentStart": {
			const root = questRoot(value.cwd);
			if (root === null) return "";
			const stubs = stubFindings(root).length;
			const context =
				stubs === 0
					? CONTEXT
					: `${CONTEXT}\n${stubs} Quest skill stubs here are missing, outdated, or edited for quest ${version} (\`quest check\` lists them): in a PR, run \`quest init\` with the repository's pinned quest, bumping the pin first if it is older.\n`;
			return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } });
		}
		case "PreToolUse": {
			if (
				typeof value.tool_name !== "string" ||
				typeof value.tool_input !== "object" ||
				value.tool_input === null
			)
				throw new Error("expected a PreToolUse hook's JSON input with tool_name and tool_input");
			if (!usesQuest(value.cwd)) return "";
			const rules = broken({ tool: value.tool_name, input: value.tool_input, cwd: value.cwd });
			if (rules.length === 0) return "";
			const reason = rules.join("\n");
			return JSON.stringify({
				hookSpecificOutput: {
					hookEventName: event,
					permissionDecision: "deny",
					permissionDecisionReason: reason,
				},
			});
		}
		case "Stop":
		case "SubagentStop": {
			if (!Array.isArray((value as StopInput).background_tasks))
				throw new Error(`expected a ${event} hook's JSON input with background_tasks; upgrade Claude Code`);
			const gates = runningGates(value as StopInput);
			if (gates.length === 0) return "";
			const named = gates.map((command) => `- ${command}`).join("\n");
			return JSON.stringify({
				decision: "block",
				reason: `\`quest gate\` commands you started still run in the background:\n${named}\n${BLOCK_ON_GATES}`,
			});
		}
		default:
			throw new Error(`quest hook does not handle ${event}; run \`quest setup\` again to update your hooks`);
	}
}
