// Who holds a quest on GitHub: its claim branch upstream or in the head fork, unless that branch is a
// merged PR's head, or the earliest open PR from a branch of that name in either.
import { handedBack, landed } from "../core";
import { type GitHub, type Repository, object, repositoryPath, string } from "./client";

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
	/** Its body has a `## Waiting` section, so it waits on the maintainer. */
	handedBack: boolean;
	body: string;
}

/** A held quest branch, and the open PR from it if there is one. */
export interface Claim {
	branch: string;
	/** The PR holding the claim: the earliest open one. */
	url: string | null;
	pull: OpenPull | null;
}

/** Which branches someone holds, and which landed branches a new claim replaces. */
export interface Holdings {
	/** Sorted by branch. */
	claims: Claim[];
	/**
	 * Branches in the head fork, or upstream without one, whose tip is the head of a merged PR, by
	 * that tip. Their work landed, so they hold nothing and a claim may replace them.
	 */
	landed: Map<string, string>;
}

/** A repository claim branches live in, and its `quest/*` branch tips when the caller already read them. */
export interface Source {
	repository: Repository;
	tips?: Map<string, string>;
}

/** Where claims live: the upstream repository, and the fork a contributor pushes claims to, if any. */
export interface Sources {
	upstream: Source;
	/** Absent when claims are pushed upstream. */
	fork?: Source;
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
			body: typeof row.body === "string" ? row.body : "",
		};
	});
}

/** The open PRs from `branch`, earliest first: the first one holds the claim. */
export function pullsFrom(pulls: OpenPull[], branch: string): OpenPull[] {
	return pulls.filter((pull) => pull.branch === branch).sort((a, b) => a.created - b.created || a.number - b.number);
}

/** The `quest/*` branches among `refs`, full ref names with their tips, by branch name. */
export function questBranches(refs: Map<string, string>): Map<string, string> {
	const branches = new Map<string, string>();
	for (const [ref, sha] of refs)
		if (ref.startsWith("refs/heads/quest/")) branches.set(ref.slice("refs/heads/".length), sha);
	return branches;
}

/** The `quest/*` branches of `repository`, with their tips. */
export async function claimBranches(github: GitHub, repository: Repository): Promise<Map<string, string>> {
	const rows = await github.all(`${repositoryPath(repository)}/git/matching-refs/heads/quest/`);
	return questBranches(new Map(rows.map((row) => [string(row.ref), string(object(row.object).sha)])));
}

/**
 * Which of `branches` someone holds: the earliest open PR from it in either source, else its branch in
 * either. A branch whose tip is a merged PR's head holds nothing: its work landed. A closed, unmerged
 * PR's branch still holds its quest, since that work may be wanted back. A fork's own branches and PRs
 * count, so a claim pushed there is seen before its PR opens. Tips a source leaves out are read here.
 */
export async function held(github: GitHub, sources: Sources, branches: string[]): Promise<Holdings> {
	const { upstream, fork } = sources;
	const read = async (source: Source) => ({
		repository: source.repository,
		tips: source.tips ?? (await claimBranches(github, source.repository)),
	});
	const listed = fork ? [upstream, fork] : [upstream];
	const [all, pulls] = await Promise.all([
		Promise.all(listed.map(read)),
		Promise.all(listed.map((source) => openPullRequests(github, source.repository))).then((each) => each.flat()),
	]);
	const pushTo = all[all.length - 1];
	const landed = new Map<string, string>();
	const holds = async (branch: string): Promise<Claim | null> => {
		const pull = pullsFrom(pulls, branch)[0] ?? null;
		if (pull !== null) return { branch, url: pull.url, pull };
		let holding = false;
		for (const source of all) {
			const tip = source.tips.get(branch);
			if (tip === undefined) continue;
			if ((await mergedPull(github, upstream.repository, source.repository, branch, tip)) !== null) {
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
