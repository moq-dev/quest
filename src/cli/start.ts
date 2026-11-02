// `quest start`: claim a ready quest by pushing an empty claim commit to its
// branch and opening a draft PR from it right away, and release that claim
// while nothing but the claim commit is on the branch.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { questBranch } from "../core";
import {
	type ClaimDependencies,
	type OpenPull,
	type Target,
	type Upstream,
	ensure,
	gitOutput,
	held,
	mergedPull,
	openPullRequests,
	pullsFrom,
	remoteBranches,
	repositoryPath,
	upstream,
	upstreamRefs,
} from "./claims";
import { object, requireRemote, string } from "./github";

/** Someone else holds the quest, or the claim cannot be released; distinct from a failure. */
export class Refusal extends Error {}

export interface Started {
	branch: string;
	/** The claim commit, also the local branch's tip when that branch was free. */
	sha: string;
	/** The draft PR; `null` off GitHub. */
	url: string | null;
}

/** The refusal for a quest the upstream default branch lacks: finished upstream, or not merged yet. */
export function notUpstream(path: string): Refusal {
	return new Refusal(`${path} is not on the upstream default branch; update your checkout`);
}

/**
 * Claim `path`, a quest ready in the target's upstream tree. Throws `Refusal`
 * when someone else holds it or the upstream tree lacks it. A branch left by
 * a merged PR holds nothing, so the claim replaces it with a lease on its tip.
 */
export async function startQuest(
	root: string,
	{ remote, up, base, branches, tree }: Target,
	path: string,
	title: string,
	deps: ClaimDependencies,
): Promise<Started> {
	const branch = questBranch(path);
	if (!tree.docs.some((doc) => doc.path === path)) throw notUpstream(path);
	const { claims, landed } = await held(root, up, [branch], branches);
	const [claim] = claims;
	if (claim) throw new Refusal(`${path} is held by ${describe(claim.branch, claim.pull, Date.now())}`);
	// A nonce keeps two claimers on the same base, identity, and second from building the same commit.
	const nonce = randomBytes(8).toString("hex");
	const sha = gitOutput(root, [
		"commit-tree",
		`${base}^{tree}`,
		"-p",
		base,
		"-m",
		`chore(quest): claim ${path}`,
		"-m",
		`Quest-Claim: ${nonce}`,
	]);
	// The lease expects the landed tip, or no branch at all.
	try {
		push(
			root,
			remote,
			[`--force-with-lease=refs/heads/${branch}:${landed.get(branch) ?? ""}`, `${sha}:refs/heads/${branch}`],
			`someone pushed ${branch} first`,
		);
	} catch (error) {
		if (error instanceof Refusal) throw error;
		const message = await obstructed(root, up, remote, path, branch);
		throw message === null ? error : new Refusal(message);
	}

	let url: string | null = null;
	if (up.github === null) {
		deps.warn(`${remote} is not on GitHub, so the claim branch was pushed without a PR`);
	} else {
		url = await openDraft(root, up, remote, path, title, branch, sha);
	}

	checkout(root, branch, sha, deps.warn);
	return { branch, sha, url };
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
		listing = gitOutput(root, ["ls-remote", up.push, ...patterns, `refs/heads/${branch}/*`]);
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
 * Put the checkout on the claim, so work lands on the quest's branch. The claim
 * changes no files, so this carries uncommitted changes along. Whatever cannot
 * be done safely is left as a warning saying what to run.
 */
function checkout(root: string, branch: string, sha: string, warn: (message: string) => void): void {
	const ref = `refs/heads/${branch}`;
	let current = "";
	try {
		current = gitOutput(root, ["symbolic-ref", "-q", "HEAD"]);
	} catch {
		// Detached HEAD.
	}
	if (current === ref) {
		// Already on the quest's branch, as after `git worktree add -b`: catch it up to the claim.
		if (!succeeds(root, ["merge", "--ff-only", "--quiet", sha])) {
			warn(`${branch} has diverged from the claim commit; merge ${sha} into it before pushing`);
		}
	} else if (succeeds(root, ["rev-parse", "--verify", "--quiet", ref])) {
		warn(`local branch ${branch} already exists; merge the claim commit ${sha} into it before pushing`);
	} else if (!succeeds(root, ["switch", "--quiet", "-c", branch, sha])) {
		gitOutput(root, ["update-ref", ref, sha, ""]);
		warn(`created ${branch} but could not switch to it; run git switch ${branch}`);
	}
}

/** Open the draft PR, then keep it only if it is the earliest open PR on the branch. */
async function openDraft(
	root: string,
	up: Upstream,
	remote: string,
	path: string,
	title: string,
	branch: string,
	sha: string,
): Promise<string> {
	const github = up.github!;
	const { owner, repo } = github.repository;
	const fork = github.head.owner !== owner || github.head.repo !== repo;
	// The quest's path in the repository, which differs from `path` when the tree sits below the top level.
	const file = encodeURI(github.prefix + path);
	let created: OpenPull;
	try {
		const response = await github.client.request(`${repositoryPath(github.repository)}/pulls`, {
			body: {
				title: title.replace(/^\[(XS|S|M|L|XL)\] /, ""),
				head: fork ? `${github.head.owner}:${branch}` : branch,
				base: github.defaultBranch,
				draft: true,
				body: `Claims [${path}](https://github.com/${owner}/${repo}/blob/${github.defaultBranch}/${file}).`,
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
	const { base } = upstreamRefs(root, up.git);
	const parents = gitOutput(root, ["rev-list", "--parents", "-n", "1", tip]).split(" ").slice(1);
	// Only the claim itself: one empty commit straight on the default branch, not one following pushed work.
	const claim =
		parents.length === 1 &&
		gitOutput(root, ["rev-parse", `${tip}^{tree}`]) === gitOutput(root, ["rev-parse", `${parents[0]}^{tree}`]) &&
		succeeds(root, ["merge-base", "--is-ancestor", parents[0], base]);
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
	const state = !pull.draft ? "ready for review" : pull.handedBack ? "draft, decisions needed" : "draft";
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
		execFileSync("git", ["-C", root, "push", "--porcelain", remote, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
	} catch (error) {
		const { stdout, stderr } = error as { stdout?: string; stderr?: string };
		// --porcelain reports each ref on stdout: `!` and `[rejected]` for a ref that is not as expected.
		if (/^!\t.*\t\[rejected\]/m.test(stdout ?? "")) throw new Refusal(rejected);
		// stderr may hold only the remote's chatter, so add each refused ref's reason from stdout.
		const refused = (stdout ?? "").split("\n").filter((line) => line.startsWith("!"));
		const detail = [(stderr ?? "").trim(), ...refused].filter((line) => line !== "").join("\n");
		throw new Error(`git push to ${remote} failed: ${detail}`);
	}
}

/** Whether a git command exits zero. */
function succeeds(root: string, args: string[]): boolean {
	try {
		gitOutput(root, args);
		return true;
	} catch {
		return false;
	}
}
