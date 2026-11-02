// A pull request's current state on GitHub, as facts for an agent to judge.
import {
	actor,
	array,
	GitHub,
	GitHubDeadline,
	type GitHubDependencies,
	link,
	object,
	type ObjectValue,
	type PullRequest,
	string,
} from "./github";
import { EJECTED, pinned } from "./land";
import { readHoldStatus, type HoldFact, type HoldReport } from "./hold";

/**
 * One query covers the PR; each connection pages by its own cursor, and a
 * connection already read in full is skipped on later pages.
 */
const STATUS = `query($owner: String!, $repo: String!, $number: Int!,
	$checks: String, $reviews: String, $threads: String,
	$moreChecks: Boolean!, $moreReviews: Boolean!, $moreThreads: Boolean!) {
	repository(owner: $owner, name: $repo) {
		pullRequest(number: $number) {
			url state isDraft headRefOid headRefName mergeable mergeStateStatus reviewDecision
			headRepository { nameWithOwner }
			autoMergeRequest { enabledAt mergeMethod commitBody enabledBy { login } }
			mergeQueueEntry { state position enqueuedAt }
			timelineItems(last: 100, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT, AUTO_MERGE_DISABLED_EVENT, ISSUE_COMMENT]) { nodes {
				__typename
				... on RemovedFromMergeQueueEvent { createdAt reason actor { login } }
				... on AutoMergeDisabledEvent { createdAt reasonCode actor { login } }
				... on IssueComment { createdAt body authorAssociation author { __typename login } }
			} }
			reactions(last: 100) { nodes { ...reaction } }
			commits(last: 1) { nodes { commit { oid statusCheckRollup { state
				contexts(first: 100, after: $checks) @include(if: $moreChecks) {
					pageInfo { hasNextPage endCursor }
					nodes {
						__typename
						... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber: $number) }
						... on StatusContext { context state targetUrl isRequired(pullRequestNumber: $number) }
					}
				}
			} } } }
			reviews(first: 100, after: $reviews) @include(if: $moreReviews) {
				pageInfo { hasNextPage endCursor }
				nodes { author { login } state submittedAt url commit { oid } reactions(last: 100) { nodes { ...reaction } } }
			}
			reviewThreads(first: 100, after: $threads) @include(if: $moreThreads) {
				pageInfo { hasNextPage endCursor }
				nodes {
					id isResolved isOutdated path line originalLine
					comments(last: 1) { nodes { author { login } url } }
				}
			}
		}
	}
}
fragment reaction on Reaction { content createdAt user { login } }`;

/** Completed check-run conclusions that do not fail; anything else completed fails. */
const PASSING = ["success", "neutral", "skipped"];

export interface Check {
	name: string;
	required: boolean;
	/** The lowercased check-run conclusion or status, or commit-status state. */
	result: string;
	url: string | null;
}

export interface Review {
	reviewer: string;
	/** approved, changes_requested, commented, or dismissed. */
	state: string;
	/** Whether the review was submitted against the current head. */
	current: boolean;
	commit: string | null;
	submittedAt: string;
	url: string;
}

export interface Reaction {
	content: string;
	actor: string;
	createdAt: string;
	/** The PR or review reacted to. */
	url: string;
}

export interface Thread {
	id: string;
	path: string;
	/** The line on the current diff, or the original line once outdated. */
	line: number | null;
	outdated: boolean;
	lastAuthor: string;
	/** The thread's latest comment. */
	url: string;
}

export interface Status {
	url: string;
	state: "open" | "closed" | "merged";
	draft: boolean;
	head: string;
	mergeable: string;
	mergeState: string;
	reviewDecision: string | null;
	/** `head` is the head it was enabled on, or null when that cannot be told; see {@link enabledHead}. */
	autoMerge: { method: string; enabledBy: string; enabledAt: string; head: string | null } | null;
	mergeQueue: { state: string; position: number; enqueuedAt: string } | null;
	/** The latest exit from the merge queue, auto-merge, or `quest land`'s queue, and the reason for it. */
	landingStopped: { reason: string; actor: string; at: string } | null;
	checks: { state: string | null; passed: number; failing: Check[]; pending: Check[] };
	/** Each reviewer's latest submitted review, oldest first. */
	reviews: Review[];
	reactions: Reaction[];
	/** Unresolved review threads, oldest first. */
	threads: Thread[];
	/** Ownership facts read by the same client as the state commands. */
	holds: HoldFact[];
	starterHold: HoldReport["starter"];
}

/** Read the paged PR state, then the state commands’ ownership snapshot. */
export async function pullRequestStatus(pr: PullRequest, deps: GitHubDependencies): Promise<Status> {
	const github = new GitHub(deps);
	const cursors: Record<"checks" | "reviews" | "threads", string | null | undefined> = {
		checks: null,
		reviews: null,
		threads: null,
	};
	const contexts: ObjectValue[] = [];
	const reviewNodes: ObjectValue[] = [];
	const threadNodes: ObjectValue[] = [];
	let first: ObjectValue | undefined;
	let rollup: ObjectValue | null = null;
	// A cursor is null to read the first page and undefined once its list is complete.
	const page = (connection: unknown, key: keyof typeof cursors, into: ObjectValue[]) => {
		const list = object(connection);
		into.push(...array(list.nodes));
		const info = object(list.pageInfo);
		cursors[key] = info.hasNextPage === true ? string(info.endCursor) : undefined;
	};
	while (Object.values(cursors).some((cursor) => cursor !== undefined)) {
		const data = await github.graphql(STATUS, {
			owner: pr.owner,
			repo: pr.repo,
			number: pr.number,
			checks: cursors.checks ?? null,
			reviews: cursors.reviews ?? null,
			threads: cursors.threads ?? null,
			moreChecks: cursors.checks !== undefined,
			moreReviews: cursors.reviews !== undefined,
			moreThreads: cursors.threads !== undefined,
		});
		const repository = data.repository;
		if (repository === null) throw new Error(`cannot read ${pr.owner}/${pr.repo}; check the repository and token`);
		const pull = object(repository).pullRequest;
		if (pull === null) throw new Error(`${pr.owner}/${pr.repo}#${pr.number} is not a pull request`);
		const current = object(pull);
		if (first === undefined) first = current;
		else if (current.headRefOid !== first.headRefOid)
			throw new Error("the PR head changed while reading its pages; rerun quest status");
		const commit = object(object(array(object(current.commits).nodes)[0]).commit);
		if (commit.oid !== current.headRefOid)
			throw new Error("the PR head changed during the query; rerun quest status");
		rollup = commit.statusCheckRollup === null ? null : object(commit.statusCheckRollup);
		if (cursors.checks !== undefined) {
			if (rollup === null) cursors.checks = undefined;
			else page(rollup.contexts, "checks", contexts);
		}
		if (cursors.reviews !== undefined) page(current.reviews, "reviews", reviewNodes);
		if (cursors.threads !== undefined) page(current.reviewThreads, "threads", threadNodes);
	}
	const ownership = await readHoldStatus(pr, deps);
	if (ownership.head !== first!.headRefOid)
		throw new Error("the PR head changed while reading its holds; rerun quest status");
	const status = summarize(first!, rollup, contexts, reviewNodes, threadNodes);
	if (status.autoMerge !== null) status.autoMerge.head = await enabledHead(github, first!, deps.warn);
	return { ...status, holds: ownership.holds, starterHold: ownership.starter };
}

/**
 * The head a PR node's auto-merge request was enabled on, or null when that cannot be told. GitHub
 * keeps auto-merge across a writer's push but does not say which head it was enabled on. A
 * `quest land` pin names it; otherwise it is the last push to the head branch before auto-merge
 * was enabled, read from the head repository's activity once that lists the current head's push.
 * A push in the same second as enabling is ambiguous. An activity listing the token cannot read
 * leaves it unknown, with a warning, rather than failing the caller. The node needs `headRefOid`,
 * `headRefName`, `headRepository { nameWithOwner }`, and `autoMergeRequest { enabledAt commitBody }`.
 */
export async function enabledHead(
	github: GitHub,
	pull: ObjectValue,
	warn: (message: string) => void,
): Promise<string | null> {
	if (pull.autoMergeRequest == null) return null;
	const request = object(pull.autoMergeRequest);
	const pin = pinned(typeof request.commitBody === "string" ? request.commitBody : "");
	if (pin !== null || pull.headRepository == null) return pin;
	const enabled = Date.parse(string(request.enabledAt));
	const head = string(pull.headRefOid);
	const pushes: { sha: string; time: number }[] = [];
	const repository = string(object(pull.headRepository).nameWithOwner);
	let path: string | undefined =
		`/repos/${repository}/activity?ref=${encodeURIComponent(string(pull.headRefName))}&per_page=100`;
	// Newest first: read until a push before enabling, which is the head auto-merge was enabled on.
	while (path && !pushes.some((push) => push.time < enabled)) {
		let response: Response;
		try {
			response = await github.request(path, { allow: [404] });
		} catch (error) {
			// A deadline is the caller's to handle; a forbidden listing, as for a token without contents access, is not.
			if (error instanceof GitHubDeadline || !(error instanceof Error)) throw error;
			warn(
				`cannot read ${repository}'s push activity, so the head auto-merge was enabled on is unknown: ${error.message}`,
			);
			return null;
		}
		if (response.status === 404) return null;
		for (const row of array(await response.json()))
			if (["push", "force_push", "branch_creation"].includes(string(row.activity_type)))
				pushes.push({ sha: string(row.after), time: Date.parse(string(row.timestamp)) });
		path = link(response, "next");
	}
	// GitHub lists a push seconds to minutes late; until the current head's is listed, an earlier one may be missing.
	if (!pushes.some((push) => push.sha === head) || pushes.some((push) => push.time === enabled)) return null;
	return pushes.find((push) => push.time < enabled)?.sha ?? null;
}

function summarize(
	pull: ObjectValue,
	rollup: ObjectValue | null,
	contexts: ObjectValue[],
	reviewNodes: ObjectValue[],
	threadNodes: ObjectValue[],
): Status {
	const head = string(pull.headRefOid);
	const url = string(pull.url);
	const checks = {
		state: rollup === null ? null : lower(rollup.state),
		passed: 0,
		failing: [],
		pending: [],
	} as Status["checks"];
	for (const context of contexts) {
		const { check, outcome } = classifyCheck(context);
		if (outcome === "passed") checks.passed++;
		else checks[outcome].push(check);
	}

	const reactions: Reaction[] = [];
	const reacted = (owner: ObjectValue, target: string) => {
		for (const row of array(object(owner.reactions).nodes))
			reactions.push({
				content: lower(row.content),
				actor: actor(row.user),
				createdAt: string(row.createdAt),
				url: target,
			});
	};
	reacted(pull, url);
	// A pending review is the viewer's unsubmitted draft, not a review.
	const submitted = reviewNodes.filter((row) => row.state !== "PENDING");
	const latest = new Map<string, Review>();
	for (const row of submitted) {
		reacted(row, string(row.url));
		const reviewer = actor(row.author);
		const commit = row.commit === null ? null : string(object(row.commit).oid);
		latest.delete(reviewer);
		latest.set(reviewer, {
			reviewer,
			state: lower(row.state),
			current: commit === head,
			commit,
			submittedAt: string(row.submittedAt),
			url: string(row.url),
		});
	}

	const threads = threadNodes
		.filter((row) => row.isResolved !== true)
		.map((row): Thread => {
			const comment = array(object(row.comments).nodes).at(-1);
			const line = row.line ?? row.originalLine;
			return {
				id: string(row.id),
				path: string(row.path),
				line: typeof line === "number" ? line : null,
				outdated: row.isOutdated === true,
				lastAuthor: comment === undefined ? "-" : actor(comment.author),
				url: comment === undefined ? url : string(comment.url),
			};
		});

	const autoMerge = pull.autoMergeRequest === null ? null : object(pull.autoMergeRequest);
	const queue = pull.mergeQueueEntry === null ? null : object(pull.mergeQueueEntry);
	const stopped = array(object(pull.timelineItems).nodes)
		.filter((node) => node.__typename !== "IssueComment" || ejection(node) !== null)
		.at(-1);
	return {
		url,
		state: lower(pull.state) as Status["state"],
		draft: pull.isDraft === true,
		head,
		mergeable: lower(pull.mergeable),
		mergeState: lower(pull.mergeStateStatus),
		reviewDecision: pull.reviewDecision === null ? null : lower(pull.reviewDecision),
		autoMerge:
			autoMerge === null
				? null
				: {
						method: lower(autoMerge.mergeMethod),
						enabledBy: actor(autoMerge.enabledBy),
						enabledAt: string(autoMerge.enabledAt),
						head: null,
					},
		mergeQueue:
			queue === null
				? null
				: { state: lower(queue.state), position: Number(queue.position), enqueuedAt: string(queue.enqueuedAt) },
		landingStopped:
			stopped === undefined
				? null
				: {
						reason: ejection(stopped) ?? lower(stopped.reason ?? stopped.reasonCode),
						actor: actor(stopped.actor ?? stopped.author),
						at: string(stopped.createdAt),
					},
		checks,
		reviews: [...latest.values()],
		reactions,
		threads,
		holds: [],
		starterHold: null,
	};
}

/**
 * The reason in a `quest land` ejection comment, or null for any other comment. Only an app or a
 * person with write access speaks for the gate.
 */
function ejection(node: ObjectValue): string | null {
	if (node.__typename !== "IssueComment") return null;
	const author = node.author === null ? null : object(node.author);
	const trusted =
		author?.__typename === "Bot" || ["OWNER", "MEMBER", "COLLABORATOR"].includes(String(node.authorAssociation));
	return trusted && typeof node.body === "string" ? (EJECTED.exec(node.body)?.[1] ?? null) : null;
}

/**
 * A check run or commit status from a `statusCheckRollup` context, and whether it passed, failed, or
 * is still pending. `quest wait` shares this, so both commands agree on what passes.
 */
export function classifyCheck(context: ObjectValue): { check: Check; outcome: "passed" | "failing" | "pending" } {
	const run = context.__typename === "CheckRun";
	const check: Check = {
		name: string(run ? context.name : context.context),
		required: context.isRequired === true,
		result:
			run && context.status !== "COMPLETED"
				? lower(context.status)
				: lower(run ? context.conclusion : context.state),
		url: optional(run ? context.detailsUrl : context.targetUrl),
	};
	if (run ? context.status !== "COMPLETED" : ["pending", "expected"].includes(check.result))
		return { check, outcome: "pending" };
	return {
		check,
		outcome: (run ? PASSING.includes(check.result) : check.result === "success") ? "passed" : "failing",
	};
}

/** Stable plain lines: a record type, then space-separated fields, with any free text last. */
export function statusLines(status: Status): string[] {
	const dash = (value: string | number | null) => (value === null ? "-" : String(value));
	const check = (kind: string, c: Check) =>
		`check ${kind} ${c.required ? "required" : "optional"} ${c.result} ${dash(c.url)} ${c.name}`;
	return [
		`url ${status.url}`,
		`state ${status.state}`,
		`draft ${status.draft}`,
		`head ${status.head}`,
		`mergeable ${status.mergeable}`,
		`merge-state ${status.mergeState}`,
		`review-decision ${dash(status.reviewDecision)}`,
		status.autoMerge === null
			? "auto-merge -"
			: `auto-merge ${status.autoMerge.method} ${status.autoMerge.enabledBy} ${status.autoMerge.enabledAt} ${dash(status.autoMerge.head)}`,
		status.mergeQueue === null
			? "merge-queue -"
			: `merge-queue ${status.mergeQueue.state} ${status.mergeQueue.position} ${status.mergeQueue.enqueuedAt}`,
		status.landingStopped === null
			? "landing-stopped -"
			: `landing-stopped ${status.landingStopped.reason} ${status.landingStopped.actor} ${status.landingStopped.at}`,
		`checks ${dash(status.checks.state)} passed=${status.checks.passed} failing=${status.checks.failing.length} pending=${status.checks.pending.length}`,
		...status.checks.failing.map((c) => check("failing", c)),
		...status.checks.pending.map((c) => check("pending", c)),
		...status.reviews.map(
			(r) => `review ${r.current ? "current" : "stale"} ${r.state} ${r.reviewer} ${r.submittedAt} ${r.url}`,
		),
		...status.reactions.map((r) => `reacted:${r.content} ${r.actor} ${r.createdAt} ${r.url}`),
		...status.threads.map(
			(t) =>
				`thread ${t.id} ${t.outdated ? "outdated" : "current"} ${t.lastAuthor} ${t.url} ${t.path}:${dash(t.line)}`,
		),
		...(status.holds.length
			? status.holds.map(
					(hold) =>
						`hold ${hold.label} ${dash(hold.token)} ${dash(hold.takenAt)} ${dash(hold.eventUrl)} ${hold.age ?? "unknown age"}`,
				)
			: ["hold -"]),
		...(status.starterHold
			? [
					`starter-hold ${status.starterHold.lastActive} ${status.starterHold.url} last active ${status.starterHold.age}`,
				]
			: []),
	];
}

function lower(value: unknown): string {
	return string(value).toLowerCase();
}

function optional(value: unknown): string | null {
	return value === null || value === undefined || value === "" ? null : string(value);
}
