// Claude Code's worktree lifecycle hooks, backed by `quest worktree`. A user opts in with one static
// entry per event in their own Claude settings, each calling `quest worktree hook`, so the logic
// upgrades with the binary.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { git } from "./git";
import { type StopInput, runningGates } from "./rules";
import {
	Busy,
	type Merged,
	type WorktreeRecord,
	Worktrees,
	canonical,
	derivedDefaults,
	mainCheckout,
} from "./worktree";

/** The Claude Code events `quest worktree hook` handles. */
export const HOOK_EVENTS = [
	"WorktreeCreate",
	"WorktreeRemove",
	"SubagentStart",
	"SubagentStop",
	"SessionStart",
	"SessionEnd",
] as const;

/**
 * The guide's workspace, which holds an agent's reports and logs. Its parent reads them after it stops,
 * so a subagent's automatic release keeps it; removing the checkout deletes it with the other scratch.
 */
const WORKSPACE = ".tmp";

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
	/** Every event: the Claude Code session it fires in, a subagent's parent session included. */
	session_id?: string;
	/** SessionEnd: why the session ended, such as `clear` when `/clear` starts a new one in its place. */
	reason?: string;
}

function parse(input: unknown): HookInput {
	const value = input as Partial<HookInput> | null;
	if (typeof value?.hook_event_name !== "string" || typeof value.cwd !== "string")
		throw new Error("expected a Claude Code hook's JSON input with hook_event_name and cwd");
	return value as HookInput;
}

function field(input: HookInput, key: "name" | "worktree_path" | "agent_id" | "session_id"): string {
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

/** The top of the checkout holding `cwd`, or undefined outside any. */
function toplevel(cwd: string): string | undefined {
	try {
		return canonical(git(cwd, ["rev-parse", "--show-toplevel"]));
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
		return git(cwd, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD^{commit}"]);
	} catch {
		return git(cwd, ["rev-parse", "HEAD"]);
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
		git(cwd, ["remote", "get-url", "origin"]);
	} catch {
		return undefined;
	}
	const tracking = new Map([
		[`refs/pull/${number}/head`, `refs/remotes/origin/pr/${number}`],
		[`refs/merge-requests/${number}/head`, `refs/remotes/origin/mr/${number}`],
	]);
	const heads = new Map<string, string>();
	for (const line of git(cwd, ["ls-remote", "origin", ...tracking.keys()]).split("\n")) {
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
	git(cwd, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", `+${ref}:${local}`]);
	return git(cwd, ["rev-parse", "--verify", "--quiet", `${local}^{commit}`]);
}

/** The checkout whose submodule `checkout` is, or undefined for a top-level one. */
function superproject(checkout: string): string | undefined {
	// Git prints it with forward slashes on Windows, so canonical paths compare against it.
	const path = git(checkout, ["rev-parse", "--show-superproject-working-tree"]);
	return path ? canonical(path) : undefined;
}

/** The registered checkout holding `cwd`, looking through the submodules it sits in. */
async function enclosing(worktrees: Worktrees, cwd: string): Promise<WorktreeRecord | undefined> {
	let path = toplevel(cwd);
	let record: WorktreeRecord | undefined;
	while (path && !record) {
		const checkout = path;
		record = await waiting(() => worktrees.registered(checkout));
		path = superproject(checkout);
	}
	return record;
}

/** Claude's name for a workflow agent's worktree, `<run ID>-<agent number>`, which carries no agent ID. */
const WORKFLOW_CHECKOUT = /^wf_[0-9a-f]{8}-[0-9a-f]{3}-[0-9]+$/;

/** Whether Claude made the checkout named `name` for a subagent or workflow agent rather than a session. */
function forSubagent(name: string): boolean {
	return name.startsWith("agent-") || WORKFLOW_CHECKOUT.test(name);
}

/** The context telling an agent that a release deleted `scratch` from its checkout while it was stopped. */
function reinstall(event: string, scratch: readonly string[]): string | undefined {
	const deleted = scratch.filter((path) => path !== WORKSPACE);
	if (!deleted.length) return undefined;
	const additionalContext =
		`Quest released this checkout while you were stopped, deleting its ignored scratch (${deleted.join(", ")}). ` +
		"Reinstall or rebuild what you need before using it.";
	return `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } })}\n`;
}

/**
 * The checkout Claude created for this subagent. Claude names a subagent's worktree `agent-<agent_id>`,
 * so a subagent that runs without isolation in another agent's checkout never matches it. A workflow
 * agent's worktree is named for its run instead, so it is bound to the first subagent that starts in
 * it, which is the workflow agent itself; one that later runs there without isolation never matches.
 */
async function subagentCheckout(worktrees: Worktrees, input: HookInput): Promise<WorktreeRecord | undefined> {
	const record = await enclosing(worktrees, input.cwd);
	const agent = field(input, "agent_id");
	if (record?.name === `agent-${agent}`) return record;
	if (record === undefined || !WORKFLOW_CHECKOUT.test(record.name)) return undefined;
	const { id } = record;
	const bound = input.hook_event_name === "SubagentStart" ? await waiting(() => worktrees.bind(id, agent)) : record;
	return bound.agent === agent ? bound : undefined;
}

/**
 * Handle one hook event and return what it prints on stdout, if anything. WorktreeCreate checks
 * out Claude's default base, or a pull request's head for `pr-<number>`, under the main checkout's
 * `.worktrees/`, with derived defaults, and prints its path; an existing checkout of that name in the
 * repository is restored instead.
 * WorktreeRemove removes the checkout after recursive safety checks. SubagentStop releases the subagent's own
 * checkout, unless `quest hook` refuses the stop for a running gate, and SubagentStart restores it, telling the subagent when its scratch was deleted. A checkout made
 * for a session rather than a subagent is held by each session that creates it or starts in it, and SessionEnd
 * releases it once the last ends; SessionStart claims it again, likewise telling the session.
 */
export async function claudeHook(
	input: unknown,
	worktrees: Worktrees,
	merged: Merged,
	project?: string,
): Promise<string | undefined> {
	const hook = parse(input);
	switch (hook.hook_event_name) {
		case "WorktreeCreate": {
			const name = field(hook, "name");
			let cwd = toplevel(hook.cwd);
			if (!cwd) throw new Error(`hook cwd is not in a Git checkout: ${hook.cwd}`);
			// The hook's project anchors ownership when cwd is inside a submodule, without
			// changing which repository a session opened directly in a vendored project owns.
			if (project && toplevel(project)) {
				const main = mainCheckout(project);
				let enclosing = cwd;
				while (mainCheckout(enclosing) !== main) {
					const parent = superproject(enclosing);
					if (!parent) break;
					enclosing = parent;
				}
				if (mainCheckout(enclosing) === main) cwd = enclosing;
			}
			const main = mainCheckout(cwd);
			const existing = await waiting(() => worktrees.registered(join(main, ".worktrees", name)));
			if (existing?.name === name) {
				// Claude reuses a name, such as a resumed workflow run's, for an agent that binds afresh.
				await waiting(() => worktrees.bind(existing.id));
				if (!forSubagent(name)) await waiting(() => worktrees.attach(existing.id, field(hook, "session_id")));
				return `${(await waiting(() => worktrees.restore(existing.id))).path}\n`;
			}
			const { reserve, scratch } = derivedDefaults(main);
			const ref = pullRequest(cwd, name) ?? base(cwd);
			const created = await waiting(() => worktrees.create(main, name, reserve, ref, scratch));
			if (!forSubagent(name)) await waiting(() => worktrees.attach(created.id, field(hook, "session_id")));
			return `${created.path}\n`;
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
			await waiting(() => worktrees.restore(record.id));
			return record.phase === "released" ? reinstall("SubagentStart", record.scratch) : undefined;
		}
		case "SubagentStop": {
			// `quest hook` refuses this stop, and Claude continues the subagent without a SubagentStart.
			if (runningGates(hook as StopInput).length > 0) return undefined;
			const record = await subagentCheckout(worktrees, hook);
			if (record) await waiting(() => worktrees.release(record.id, [WORKSPACE]));
			return undefined;
		}
		case "SessionStart": {
			const session = field(hook, "session_id");
			// Resuming starts in the directory Claude was launched from before it enters the session's checkout.
			const ids = new Set((await waiting(() => worktrees.held(session))).map((record) => record.id));
			const here = await enclosing(worktrees, hook.cwd);
			if (here?.sessions) ids.add(here.id);
			const deleted = new Set<string>();
			for (const id of ids) {
				const before = await waiting(() => worktrees.attach(id, session));
				// A failure means a release may have deleted part of the scratch before it failed or was cut short.
				if (before.phase === "released" || before.failure) for (const item of before.scratch) deleted.add(item);
			}
			return reinstall("SessionStart", [...deleted]);
		}
		case "SessionEnd":
			// `/clear` ends the session only to start another in the same checkout, which claims it then.
			await worktrees.detach(field(hook, "session_id"), hook.reason !== "clear", [WORKSPACE]);
			return undefined;
		default:
			throw new Error(`unsupported hook event: ${hook.hook_event_name}`);
	}
}
