// Quest's settings in the user's own Claude Code and Codex settings: what
// `quest setup` writes, and `quest hook`, which handles every hook it installs.
// Repositories write no hooks, since their settings would bind every
// contributor, so a user opts in once for all their repositories. Every hook
// runs the same command and the handler dispatches on the event, so a new hook
// is one more row in an agent's hooks and one more case in `hook`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { REFERENCE_MARKER, lines } from "../core";
import { broken } from "./rules";
import { CONTEXT } from "./skills";

/** The command every Quest entry runs; `quest setup` recognizes its own entries by it. */
export const HOOK_COMMAND = "quest hook";

/** Claude Code truncates longer hook context to a preview and a file path it never asks Claude to read. */
export const CONTEXT_LIMIT = 10_000;

/** One installed entry: the event, the matcher narrowing it, if any, and the handler's settings beyond its command. */
export interface HookEntry {
	event: string;
	matcher?: string;
	settings?: Record<string, unknown>;
}

/** When a session starts, resumes, or clears, and after compaction, which summarizes earlier output away; a fork already holds the rules. */
const SESSION = "startup|resume|clear|compact";

/**
 * The entries `quest setup` installs for Claude Code. SessionStart prints the
 * rules; SubagentStart gives each subagent the same rules, since it starts
 * without the session's. PreToolUse blocks the calls that break a rule a
 * program can check.
 */
export const CLAUDE_HOOKS: readonly HookEntry[] = [
	{ event: "SessionStart", matcher: SESSION },
	{ event: "SubagentStart" },
	{ event: "PreToolUse", matcher: "Bash|Write|Edit|MultiEdit" },
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

/** A settings file `quest setup` writes: its path, its hooks, and whether it also holds Claude Code's foreground timeout cap. */
export interface Target {
	name: string;
	path: string;
	hooks: readonly HookEntry[];
	timeout: boolean;
}

/**
 * The settings `quest setup` configures: Claude Code's always, and Codex's
 * `hooks.json` when its home directory exists, in `CODEX_HOME` when set, else
 * `~/.codex`.
 */
export function targets(env: NodeJS.ProcessEnv = process.env): Target[] {
	const claude = { name: "Claude Code", path: settingsPath(env), hooks: CLAUDE_HOOKS, timeout: true };
	const codexHome = env.CODEX_HOME || join(homedir(), ".codex");
	if (!existsSync(codexHome)) return [claude];
	return [claude, { name: "Codex", path: join(codexHome, "hooks.json"), hooks: CODEX_HOOKS, timeout: false }];
}

/**
 * Claude Code's cap on a foreground command's timeout: 55 minutes, just under the
 * 1h prompt-cache TTL, so a blocking wait returns while the session's cache is warm.
 */
export const BASH_MAX_TIMEOUT_MS = "3300000";

/** The user settings file Claude Code reads: in `CLAUDE_CONFIG_DIR` when set, else `~/.claude`. */
export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
	const dir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
	return join(dir, "settings.json");
}

type Json = Record<string, unknown>;

/**
 * Set Quest's settings in `target`'s file: its hooks, and the foreground
 * timeout cap where it holds one. With `remove`, take Quest's hooks out, and
 * the cap while it still holds Quest's value. Keeps every other setting and
 * hook, and writes once. Returns a line per change. A file that is not a JSON
 * object, or whose `env` or `hooks` is malformed, throws before anything is
 * written.
 */
export function setup(target: Target, remove = false): string[] {
	const { path } = target;
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
	const hooked = withHooks(settings, remove ? [] : target.hooks, path);

	const changes: string[] = [];
	let updated = hooked;
	if (hooked !== settings) changes.push(`${path}: ${remove ? "removed" : "installed"} Quest's hooks`);
	const cap = env.BASH_MAX_TIMEOUT_MS;
	if (!target.timeout) {
		// Only Claude Code's settings hold the cap.
	} else if (remove) {
		if (cap === BASH_MAX_TIMEOUT_MS) {
			const { BASH_MAX_TIMEOUT_MS: _, ...rest } = env;
			updated = { ...updated, env: rest };
			if (Object.keys(rest).length === 0) delete updated.env;
			changes.push(`${path}: removed env.BASH_MAX_TIMEOUT_MS`);
		}
	} else if (cap !== BASH_MAX_TIMEOUT_MS) {
		updated = { ...updated, env: { ...env, BASH_MAX_TIMEOUT_MS } };
		const was = cap === undefined ? "" : ` (was ${JSON.stringify(cap)})`;
		changes.push(`${path}: env.BASH_MAX_TIMEOUT_MS=${BASH_MAX_TIMEOUT_MS}${was}`);
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
				const { type: _, command: __, ...settings } = group.hooks[0] as Json;
				installed.push({
					event,
					...(group.matcher === undefined ? {} : { matcher: group.matcher as string }),
					...(Object.keys(settings).length === 0 ? {} : { settings }),
				});
			} else scattered = true;
			return handlers.length > 0 ? [{ ...group, hooks: handlers }] : [];
		});
		if (left.length > 0 || groups.length === 0) kept[event] = left;
	}
	if (!scattered && sameEntries(installed, entries)) return settings;
	for (const { event, matcher, settings: extra } of entries) {
		const group = {
			...(matcher === undefined ? {} : { matcher }),
			hooks: [{ type: "command", command: HOOK_COMMAND, ...extra }],
		};
		kept[event] = [...((kept[event] as unknown[] | undefined) ?? []), group];
	}
	if (Object.keys(kept).length > 0) return { ...settings, hooks: kept };
	const rest = { ...settings };
	delete rest.hooks;
	return rest;
}

/** Whether a hook handler is one `quest setup` wrote. */
function isOurs(handler: unknown): boolean {
	return isObject(handler) && handler.type === "command" && handler.command === HOOK_COMMAND;
}

function sameEntries(a: readonly HookEntry[], b: readonly HookEntry[]): boolean {
	const key = (entry: HookEntry) =>
		`${entry.event}\0${entry.matcher ?? ""}\0${JSON.stringify(Object.entries(entry.settings ?? {}).sort())}`;
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

/**
 * What `quest hook` prints for the Claude Code or Codex hook event in `input`,
 * or "" when it adds nothing, in a repository whose root instructions carry
 * Quest's reference line. SessionStart and SubagentStart add `quest context`
 * to the session's context, so its agents never run the command themselves.
 * PreToolUse denies a tool call that breaks a rule `broken` checks, giving the
 * rule as the reason.
 */
export function hook(input: unknown): string {
	const value = input as Partial<HookInput> | null;
	if (typeof value?.hook_event_name !== "string" || typeof value.cwd !== "string")
		throw new Error("expected a Claude Code hook's JSON input with hook_event_name and cwd");
	const event = value.hook_event_name;
	switch (event) {
		case "SessionStart":
		case "SubagentStart":
			if (!usesQuest(value.cwd)) return "";
			return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: CONTEXT } });
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
		default:
			throw new Error(`quest hook does not handle ${event}; run \`quest setup\` again to update your hooks`);
	}
}

/**
 * Whether the checkout holding `cwd` points its agents at `quest context`:
 * its root `AGENTS.md` or `CLAUDE.md` has a line starting with Quest's
 * reference marker. Found without running git, since every session waits on it.
 */
function usesQuest(cwd: string): boolean {
	for (let dir = cwd; ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) {
			return ["AGENTS.md", "CLAUDE.md"].some((name) => {
				try {
					return lines(readFileSync(join(dir, name), "utf8")).some((line) =>
						line.startsWith(REFERENCE_MARKER),
					);
				} catch {
					return false;
				}
			});
		}
		if (dirname(dir) === dir) return false;
	}
}
