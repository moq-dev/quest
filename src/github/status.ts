// A pull request's current state on GitHub, as facts for an agent to judge: what `quest status` prints.
import {
	actor,
	array,
	currentChecks,
	GitHub,
	GitHubDeadline,
	type GitHubDependencies,
	link,
	object,
	type ObjectValue,
	type PullRequest,
	type Repository,
	requirements,
	string,
	workflowKey,
} from "./client";
import { appOf, checksState, contextOutcome } from "./checks";
import { EJECTED, LAND_CHECK, pinned } from "./land";
import { reviewSection } from "../core";
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
			url body baseRefName state isDraft headRefOid headRefName mergeable mergeStateStatus reviewDecision
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
			commits(last: 1) { nodes { commit { oid statusCheckRollup { __typename
				contexts(first: 100, after: $checks) @include(if: $moreChecks) {
					pageInfo { hasNextPage endCursor }
					nodes {
						__typename
						... on CheckRun {
							databaseId name status conclusion detailsUrl isRequired(pullRequestNumber: $number)
							checkSuite { databaseId app { databaseId } workflowRun { file { path repositoryName } } }
						}
						... on StatusContext { context state createdAt targetUrl isRequired(pullRequestNumber: $number) }
					}
				}
			} } } }
			reviews(first: 100, after: $reviews) @include(if: $moreReviews) {
				pageInfo { hasNextPage endCursor }
				nodes { author { __typename login } state submittedAt url commit { oid } reactions(last: 100) { nodes { ...reaction } } }
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

/** A check run or commit status on the head, as `quest status` prints it. */
export interface Check {
	name: string;
	required: boolean;
	/** The lowercased check-run conclusion or status, or commit-status state. */
	result: string;
	url: string | null;
}

/** A reviewer's latest submitted review. */
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

/** A reaction on the PR or one of its reviews. */
export interface Reaction {
	content: string;
	actor: string;
	createdAt: string;
	/** The PR or review reacted to. */
	url: string;
}

/** An unresolved review thread. */
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

/**
 * The head the PR body's `## Review` section names last, the latest reviewed one: a round's record, or a line after
 * it for low-severity fixes or a skip. `current` is the PR's head; `diff-identical` an earlier head whose diff from
 * the base (`git diff <base>...<sha>`) matches the head's; `unknown` one GitHub cannot compare, such as a diff too
 * large to render.
 */
export interface ReviewRecord {
	state: "current" | "diff-identical" | "stale" | "unknown";
	head: string;
}

/** Everything `quest status` reports about a PR. */
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
	/**
	 * The latest exit from the merge queue, auto-merge, or `quest land`'s queue, and the reason for it;
	 * null once the PR is queued again.
	 */
	landingStopped: { reason: string; actor: string; at: string } | null;
	checks: { state: string | null; passed: number; failing: Check[]; pending: Check[] };
	/** Each reviewer's latest submitted review, oldest first. */
	reviews: Review[];
	/** The design checkpoints online reviewers put on the head, as {@link checkpoints} finds them. */
	checkpoints: { reviewer: string; round: number; url: string }[];
	/** Null when the `## Review` section names no full SHA. */
	reviewRecord: ReviewRecord | null;
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
	const head = string(first!.headRefOid);
	const { checks: current } = await currentChecks(github, pr, head, contexts);
	// Only an open PR can still merge, and a closed one's base may be gone.
	const needs: Needs =
		first!.state === "OPEN"
			? await requiredOf(github, pr, string(first!.baseRefName))
			: { checks: [], workflows: [] };
	const status = summarize(first!, rollup, current, needs, reviewNodes, threadNodes);
	status.reviewRecord = await reviewRecord(github, pr, first!, deps.warn);
	if (status.autoMerge !== null) status.autoMerge.head = await enabledHead(github, first!, deps.warn);
	return { ...status, holds: ownership.holds, starterHold: ownership.starter };
}

async function reviewRecord(
	github: GitHub,
	pr: PullRequest,
	pull: ObjectValue,
	warn: (message: string) => void,
): Promise<ReviewRecord | null> {
	const body = typeof pull.body === "string" ? pull.body : "";
	const section = reviewSection(body);
	// Only the last SHA, so a body naming many costs no more requests than one.
	const reviewed =
		section &&
		body
			.slice(section.start, section.end)
			.match(/\b[0-9a-f]{40}\b/g)
			?.at(-1);
	if (!reviewed) return null;
	const head = string(pull.headRefOid);
	if (reviewed === head) return { state: "current", head: reviewed };
	const base = encodeURIComponent(string(pull.baseRefName));
	const diffs: string[] = [];
	for (const sha of [head, reviewed]) {
		const unknown = (why: string): ReviewRecord => {
			warn(`cannot compare ${sha} with the base, so whether the review of ${reviewed} carries is unknown${why}`);
			return { state: "unknown", head: reviewed };
		};
		let response: Response;
		try {
			response = await github.request(`/repos/${pr.owner}/${pr.repo}/compare/${base}...${sha}`, {
				accept: "application/vnd.github.diff",
				allow: [404, 406, 422],
			});
		} catch (error) {
			// A deadline is the caller's to handle; a forbidden or failing compare is not.
			if (error instanceof GitHubDeadline || !(error instanceof Error)) throw error;
			return unknown(`: ${error.message}`);
		}
		if (!response.ok) return unknown("");
		diffs.push(await response.text());
	}
	return { state: diffs[0] === diffs[1] ? "diff-identical" : "stale", head: reviewed };
}

/** Repository activity types that move a branch to a new head, including merges into it. */
export const BRANCH_UPDATES = ["push", "force_push", "branch_creation", "pr_merge", "merge_queue_merge"];

/**
 * The head a PR node's auto-merge request was enabled on, or null when that cannot be told. GitHub
 * keeps auto-merge across a writer's push but does not say which head it was enabled on. A
 * `quest land` pin names it; otherwise it is the last push or merge to the head branch before auto-merge
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
	return headBefore(github, pull, Date.parse(string(request.enabledAt)), "the head auto-merge was enabled on", warn);
}

/**
 * The PR's head just before `time`: the last push or merge to its head branch before then, read from
 * the head repository's activity once that lists the current head's push. A push in the same second
 * is ambiguous. An activity listing the token cannot read leaves it unknown (null), with a warning
 * naming `what`, rather than failing the caller. The node needs `headRefOid`, `headRefName`, and
 * `headRepository { nameWithOwner }`.
 */
export async function headBefore(
	github: GitHub,
	pull: ObjectValue,
	time: number,
	what: string,
	warn: (message: string) => void,
): Promise<string | null> {
	if (pull.headRepository == null) return null;
	const head = string(pull.headRefOid);
	const pushes: { sha: string; time: number }[] = [];
	const repository = string(object(pull.headRepository).nameWithOwner);
	let path: string | undefined =
		`/repos/${repository}/activity?ref=${encodeURIComponent(string(pull.headRefName))}&per_page=100`;
	// Newest first: read until a push before `time`, which is the head then.
	while (path && !pushes.some((push) => push.time < time)) {
		let response: Response;
		try {
			response = await github.request(path, { allow: [404] });
		} catch (error) {
			// A deadline is the caller's to handle; a forbidden listing, as for a token without contents access, is not.
			if (error instanceof GitHubDeadline || !(error instanceof Error)) throw error;
			warn(`cannot read ${repository}'s push activity, so ${what} is unknown: ${error.message}`);
			return null;
		}
		if (response.status === 404) return null;
		for (const row of array(await response.json()))
			if (BRANCH_UPDATES.includes(string(row.activity_type)))
				pushes.push({ sha: string(row.after), time: Date.parse(string(row.timestamp)) });
		path = link(response, "next");
	}
	// GitHub lists a push seconds to minutes late; until the current head's is listed, an earlier one may be missing.
	if (!pushes.some((push) => push.sha === head) || pushes.some((push) => push.time === time)) return null;
	return pushes.find((push) => push.time < time)?.sha ?? null;
}

/** The checks and workflow files a base requires of a PR head. */
export interface Needs {
	/** Required checks, each from its app, or from any when `app` is null. */
	checks: { name: string; app: number | null }[];
	/** Workflow files that must pass as a whole, from {@link workflowKey}. */
	workflows: string[];
}

/** What `branch` requires of a PR head. The gate's own check is never on one, so it is left out. */
export async function requiredOf(github: GitHub, repository: Repository, branch: string): Promise<Needs> {
	const found = await requirements(github, repository, branch);
	return { checks: found.checks.filter((check) => check.name !== LAND_CHECK), workflows: found.workflows };
}

/** A check as a requirement matches it: its name, its app, and the workflow file a GitHub Actions job runs in. */
export interface Reported {
	name: string;
	/** The app behind a check run; null for a commit status. */
	app: number | null;
	/** The workflow file a GitHub Actions job runs in, from {@link workflowKey}. */
	workflow?: string;
}

/** A rollup context as a requirement matches it; queries ask for `checkSuite { workflowRun { file { path repositoryName } } }`. */
export function reported(context: ObjectValue): Reported {
	const run = context.__typename === "CheckRun" && context.checkSuite ? object(context.checkSuite).workflowRun : null;
	const file = run ? object(run).file : null;
	return {
		name: string(context.__typename === "CheckRun" ? context.name : context.context),
		app: appOf(context),
		...(file ? { workflow: workflowKey(string(object(file).repositoryName), string(object(file).path)) } : {}),
	};
}

/**
 * The required checks and workflows nothing on the head reports yet: a check by its name, from its app when
 * the requirement names one, as GitHub and `quest land` match it, and a workflow by its repository and path.
 */
export function unreported(found: Reported[], needs: Needs): string[] {
	return [
		...needs.checks
			.filter(
				(need) =>
					!found.some((entry) => entry.name === need.name && (need.app === null || entry.app === need.app)),
			)
			.map((need) => (need.app === null ? need.name : `${need.name} (from app ${need.app})`)),
		...needs.workflows.filter((key) => !found.some((entry) => entry.workflow === key)),
	];
}

/**
 * The PR's state from its pages. `current` holds the head's checks that count, from {@link currentChecks}; a
 * check is required when the base requires it or its workflow, and a requirement nothing reports is pending.
 */
function summarize(
	pull: ObjectValue,
	rollup: ObjectValue | null,
	current: ObjectValue[],
	needs: Needs,
	reviewNodes: ObjectValue[],
	threadNodes: ObjectValue[],
): Status {
	const head = string(pull.headRefOid);
	const url = string(pull.url);
	const missing = unreported(current.map(reported), needs);
	// The rollup's own state counts runs a newer run of the same check replaced.
	const state = checksState(current);
	const checks = {
		state:
			rollup === null && missing.length === 0
				? null
				: lower(state === "SUCCESS" && missing.length > 0 ? "PENDING" : state),
		passed: 0,
		failing: [],
		pending: [],
	} as Status["checks"];
	for (const context of current) {
		const { check, outcome } = classifyCheck(context);
		const workflow = reported(context).workflow;
		if (workflow !== undefined && needs.workflows.includes(workflow)) check.required = true;
		if (outcome === "passed") checks.passed++;
		else checks[outcome].push(check);
	}
	for (const name of missing) checks.pending.push({ name, required: true, result: "expected", url: null });

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
	const last = array(object(pull.timelineItems).nodes)
		.filter((node) => node.__typename !== "IssueComment" || ejection(node) !== null)
		.at(-1);
	// Entering the merge queue or auto-merge at or after the latest exit supersedes it. `quest land`'s
	// enqueue disables auto-merge just before enabling it again, often within the same second.
	const entered = [autoMerge?.enabledAt, queue?.enqueuedAt].flatMap((at) =>
		at == null ? [] : [Date.parse(string(at))],
	);
	const stopped =
		last !== undefined && !entered.some((at) => at >= Date.parse(string(last.createdAt))) ? last : undefined;
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
		checkpoints: checkpoints(head, submitted),
		reviewRecord: null,
		reactions,
		threads,
		holds: [],
		starterHold: null,
	};
}

/**
 * The design checkpoint `/quest-review` takes every third round, put on the head by an online reviewer: a bot that
 * approves or requests changes, such as one whose approval the base requires, whose latest review is of the head
 * and whose latest verdict on the head, ignoring plain comments, is not an approval or a dismissal, in its third,
 * sixth, ... round. A dismissed review was an approval or a change
 * request, so it shows the bot gates too, as when a push dismisses its approval. A round is one commit it reviewed;
 * a rethink at a checkpoint leaves the next one three rounds on, so nothing restarts the count.
 */
const GATING = ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"];

function checkpoints(head: string, submitted: ObjectValue[]): Status["checkpoints"] {
	const due: Status["checkpoints"] = [];
	const rounds = new Map<string, ObjectValue[]>();
	for (const row of submitted) {
		if (row.author == null || object(row.author).__typename !== "Bot") continue;
		const reviewer = actor(row.author);
		rounds.set(reviewer, [...(rounds.get(reviewer) ?? []), row]);
	}
	for (const [reviewer, rows] of rounds) {
		if (!rows.some((row) => GATING.includes(string(row.state)))) continue;
		const counted = rows.filter((row) => row.commit != null);
		const last = counted.at(-1);
		if (last === undefined || string(object(last.commit).oid) !== head) continue;
		const verdict = counted
			.filter((row) => string(object(row.commit).oid) === head && GATING.includes(string(row.state)))
			.at(-1);
		if (verdict?.state === "APPROVED" || verdict?.state === "DISMISSED") continue;
		const round = new Set(counted.map((row) => string(object(row.commit).oid))).size;
		if (round % 3 === 0) due.push({ reviewer, round, url: string(last.url) });
	}
	return due;
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
	return { check, outcome: contextOutcome(context) };
}

function lower(value: unknown): string {
	return string(value).toLowerCase();
}

function optional(value: unknown): string | null {
	return value === null || value === undefined || value === "" ? null : string(value);
}
