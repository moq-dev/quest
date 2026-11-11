// `quest start`: claim a ready quest by pushing an empty claim commit to its
// branch and opening a draft PR from it right away, and release that claim
// while nothing but the claim commit is on the branch.
import { randomBytes } from "node:crypto";

import { branchEpic, epicBranch, epicOf, questBranch } from "../core";
import { parent } from "../core/path";
import {
	type ClaimDependencies,
	type OpenPull,
	type Target,
	type Upstream,
	ensure,
	held,
	mergedPull,
	openPullRequests,
	pullsFrom,
	remoteBranches,
	repositoryPath,
	same,
	upstream,
	upstreamRefs,
} from "./claims";
import { epicView } from "./epics";
import { GitError, git } from "./git";
import { object, requireRemote, string } from "./github";
import { type Snapshot } from "./tree";

/** Someone else holds the quest, or the claim cannot be released; distinct from a failure. */
export class Refusal extends Error {}

/** A push the remote rejected because its ref was not what the lease expected: someone pushed first. */
class Rejected extends Refusal {}

export interface Started {
	branch: string;
	/** The claim commit, also the local branch's tip when that branch was free. */
	sha: string;
	/** The draft PR; `null` off GitHub. */
	url: string | null;
}

/** The refusal for a quest its base lacks: finished there, or not merged yet. */
export function notUpstream(path: string): Refusal {
	const where =
		epicOf(path) === null ? "the upstream default branch" : "the upstream default branch or its epic's branch";
	return new Refusal(`${path} is not on ${where}; update your checkout`);
}

/** The branch of the epic whose quest is claimed, as the upstream holds it. */
export interface EpicBase {
	/** The epic's README. */
	readme: string;
	branch: string;
	/** Its tip, fetched; `null` when the branch is missing, landed by a merged PR, or holds nothing beyond the default branch. */
	tip: string | null;
	/** The tip a missing branch's push leases: a landed or empty one, or "" for none. */
	lease: string;
	/** Whether an open PR is from the branch. */
	open: boolean;
	/** Whether the quest's readiness was read from a change the default branch made after the branch was cut. */
	behind: boolean;
}

/** Where a quest's claim builds: the tree its readiness is read from, and its epic's branch, if any. */
export interface Base {
	tree: Snapshot;
	epic: EpicBase | null;
}

/**
 * The base of `path`'s claim. A quest directly under a milestone, and an
 * epic's README, build on the default branch. Any other quest builds on its
 * epic's branch, read as it will be once the default branch is next merged
 * into it, or on the default branch when that branch is missing, landed, or
 * holds nothing beyond it.
 */
export async function claimBase(root: string, at: Target, path: string, deps: ClaimDependencies): Promise<Base> {
	// An epic's README is read from its epic's branch, where its children finish, but builds on the default branch.
	const own = branchEpic(questBranch(path)) === path;
	const readme = own ? path : epicOf(path);
	if (readme === null) return { tree: at.main.snapshot, epic: null };
	const branch = questBranch(readme);
	const tip = at.branches.get(branch);
	const missing = (lease: string): Base => ({
		tree: at.main.snapshot,
		epic: own ? null : { readme, branch, tip: null, lease, open: false, behind: false },
	});
	if (tip === undefined) return missing("");
	const { claims, landed } = await held(root, at.up, [branch], at.branches);
	if (claims.length === 0) return missing(landed.get(branch) ?? "");
	ensure(root, at.up.git, tip);
	// GitHub opens no PR from a branch with nothing beyond its base, so the claim stacks the epic's commit on it.
	if (succeeds(root, ["merge-base", "--is-ancestor", tip, at.base])) return missing(tip);
	const tree = epicView(root, at.main, tip, deps.warn);
	return {
		tree,
		epic: own
			? null
			: { readme, branch, tip, lease: tip, open: claims[0].pull !== null, behind: tree.behind(path) },
	};
}

/**
 * Claim `path`, a quest ready in its base's tree, on that base: the default
 * branch, or its epic's branch, which is created from the default branch with
 * a draft PR into it when missing. Throws `Refusal` when someone else holds the
 * quest or its base lacks it. A branch left by a merged PR holds nothing, so the
 * claim replaces it with a lease on its tip.
 */
export async function startQuest(
	root: string,
	at: Target,
	{ tree, epic }: Base,
	path: string,
	title: string,
	deps: ClaimDependencies,
): Promise<Started> {
	const { remote, up, branches } = at;
	const branch = questBranch(path);
	if (!tree.docs.some((doc) => doc.path === path)) throw notUpstream(path);
	const { claims, landed } = await held(root, up, [branch], branches);
	const [claim] = claims;
	if (claim) throw new Refusal(`${path} is held by ${describe(claim.branch, claim.pull, Date.now())}`);
	const parent = epic === null ? at.base : await openEpic(root, at, epic, tree, path);
	// The claim carries the default branch's change its readiness was read from.
	const parents = epic?.behind ? [parent, at.base] : [parent];
	if (epic?.behind && mergedTree(root, parent, at.base) === null) {
		throw new Refusal(
			`${path} is ready only with changes the default branch made after ${epic.branch} was cut, and ` +
				`merging the default branch into ${epic.branch} conflicts; merge it there first`,
		);
	}
	const sha = claimCommit(root, parents, `chore(quest): claim ${path}`);
	// The lease expects the landed tip, or no branch at all.
	await pushBranch(root, at, path, branch, sha, landed.get(branch) ?? "");

	let url: string | null = null;
	if (up.github === null) {
		deps.warn(`${remote} is not on GitHub, so the claim branch was pushed without a PR`);
	} else {
		url = await openDraft(root, up, remote, path, title, branch, sha, epic?.branch ?? up.github.defaultBranch);
	}

	checkout(root, branch, sha, deps.warn);
	return { branch, sha, url };
}

/**
 * A commit on `parents` with no change of its own: one parent's tree, or a
 * clean merge of two. A nonce keeps two claimers on the same parents,
 * identity, and second apart.
 */
function claimCommit(root: string, parents: string[], subject: string): string {
	const nonce = randomBytes(8).toString("hex");
	const tree = parents.length === 1 ? `${parents[0]}^{tree}` : mergedTree(root, parents[0], parents[1]);
	if (tree === null) throw new Error(`${parents.join(" and ")} do not merge cleanly`);
	const links = parents.flatMap((parent) => ["-p", parent]);
	return git(root, ["commit-tree", tree, ...links, "-m", subject, "-m", `Quest-Claim: ${nonce}`]);
}

/** The tree of merging `a` and `b`, or `null` when they conflict. */
function mergedTree(root: string, a: string, b: string): string | null {
	try {
		return git(root, ["merge-tree", "--write-tree", a, b]).split("\n")[0];
	} catch (error) {
		if (error instanceof GitError && error.status === 1) return null;
		throw error;
	}
}

/**
 * Push `sha` to `branch` on the target's remote, leasing `lease`. A rejected
 * push is a `Refusal` that someone pushed first; one that a branch in the way
 * refused is a `Refusal` naming it, for claiming `path`.
 */
async function pushBranch(
	root: string,
	{ remote, up }: Target,
	path: string,
	branch: string,
	sha: string,
	lease: string,
): Promise<void> {
	try {
		push(
			root,
			remote,
			[`--force-with-lease=refs/heads/${branch}:${lease}`, `${sha}:refs/heads/${branch}`],
			`someone pushed ${branch} first`,
		);
	} catch (error) {
		if (error instanceof Refusal) throw error;
		const message = await obstructed(root, up, remote, path, branch);
		throw message === null ? error : new Refusal(message);
	}
}

/**
 * The tip of `epic`'s branch, which the claim on `path` builds on: created
 * from the default branch when missing, or the one another claim in the epic
 * created first, with a draft PR into the default branch opened when none is.
 * A fork cannot push the upstream's branches, so it refuses to create one.
 */
async function openEpic(root: string, at: Target, epic: EpicBase, tree: Snapshot, path: string): Promise<string> {
	const { up } = at;
	let tip = epic.tip;
	if (tip === null) {
		const github = up.github;
		if (github !== null && !same(github.head, github.repository)) {
			throw new Refusal(
				`${path} is in the epic ${epic.readme}, whose branch ${epic.branch} on ` +
					`${github.repository.owner}/${github.repository.repo} is missing or holds nothing beyond ` +
					`${github.defaultBranch}; a fork cannot create it, so a maintainer ` +
					"starts a quest in the epic first",
			);
		}
		const sha = claimCommit(root, [at.base], `chore(quest): open epic ${epic.readme}`);
		try {
			await pushBranch(root, at, path, epic.branch, sha, epic.lease);
			tip = sha;
		} catch (error) {
			if (!(error instanceof Rejected)) throw error;
			// Another claim in the epic created the branch first: build on it.
			tip = remoteBranches(root, up.git).get(epic.branch) ?? null;
			if (tip === null) throw error;
			ensure(root, up.git, tip);
		}
	}
	if (!epic.open && up.github !== null) {
		const doc = tree.docs.find((d) => d.path === epic.readme);
		await openEpicPull(up, epic, doc?.title?.text ?? epic.readme);
	}
	return tip;
}

/**
 * Open the draft PR that lands `epic`'s branch on the default branch. GitHub
 * refuses a second open PR between the same branches, so a refusal is fine
 * while another claim's PR is open.
 */
async function openEpicPull(up: Upstream, epic: EpicBase, title: string): Promise<void> {
	const github = up.github!;
	const { owner, repo } = github.repository;
	const file = encodeURI(github.prefix + epic.readme);
	const main = github.defaultBranch;
	const body =
		`Lands the epic [${epic.readme}](https://github.com/${owner}/${repo}/blob/${main}/${file}) on \`${main}\` ` +
		"as one PR. Its quests' PRs merge into this branch first; the README's own work comes last.\n\n" +
		`## Waiting\n\n- ${parent(epic.readme)}: its quests merge into this branch first; this PR lands once none remain.\n`;
	const response = await github.client.request(`${repositoryPath(github.repository)}/pulls`, {
		body: { title: title.replace(/^\[(XS|S|M|L|XL)\] /, ""), head: epic.branch, base: main, draft: true, body },
		allow: [422],
	});
	if (response.status !== 422) return;
	const open = pullsFrom(await openPullRequests(github.client, github.repository), epic.branch);
	if (open.length === 0) throw new Error(`GitHub refused the PR for ${epic.branch}: ${await response.text()}`);
}

/**
 * Why `remote` refused `branch`, when a branch there is in its way: git cannot hold a branch whose
 * name is another's directory, as `quest/m1/epic` is for `quest/m1/epic/one`. Each such branch is
 * named, with whether it is a merged PR's head, and left alone. `null` when nothing is in the way.
 */
async function obstructed(
	root: string,
	up: Upstream,
	remote: string,
	path: string,
	branch: string,
): Promise<string | null> {
	const parts = branch.split("/");
	const patterns = parts.slice(1).map((_, i) => `refs/heads/${parts.slice(0, i + 1).join("/")}`);
	let listing: string;
	try {
		listing = git(root, ["ls-remote", up.push, ...patterns, `refs/heads/${branch}/*`]);
	} catch {
		return null;
	}
	const found = listing
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => {
			const [tip, ref] = line.split("\t");
			return { tip, name: ref.replace(/^refs\/heads\//, "") };
		})
		// ls-remote matches patterns against the end of a ref, so keep only the exact ancestors and descendants.
		.filter(({ name }) => branch.startsWith(`${name}/`) || name.startsWith(`${branch}/`));
	if (found.length === 0) return null;
	const github = up.github;
	const states = await Promise.all(
		found.map(async ({ tip, name }) => {
			if (github === null) return `- ${name}: whether it is a merged PR's head is unknown off GitHub`;
			const url = await mergedPull(github.client, github.repository, github.head, name, tip);
			return `- ${name}: ${url === null ? "not a merged PR's head" : `the head of ${url}, which merged`}`;
		}),
	);
	return [
		`${path} cannot be claimed: git cannot hold ${branch} on ${remote} beside a branch named after its directory or inside it:`,
		...states,
		"Stop and report this; do not delete or rename a branch in the way.",
	].join("\n");
}

/**
 * Put the checkout on the claim, so work lands on the quest's branch, carrying
 * uncommitted changes along where the claim's base allows. Whatever cannot be
 * done safely is left as a warning saying what to run.
 */
function checkout(root: string, branch: string, sha: string, warn: (message: string) => void): void {
	const ref = `refs/heads/${branch}`;
	let current = "";
	try {
		current = git(root, ["symbolic-ref", "-q", "HEAD"]);
	} catch {
		// Detached HEAD.
	}
	if (current === ref) {
		// Already on the quest's branch, as after `git worktree add -b`: catch it up to the claim.
		if (!succeeds(root, ["merge", "--ff-only", "--quiet", sha])) {
			warn(`${branch} has diverged from the claim commit; merge ${sha} into it before pushing`);
		}
	} else if (succeeds(root, ["rev-parse", "--verify", "--quiet", ref])) {
		warn(
			`claimed, but local branch ${branch} already exists from an earlier attempt; ` +
				`switch to it, merge the claim commit ${sha} into it, and resume that work before pushing`,
		);
	} else if (!succeeds(root, ["switch", "--quiet", "-c", branch, sha])) {
		git(root, ["update-ref", ref, sha, ""]);
		warn(`created ${branch} but could not switch to it; run git switch ${branch}`);
	}
}

/** Open the draft PR into `base`, then keep it only if it is the earliest open PR on the branch. */
async function openDraft(
	root: string,
	up: Upstream,
	remote: string,
	path: string,
	title: string,
	branch: string,
	sha: string,
	base: string,
): Promise<string> {
	const github = up.github!;
	const { owner, repo } = github.repository;
	const fork = github.head.owner !== owner || github.head.repo !== repo;
	// The quest's path in the repository, which differs from `path` when the tree sits below the top level.
	const file = encodeURI(github.prefix + path);
	const body = `Claims [${path}](https://github.com/${owner}/${repo}/blob/${base}/${file}).`;
	let created: OpenPull;
	try {
		const response = await github.client.request(`${repositoryPath(github.repository)}/pulls`, {
			body: {
				title: title.replace(/^\[(XS|S|M|L|XL)\] /, ""),
				head: fork ? `${github.head.owner}:${branch}` : branch,
				base,
				draft: true,
				body,
			},
		});
		const row = object(await response.json());
		created = {
			number: Number(row.number),
			url: string(row.html_url),
			branch,
			head: `${github.head.owner}/${github.head.repo}`,
			draft: true,
			created: Date.parse(string(row.created_at)),
			updated: Date.parse(string(row.created_at)),
			handedBack: false,
			body,
		};
	} catch (error) {
		// Without its PR the claim is invisible on GitHub, so take the branch back.
		deleteBranch(root, remote, branch, sha);
		throw error;
	}

	// Two claimers on different repositories, such as forks, both push; the earliest PR wins.
	const open = pullsFrom(await openPullRequests(github.client, github.repository), branch);
	const first = pullsFrom([...open.filter((pull) => pull.number !== created.number), created], branch)[0];
	if (first.number !== created.number) {
		deleteBranch(root, remote, branch, sha);
		await close(up, created.number);
		throw new Refusal(`${first.url} claimed ${path} first; closed ${created.url}`);
	}
	return created.url;
}

export interface Released {
	branch: string;
	/** The PRs closed with it. */
	closed: string[];
}

/**
 * Release the claim on `path`: delete its branch on `remote` with a lease on
 * the claim commit, then close its open PR. Refuses once the branch has work on it.
 */
export async function releaseQuest(
	root: string,
	path: string,
	remote: string,
	deps: ClaimDependencies,
): Promise<Released> {
	const branch = questBranch(path);
	const up = await upstream(root, requireRemote(root, remote), deps);
	const tip = remoteBranches(root, up.push).get(branch);
	if (!tip) throw new Error(`${remote} has no branch ${branch} to release`);
	ensure(root, up.push, tip);
	const { base, branches } = upstreamRefs(root, up.git);
	const epic = epicBranch(path);
	const epicTip = epic === null ? undefined : branches.get(epic);
	if (epicTip !== undefined) ensure(root, up.git, epicTip);
	const parents = git(root, ["rev-list", "--parents", "-n", "1", tip]).split(" ").slice(1);
	// Only the claim itself, not one following pushed work: one empty commit straight on the default branch or
	// its epic's branch, or a clean merge of the epic's branch and the default branch.
	const on = (commit: string, branch: string | undefined) =>
		branch !== undefined && succeeds(root, ["merge-base", "--is-ancestor", commit, branch]);
	const treeOf = (commit: string) => git(root, ["rev-parse", `${commit}^{tree}`]);
	const claim =
		parents.length === 1
			? treeOf(tip) === treeOf(parents[0]) && (on(parents[0], base) || on(parents[0], epicTip))
			: parents.length === 2 &&
				on(parents[0], epicTip) &&
				on(parents[1], base) &&
				treeOf(tip) === mergedTree(root, parents[0], parents[1]);
	if (!claim) {
		throw new Refusal(
			`${branch} on ${remote} has work beyond its empty claim commit; close its PR yourself to abandon that work`,
		);
	}

	const pulls: OpenPull[] = [];
	if (up.github) {
		const head = `${up.github.head.owner}/${up.github.head.repo}`.toLowerCase();
		const open = await openPullRequests(up.github.client, up.github.repository);
		pulls.push(...pullsFrom(open, branch).filter((pull) => pull.head?.toLowerCase() === head));
	}
	// Deleting first means the lease decides: a push since the check keeps both the branch and its PR.
	deleteBranch(root, remote, branch, tip);
	for (const pull of pulls) await close(up, pull.number);
	return { branch, closed: pulls.map((pull) => pull.url) };
}

/** How long ago `time` was, roughly: just now, minutes, hours, then days. */
export function ago(now: number, time: number): string {
	const minutes = Math.max(0, Math.round((now - time) / 60_000));
	if (minutes === 0) return "just now";
	const [count, unit] =
		minutes < 60
			? [minutes, "minute"]
			: minutes < 48 * 60
				? [Math.round(minutes / 60), "hour"]
				: [Math.round(minutes / 1440), "day"];
	return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/** A claim for a person deciding whether to wait, take it over, or pick other work. */
export function describe(branch: string, pull: OpenPull | null, now: number): string {
	if (pull === null) return `branch ${branch}, with no open PR`;
	// A draft without the hand-back heading is still its starter's; the others wait on the maintainer.
	const state = !pull.draft ? "ready for review" : pull.handedBack ? "draft, waiting" : "draft";
	return `${pull.url} (${state}, last active ${ago(now, pull.updated)})`;
}

/** Close a PR on the upstream repository. */
async function close(up: Upstream, number: number): Promise<void> {
	await up.github!.client.request(`${repositoryPath(up.github!.repository)}/pulls/${number}`, {
		method: "PATCH",
		body: { state: "closed" },
	});
}

/** Delete `branch` on `remote` only while its tip is still `sha`. */
function deleteBranch(root: string, remote: string, branch: string, sha: string): void {
	push(
		root,
		remote,
		[`--force-with-lease=refs/heads/${branch}:${sha}`, `:refs/heads/${branch}`],
		`${branch} moved on ${remote}, so it was kept`,
	);
}

/**
 * Push, forcing only where a lease in `args` allows. A rejection, which means the remote ref is not what
 * this push expects, is a `Refusal` with `rejected`; anything else fails.
 */
function push(root: string, remote: string, args: string[], rejected: string): void {
	try {
		git(root, ["push", "--porcelain", remote, ...args]);
	} catch (error) {
		if (!(error instanceof GitError)) throw error;
		const { stdout, stderr } = error;
		// --porcelain reports each ref on stdout: `!` and `[rejected]` for a ref that is not as expected.
		if (/^!\t.*\t\[rejected\]/m.test(stdout)) throw new Rejected(rejected);
		// stderr may hold only the remote's chatter, so add each refused ref's reason from stdout.
		const refused = stdout.split("\n").filter((line) => line.startsWith("!"));
		const detail = [stderr.trim(), ...refused].filter((line) => line !== "").join("\n");
		throw new Error(`git push to ${remote} failed: ${detail}`);
	}
}

/** Whether a git command exits zero. */
function succeeds(root: string, args: string[]): boolean {
	try {
		git(root, args);
		return true;
	} catch {
		return false;
	}
}
