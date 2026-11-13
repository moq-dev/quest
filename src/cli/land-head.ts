// Trusted preparation and publication. Sandboxes and fixers never receive this repository or state.
import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { carriedBy } from "./land-fixer";
import { gitAuthentication } from "./land-git";
import { GitHub, type GitHubDependencies, type Repository, object, string } from "../github/client";
import {
	baseRemote,
	type LandMethod,
	contains,
	eject,
	ejection,
	git,
	readRemote,
	type RemoteRead,
	mergeBase,
	resolveQueue,
	SETTLE_RETRIES,
	tryGit,
	type Entry,
	type Plan,
	type Target,
} from "./land";

interface Prepared {
	approved: string;
	enabledAt: string;
	head: string;
	base: string;
	tree: string;
}
function recordPath(state: string, number: number, head: string): string {
	return join(state, `head-${number}-${head}.json`);
}
function save(path: string, value: unknown): void {
	writeFileSync(`${path}.new`, JSON.stringify(value), { mode: 0o600 });
	renameSync(`${path}.new`, path);
}

/**
 * A restart may trust only the exact merge recorded privately before the daemon pushed it:
 * first parent = original pin, second parent = tested base, same queue entry and tested tree.
 * Author text alone is forgeable. A later writer's commit or a requeue never inherits this approval.
 */
export async function resolvePreparedQueue(
	root: string,
	state: string,
	repository: Repository,
	target: Target,
	deps: GitHubDependencies,
): Promise<Plan> {
	const plan = await resolveQueue(repository, target, deps, {
		acceptHead: (entry) => isPrepared(root, state, entry),
		carried: (number, head) => carriedBy(state, number, head),
	});
	const numbers = new Set(
		readdirSync(state).flatMap((name) => {
			const match = /^head-(\d+)-.*\.json$/.exec(name);
			return match ? [Number(match[1])] : [];
		}),
	);
	const github = new GitHub(deps);
	for (const number of numbers) {
		if (plan.queue.some((entry) => entry.number === number)) continue;
		const pull = object(await (await github.request(`/repos/${plan.repository}/pulls/${number}`)).json());
		if (pull.state === "closed" || pull.merged === true || plan.eject.some((entry) => entry.number === number))
			forgetHeads(state, number);
	}
	return plan;
}

export function forgetHeads(state: string, number: number): void {
	for (const name of readdirSync(state))
		if (name.startsWith(`head-${number}-`) && name.endsWith(".json")) unlinkSync(join(state, name));
}

export function isPrepared(root: string, state: string, entry: Entry): boolean {
	const path = recordPath(state, entry.number, entry.head);
	if (!existsSync(path)) return false;
	const record = JSON.parse(readFileSync(path, "utf8")) as Prepared;
	return (
		record.head === entry.head &&
		record.approved === entry.approved &&
		record.enabledAt === entry.enabledAt &&
		tryGit(root, ["show", "-s", "--format=%P", entry.head]).stdout.trim() === `${record.approved} ${record.base}` &&
		git(root, ["show", "-s", "--format=%an <%ae>", entry.head]) === "moq-bot <moq-bot@users.noreply.github.com>" &&
		git(root, ["rev-parse", `${entry.head}^{tree}`]) === record.tree &&
		contains(root, record.base, entry.head)
	);
}

/** What `push` sends where, and the credential it sends it with. */
export interface Push {
	remote: string;
	/** The commit `to` builds on, for whether the push changes workflows. */
	from: string;
	to: string;
	ref: string;
	/** What `ref` must be before the push, `from` when absent; empty when it must not exist yet. */
	lease?: string;
	token: (workflows: boolean) => Promise<string>;
}

/**
 * Fresh tokens go only to git over HTTPS, with no inherited credential helper or global config. GitHub
 * intermittently answers a push to a repository the token reaches with "Repository not found", so that
 * is retried as `github` retries a failed request; any other refusal returns at once. A fork the App's
 * token cannot reach answers the same lasting 404, and so reaches its caller's fallback only after the
 * retries, about 15 seconds later.
 */
export async function push(github: GitHub, root: string, { remote, from, to, ref, lease = from, token }: Push) {
	// A push that replaces another head than the one it builds on can change workflows relative to either.
	const workflows = [...new Set([from, lease])].some(
		(old) => old !== "" && git(root, ["diff", "--name-only", old, to, "--", ".github/workflows"]) !== "",
	);
	return github.retry(
		async () =>
			tryGit(root, ["push", "--quiet", remote, `${to}:${ref}`, `--force-with-lease=${ref}:${lease}`], {
				env: gitAuthentication(await token(workflows)),
			}),
		(result) =>
			result.status !== 0 && /^remote: Repository not found\.\s*$/m.test(result.stderr)
				? `pushing ${ref} to ${remote}: GitHub answered Repository not found`
				: undefined,
	);
}
export async function remoteHead(root: string, remote: string, ref: string, read: RemoteRead): Promise<string | null> {
	return (
		(await read(root, ["ls-remote", remote, ref]))
			.split("\n")
			.find((line) => line.endsWith(`\t${ref}`))
			?.split("\t")[0] ?? null
	);
}

export type Preparation =
	| { head: string }
	| { fallback: true }
	| { reason: "head_moved" | "tree_mismatch" | "merge_conflict" | "merge_refused"; detail: string };
export async function prepareHead(
	root: string,
	state: string,
	plan: Plan,
	entry: Entry,
	base: string,
	tree: string,
	deps: GitHubDependencies,
	token: (workflows: boolean) => Promise<string>,
	read: RemoteRead = readRemote,
): Promise<Preparation> {
	await read(root, ["fetch", "--quiet", "--no-tags", baseRemote(plan), base]);
	const remote = `https://github.com/${entry.repository}.git`;
	const ref = `refs/heads/${entry.branch}`;
	const actual = await remoteHead(root, remote, ref, read);
	if (actual !== entry.head) {
		const updated = actual === null ? null : { ...entry, head: actual };
		if (!updated || !isPrepared(root, state, updated))
			return { reason: "head_moved", detail: `PR #${entry.number}'s head moved before preparing its merge` };
		// GitHub's queue can lag our own push. Recognize the privately recorded head, never a writer's.
		entry = updated;
	}

	if (contains(root, base, entry.head)) {
		if (git(root, ["rev-parse", `${entry.head}^{tree}`]) !== tree)
			return { reason: "tree_mismatch", detail: `PR #${entry.number}'s head tree differs from the tested chain` };
		return { head: entry.head };
	}
	if (entry.repository !== plan.repository && !entry.maintainerCanModify) return { fallback: true };
	// Rebuild directly on the original pin, even when replacing a prior daemon merge after a restart.
	const prepared = mergeBase(root, entry.approved, base);
	if ("reason" in prepared) return prepared;
	if (prepared.tree !== tree)
		return {
			reason: "tree_mismatch",
			detail: `PR #${entry.number}'s resolved merge tree ${prepared.tree} differs from tested ${tree}`,
		};
	save(recordPath(state, entry.number, prepared.head), {
		...prepared,
		approved: entry.approved,
		enabledAt: entry.enabledAt,
		base,
	});
	const result = await push(new GitHub(deps), root, { remote, from: entry.head, to: prepared.head, ref, token });
	if (result.status === 0) return { head: prepared.head };
	if ((await remoteHead(root, remote, ref, read)) !== entry.head)
		return { reason: "head_moved", detail: `PR #${entry.number}'s head moved while preparing its merge` };
	if (entry.repository !== plan.repository) return { fallback: true };
	return { reason: "merge_refused", detail: `PR #${entry.number} merge push failed: ${result.stderr.trim()}` };
}

interface Fallback {
	plan: Plan;
	entry: Entry;
	commit: string;
	parent: string;
}
/** Finish a base push/close interrupted by a restart, without repeating a landed commit. */
export async function finishFallback(
	root: string,
	state: string,
	deps: GitHubDependencies,
	token: (workflows: boolean) => Promise<string>,
	read: RemoteRead = readRemote,
): Promise<string | null> {
	const path = join(state, "fallback.json");
	if (!existsSync(path)) return null;
	const { plan, entry, commit, parent } = JSON.parse(readFileSync(path, "utf8")) as Fallback;
	// A fallback saved before the gate had a method squashed.
	plan.method ??= "squash";
	const remote = baseRemote(plan);
	await read(root, ["fetch", "--quiet", remote, plan.base.ref]);
	if (!contains(root, commit, "FETCH_HEAD")) {
		if (git(root, ["rev-parse", "FETCH_HEAD"]) !== parent) {
			unlinkSync(path);
			return null;
		}
		const [owner, repo] = plan.repository.split("/");
		const fresh = await resolvePreparedQueue(
			root,
			state,
			{ owner, repo },
			{ base: plan.base.ref, method: plan.method },
			deps,
		);
		const queued = fresh.queue.find(
			(now) =>
				now.number === entry.number && now.approved === entry.approved && now.enabledAt === entry.enabledAt,
		);
		if (!queued) {
			unlinkSync(path);
			return null;
		}
		if (fresh.base.sha !== parent) throw new Error("fallback base is not yet reflected in the queue; retrying");
		const result = await push(new GitHub(deps), root, {
			remote,
			from: parent,
			to: commit,
			ref: `refs/heads/${plan.base.ref}`,
			token,
		});
		if (result.status !== 0) {
			await read(root, ["fetch", "--quiet", remote, plan.base.ref]);
			if (!contains(root, commit, "FETCH_HEAD")) {
				unlinkSync(path);
				if (git(root, ["rev-parse", "FETCH_HEAD"]) !== parent) return null;
				await eject(new GitHub(deps), plan, ejection(entry, "merge_refused", result.stderr.trim()));
				forgetHeads(state, entry.number);
				return `ejected ${entry.number} merge_refused`;
			}
		}
	}
	// The commit is on the base. Every step below is safe to repeat, so a restart resumes where it stopped.
	const github = new GitHub(deps);
	// A merge commit brings the head into the base, and GitHub marks a PR merged once a push does,
	// though its documentation names only pushes to the default branch. A close would race that, so
	// it waits for GitHub first and closes only a PR GitHub has not marked. A squash never marks it.
	const merged = plan.method === "merge" && (await markedMerged(github, entry));
	const issue = `/repos/${plan.repository}/issues/${entry.number}`;
	const marker = `<!-- quest land: landed ${commit} -->`;
	const comments = await github.all(`${issue}/comments?per_page=100`);
	if (!comments.some((comment) => string(comment.body).includes(marker))) {
		const url = `https://github.com/${plan.repository}/commit/${commit}`;
		const why = merged
			? ""
			: plan.method === "squash"
				? "; GitHub cannot show a fork PR as merged without a push to its branch"
				: "; GitHub did not mark this PR merged from that push";
		await github.request(`${issue}/comments`, {
			body: { body: `landed as [${commit}](${url}) by quest land${why}.\n\n${marker}` },
		});
	}
	if (!merged) await closeTested(github, plan, entry);
	unlinkSync(path);
	forgetHeads(state, entry.number);
	return `landed ${entry.number} ${commit}`;
}

/** Whether GitHub marks the PR merged within its settling time after the base push. */
async function markedMerged(github: GitHub, entry: Entry): Promise<boolean> {
	for (let attempt = 0; ; attempt++) {
		const data = await github.graphql("query($id: ID!) { node(id: $id) { ... on PullRequest { state } } }", {
			id: entry.id,
		});
		const state = object(data.node).state;
		if (state === "MERGED") return true;
		if (state !== "OPEN" || attempt >= SETTLE_RETRIES) return false;
		await github.pause(500 * 2 ** attempt);
	}
}

/**
 * Close the PR as it was tested: the approved head, or the daemon's own prepared head on it, still
 * queued as it was. A contributor's newer work stays open, and queued, with the landing comment.
 */
async function closeTested(github: GitHub, plan: Plan, entry: Entry): Promise<void> {
	const data = await github.graphql(
		"query($id: ID!) { node(id: $id) { ... on PullRequest { state headRefOid autoMergeRequest { enabledAt } } } }",
		{ id: entry.id },
	);
	const pull = object(data.node);
	const unchanged =
		(pull.headRefOid === entry.head || pull.headRefOid === entry.approved) &&
		pull.autoMergeRequest !== null &&
		object(pull.autoMergeRequest).enabledAt === entry.enabledAt;
	if (pull.state === "OPEN" && unchanged) {
		await github.request(`/repos/${plan.repository}/pulls/${entry.number}`, {
			method: "PATCH",
			body: { state: "closed" },
		});
	}
}

export async function landFallback(
	root: string,
	state: string,
	plan: Plan,
	entry: Entry,
	commit: string,
	parent: string,
	deps: GitHubDependencies,
	token: (workflows: boolean) => Promise<string>,
	read: RemoteRead = readRemote,
): Promise<string | null> {
	// The local chain parent has a different SHA from one GitHub landed, but the same verified tree.
	// Reparent without changing the tested tree so the fallback is strictly a fast-forward, keeping a
	// merge commit's second parent, the PR's head.
	const tree = git(root, ["rev-parse", `${commit}^{tree}`]);
	const message = git(root, ["show", "-s", "--format=%B", commit]);
	const [first, ...rest] = git(root, ["show", "-s", "--format=%P", commit]).split(" ");
	const landed =
		first === parent
			? commit
			: git(root, ["commit-tree", tree, ...[parent, ...rest].flatMap((sha) => ["-p", sha])], {
					input: message,
				});
	save(join(state, "fallback.json"), { plan, entry, commit: landed, parent });
	return finishFallback(root, state, deps, token, read);
}

/**
 * The merge needs workflow write when the commit landing it changes a workflow, or when any commit the PR
 * brings changes one: GitHub refuses an App's merge of a PR whose commits touch workflows, such as a
 * merge of a base that changed one, whether the gate or the author made it.
 */
export function touchesWorkflows(root: string, parent: string, commit: string, base: string, head: string): boolean {
	if (git(root, ["diff", "--name-only", parent, commit, "--", ".github/workflows"]) !== "") return true;
	// `-m` also lists a merge commit's changes against each parent, so a merged-in workflow change counts.
	return git(root, ["log", "-m", "--format=", "--name-only", `${base}..${head}`, "--", ".github/workflows"]) !== "";
}

export type MergeResult =
	{ sha: string } | { reason: "head_moved" | "merge_conflict" | "merge_refused"; detail: string } | null;

/**
 * Retry only GitHub's pending mergeability or base refresh. Any other refusal, such as `method` being
 * disabled or a rule the bot cannot bypass, would refuse every round after a full check, so it ejects.
 * `previous` is the head before the gate pushed its own base merge as `head`, if it did.
 */
export async function mergePinned(
	github: GitHub,
	path: string,
	method: LandMethod,
	head: string,
	previous = head,
): Promise<MergeResult> {
	for (let attempt = 0; ; attempt++) {
		const response = await github.request(`${path}/merge`, {
			method: "PUT",
			body: { merge_method: method, sha: head },
			allow: [403, 405, 409],
		});
		// The client waits out a rate limit; any other 403 is GitHub refusing this PR, which ends its
		// landing rather than retrying.
		const result = object(await response.json());
		if (response.ok && result.merged === true) return { sha: string(result.sha) };
		const pull = object(await (await github.request(path)).json());
		// A lost response or a manual merge is reconciled by rebuilding the remaining queue.
		if (pull.merged === true) return null;
		const detail = `GitHub refused ${path}: ${String(result.message)}`;
		if (pull.state !== "open") return { reason: "merge_refused", detail };
		// Right after the gate's own push, GitHub can still report the pin as the head and refuse the merge
		// for it: a 409, or a 405 when the pin conflicts with the base that push merged. Neither is a writer.
		const current = object(pull.head).sha;
		if (previous !== head && (current === previous || (response.status === 409 && current === head))) {
			if (attempt >= SETTLE_RETRIES) throw new Error(`${detail}; prepared head has not propagated`);
			await github.pause(500 * 2 ** attempt);
			continue;
		}
		if (current !== head) return { reason: "head_moved", detail };
		const conflict = pull.mergeable === false || pull.mergeable_state === "dirty";
		// Once GitHub shows the gate's own merge, it can still call it conflicting from the pin's stale
		// mergeability, in its refusal or in the PR (moq-dev/quest#342). That merge already holds the
		// base it was checked on, so it cannot conflict with it: wait. Only a base that moved since can
		// conflict, and then the retries run out and the next round rebuilds on that base.
		const stale = previous !== head && (conflict || /merge conflict/i.test(String(result.message)));
		if (conflict && !stale) return { reason: "merge_conflict", detail };
		if (stale || pull.mergeable === null || /base branch was modified/i.test(String(result.message))) {
			if (attempt >= SETTLE_RETRIES) throw new Error(`${detail}; mergeability did not settle`);
			await github.pause(500 * 2 ** attempt);
			continue;
		}
		return { reason: "merge_refused", detail };
	}
}

/**
 * What GitHub's commit `sha`, landing a PR with `method`, put on the base: its first parent, and how it
 * differs from the tested `tree` and, for a merge commit, from `head` as its second parent.
 */
export async function landedCommit(
	github: GitHub,
	repository: string,
	method: LandMethod,
	sha: string,
	tree: string,
	head: string | null,
): Promise<{ parent: string | null; faults: string[] }> {
	const commit = object(await (await github.request(`/repos/${repository}/git/commits/${sha}`)).json());
	const parents = Array.isArray(commit.parents) ? commit.parents.map((parent) => string(object(parent).sha)) : [];
	const landed = string(object(commit.tree).sha);
	const faults = [
		landed !== tree && `has tree ${landed}, but the tested one is ${tree}`,
		method === "merge" &&
			(parents.length !== 2 || parents[1] !== head) &&
			`has parents ${parents.join(" ")}, but its second parent must be the landed head ${head}`,
	].filter((fault) => fault !== false);
	return { parent: parents[0] ?? null, faults };
}
