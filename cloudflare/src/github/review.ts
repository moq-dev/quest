// kix lands a pull request only at a head with a review that counts on that
// exact commit, whether a maintainer merges it from the inbox or a merge job
// lands it. A maintainer's earlier pick never stands in for a review of what a
// runner, or anyone, pushed since. Everything read here is GitHub's own record,
// never text a pull request's author or a runner wrote, such as its body.

/** The check run a runner's `quest review` result becomes, written only by the App. */
export const REVIEW_CHECK = "quest review";
/** How many merges of the base since its review a head carries the review across; each costs about ten reads. */
const MERGES = 5;

/** Reads on the pull request's repository, through the caller's scoped token. */
export type Reads = {
	/** A REST read below `/repos/<owner>/<name>`, such as `/pulls/1`. */
	get<T>(path: string): Promise<T>;
	graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
};

export type Landing = {
	owner: string;
	name: string;
	pull: number;
	/** The exact head being landed. */
	head: string;
	/** The repository's default branch: a merge carries a review only when it merges commits already there. */
	branch: string;
	/** The GitHub App's ID: only its check runs count. */
	app: number;
};

type Actor = { __typename: string; login: string } | null;
const PULL = `query($owner:String!,$name:String!,$number:Int!) { repository(owner:$owner,name:$name) { pullRequest(number:$number) {
 state headRefOid baseRefName author { __typename login }
 latestOpinionatedReviews(first:100,writersOnly:true) { nodes { state author { __typename login } commit { oid } } } } } }`;
type PullRow = {
	state: string;
	headRefOid: string;
	baseRefName: string;
	author: Actor;
	latestOpinionatedReviews: { nodes: { state: string; author: Actor; commit: { oid: string } | null }[] };
};
type Rule = { type: string; ruleset_id?: number; parameters?: Record<string, unknown> };
type GitCommit = { sha: string; tree: { sha: string }; parents: { sha: string }[] };
type GitTree = { truncated: boolean; tree: { path: string; type: string; mode: string; sha: string }[] };

const short = (sha: string) => sha.slice(0, 7);

/**
 * Why `landing.head` cannot land yet, or null when a review counts on it:
 *
 * - GitHub enforces one itself: a ruleset on the base the App cannot bypass
 *   requires an approval and dismisses stale ones or requires approval of the
 *   last push. Classic branch protection's review settings need the
 *   administration permission to read, so kix keeps its own check there.
 * - Someone with write access other than the pull request's author approved
 *   the head on GitHub, as a person rather than an App.
 * - The App's `quest review` check run passed on the head.
 *
 * Either review also counts across merges of the default branch since the
 * reviewed commit that resolved no conflict: every path holds the reviewed
 * side's or the default branch's version, whichever changed it, so the merge
 * adds nothing the review or the branch did not already hold.
 */
export async function unreviewed(reads: Reads, landing: Landing): Promise<string | null> {
	const response = await reads.graphql<{
		data?: { repository: { pullRequest: PullRow | null } | null };
		errors?: unknown[];
	}>(PULL, { owner: landing.owner, name: landing.name, number: landing.pull });
	const pull = response.data?.repository?.pullRequest;
	if (response.errors?.length || !pull) return "kix could not read the pull request's reviews.";
	if (pull.state !== "OPEN") return "The pull request is no longer open.";
	if (pull.headRefOid !== landing.head) return "The pull request's head moved since you looked; review it again.";
	if (await enforced(reads, pull.baseRefName)) return null;
	const author = pull.author?.login.toLowerCase();
	const approved = new Set(
		pull.latestOpinionatedReviews.nodes.flatMap((review) =>
			review.state === "APPROVED" &&
			review.author?.__typename === "User" &&
			review.author.login.toLowerCase() !== author &&
			review.commit
				? [review.commit.oid]
				: [],
		),
	);
	const commits = new Map<string, Promise<GitCommit>>();
	const commit = (sha: string) => {
		if (!commits.has(sha)) commits.set(sha, reads.get<GitCommit>(`/git/commits/${sha}`));
		return commits.get(sha)!;
	};
	let reviewed: string | null = landing.head;
	for (let merges = 0; reviewed && merges <= MERGES; merges++) {
		if (approved.has(reviewed) || (await checked(reads, landing.app, reviewed))) return null;
		// A merge kix cannot read in full is one it cannot verify, so it carries no review.
		reviewed = merges < MERGES ? await baseMerge(reads, commit, landing.branch, reviewed).catch(() => null) : null;
	}
	const head = short(landing.head);
	const ask = `kix lands only a reviewed head. Approve ${head} on GitHub as someone with write access other than the pull request's author, or have a runner's \`${REVIEW_CHECK}\` check pass on it.`;
	if (!approved.size) return `No review counts on ${head} yet. ${ask}`;
	return `The approval of ${[...approved].map(short).join(", ")} does not carry to ${head}: what changed since is more than conflict-free merges of ${landing.branch}. ${ask}`;
}

/** Whether a ruleset the App cannot bypass makes GitHub itself require a review of the current head. */
async function enforced(reads: Reads, base: string) {
	const rules = await reads.get<Rule[]>(`/rules/branches/${encodeURIComponent(base)}?per_page=100`);
	for (const rule of rules) {
		const p = rule.parameters ?? {};
		if (
			rule.type !== "pull_request" ||
			!(typeof p.required_approving_review_count === "number" && p.required_approving_review_count > 0) ||
			!(p.dismiss_stale_reviews_on_push === true || p.require_last_push_approval === true) ||
			typeof rule.ruleset_id !== "number"
		)
			continue;
		try {
			const ruleset = await reads.get<{ current_user_can_bypass?: string }>(`/rulesets/${rule.ruleset_id}`);
			if (ruleset.current_user_can_bypass === "never") return true;
		} catch {
			// A ruleset kix cannot read is one it cannot rely on; its own check stands.
		}
	}
	return false;
}

/** Whether the App's `quest review` check run passed on `sha`. */
async function checked(reads: Reads, app: number, sha: string) {
	const { check_runs } = await reads.get<{
		check_runs: {
			name: string;
			head_sha: string;
			status: string;
			conclusion: string | null;
			app: { id: number } | null;
		}[];
	}>(
		`/commits/${sha}/check-runs?check_name=${encodeURIComponent(REVIEW_CHECK)}&app_id=${app}&filter=latest&per_page=100`,
	);
	return check_runs.some(
		(run) =>
			run.name === REVIEW_CHECK &&
			run.app?.id === app &&
			run.head_sha === sha &&
			run.status === "completed" &&
			run.conclusion === "success",
	);
}

/**
 * The reviewed side of `sha` when it is a merge of commits the default branch
 * already holds that resolved no conflict, or else null.
 */
async function baseMerge(
	reads: Reads,
	commit: (sha: string) => Promise<GitCommit>,
	branch: string,
	sha: string,
): Promise<string | null> {
	const merge = await commit(sha);
	if (merge.parents.length !== 2) return null;
	const [ours, theirs] = merge.parents.map((parent) => parent.sha) as [string, string];
	const onBranch = await reads.get<{ status: string }>(`/compare/${theirs}...${encodeURIComponent(branch)}`);
	if (onBranch.status !== "identical" && onBranch.status !== "ahead") return null;
	const { merge_base_commit } = await reads.get<{ merge_base_commit: { sha: string } | null }>(
		`/compare/${ours}...${theirs}`,
	);
	if (!merge_base_commit) return null;
	const files = async (tree: string) => {
		const read = await reads.get<GitTree>(`/git/trees/${tree}?recursive=1`);
		if (read.truncated) return null;
		return new Map(read.tree.filter((e) => e.type !== "tree").map((e) => [e.path, `${e.mode} ${e.sha}`]));
	};
	const [base, a, b, merged] = await Promise.all(
		[merge_base_commit.sha, ours, theirs]
			.map(async (parent) => files((await commit(parent)).tree.sha))
			.concat(files(merge.tree.sha)),
	);
	if (!base || !a || !b || !merged) return null;
	for (const path of new Set([...base.keys(), ...a.keys(), ...b.keys(), ...merged.keys()])) {
		const [o, x, y] = [base.get(path), a.get(path), b.get(path)];
		// Both sides changed the path differently: whatever the merge holds was resolved by hand or by Git's
		// line merge, which a review of either side never saw.
		const expected = x === y ? x : x === o ? y : y === o ? x : null;
		if (expected === null || merged.get(path) !== expected) return null;
	}
	return ours;
}
