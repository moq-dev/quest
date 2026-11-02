// Trusted preparation and publication. Sandboxes and fixers never receive this repository or state.
import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitAuthentication } from "./land-git";
import { MERGE_LABEL } from "../core";
import { GitHub, type GitHubDependencies, type Repository, object, string } from "./github";
import {
	baseRemote,
	contains,
	eject,
	ejection,
	git,
	readRemote,
	type RemoteRead,
	mergeBase,
	resolveQueue,
	tryGit,
	type Entry,
	type Plan,
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
	base: string | undefined,
	deps: GitHubDependencies,
): Promise<Plan> {
	const plan = await resolveQueue(repository, base, deps, (entry) => isPrepared(root, state, entry));
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

/** Fresh tokens go only to git over HTTPS, with no inherited credential helper or global config. */
export async function push(
	root: string,
	remote: string,
	from: string,
	to: string,
	ref: string,
	token: (workflows: boolean) => Promise<string>,
	/** What `ref` must be before the push; empty when it must not exist yet. */
	lease = from,
) {
	// A push that replaces another head than the one it builds on can change workflows relative to either.
	const workflows = [...new Set([from, lease])].some(
		(old) => old !== "" && git(root, ["diff", "--name-only", old, to, "--", ".github/workflows"]) !== "",
	);
	const credential = await token(workflows);
	return tryGit(root, ["push", "--quiet", remote, `${to}:${ref}`, `--force-with-lease=${ref}:${lease}`], {
		env: gitAuthentication(credential),
	});
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
	const result = await push(root, remote, entry.head, prepared.head, ref, token);
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
	const remote = baseRemote(plan);
	await read(root, ["fetch", "--quiet", remote, plan.base.ref]);
	if (!contains(root, commit, "FETCH_HEAD")) {
		if (git(root, ["rev-parse", "FETCH_HEAD"]) !== parent) {
			unlinkSync(path);
			return null;
		}
		const [owner, repo] = plan.repository.split("/");
		const fresh = await resolvePreparedQueue(root, state, { owner, repo }, plan.base.ref, deps);
		const queued = fresh.queue.find(
			(now) =>
				now.number === entry.number && now.approved === entry.approved && now.enabledAt === entry.enabledAt,
		);
		if (!queued) {
			unlinkSync(path);
			return null;
		}
		if (fresh.base.sha !== parent) throw new Error("fallback base is not yet reflected in the queue; retrying");
		const result = await push(root, remote, parent, commit, `refs/heads/${plan.base.ref}`, token);
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
	const issue = `/repos/${plan.repository}/issues/${entry.number}`;
	const marker = `<!-- quest land: landed ${commit} -->`;
	const comments = await github.all(`${issue}/comments?per_page=100`);
	if (!comments.some((comment) => string(comment.body).includes(marker))) {
		const url = `https://github.com/${plan.repository}/commit/${commit}`;
		await github.request(`${issue}/comments`, {
			body: {
				body: `landed as [${commit}](${url}) by quest land; GitHub cannot show a fork PR as merged without a push to its branch.\n\n${marker}`,
			},
		});
	}
	const data = await github.graphql(
		"query($id: ID!) { node(id: $id) { ... on PullRequest { state headRefOid autoMergeRequest { enabledAt } } } }",
		{ id: entry.id },
	);
	const pull = object(data.node);
	// Close only the PR as it was tested: the approved head, or the daemon's own prepared head on it,
	// still queued as it was. A contributor's newer work stays open, and queued, with the comment above.
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
	if (pull.state !== "OPEN" || unchanged) {
		await github.request(`${issue}/labels/${encodeURIComponent(MERGE_LABEL)}`, {
			method: "DELETE",
			allow: [404],
		});
	}
	unlinkSync(path);
	forgetHeads(state, entry.number);
	return `landed ${entry.number} ${commit}`;
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
	// The local chain parent has a different SHA from an API squash, but the same verified tree.
	// Reparent without changing the tested tree so the fallback is strictly a fast-forward.
	const tree = git(root, ["rev-parse", `${commit}^{tree}`]);
	const message = git(root, ["show", "-s", "--format=%B", commit]);
	const landed =
		git(root, ["show", "-s", "--format=%P", commit]) === parent
			? commit
			: git(root, ["commit-tree", tree, "-p", parent], { input: message });
	save(join(state, "fallback.json"), { plan, entry, commit: landed, parent });
	return finishFallback(root, state, deps, token, read);
}
