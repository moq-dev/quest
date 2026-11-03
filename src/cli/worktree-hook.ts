// Claude Code's worktree lifecycle hooks, backed by `quest worktree`. `quest init` installs one
// static entry per event, each calling `quest worktree hook`, so the logic upgrades with the binary.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	Busy,
	type Merged,
	type WorktreeRecord,
	Worktrees,
	canonical,
	derivedDefaults,
	mainCheckout,
} from "./worktree";

// The events this handles are the core's HOOK_EVENTS, which `quest init` installs.
export { HOOK_EVENTS } from "../core";

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

/** Runs a registry operation, waiting out the short critical sections of concurrent hooks and commands. */
async function waiting<T>(action: () => T | Promise<T>): Promise<T> {
	for (;;) {
		try {
			return await action();
		} catch (error) {
			if (!(error instanceof Busy)) throw error;
		}
		await sleep(100);
	}
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
 * Claude's default base for a new worktree: the remote's default branch as last fetched, or the
 * session's own commit when no remote default branch is known.
 */
function base(cwd: string): string {
	try {
		return git(cwd, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD^{commit}");
	} catch {
		return git(cwd, "rev-parse", "HEAD");
	}
}

/**
 * The head of the pull or merge request a checkout named `pr-<number>` is for, or undefined when origin
 * has none. Claude names the worktree for `--worktree '#<number>'` or a request's URL `pr-<number>` and
 * passes the hook only that name, so a literal `pr-<number>` gets the request's head too. Like Claude,
 * it reads origin's `refs/pull/<number>/head` (GitHub) and `refs/merge-requests/<number>/head` (GitLab),
 * refusing the request when origin has both at different commits. The head is fetched into
 * `origin/pr/<number>` or `origin/mr/<number>`, so removing the checkout counts its commits as preserved.
 */
function pullRequest(cwd: string, name: string): string | undefined {
	const number = /^pr-([1-9][0-9]*)$/.exec(name)?.[1];
	if (number === undefined) return undefined;
	try {
		git(cwd, "remote", "get-url", "origin");
	} catch {
		return undefined;
	}
	const tracking = new Map([
		[`refs/pull/${number}/head`, `refs/remotes/origin/pr/${number}`],
		[`refs/merge-requests/${number}/head`, `refs/remotes/origin/mr/${number}`],
	]);
	const heads = new Map<string, string>();
	for (const line of git(cwd, "ls-remote", "origin", ...tracking.keys()).split("\n")) {
		const [sha, ref] = line.split("\t");
		if (sha && ref && tracking.has(ref)) heads.set(ref, sha);
	}
	if (new Set(heads.values()).size > 1)
		throw new Error(
			`origin has both ${[...tracking.keys()].join(" and ")} at different commits, so it is unclear which is #${number}; ` +
				"delete the one your forge does not create",
		);
	const [ref] = heads.keys();
	if (ref === undefined) return undefined;
	const local = tracking.get(ref)!;
	git(cwd, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", `+${ref}:${local}`);
	return git(cwd, "rev-parse", "--verify", "--quiet", `${local}^{commit}`);
}

/** Claude's name for a workflow agent's worktree, `<run ID>-<agent number>`, which carries no agent ID. */
const WORKFLOW_CHECKOUT = /^wf_[0-9a-f]{8}-[0-9a-f]{3}-[0-9]+$/;

/**
 * The checkout Claude created for this subagent. Claude names a subagent's worktree `agent-<agent_id>`,
 * so a subagent that runs without isolation in another agent's checkout never matches it. A workflow
 * agent's worktree is named for its run instead, so it is bound to the first subagent that starts in
 * it, which is the workflow agent itself; one that later runs there without isolation never matches.
 */
async function subagentCheckout(worktrees: Worktrees, input: HookInput): Promise<WorktreeRecord | undefined> {
	const path = toplevel(input.cwd);
	const record = path === undefined ? undefined : await waiting(() => worktrees.registered(path));
	const agent = field(input, "agent_id");
	if (record?.name === `agent-${agent}`) return record;
	if (record === undefined || !WORKFLOW_CHECKOUT.test(record.name)) return undefined;
	const bound =
		input.hook_event_name === "SubagentStart" ? await waiting(() => worktrees.bind(record.id, agent)) : record;
	return bound.agent === agent ? bound : undefined;
}

/**
 * Handle one hook event and return what it prints on stdout, if anything. WorktreeCreate checks
 * out Claude's default base, or a pull request's head for `pr-<number>`, under the main checkout's
 * `.worktrees/`, with derived defaults, and prints its path; an existing checkout of that name in the
 * repository is restored instead.
 * WorktreeRemove removes the checkout, never forcing. SubagentStop releases the subagent's own
 * checkout, and SubagentStart restores it, telling the subagent when its scratch was deleted.
 */
export async function claudeHook(input: unknown, worktrees: Worktrees, merged: Merged): Promise<string | undefined> {
	const hook = parse(input);
	switch (hook.hook_event_name) {
		case "WorktreeCreate": {
			const name = field(hook, "name");
			const main = mainCheckout(hook.cwd);
			const existing = await waiting(() => worktrees.registered(join(main, ".worktrees", name)));
			if (existing?.name === name) {
				// Claude reuses a name, such as a resumed workflow run's, for an agent that binds afresh.
				await waiting(() => worktrees.bind(existing.id));
				return `${(await waiting(() => worktrees.restore(existing.id))).path}\n`;
			}
			const { reserve, scratch } = derivedDefaults(main);
			const ref = pullRequest(hook.cwd, name) ?? base(hook.cwd);
			return `${(await waiting(() => worktrees.create(main, name, reserve, ref, scratch))).path}\n`;
		}
		case "WorktreeRemove": {
			const path = canonical(field(hook, "worktree_path"));
			const record = await waiting(() => worktrees.registered(path));
			if (record) await waiting(() => worktrees.remove(record.id, merged));
			// Claude counts a path that is gone as removed, and keeps one that remains after a failure.
			else if (existsSync(path))
				throw new Error(`not a checkout quest worktree owns; remove it by hand: ${path}`);
			return undefined;
		}
		case "SubagentStart": {
			const record = await subagentCheckout(worktrees, hook);
			if (!record) return undefined;
			const released = record.phase === "released" && record.scratch.length > 0;
			await waiting(() => worktrees.restore(record.id));
			if (!released) return undefined;
			const additionalContext =
				`Quest released this checkout while you were stopped, deleting its ignored scratch (${record.scratch.join(", ")}). ` +
				"Reinstall or rebuild what you need before using it.";
			return `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext } })}\n`;
		}
		case "SubagentStop": {
			const record = await subagentCheckout(worktrees, hook);
			if (record) await waiting(() => worktrees.release(record.id));
			return undefined;
		}
		default:
			throw new Error(`unsupported hook event: ${hook.hook_event_name}`);
	}
}
