// Claude Code's worktree lifecycle hooks, backed by `quest worktree`. `quest init` installs one
// static entry per event, each calling `quest worktree hook`, so the logic upgrades with the binary.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Merged, type WorktreeRecord, Worktrees, canonical, derivedDefaults, mainCheckout } from "./worktree";

/** The Claude Code events `quest worktree hook` handles, in the order `quest init` installs them. */
export const HOOK_EVENTS = ["WorktreeCreate", "WorktreeRemove", "SubagentStart", "SubagentStop"] as const;

/** The fields of a Claude Code hook's JSON input that these events read. */
interface HookInput {
	hook_event_name: string;
	cwd: string;
	/** WorktreeCreate: the slug Claude chose or the user gave. */
	name?: string;
	/** WorktreeRemove: the path WorktreeCreate printed. */
	worktree_path?: string;
	/** SubagentStart and SubagentStop: the subagent's ID. */
	agent_id?: string;
}

function parse(input: unknown): HookInput {
	const value = input as Partial<HookInput> | null;
	if (typeof value?.hook_event_name !== "string" || typeof value.cwd !== "string")
		throw new Error("expected a Claude Code hook's JSON input with hook_event_name and cwd");
	return value as HookInput;
}

function field(input: HookInput, key: "name" | "worktree_path" | "agent_id"): string {
	const value = input[key];
	if (typeof value !== "string" || value === "") throw new Error(`${input.hook_event_name} input lacks ${key}`);
	return value;
}

function git(path: string, ...args: string[]): string {
	return execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The top of the checkout holding `cwd`, or undefined outside any. */
function toplevel(cwd: string): string | undefined {
	try {
		return canonical(git(cwd, "rev-parse", "--show-toplevel"));
	} catch {
		return undefined;
	}
}

/**
 * The checkout Claude created for this subagent. Claude names a subagent's worktree `agent-<agent_id>`,
 * so a subagent that runs without isolation in another agent's checkout never matches it.
 */
function subagentCheckout(worktrees: Worktrees, input: HookInput): WorktreeRecord | undefined {
	const path = toplevel(input.cwd);
	const record = path === undefined ? undefined : worktrees.registered(path);
	return record?.name === `agent-${field(input, "agent_id")}` ? record : undefined;
}

/**
 * Handle one hook event and return what it prints on stdout, if anything. WorktreeCreate checks
 * out the session's commit under the main checkout's `.worktrees/`, with derived defaults, and
 * prints its path; an existing checkout of that name in the repository is restored instead.
 * WorktreeRemove removes the checkout, never forcing. SubagentStop releases the subagent's own
 * checkout, and SubagentStart restores it, telling the subagent when its scratch was deleted.
 */
export async function claudeHook(input: unknown, worktrees: Worktrees, merged: Merged): Promise<string | undefined> {
	const hook = parse(input);
	switch (hook.hook_event_name) {
		case "WorktreeCreate": {
			const name = field(hook, "name");
			const main = mainCheckout(hook.cwd);
			const existing = worktrees.registered(join(main, ".worktrees", name));
			if (existing?.name === name) return `${worktrees.restore(existing.id).path}\n`;
			const { reserve, scratch } = derivedDefaults(main);
			return `${worktrees.create(main, name, reserve, git(hook.cwd, "rev-parse", "HEAD"), scratch).path}\n`;
		}
		case "WorktreeRemove": {
			const path = canonical(field(hook, "worktree_path"));
			const record = worktrees.registered(path);
			if (record) await worktrees.remove(record.id, merged);
			// Claude counts a path that is gone as removed, and keeps one that remains after a failure.
			else if (existsSync(path))
				throw new Error(`not a checkout quest worktree owns; remove it by hand: ${path}`);
			return undefined;
		}
		case "SubagentStart": {
			const record = subagentCheckout(worktrees, hook);
			if (!record) return undefined;
			const released = record.phase === "released" && record.scratch.length > 0;
			worktrees.restore(record.id);
			if (!released) return undefined;
			const additionalContext =
				`Quest released this checkout while you were stopped, deleting its ignored scratch (${record.scratch.join(", ")}). ` +
				"Reinstall or rebuild what you need before using it.";
			return `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext } })}\n`;
		}
		case "SubagentStop": {
			const record = subagentCheckout(worktrees, hook);
			if (record) worktrees.release(record.id);
			return undefined;
		}
		default:
			throw new Error(`unsupported hook event: ${hook.hook_event_name}`);
	}
}
