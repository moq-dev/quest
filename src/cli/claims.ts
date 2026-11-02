// Who holds a quest: its claim branch upstream, unless that branch is a merged
// PR's head, or an open PR from a branch of that name in any repository.
// Commands that must not disturb held work look here first, and `quest start`
// records a claim the same way, judging readiness by the upstream tree.
import { execFileSync } from "node:child_process";

import { handedBack, landed } from "../core";
import {
	type GitHubDependencies,
	type Repository,
	type Remote,
	GitHub,
	object,
	readRemote,
	remoteRepository,
	requireRemote,
	string,
} from "./github";
import { type Snapshot, snapshot } from "./tree";

/** An open PR, from any head repository, as the claim checks read it. */
export interface OpenPull {
	number: number;
	url: string;
	branch: string;
	/** The head repository as `owner/repo`, or `null` once a fork is deleted. */
	head: string | null;
	draft: boolean;
	/** Epoch milliseconds. The earliest open PR on a branch holds the claim. */
	created: number;
	/** Epoch milliseconds of the last push, comment, or edit. */
	updated: number;
	/** Its body has a `## Decisions needed` section, so it waits on the maintainer. */
	handedBack: boolean;
}

/** A held quest branch, and the open PR from it if there is one. */
export interface Claim {
	branch: string;
	/** The PR holding the claim: the earliest open one. */
	url: string | null;
	pull: OpenPull | null;
}

export interface ClaimDependencies {
	/** Called only when the remote is on GitHub, so other forges need no token. */
	github(): GitHubDependencies;
	warn(message: string): void;
}

/**
 * Where claims live: the furthest repository up the remote's fork chain that
 * keeps quests, so a contributor's fork claims on the project it came from,
 * while a fork with its own quest tree claims on itself.
 */
export interface Upstream {
	/** The remote's name, or the upstream's URL when that is an ancestor; git reads upstream branches from it. */
	git: string;
	/** The URL the remote pushes to, where a claim branch is pushed. Read from git on first use. */
	readonly push: string;
	github: {
		client: GitHub;
		/** Where PRs open and claims are checked. */
		repository: Repository;
		/** The repository the remote pushes to: `repository` itself, or a fork. */
		head: Repository;
		defaultBranch: string;
		/** Where this checkout's tree sits in the repository: empty at the top level, else a path ending in `/`. */
		prefix: string;
	} | null;
}

/**
 * The upstream of `remote`. On GitHub, it walks from the remote's repository
 * up to each parent whose default branch holds the quest tree's README, and
 * stops at the first parent without one; a failed lookup fails rather than
 * stops the walk. An ancestor is reached with the same URL scheme as the
 * remote. Off GitHub, the remote is its own upstream. The head repository is
 * where the remote pushes, which may be a fork even when it fetches from upstream.
 */
export async function upstream(root: string, remote: Remote, deps: ClaimDependencies): Promise<Upstream> {
	const source = remoteRepository(remote);
	if (source.repository === null)
		return {
			git: remote.name,
			get push() {
				return remote.used().push;
			},
			github: null,
		};

	const client = new GitHub(deps.github());
	const self = await repositoryInfo(client, source.repository);
	// Push somewhere other than the fetched repository, such as a fork, and that is the head; a push
	// URL off GitHub can open no PR, so it falls back to the fetched repository.
	const pushed = remoteRepository(remote, true).repository;
	const head =
		pushed === null || same(pushed, self.repository)
			? self.repository
			: (await repositoryInfo(client, pushed)).repository;
	// The README where this checkout's tree sits, which may be below the top level.
	const prefix = gitOutput(root, ["rev-parse", "--show-prefix"]);
	let up = self;
	while (up.parent !== null && (await has(client, up.parent, `${prefix}quest/README.md`)))
		up = await repositoryInfo(client, up.parent);
	return {
		// Reach an ancestor the way the remote is reached, so the same credentials work.
		git: up === self ? remote.name : /^https:/.test(source.url) ? up.https : up.ssh,
		get push() {
			return remote.used().push;
		},
		github: { client, repository: up.repository, head, defaultBranch: up.defaultBranch, prefix },
	};
}

/** A repository as GitHub names it, its default branch and clone URLs, and its parent when it is a fork. */
async function repositoryInfo(
	client: GitHub,
	named: Repository,
): Promise<{ repository: Repository; defaultBranch: string; https: string; ssh: string; parent: Repository | null }> {
	const info = object(await (await client.request(repositoryPath(named))).json());
	const parent = info.fork === true && info.parent !== undefined && info.parent !== null ? object(info.parent) : null;
	return {
		repository: { owner: string(object(info.owner).login), repo: string(info.name) },
		defaultBranch: string(info.default_branch),
		https: string(info.clone_url),
		ssh: string(info.ssh_url),
		parent: parent === null ? null : { owner: string(object(parent.owner).login), repo: string(parent.name) },
	};
}

/** Whether `repository`'s default branch has `path`. Only a 404 says no; any other failure throws. */
async function has(client: GitHub, repository: Repository, path: string): Promise<boolean> {
	const encoded = path.split("/").map(encodeURIComponent).join("/");
	const response = await client.request(`${repositoryPath(repository)}/contents/${encoded}`, { allow: [404] });
	return response.status !== 404;
}

/** Whether two names are the same repository; GitHub ignores case. */
function same(a: Repository, b: Repository): boolean {
	return a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
}

/** The REST path of a repository. */
export function repositoryPath(repository: Repository): string {
	return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
}

/** The `quest/*` branches on `remote` (a name or URL), with their tips. Plain git, so it works with any forge. */
export function remoteBranches(root: string, remote: string): Map<string, string> {
	return questBranches(listRemote(root, remote, ["refs/heads/quest/*"]));
}

/** The refs on `remote` matching `patterns`, by name, with their tips. */
function listRemote(root: string, remote: string, patterns: string[]): Map<string, string> {
	const refs = new Map<string, string>();
	for (const line of gitOutput(root, ["ls-remote", remote, ...patterns]).split("\n")) {
		if (line === "") continue;
		const [sha, ref] = line.split("\t");
		refs.set(ref, sha);
	}
	return refs;
}

/** The `quest/*` branches among `refs`, by branch name. */
function questBranches(refs: Map<string, string>): Map<string, string> {
	const branches = new Map<string, string>();
	for (const [ref, sha] of refs)
		if (ref.startsWith("refs/heads/quest/")) branches.set(ref.slice("refs/heads/".length), sha);
	return branches;
}

/** Every open PR in `repository`, from any head repository. */
export async function openPullRequests(github: GitHub, repository: Repository): Promise<OpenPull[]> {
	const rows = await github.all(`${repositoryPath(repository)}/pulls?state=open&per_page=100`);
	return rows.map((row) => {
		const head = object(row.head);
		const repo = head.repo === null || head.repo === undefined ? null : object(head.repo);
		return {
			number: Number(row.number),
			url: string(row.html_url),
			branch: string(head.ref),
			head: repo === null ? null : string(repo.full_name),
			draft: row.draft === true,
			created: Date.parse(string(row.created_at)),
			updated: Date.parse(string(row.updated_at)),
			handedBack: typeof row.body === "string" && handedBack(row.body),
		};
	});
}

/** The open PRs from `branch`, earliest first: the first one holds the claim. */
export function pullsFrom(pulls: OpenPull[], branch: string): OpenPull[] {
	return pulls.filter((pull) => pull.branch === branch).sort((a, b) => a.created - b.created || a.number - b.number);
}

/**
 * Which of `branches` someone holds: pushed to `remote` or its upstream, or the
 * head of an open PR in either. Without the remote it warns and checks nothing;
 * off GitHub it checks branches only.
 */
export async function claims(
	root: string,
	remote: string,
	branches: string[],
	deps: ClaimDependencies,
): Promise<Claim[]> {
	const up = await reach(root, remote, deps);
	return up === null ? [] : (await held(root, up, branches)).claims;
}

/**
 * The upstream of `remote` for reading claims, warning when off GitHub that
 * only branches count. Without the remote it warns and returns `null`.
 */
export async function reach(root: string, name: string, deps: ClaimDependencies): Promise<Upstream | null> {
	const remote = readRemote(root, name);
	if (remote === null) {
		deps.warn(`no ${name} remote, so claims were not checked`);
		return null;
	}
	const up = await upstream(root, remote, deps);
	if (up.github === null) deps.warn(`${name} is not on GitHub, so only its branches were checked for claims`);
	return up;
}

/** Which branches someone holds, and which landed branches a new claim replaces. */
export interface Holdings {
	/** Sorted by branch. */
	claims: Claim[];
	/**
	 * Branches where the remote pushes whose tip is the head of a merged PR,
	 * by that tip. Their work landed, so they hold nothing and a claim may replace them.
	 */
	landed: Map<string, string>;
}

/**
 * Which of `branches` someone holds. `tips` are the upstream's `quest/*`
 * branches, when already read. A fork's own branches and PRs count too,
 * so a claim pushed there is seen before its PR opens. On GitHub, a branch
 * whose tip is a merged PR's head holds nothing: its work landed. A closed,
 * unmerged PR's branch still holds its quest, since that work may be wanted back.
 */
export async function held(
	root: string,
	up: Upstream,
	branches: string[],
	tips: Map<string, string> = remoteBranches(root, up.git),
): Promise<Holdings> {
	// Where claim branches live: upstream, then the fork the remote pushes to.
	const sources: { repository: Repository | null; tips: Map<string, string> }[] = [
		{ repository: up.github?.repository ?? null, tips },
	];
	const pulls: OpenPull[] = [];
	if (up.github) {
		pulls.push(...(await openPullRequests(up.github.client, up.github.repository)));
		const { head, repository } = up.github;
		if (head.owner !== repository.owner || head.repo !== repository.repo) {
			sources.push({ repository: head, tips: remoteBranches(root, up.push) });
			pulls.push(...(await openPullRequests(up.github.client, head)));
		}
	}
	const pushTo = sources[sources.length - 1];
	const landed = new Map<string, string>();
	const holds = async (branch: string): Promise<Claim | null> => {
		const pull = pullsFrom(pulls, branch)[0] ?? null;
		if (pull !== null) return { branch, url: pull.url, pull };
		let holding = false;
		for (const source of sources) {
			const tip = source.tips.get(branch);
			if (tip === undefined) continue;
			if (
				up.github &&
				source.repository &&
				(await mergedPull(up.github.client, up.github.repository, source.repository, branch, tip)) !== null
			) {
				if (source === pushTo) landed.set(branch, tip);
			} else {
				holding = true;
			}
		}
		return holding ? { branch, url: null, pull: null } : null;
	};
	const found = await Promise.all([...new Set(branches)].sort().map(holds));
	return { claims: found.filter((claim): claim is Claim => claim !== null), landed };
}

/** The URL of the PR from `head`'s `branch` that merged into `repository` with `tip` as its head, or `null`. */
export async function mergedPull(
	github: GitHub,
	repository: Repository,
	head: Repository,
	branch: string,
	tip: string,
): Promise<string | null> {
	const query = new URLSearchParams({ state: "closed", head: `${head.owner}:${branch}`, per_page: "100" });
	const rows = await github.all(`${repositoryPath(repository)}/pulls?${query}`);
	const pull = landed(
		tip,
		rows.map((row) => ({
			head: string(object(row.head).sha),
			merged: typeof row.merged_at === "string",
			url: string(row.html_url),
		})),
	);
	return pull?.url ?? null;
}

/** Where a claim lands: the remote, its upstream, and the upstream default branch's tip and quest tree. */
export interface Target extends UpstreamRefs {
	remote: string;
	up: Upstream;
	tree: Snapshot;
}

/** The target for claims pushed to `remote`, read from the fetched upstream default branch. */
export async function target(root: string, remote: string, deps: ClaimDependencies): Promise<Target> {
	const up = await upstream(root, requireRemote(root, remote), deps);
	const refs = upstreamRefs(root, up.git);
	return { remote, up, ...refs, tree: snapshot(root, refs.base) };
}

/** What the upstream holds, read with one `ls-remote`. */
export interface UpstreamRefs {
	/** The default branch's tip, fetched so it can be read and built on. */
	base: string;
	/** The `quest/*` branches, with their tips. */
	branches: Map<string, string>;
}

/** The refs of `remote` (a name or URL) that claims read. */
export function upstreamRefs(root: string, remote: string): UpstreamRefs {
	const refs = listRemote(root, remote, ["HEAD", "refs/heads/quest/*"]);
	const base = refs.get("HEAD");
	if (!base) throw new Error(`${remote} has no default branch`);
	ensure(root, remote, base);
	return { base, branches: questBranches(refs) };
}

/** Make `sha` from `remote` available locally. */
export function ensure(root: string, remote: string, sha: string): void {
	try {
		gitOutput(root, ["cat-file", "-e", `${sha}^{commit}`]);
	} catch {
		gitOutput(root, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, sha]);
	}
}

/** Run git in `root` and return its trimmed stdout; an unset config key is empty rather than an error. */
export function gitOutput(root: string, args: string[]): string {
	try {
		return execFileSync("git", ["-C", root, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		}).trim();
	} catch (error) {
		if (args[0] === "config" && (error as { status?: number }).status === 1) return "";
		const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
		throw new Error(`git ${args[0]} failed${stderr ? `: ${stderr}` : ""}`);
	}
}
