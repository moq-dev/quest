// Quest's settings in the user's own Claude Code settings: what `quest setup`
// writes, and `quest hook`, which handles every hook it installs. Repositories
// write no hooks, since their settings would bind every contributor, so a user
// opts in once for all their repositories. Every hook runs the same command and
// the handler dispatches on the event, so a new hook is one more row in `HOOKS`
// and one more case in `hook`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { REFERENCE_MARKER, lines } from "../core";
import { CONTEXT } from "./skills";
import { HOOK_EVENTS } from "./worktree-hook";

/** The command the rule hooks run. */
export const HOOK_COMMAND = "quest hook";

/** The command the worktree hooks run; README-pasted entries ending in it are recognized too. */
export const WORKTREE_COMMAND = "quest worktree hook";

/** Claude Code truncates longer hook context to a preview and a file path it never asks Claude to read. */
export const CONTEXT_LIMIT = 10_000;

/** One installed entry: the event, the matcher narrowing it, the command (`HOOK_COMMAND` by default), and its timeout in seconds. */
export interface HookEntry {
	event: string;
	matcher?: string;
	command?: string;
	timeout?: number;
}

/**
 * The entries `quest setup` installs. SessionStart prints the rules when a
 * session starts, resumes, or clears, and again after compaction, which
 * summarizes earlier output away; a fork already holds them. SubagentStart
 * gives each subagent the same rules, since it starts without the session's.
 */
export const HOOKS: readonly HookEntry[] = [
	{ event: "SessionStart", matcher: "startup|resume|clear|compact" },
	{ event: "SubagentStart" },
];

/**
 * The entries `quest setup --worktrees` adds, handing Claude Code's worktrees,
 * and the subagent and session lifecycles that hold them, to `quest worktree`.
 * Claude Code gives SessionEnd hooks at most a minute, which its timeout asks for.
 */
export const WORKTREE_HOOKS: readonly HookEntry[] = HOOK_EVENTS.map((event) => ({
	event,
	command: WORKTREE_COMMAND,
	...(event === "SessionEnd" ? { timeout: 60 } : {}),
}));

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
 * Set Quest's settings in the Claude Code settings file at `path`: the
 * foreground timeout cap and `entries` as Quest's hooks, by default the rule
 * hooks plus the worktree hooks when `worktrees` is true, or when it is
 * unset and the file already has them. With `remove`, take
 * Quest's hooks out, and the cap while it still holds Quest's value. Keeps
 * every other setting and hook, and writes once. Returns a line per change. A
 * file that is not a JSON object, or whose `env` or `hooks` is malformed,
 * throws before anything is written.
 */
export function setup(
	path: string,
	options: { remove?: boolean; worktrees?: boolean; entries?: readonly HookEntry[] } = {},
): string[] {
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
	const worktrees = options.worktrees ?? hasWorktreeHooks(settings);
	const entries = options.entries ?? (worktrees ? [...HOOKS, ...WORKTREE_HOOKS] : HOOKS);
	const hooked = withHooks(settings, options.remove ? [] : entries, path);

	const changes: string[] = [];
	let updated = hooked;
	if (hooked !== settings) changes.push(`${path}: ${options.remove ? "removed" : "installed"} Quest's hooks`);
	const cap = env.BASH_MAX_TIMEOUT_MS;
	if (options.remove) {
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
			if (only && (group.matcher === undefined || typeof group.matcher === "string"))
				installed.push({
					event,
					...(group.matcher === undefined ? {} : { matcher: group.matcher as string }),
					...handlerEntry(group.hooks[0] as Json & { command: string }),
				});
			else scattered = true;
			return handlers.length > 0 ? [{ ...group, hooks: handlers }] : [];
		});
		if (left.length > 0 || groups.length === 0) kept[event] = left;
	}
	if (!scattered && sameEntries(installed, entries)) return settings;
	for (const { event, matcher, command = HOOK_COMMAND, timeout } of entries) {
		const group = {
			...(matcher === undefined ? {} : { matcher }),
			hooks: [{ type: "command", command, ...(timeout === undefined ? {} : { timeout }) }],
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

/** The command and timeout of Quest's `handler`, with any other field making it differ from every entry. */
function handlerEntry(handler: Json & { command: string }): Pick<HookEntry, "command" | "timeout"> {
	const extra = Object.keys(handler).some((key) => !["type", "command", "timeout"].includes(key));
	const timeout = typeof handler.timeout === "number" ? handler.timeout : undefined;
	return { command: extra ? `${handler.command}\0` : handler.command, ...(timeout === undefined ? {} : { timeout }) };
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
		[entry.event, entry.matcher ?? "", entry.command ?? HOOK_COMMAND, entry.timeout ?? ""].join("\0");
	const left = a.map(key).sort();
	const right = b.map(key).sort();
	return left.length === right.length && left.every((value, i) => value === right[i]);
}

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The fields of a Claude Code hook's JSON input that `quest hook` reads. */
interface HookInput {
	hook_event_name: string;
	cwd: string;
}

/**
 * What `quest hook` prints for the Claude Code hook event in `input`, or ""
 * when it adds nothing. SessionStart and SubagentStart add `quest context` to
 * the session's context in a repository whose root instructions carry Quest's
 * reference line, so its agents never run the command themselves.
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
