import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { type Finding, MERGE_LABEL, check, formatFinding } from "../core";
import { repositoryPath } from "./claims";
import {
	GitHub,
	GitHubDeadline,
	type GitHubDependencies,
	object,
	type ObjectValue,
	type Repository,
	type RequiredCheck,
	array,
	requirements,
	string,
} from "./github";
import { classifyCheck } from "./status";
import { snapshot } from "./tree";

/** The check a gated base requires. Nothing reports it on a PR head, so GitHub's auto-merge only waits. */
export const LAND_CHECK = "quest land";

/** The auto-merge commit body trailer that pins the head `quest merge --land` approved. */
const PIN = "Quest-Land-Head";

/** The auto-merge commit body that queues `sha`. */
export function pin(sha: string): string {
	return `${PIN}: ${sha}`;
}

/**
 * Queue `head` for the gate: squash auto-merge whose commit body pins it. GitHub keeps an
 * existing auto-merge request, and its old commit body, when asked to enable it again, so an
 * existing request is disabled first and the pin always names `head`.
 */
export async function enqueue(github: GitHub, id: string, head: string): Promise<void> {
	const current = object(
		await github.graphql(
			"query($id: ID!) { node(id: $id) { ... on PullRequest { autoMergeRequest { commitBody } } } }",
			{
				id,
			},
		),
	);
	const request = object(current.node).autoMergeRequest;
	if (request !== null && request !== undefined) {
		const body = object(request).commitBody;
		if (pinned(typeof body === "string" ? body : "") === head) return;
		await github.graphql(
			"mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }",
			{ id },
		);
	}
	await github.graphql(
		"mutation($id: ID!, $sha: GitObjectID!, $body: String!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, expectedHeadOid: $sha, mergeMethod: SQUASH, commitBody: $body }) { clientMutationId } }",
		{ id, sha: head, body: pin(head) },
	);
}

/** The head an auto-merge commit body pins, if any. */
function pinned(body: string): string | null {
	return new RegExp(`^${PIN}: ([0-9a-f]{40})$`, "m").exec(body)?.[1] ?? null;
}

/** Why the gate removed a PR from the queue; `quest status` prints it under `landing-stopped`. */
export type Reason =
	| "merge_conflict"
	| "failed_checks"
	| "review_required"
	| "changes_requested"
	| "unresolved_conversations"
	| "head_moved"
	| "not_pinned"
	| "tree_mismatch"
	| "merge_refused";

/** The hidden line an ejection comment carries, which `quest status` reads. */
export const EJECTED = /^<!-- quest land: ([a-z_]+) -->$/m;

/** A queued PR, as the queue resolved it. */
export interface Entry {
	/** GraphQL node ID. */
	id: string;
	number: number;
	url: string;
	title: string;
	/** When auto-merge was enabled: the queue order, and how a later ejection tells a re-queued PR apart. */
	enabledAt: string;
	/** The pinned head, which the chain builds and the merge API must match. */
	head: string;
	approved: string;
	repository: string;
	branch: string;
	maintainerCanModify: boolean;
}

export interface Ejection {
	id: string;
	number: number;
	url: string;
	enabledAt: string;
	reason: Reason;
	/** Why, for the PR's comment. */
	detail: string;
}

/** A snapshot of the base, approved queue, and pending ejections. */
export interface Plan {
	/** `owner/name`. */
	repository: string;
	base: { ref: string; sha: string };
	/** Queued PRs in enqueue order. */
	queue: Entry[];
	eject: Ejection[];
	/** Queued PRs whose required checks have not finished: they stay queued and sit out batches until they pass. */
	waiting?: Waiting[];
}

/** A queued PR waiting on required checks that are still running or have not reported. */
export interface Waiting {
	number: number;
	url: string;
	/** Its pick, from which the wait for its checks is measured. */
	enabledAt: string;
	/** The required checks still pending on its head. */
	pending: string[];
}

/** A page of a commit's check runs and commit statuses, with the app behind each run. */
const CONTEXTS = `pageInfo { hasNextPage endCursor }
	nodes {
		__typename
		... on CheckRun { name status conclusion detailsUrl checkSuite { app { databaseId } } }
		... on StatusContext { context state targetUrl }
	}`;

const QUEUE = `query($owner: String!, $name: String!, $base: String!, $qualified: String!, $after: String) {
	repository(owner: $owner, name: $name) {
		ref(qualifiedName: $qualified) { target { oid } }
		queue:pullRequests(states: OPEN, baseRefName: $base, first: 100, after: $after) {
			pageInfo { hasNextPage endCursor }
			nodes {
				id number url title isDraft headRefOid headRefName reviewDecision
				headRepository { nameWithOwner }
				maintainerCanModify
				autoMergeRequest { enabledAt commitBody }
				commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: 100) { ${CONTEXTS} } } } } }
			}
		}
	}
}`;

/** The pages of a commit's checks after the first. */
const MORE_CONTEXTS = `query($owner: String!, $name: String!, $oid: GitObjectID!, $after: String) {
	repository(owner: $owner, name: $name) {
		object(oid: $oid) { ... on Commit { statusCheckRollup { contexts(first: 100, after: $after) { ${CONTEXTS} } } } }
	}
}`;

/**
 * The ruleset rule types the gate upholds although its merge bypasses them, and how: each PR's
 * review decision, review threads, and required checks are its own to enforce, and the rest its
 * merge satisfies.
 */
export const UPHELD: Record<string, string> = {
	creation: "the gate never creates the base",
	deletion: "the gate never deletes the base",
	non_fast_forward: "GitHub squashes each PR onto the current base",
	required_linear_history: "the gate lands squash commits in a line",
	pull_request:
		"each PR's review decision must not block it, and its review threads must be resolved if the rule says so",
	required_status_checks: "each required check must pass on each PR's head, from the app the rule names",
	copilot_code_review: "it requests a review and blocks nothing",
};

/** What `rule` sets that the gate does not uphold, or null when it upholds all of it. */
function unheld(rule: ObjectValue): string | null {
	const type = string(rule.type);
	if (!(type in UPHELD)) return type;
	if (type !== "pull_request") return null;
	// The review decision covers approvals, code owners, and stale reviews, but not these.
	const parameters = rule.parameters == null ? {} : object(rule.parameters);
	const methods = parameters.allowed_merge_methods;
	const reviewers = parameters.required_reviewers;
	const settings = [
		parameters.require_last_push_approval === true && "require_last_push_approval",
		Array.isArray(methods) && !methods.includes("squash") && "allowed_merge_methods without squash",
		Array.isArray(reviewers) && reviewers.length > 0 && "required_reviewers",
	].filter((setting) => setting !== false);
	return settings.length > 0 ? `${type} (${settings.join(", ")})` : null;
}

/**
 * The classic branch protection settings the gate upholds although its merge bypasses them, and
 * how. Classic settings that the gate cannot enforce remain a refusal.
 */
export const UPHELD_CLASSIC: Record<string, string> = {
	required_status_checks:
		"each required check must pass on each PR's head, from the app it names, and the gate checks the chain on the current base",
	required_pull_request_reviews: "each PR's review decision must not block it",
	required_conversation_resolution: "each PR's review threads must be resolved",
	required_linear_history: "the gate lands squash commits in a line",
	block_creations: "the gate never creates the base",
	allow_force_pushes: "it only loosens the base",
	allow_deletions: "it only loosens the base",
	allow_fork_syncing: "it only loosens a locked base",
};

/** The settings of a base's classic protection that the gate does not uphold. */
function unheldClassic(protection: ObjectValue): string[] {
	return Object.entries(protection).flatMap(([setting, value]) => {
		if (setting === "url") return [];
		// A setting is on unless it says it is off; one without `enabled`, such as `restrictions`, is on when present.
		if (value == null || object(value).enabled === false) return [];
		if (!(setting in UPHELD_CLASSIC)) return [setting];
		// As for rulesets, the review decision does not cover approval of the last push.
		return setting === "required_pull_request_reviews" && object(value).require_last_push_approval === true
			? [`${setting} (require_last_push_approval)`]
			: [];
	});
}

/**
 * The base's classic protection, or null when it has none. Reading it needs administration read,
 * and an unreadable protection is never taken as none.
 */
async function classicProtection(github: GitHub, repository: Repository, ref: string): Promise<ObjectValue | null> {
	const path = `${repositoryPath(repository)}/branches/${encodeURIComponent(ref)}/protection`;
	const unreadable = (why: string) =>
		new Error(
			`cannot read ${repository.owner}/${repository.repo}'s classic branch protection on ${ref}, which needs administration read (a GitHub App's "Administration: read", or a token with admin rights): ${why}`,
		);
	let response: Response;
	try {
		response = await github.request(path, { allow: [404] });
	} catch (error) {
		if (error instanceof GitHubDeadline || !(error instanceof Error)) throw error;
		throw unreadable(error.message);
	}
	const body = object(await response.json());
	if (response.status === 200) return body;
	if (body.message === "Branch not protected") return null;
	throw unreadable(`GitHub HTTP 404; ${String(body.message)}`);
}

/** A page of a PR's review threads, by its node ID. */
const THREADS = `query($id: ID!, $after: String) {
	node(id: $id) { ... on PullRequest { reviewThreads(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { isResolved } } } }
}`;

/** How many of a PR's review threads are unresolved. */
async function unresolved(github: GitHub, id: string): Promise<number> {
	let count = 0;
	for (let after: string | null = null; ;) {
		const threads = object(object(object((await github.graphql(THREADS, { id, after })).node).reviewThreads));
		count += array(threads.nodes).filter((thread) => thread.isResolved !== true).length;
		const info = object(threads.pageInfo);
		if (info.hasNextPage !== true) return count;
		after = string(info.endCursor);
	}
}

/**
 * Read the queue: open PRs to `base` with auto-merge enabled, in the order it
 * was enabled. A PR is queued while its auto-merge commit body pins its current
 * head; one whose required checks are still running waits, and the rest of the
 * auto-merging PRs are ejected with a reason.
 */
export async function resolveQueue(
	repository: Repository,
	base: string | undefined,
	deps: GitHubDependencies,
	acceptHead?: (entry: Entry) => boolean,
): Promise<Plan> {
	const github = new GitHub(deps);
	const name = `${repository.owner}/${repository.repo}`;
	const ref =
		base ??
		string(
			object(
				object(
					(
						await github.graphql(
							"query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { defaultBranchRef { name } } }",
							{ owner: repository.owner, name: repository.repo },
						)
					).repository,
				).defaultBranchRef,
			).name,
		);
	const needs = await requirements(github, repository, ref);
	if (!needs.checks.some((check) => check.name === LAND_CHECK)) {
		throw new Error(
			`${name}'s ${ref} does not require the ${LAND_CHECK} check, so GitHub could merge a queued PR around the gate`,
		);
	}
	const refused = needs.rules.flatMap((rule) => {
		const what = unheld(rule);
		return what === null ? [] : [`${what} from ruleset ${String(rule.ruleset_id)}`];
	});
	if (refused.length > 0) {
		throw new Error(
			`${name}'s ${ref} has ruleset rules the gate does not uphold, and its merge bypasses them: ${refused.join("; ")}. It upholds only ${Object.keys(UPHELD).join(", ")}`,
		);
	}
	// Classic protection's required checks are already among `needs.checks`.
	const classic = needs.classic ? await classicProtection(github, repository, ref) : null;
	const unmodeled = classic === null ? [] : unheldClassic(classic);
	if (unmodeled.length > 0) {
		throw new Error(
			`${name}'s ${ref} has classic branch protection settings the gate does not uphold, and its merge bypasses them: ${unmodeled.join(", ")}. It upholds only ${Object.keys(UPHELD_CLASSIC).join(", ")}`,
		);
	}
	const resolution =
		(classic?.required_conversation_resolution != null &&
			object(classic.required_conversation_resolution).enabled === true) ||
		needs.rules.some(
			(rule) =>
				rule.type === "pull_request" &&
				rule.parameters != null &&
				object(rule.parameters).required_review_thread_resolution === true,
		);
	const required = needs.checks.filter((check) => check.name !== LAND_CHECK);

	let sha: string | undefined;
	const nodes: ObjectValue[] = [];
	let after: string | null = null;
	do {
		const data = await github.graphql(QUEUE, {
			owner: repository.owner,
			name: repository.repo,
			base: ref,
			qualified: `refs/heads/${ref}`,
			after,
		});
		if (data.repository === null) throw new Error(`cannot read ${name}; check the repository and token`);
		const repo = object(data.repository);
		if (repo.ref === null) throw new Error(`${name} has no branch ${ref}`);
		sha ??= string(object(object(repo.ref).target).oid);
		const page = object(repo.queue);
		nodes.push(...array(page.nodes));
		const info = object(page.pageInfo);
		after = info.hasNextPage === true ? string(info.endCursor) : null;
	} while (after !== null);

	const plan: Plan = { repository: name, base: { ref, sha: sha! }, queue: [], eject: [], waiting: [] };
	const landing = nodes.filter((node) => node.autoMergeRequest !== null && node.isDraft !== true);
	const order = (node: ObjectValue) => string(object(node.autoMergeRequest).enabledAt);
	landing.sort((a, b) => order(a).localeCompare(order(b)) || Number(a.number) - Number(b.number));
	for (const node of landing) {
		const request = object(node.autoMergeRequest);
		const head = string(node.headRefOid);
		const entry: Entry = {
			id: string(node.id),
			number: Number(node.number),
			url: string(node.url),
			title: string(node.title),
			enabledAt: string(request.enabledAt),
			head,
			approved: pinned(typeof request.commitBody === "string" ? request.commitBody : "") ?? head,
			maintainerCanModify: node.maintainerCanModify === true,
			repository: node.headRepository === null ? name : string(object(node.headRepository).nameWithOwner),
			branch: string(node.headRefName),
		};
		const eject = (reason: Reason, detail: string) =>
			plan.eject.push({
				id: entry.id,
				number: entry.number,
				url: entry.url,
				enabledAt: entry.enabledAt,
				reason,
				detail,
			});
		const approved = pinned(typeof request.commitBody === "string" ? request.commitBody : "");
		if (approved === null) {
			eject("not_pinned", "auto-merge was enabled without `quest merge --land`, which pins the head to land");
		} else if (approved !== head && !acceptHead?.(entry)) {
			eject("head_moved", `its head moved from ${approved} to ${head} after it was queued`);
		} else if (node.reviewDecision === "REVIEW_REQUIRED") {
			eject("review_required", "it still needs an approving review");
		} else if (node.reviewDecision === "CHANGES_REQUESTED") {
			eject("changes_requested", "a reviewer requested changes");
		} else if (resolution && (await unresolved(github, entry.id)) > 0) {
			eject("unresolved_conversations", "it has unresolved review threads; resolve them and land it again");
		} else {
			const unmet = checks(await contexts(github, repository, { ...node, headRefOid: approved }), required);
			if (unmet.failing.length > 0) {
				eject("failed_checks", `required checks failed on its head: ${unmet.failing.join(", ")}`);
			} else if (unmet.pending.length > 0) {
				// Still running: it keeps its auto-merge and its place, and joins a batch once they pass.
				plan.waiting!.push({
					number: entry.number,
					url: entry.url,
					enabledAt: entry.enabledAt,
					pending: unmet.pending,
				});
			} else {
				plan.queue.push(entry);
			}
		}
	}
	return plan;
}

/**
 * Every check run and commit status on a PR node's head: the queue's first page, then the rest by
 * the head's SHA, which also reads them all when the head moved between the queue's fields.
 */
async function contexts(github: GitHub, repository: Repository, node: ObjectValue): Promise<ObjectValue[]> {
	const head = string(node.headRefOid);
	const commit = object(object(array(object(node.commits).nodes)[0]).commit);
	const found: ObjectValue[] = [];
	let rollup = commit.oid === head ? commit.statusCheckRollup : undefined;
	let after: string | null = null;
	for (;;) {
		if (rollup === undefined) {
			const data = await github.graphql(MORE_CONTEXTS, {
				owner: repository.owner,
				name: repository.repo,
				oid: head,
				after,
			});
			const target = object(data.repository).object;
			if (target === null) throw new Error(`${string(node.url)}'s head ${head} is missing`);
			rollup = object(target).statusCheckRollup;
		}
		if (rollup === null) return found;
		const page = object(object(rollup).contexts);
		found.push(...array(page.nodes));
		const info = object(page.pageInfo);
		if (info.hasNextPage !== true) return found;
		after = string(info.endCursor);
		rollup = undefined;
	}
}

/** The required checks a head failed, and those pending or not yet reported, each from its app. */
function checks(contexts: ObjectValue[], required: RequiredCheck[]): { failing: string[]; pending: string[] } {
	const failing: string[] = [];
	const pending: string[] = [];
	for (const need of required) {
		let result: "passed" | "failing" | "pending" = "pending";
		let reported = false;
		for (const context of contexts) {
			const { check, outcome } = classifyCheck(context);
			if (check.name !== need.name || (need.app !== null && appOf(context) !== need.app)) continue;
			// A name reported twice, as by a rerun, counts only once every report passes.
			if (!reported || result === "passed") result = outcome;
			reported = true;
		}
		const name = need.app === null ? need.name : `${need.name} (from app ${need.app})`;
		if (result === "failing") failing.push(name);
		else if (result === "pending") pending.push(name);
	}
	return { failing: failing.sort(), pending: pending.sort() };
}

/** The GitHub App behind a check run; a commit status has none the gate can verify. */
function appOf(context: ObjectValue): number | null {
	if (context.__typename !== "CheckRun" || context.checkSuite == null) return null;
	const app = object(context.checkSuite).app;
	return app == null ? null : Number(object(app).databaseId);
}

/** A queued PR's squash commit on the chain. */
interface Link {
	entry: Entry;
	commit: string;
	tree: string;
}

/** The oldest PR conflicts with the base. Conflicting additions are skipped. */
interface Conflict {
	entry: Entry;
	files: string[];
}

/** A queued PR that fails `quest check` squashed alone onto the base, with the findings the base lacks. */
export interface Rejection {
	entry: Entry;
	/** The squash onto the base that fails, which a fixer starts from. */
	commit: string;
	findings: string[];
}

/** A newly screened PR, and the PRs ahead of it that it conflicts with, each squashed alone onto the base. */
export interface Overlap {
	entry: Entry;
	ahead: Conflict[];
}

/**
 * A bounded batch of squash commits, or a conflict on its base PR. Rejected PRs are left out of
 * it; overlaps only inform.
 */
interface Chain {
	links: Link[];
	conflict?: Conflict;
	rejected: Rejection[];
	overlaps: Overlap[];
}

/**
 * How the next batch is chosen. Batches alternate between the oldest and the newest queued PR as their base, and a
 * failed batch halves the next one's size, which each landed batch grows back toward 1 + floor(log2 n).
 */
export interface BatchPolicy {
	order: "oldest" | "newest";
	size: number;
}

/**
 * Fetch the base and every queued head, then fill a batch in `policy`'s order in a scratch
 * worktree inside the git directory, resolving quest files with `quest resolve`. Each candidate
 * is first squashed alone onto the base: one that fails `quest check` there with findings the
 * base lacks is rejected, and a fresh one is also squashed onto the PRs landing soonest ahead of
 * it, to report which ones it conflicts with. Stop at the policy's batch limit, skipping
 * conflicting additions; a conflicting base stops the batch.
 */
export async function build(
	root: string,
	plan: Plan,
	read: RemoteRead = readRemote,
	fresh: (entry: Entry) => boolean = () => false,
	policy: BatchPolicy = { order: "oldest", size: Number.POSITIVE_INFINITY },
): Promise<Chain> {
	await read(root, [
		"fetch",
		"--quiet",
		"--no-tags",
		baseRemote(plan),
		plan.base.sha,
		...plan.queue.map((entry) => entry.head),
	]);
	return mergeWorktree(root, plan.base.sha, (dir, driver) => {
		const chain: Chain = { links: [], rejected: [], overlaps: [] };
		const ordered = policy.order === "newest" ? [...plan.queue].reverse() : plan.queue;
		const limit = Math.max(1, Math.min(policy.size, 1 + Math.floor(Math.log2(plan.queue.length))));
		const screening = screener(dir, driver, plan);
		// Screen each head only as the batch reaches it, so a long queue costs this batch's
		// candidates, not every queued PR on every round.
		for (const entry of ordered) {
			if (chain.links.length >= limit) break;
			const alone = screening.alone(entry);
			if (alone === null) {
				if (chain.links.length > 0) continue;
				git(dir, ["reset", "--quiet", "--hard", plan.base.sha]);
				chain.conflict = { entry, files: squash(dir, driver, entry)! };
				break;
			}
			if (alone.findings.length > 0) {
				chain.rejected.push({ entry, commit: alone.commit, findings: alone.findings.map(formatFinding) });
				continue;
			}
			if (fresh(entry)) chain.overlaps.push({ entry, ahead: screening.overlaps(entry) });
			git(dir, ["reset", "--quiet", "--hard", chain.links.at(-1)?.commit ?? plan.base.sha]);
			if (squash(dir, driver, entry) !== null) continue;
			chain.links.push({
				entry,
				commit: git(dir, ["rev-parse", "HEAD"]),
				tree: git(dir, ["rev-parse", "HEAD^{tree}"]),
			});
		}
		return chain;
	});
}

/** Squash `entry` onto `HEAD` and commit it, or return the conflicting files and leave `HEAD` as it was. */
function squash(dir: string, driver: string, entry: Entry): string[] | null {
	const merged = tryGit(dir, ["-c", `merge.quest.driver=${driver}`, "merge", "--squash", entry.head]);
	if (merged.status !== 0) {
		const files = lines(git(dir, ["diff", "--name-only", "--diff-filter=U"]));
		if (files.length === 0) throw new Error(`git merge --squash ${entry.head} failed: ${merged.stderr.trim()}`);
		git(dir, ["reset", "--quiet", "--hard", "HEAD"]);
		return files;
	}
	git(dir, ["commit", "--quiet", "--allow-empty", "-m", `${entry.title} (#${entry.number})`]);
	return null;
}

/** How many queued PRs ahead of a newly queued one its conflict report covers: those landing soonest. */
const OVERLAP_AHEAD = 4;

/**
 * Screening for one batch: each head squashed alone onto the base, with `quest check` findings
 * the base lacks, and a fresh head's conflicts with the PRs landing soonest ahead of it. Results are
 * memoized, since a head is squashed alone once per batch however often it is needed.
 */
function screener(dir: string, driver: string, plan: Plan) {
	// A base without quests is a repository that does not use them.
	const known =
		git(dir, ["ls-tree", "--name-only", plan.base.sha, "quest"]) === "" ? null : questCheck(dir, plan.base.sha);
	const cache = new Map<Entry, { commit: string; findings: Finding[] } | null>();
	const alone = (entry: Entry) => {
		if (cache.has(entry)) return cache.get(entry)!;
		git(dir, ["reset", "--quiet", "--hard", plan.base.sha]);
		let result: { commit: string; findings: Finding[] } | null = null;
		if (squash(dir, driver, entry) === null) {
			const commit = git(dir, ["rev-parse", "HEAD"]);
			// A finding the base already has is not this PR's, even on a line the PR moved.
			const findings =
				known === null
					? []
					: questCheck(dir, commit).filter(
							(finding) =>
								!known.some((old) => old.path === finding.path && old.message === finding.message),
						);
			result = { commit, findings };
		}
		cache.set(entry, result);
		return result;
	};
	const overlaps = (entry: Entry) => {
		const index = plan.queue.indexOf(entry);
		return plan.queue
			.slice(0, Math.max(0, index))
			.slice(0, OVERLAP_AHEAD)
			.flatMap((earlier) => {
				const base = alone(earlier);
				if (base === null || base.findings.length > 0) return [];
				git(dir, ["reset", "--quiet", "--hard", base.commit]);
				const files = squash(dir, driver, entry);
				return files === null ? [] : [{ entry: earlier, files }];
			});
	};
	return { alone, overlaps };
}

/**
 * `quest check`'s findings on `commit`, read from git objects by this trusted process, so nothing
 * from the tree runs. A tree it cannot read, such as one with no quests left, is itself a finding,
 * as it is for `quest check`.
 */
function questCheck(dir: string, commit: string): Finding[] {
	try {
		const tree = snapshot(dir, commit, false);
		return check(tree.docs, tree.exists);
	} catch (error) {
		// Its messages name the scratch worktree, a host path the PR comment need not show.
		const message = (error instanceof Error ? error.message : String(error)).replaceAll(`${dir}/`, "");
		return [{ path: "quest", line: null, message }];
	}
}

/** Trusted merge driver/worktree shared by batch construction and PR-head preparation. */
export function mergeWorktree<T>(root: string, start: string, run: (dir: string, driver: string) => T): T {
	const probe = spawnSync("quest", ["help", "resolve"], { stdio: "ignore" });
	if (probe.status !== 0) {
		throw new Error("quest land merges quest files with `quest resolve`, so `quest` must be on PATH");
	}
	const dir = resolve(root, git(root, ["rev-parse", "--git-path", "quest-land"]));
	// The driver runs from the git directory, not the chain's worktree, where a
	// queued PR's `bunfig.toml` or `.env` would configure the trusted `quest`.
	const trusted = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const driver = `d=$PWD && cd '${trusted.replaceAll("'", "'\\''")}' && quest resolve "$d"/%A "$d"/%O "$d"/%B`;
	// A crashed run can leave its worktree registered.
	tryGit(root, ["worktree", "remove", "--force", dir]);
	git(root, ["worktree", "prune"]);
	git(root, ["worktree", "add", "--quiet", "--detach", dir, start]);
	try {
		return run(dir, driver);
	} finally {
		git(root, ["worktree", "remove", "--force", dir]);
	}
}

export function contains(root: string, ancestor: string, head: string): boolean {
	return tryGit(root, ["merge-base", "--is-ancestor", ancestor, head]).status === 0;
}

/** A merge whose first parent remains the approved PR head; no PR hooks or config run. */
export function mergeBase(
	root: string,
	head: string,
	base: string,
): { head: string; tree: string } | { reason: "merge_conflict"; detail: string } {
	return mergeWorktree(root, base, (dir, driver) => {
		// Match build: the driver orders the base/chain inserts before the PR inserts.
		const result = tryGit(dir, ["-c", `merge.quest.driver=${driver}`, "merge", "--no-ff", "--no-commit", head]);
		if (result.status !== 0)
			return { reason: "merge_conflict", detail: `${result.stdout}\n${result.stderr}`.trim() };
		const tree = git(dir, ["write-tree"]);
		const commit = git(dir, ["commit-tree", tree, "-p", head, "-p", base], {
			input: "quest land: merge tested base\n",
			env: {
				GIT_AUTHOR_NAME: "moq-bot",
				GIT_AUTHOR_EMAIL: "moq-bot@users.noreply.github.com",
				GIT_COMMITTER_NAME: "moq-bot",
				GIT_COMMITTER_EMAIL: "moq-bot@users.noreply.github.com",
			},
		});
		return { head: commit, tree };
	});
}

/** Remove `entry` from the queue for `reason`. */
export function ejection(entry: Entry, reason: Reason, detail: string): Ejection {
	return { id: entry.id, number: entry.number, url: entry.url, enabledAt: entry.enabledAt, reason, detail };
}

/**
 * Remove `ejection` from the queue: disable its auto-merge, drop `quest:merge`,
 * and comment with the reason. A PR whose auto-merge was enabled again since
 * the queue was read is a new entry and is left alone. Returns whether it ejected.
 */
export async function eject(github: GitHub, plan: Plan, ejection: Ejection): Promise<boolean> {
	const data = await github.graphql(
		"query($id: ID!) { node(id: $id) { ... on PullRequest { state autoMergeRequest { enabledAt } } } }",
		{ id: ejection.id },
	);
	const pull = object(data.node);
	if (pull.state !== "OPEN") return false;
	const request = pull.autoMergeRequest === null ? null : object(pull.autoMergeRequest);
	if (request !== null && string(request.enabledAt) !== ejection.enabledAt) return false;
	if (request !== null) {
		await github.graphql(
			"mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }",
			{ id: ejection.id },
		);
	}
	const [owner, repo] = plan.repository.split("/");
	const issue = `${repositoryPath({ owner, repo })}/issues/${ejection.number}`;
	await github.request(`${issue}/labels/${encodeURIComponent(MERGE_LABEL)}`, { method: "DELETE", allow: [404] });
	await github.request(`${issue}/comments`, {
		body: {
			body: `quest land removed this pull request from the queue: ${ejection.detail}.\n\n<!-- quest land: ${ejection.reason} -->`,
		},
	});
	return true;
}

/** The repository from which approved heads and the base are fetched. */
export function baseRemote(plan: Pick<Plan, "repository">): string {
	return `https://github.com/${plan.repository}.git`;
}

function lines(text: string): string[] {
	return text.split("\n").filter((line) => line !== "");
}

/** Deliberately exclude HOME, Git configuration, agents, tokens, and systemd credentials. */
export function commandEnvironment(): NodeJS.ProcessEnv {
	return { PATH: process.env.PATH, LANG: "C.UTF-8" };
}

/** Git's environment for trusted work: no system or global configuration, and no prompts. */
export function gitEnvironment(): NodeJS.ProcessEnv {
	return {
		...commandEnvironment(),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
	};
}

/** Run git without the repository's hooks, returning its status and output. */
export function tryGit(
	cwd: string,
	args: string[],
	options: { input?: string; env?: Record<string, string> } = {},
): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
		cwd,
		encoding: "utf8",
		input: options.input,
		env: { ...gitEnvironment(), ...options.env },
		maxBuffer: 1 << 30,
	});
	if (result.error) throw result.error;
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Run git, failing loudly; returns its trimmed output. */
export function git(
	cwd: string,
	args: string[],
	options: { input?: string; env?: Record<string, string> } = {},
): string {
	const result = tryGit(cwd, args, options);
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

/** A remote read is injected separately from local Git work, so credentials cannot reach child clones. */
export type RemoteRead = (root: string, args: string[]) => Promise<string>;
export const readRemote: RemoteRead = async (root, args) => git(root, args);
