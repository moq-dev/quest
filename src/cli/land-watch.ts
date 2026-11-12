// The merge queue watcher: notice each PR GitHub's merge queue drops unmerged, record why, and say so on it,
// or, on a base without GitHub's merge queue, run the watcher's own serial queue (`land-queue.ts`).
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	array,
	GitHub,
	type GitHubDependencies,
	GitHubGraphQLError,
	link,
	object,
	type ObjectValue,
	type Repository,
	string,
} from "./github";
import type { Entry, LandMethod, Plan } from "./land";
import { authenticatedRead } from "./land-git";
import { jobLog } from "./land-checks";
import { fixerText, post } from "./land-fixer";
import {
	apiDependencies,
	daemonLoop,
	defaultBranch,
	EXCERPT,
	excerpt,
	type Failure,
	installationToken,
	privateRepository,
	save,
	startDaemon,
} from "./land-serve";
import {
	advanceFixes,
	endPick,
	type FixContext,
	HELD,
	isHeld,
	readPull,
	readRemoval,
	requeuedHeads,
} from "./land-watch-fix";
import { leaveOwnQueue, type OwnQueue, ownPass } from "./land-queue";
import { BUMP_PERMISSIONS, type BumpConnection, type BumpContext, bumpPass, checkTools, hostTools } from "./land-bump";
import { pruneLogs } from "./land-prune";
import { enabledHead, headBefore } from "./status";
import { describe, readSignals } from "./signals";

export { readRemoval } from "./land-watch-fix";

export interface WatchOptions {
	base?: string;
	/** How the own queue lands each PR; GitHub's merge queue applies its own method. */
	method: LandMethod;
	/** Minutes an own-queue build may run before it is dropped as timed out. */
	timeout: number;
	/** Empty for the default, `defaultState`, which `quest land serve` shares. */
	state: string;
	appId: string;
	/** The credential-free fixer wrapper; without one, removals are only recorded. */
	fixer?: string;
	/** The most fixer jobs that run at once. */
	fixerJobs: number;
	/** The fixer's `model_reasoning_effort`. */
	fixerEffort: string;
	/** Patterns of tags fetched from GitHub into each fixer checkout. */
	fixerTag: string[];
	/** Repositories whose flake input on this repository each pass bumps to this repository's base. */
	bump: Repository[];
	/** On the own queue, eject fork picks before pushing their build, so a fork's code never reaches a private runner. */
	refuseForks?: boolean;
}

/**
 * What a removal means for its pick: the fixer's to take (`fix`), or the end of the pick, left alone
 * until a writer enqueues the PR again: a push since the queue dropped it (`pushed`), a person's
 * removal (`removed`), a hold label another session keeps on it (`held`), or a reason the watcher
 * does not know (`unrecognized`).
 */
export type Verdict = "fix" | "pushed" | "removed" | "held" | "unrecognized" | "unknown";

/** A `merge_group` job that failed, or was still running when its checks timed out. */
export interface FailedJob {
	workflow: string;
	name: string;
	url: string;
	/** Its conclusion, or its status while it had none. */
	conclusion: string;
	/** The first step that failed, if one did. */
	step?: string;
}

/** A writer's enqueue, which starts a pick, and its time, which keys the pick's fixer history. */
export interface QueuePick {
	by: string;
	at: string;
}

/** One PR the merge queue dropped unmerged, as the watcher recorded it in `removal-<number>.json`. */
export interface Removal {
	/** The removal event's node ID. */
	event: string;
	at: string;
	number: number;
	url: string;
	/** GitHub's reason, such as `failed_checks`, `checks_timed_out`, `merge_conflict`, or `manual`. */
	reason: string;
	actor: string;
	/** The head the queue dropped. */
	head: string;
	/** The PR's head when the watcher read the removal. */
	current: string;
	pick: QueuePick;
	verdict: Verdict;
	jobs: FailedJob[];
	/** The full log the comment quotes the tail of. */
	log: string;
	/** For a `fix` verdict: the fixer's input, the dropped head as the pick's one entry on the base it was built on. */
	failure?: QueueFailure;
	/** What the fixer step made of a `fix` verdict; unset while it waits for one. */
	taken?: string;
	/** For a conflict: the base the quest merge driver could not merge, retried only once the base moves. */
	unmerged?: string;
}

/** A dropped PR's failure for the fixer. The merge queue applies its own method, so its plan names none. */
type QueueFailure = Omit<Failure, "plan"> & { plan: Omit<Plan, "method"> };

/** The watcher's progress, in `watch.json`. */
interface Progress {
	/** The start of the last complete pass; each pass reads the removals since `SETTLE` before it. */
	since: string;
	/**
	 * Per open PR, each removal handled that a pass may still read, by event ID to its time. GitHub can
	 * show a removal late, after a newer one, so each is remembered by ID until it falls out of the window.
	 */
	handled: Record<number, Record<string, string>>;
	/** Per open PR, the armed pick GitHub refused to enqueue on the last pass, so each refusal is reported once. */
	refused?: Record<number, string>;
}

/** How far back of the last pass each pass reads again, for an event GitHub shows late. */
export const SETTLE = 10 * 60_000;
/** How long before a removal its `merge_group` runs are looked for, when its enqueue is unknown. */
const LOOKBACK = 24 * 60 * 60_000;
/** Conclusions of a run or job that failed its build. */
const FAILED = ["failure", "timed_out", "startup_failure"];
/** GitHub's removal reasons that a fixer can act on. */
const FIXABLE = ["failed_checks", "checks_timed_out", "merge_conflict"];
/** Merge states of a PR GitHub can enqueue now: its required checks passed and it does not conflict. */
const READY = ["CLEAN", "HAS_HOOKS", "UNSTABLE"];

const REMOVALS = `pageInfo { hasNextPage endCursor }
	nodes {
		... on RemovedFromMergeQueueEvent {
			id createdAt reason actor { login } enqueuer { login }
		}
	}`;

const OPEN = `query($owner: String!, $name: String!, $base: String!, $qualified: String!, $since: DateTime!, $after: String) {
	repository(owner: $owner, name: $name) {
		ref(qualifiedName: $qualified) { target { oid } }
		pullRequests(states: OPEN, baseRefName: $base, first: 50, after: $after) {
			pageInfo { hasNextPage endCursor }
			nodes {
				id number url title headRefOid headRefName maintainerCanModify mergeStateStatus
				headRepository { nameWithOwner }
				labels(first: 100) { nodes { name } }
				mergeQueueEntry { id }
				autoMergeRequest { enabledAt commitBody }
				removals: timelineItems(since: $since, first: 20, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT]) { ${REMOVALS} }
			}
		}
	}
}`;

const MORE_REMOVALS = `query($id: ID!, $since: DateTime!, $after: String) {
	node(id: $id) { ... on PullRequest {
		removals: timelineItems(since: $since, first: 100, after: $after, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT]) { ${REMOVALS} }
	} }
}`;

const ENQUEUES = `query($id: ID!) {
	node(id: $id) { ... on PullRequest {
		timelineItems(last: 100, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT]) {
			nodes { ... on AddedToMergeQueueEvent { createdAt actor { login } enqueuer { login } } }
		}
	} }
}`;

/** GraphQL names a bot `name` as an actor and `name[bot]` as a user, as REST does. */
export const account = (login: string) => login.replace(/\[bot\]$/, "");
export const login = (value: unknown) => (value == null ? "" : string(object(value).login));

/** Every removal on `pull` since `since`, oldest first: its first page, then the rest by node. */
async function removalsOf(github: GitHub, pull: ObjectValue, since: string): Promise<ObjectValue[]> {
	let page = object(pull.removals);
	const nodes = array(page.nodes);
	while (object(page.pageInfo).hasNextPage === true) {
		const data = await github.graphql(MORE_REMOVALS, {
			id: pull.id,
			since,
			after: string(object(page.pageInfo).endCursor),
		});
		page = object(object(data.node).removals);
		nodes.push(...array(page.nodes));
	}
	return nodes.filter((node) => typeof node.id === "string");
}

/**
 * The pick a removal belongs to, and the latest enqueue of any kind, from which its builds are looked
 * for. A pick is the latest enqueue at or before the removal by anyone, the App included, as when a
 * workflow enqueues Dependabot's PRs with its token, except one continuing the watcher's own pick: an
 * App enqueue since that pick began, of a head the watcher put back in the queue for it
 * (`requeuedHeads`), which is the watcher's re-enqueue, GitHub's auto-merge of it, or such a workflow
 * picking the fixer's push.
 */
async function pickOf(
	github: GitHub,
	id: string,
	removal: ObjectValue,
	head: string,
	app: string,
	own: { pick: string; heads: string[] } | undefined,
): Promise<{ pick: QueuePick; queued?: string }> {
	const at = string(removal.createdAt);
	const data = await github.graphql(ENQUEUES, { id });
	const enqueues = array(object(object(data.node).timelineItems).nodes).filter(
		(node) => typeof node.createdAt === "string" && node.createdAt <= at,
	);
	const continues = own !== undefined && own.heads.includes(head);
	const picks = enqueues.filter(
		(node) => !(continues && account(login(node.actor)) === app && string(node.createdAt) > own.pick),
	);
	const writer = picks.at(-1);
	const queued = enqueues.at(-1)?.createdAt as string | undefined;
	if (writer)
		return {
			pick: { by: login(writer.enqueuer) || login(writer.actor), at: string(writer.createdAt) },
			...(queued ? { queued } : {}),
		};
	return {
		pick: { by: login(removal.enqueuer), at: continues ? own.pick : (queued ?? at) },
		...(queued ? { queued } : {}),
	};
}

/**
 * Enqueue each armed pick GitHub left out of the merge queue
 * ([community#209348](https://github.com/orgs/community/discussions/209348)): an open PR whose
 * auto-merge was armed, by a writer or by the watcher's own re-enqueue, that is now ready but was
 * neither in the queue nor added to it since. Only the head auto-merge was armed on is enqueued, with
 * `expectedHeadOid` bound to it: GitHub keeps auto-merge across a writer's push, but that push ends the
 * pick, and a head `enabledHead` cannot tell yet waits for the next pass. The PR is read again just
 * before the enqueue, so a request disabled or a PR retargeted since the pass read it is not enqueued,
 * which `expectedHeadOid` alone would not catch, and neither is a PR another session holds. An armed pick whose required
 * checks fail, or that conflicts, is not ready and is left alone. A refusal is reported once per pick
 * and retried each pass; one because GitHub queued the PR first says nothing.
 */
async function enqueueArmed(
	github: GitHub,
	base: string,
	pulls: ObjectValue[],
	progress: Progress,
	note: (text: string) => void,
): Promise<string[]> {
	const output: string[] = [];
	const refused: Record<number, string> = {};
	for (const pull of pulls) {
		if (pull.autoMergeRequest == null || pull.mergeQueueEntry != null) continue;
		if (!READY.includes(string(pull.mergeStateStatus))) continue;
		const number = Number(pull.number);
		const head = string(pull.headRefOid);
		const armed = string(object(pull.autoMergeRequest).enabledAt);
		// Queued since it was armed: GitHub took this pick, and a removal since is the removal handler's.
		const enqueues = array(
			object(object((await github.graphql(ENQUEUES, { id: pull.id })).node).timelineItems).nodes,
		);
		if (enqueues.some((node) => typeof node.createdAt === "string" && node.createdAt >= armed)) continue;
		if ((await enabledHead(github, pull, note)) !== head) continue;
		const now = await readPull(github, string(pull.id));
		const request = now.autoMergeRequest == null ? null : object(now.autoMergeRequest);
		if (
			now.state !== "OPEN" ||
			string(now.baseRefName) !== base ||
			string(now.headRefOid) !== head ||
			now.mergeQueueEntry != null ||
			request === null ||
			string(request.enabledAt) !== armed ||
			// Another session holds it: leave the pick armed, for the next pass once the hold clears.
			isHeld(now)
		)
			continue;
		try {
			await github.graphql(
				`mutation($id: ID!, $sha: GitObjectID!) {
					enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $sha }) { clientMutationId }
				}`,
				{ id: pull.id, sha: head },
			);
			output.push(`enqueued ${number} ${head}`);
		} catch (error) {
			if (!(error instanceof GitHubGraphQLError)) throw error;
			// GitHub moved it first, or the head moved since this pass read it: nothing to report.
			const fresh = await readPull(github, string(pull.id));
			if (fresh.mergeQueueEntry != null || string(fresh.headRefOid) !== head) continue;
			const pick = `${armed} ${head}`;
			refused[number] = pick;
			if (progress.refused?.[number] !== pick) output.push(`refused ${number} ${head}: ${error.message}`);
		}
	}
	progress.refused = refused;
	return output;
}

/**
 * Take each queued or armed PR whose head draws a signal, an online reviewer's unanswered finding or a newer
 * maintainer decision, out of the merge queue and disarm its auto-merge, so neither it nor {@link enqueueArmed} lands
 * it, and say why on it once per pick and head. Nothing waits for a reviewer: a signal that arrives before the merge
 * ends the pick until a writer fixes or answers it and picks the PR again. A pull is read again just before, so a
 * head pushed since is left for the next pass.
 */
async function dequeueSignaled(github: GitHub, repository: Repository, pulls: ObjectValue[]): Promise<string[]> {
	const picked = pulls.filter((pull) => pull.mergeQueueEntry != null || pull.autoMergeRequest != null);
	if (picked.length === 0) return [];
	const output: string[] = [];
	const read = await readSignals(
		github,
		repository,
		picked.map((pull) => Number(pull.number)),
	);
	for (const pull of picked) {
		const number = Number(pull.number);
		const head = string(pull.headRefOid);
		const found = read.get(number);
		if (!found || found.head !== head || found.signals.length === 0) continue;
		const now = await readPull(github, string(pull.id));
		if (now.state !== "OPEN" || string(now.headRefOid) !== head) continue;
		const pick =
			now.autoMergeRequest != null
				? string(object(now.autoMergeRequest).enabledAt)
				: now.mergeQueueEntry != null
					? string(object(now.mergeQueueEntry).enqueuedAt)
					: null;
		if (pick === null) continue;
		// GitHub may disarm auto-merge with the dequeue, so the disarm reads the PR again first. Either one taken
		// ends the pick and is said; when GitHub moved first and neither was taken, the next pass reads it again.
		let taken = false;
		try {
			if (now.mergeQueueEntry != null) {
				await github.graphql(
					"mutation($id: ID!) { dequeuePullRequest(input: { id: $id }) { clientMutationId } }",
					{ id: pull.id },
				);
				taken = true;
			}
			const armed = taken ? (await readPull(github, string(pull.id))).autoMergeRequest : now.autoMergeRequest;
			if (armed != null) {
				await github.graphql(
					"mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }",
					{ id: pull.id },
				);
				taken = true;
			}
		} catch (error) {
			if (!(error instanceof GitHubGraphQLError)) throw error;
			const fresh = await readPull(github, string(pull.id));
			const ended =
				fresh.state !== "OPEN" ||
				string(fresh.headRefOid) !== head ||
				(fresh.mergeQueueEntry == null && fresh.autoMergeRequest == null);
			if (!ended) throw error;
			if (!taken) continue;
		}
		await post(
			github,
			{ repository: `${repository.owner}/${repository.repo}` },
			{ number, enabledAt: pick },
			`quest land watch: ended this pull request's pick, taking it out of the queue and disarming its auto-merge, since its head ${head} is held by ${describe(found.signals)}. Push a fix, or answer each, then land it again.`,
			`signaled ${head}`,
			"quest land watch",
			"unanswered_signal",
		);
		output.push(`dequeued ${number} ${head} ${found.signals.length} signals`);
	}
	return output;
}

/** Every page of an Actions listing, whose rows are the response's `field`. */
export async function listed(github: GitHub, path: string, field: string): Promise<ObjectValue[]> {
	const rows: ObjectValue[] = [];
	for (let next: string | undefined = path; next;) {
		const response = await github.request(next);
		rows.push(...array(object(await response.json())[field]));
		next = link(response, "next");
	}
	return rows;
}

/**
 * The failing jobs of the PR's last `merge_group` build before `at`, and their logs. At build
 * concurrency 1 a merge group holds only this PR on the base, so its failure is the PR's own. The
 * group's branch, `gh-readonly-queue/<base>/pr-<number>-<base sha>`, names the base it was built on.
 */
async function failedBuild(
	github: GitHub,
	repository: string,
	base: string,
	number: number,
	from: string,
	at: string,
	timedOut: boolean,
): Promise<{ jobs: (FailedJob & { log: string })[]; base?: string }> {
	const prefix = `gh-readonly-queue/${base}/pr-${number}-`;
	const created = encodeURIComponent(`${from}..${at}`);
	const runs = (
		await listed(
			github,
			`/repos/${repository}/actions/runs?event=merge_group&created=${created}&per_page=100`,
			"workflow_runs",
		)
	).filter((run) => string(run.head_branch).startsWith(prefix) && string(run.created_at) <= at);
	runs.sort((a, b) => string(a.created_at).localeCompare(string(b.created_at)));
	const last = runs.at(-1);
	if (!last) return { jobs: [] };
	const group = string(last.head_branch);
	const jobs = await failingJobs(
		github,
		repository,
		runs.filter((item) => item.head_sha === last.head_sha),
		timedOut,
	);
	return { jobs, base: group.slice(prefix.length) };
}

/** The failing jobs of `runs`, and with `timedOut` those still running, each with its log. */
export async function failingJobs(
	github: GitHub,
	repository: string,
	runs: ObjectValue[],
	timedOut: boolean,
): Promise<(FailedJob & { log: string })[]> {
	const jobs: (FailedJob & { log: string })[] = [];
	for (const run of runs) {
		const path = `/repos/${repository}/actions/runs/${Number(run.id)}/jobs?filter=latest&per_page=100`;
		for (const job of await listed(github, path, "jobs")) {
			const conclusion = typeof job.conclusion === "string" ? job.conclusion : null;
			const running = job.status !== "completed";
			if (!(conclusion !== null && FAILED.includes(conclusion)) && !(timedOut && running)) continue;
			const step = array(job.steps ?? []).find(
				(item) => typeof item.conclusion === "string" && FAILED.includes(item.conclusion),
			);
			const log = running ? "" : await jobLog(github, repository, Number(job.id));
			jobs.push({
				workflow: string(run.name),
				name: string(job.name),
				url: string(job.html_url),
				conclusion: conclusion ?? string(job.status),
				...(step ? { step: string(step.name) } : {}),
				log,
			});
		}
	}
	return jobs;
}

/** Why the queue dropped the PR, as the comment's first sentence ends; `build` names the queue's build. */
export function because(reason: string, actor: string, base: string, build = "`merge_group`"): string {
	switch (reason) {
		case "failed_checks":
			return `its ${build} build failed`;
		case "checks_timed_out":
			return `its ${build} checks timed out`;
		case "merge_conflict":
			return `it conflicts with ${fixerText(base)}`;
		case "manual":
			return `${fixerText(actor)} removed it`;
		default:
			return `of ${fixerText(reason)}`;
	}
}

/**
 * Write a removal's full log, `removal-<number>-<at>.log` in `state`: `summary`, then each failing job's
 * log, which the land fixer reads. Returns its path.
 */
export function removalLog(
	state: string,
	number: number,
	at: string,
	summary: string,
	jobs: (FailedJob & { log: string })[],
): string {
	const path = join(state, `removal-${number}-${at.replace(/[^0-9TZ]/g, "")}.log`);
	const sections = jobs.map(
		(job) =>
			`\n== ${job.workflow} / ${job.name}: ${job.conclusion}${job.step ? ` at step ${job.step}` : ""} (${job.url}) ==\n${job.log}`,
	);
	writeFileSync(path, [summary, ...sections, ""].join("\n"), { mode: 0o600 });
	return path;
}

/** Each failing job's block for a removal's comment, its log's tail sharing the excerpt's room with the others. */
export function jobBlocks(jobs: (FailedJob & { log: string })[]): string[] {
	const share = Math.floor(EXCERPT / Math.max(1, jobs.length));
	return jobs.map(
		(job) =>
			`\n\n${fixerText(`${job.workflow} / ${job.name}`)} ([job](${job.url})) ${job.conclusion}${job.step ? ` at step ${fixerText(job.step)}` : ""}${job.log ? `:\n\n<pre>${excerpt(job.log.trimEnd(), share)}</pre>` : "."}`,
	);
}

/**
 * The failing jobs' blocks that fit in `room`, in order, so a PR whose workflow names many jobs, or
 * long ones, cannot make the comment too long to post and stall the watcher on it.
 */
export function jobsSection(blocks: string[], room: number): string {
	const NOTE = 120;
	let text = "";
	for (const [index, block] of blocks.entries()) {
		if (text.length + block.length > room - NOTE) {
			return `${text}\n\n${blocks.length - index} more failing jobs do not fit in this comment.`;
		}
		text += block;
	}
	return text;
}

/** What the watcher does about it, if anything it needs to say; `fixing` when a land fixer is configured. */
export const AFTER: Record<Verdict, (current: string, fixing: boolean) => string> = {
	fix: (_, fixing) =>
		fixing
			? "\n\nThe land fixer works on it in the background, and the watcher re-enqueues it at the back of the queue once it is fixed or judged flaky, or hands it back here with what it needs."
			: "",
	pushed: (current) =>
		`\n\nIts head has moved to ${current} since, and a push by anyone but the land fixer ends the pick: the watcher leaves this pull request alone until a maintainer enqueues it again.`,
	removed: () =>
		"\n\nA person's removal ends the pick: the watcher leaves this pull request alone until a maintainer enqueues it again.",
	held: () => `\n\n${HELD}`,
	unrecognized: () =>
		"\n\nThe watcher does not recognize this reason, so it leaves this pull request alone until a maintainer enqueues it again.",
	unknown: () =>
		"\n\nThe watcher cannot tell which head entered the queue, since GitHub has not listed the head branch's pushes or the watcher cannot read them, so it leaves this pull request alone until a maintainer enqueues it again.",
};

/**
 * How long a removal whose enqueued head the push activity cannot tell yet waits for GitHub to list
 * it (14 s to 6 min observed) before it ends the pick. It stays within `SETTLE`, so every pass until
 * then reads the removal again.
 */
const UNLISTED = SETTLE - 2 * 60_000;

/**
 * Handle one removal: classify it, fetch a failed build's logs, comment on the PR once (a retry
 * finds the marker and posts nothing), and record it for the fixer. A merge, and the App's own
 * removal, need neither. Returns what it did.
 */
async function handle(
	github: GitHub,
	repository: string,
	base: { ref: string; sha: string },
	state: string,
	app: string,
	fixing: boolean,
	pull: ObjectValue,
	event: ObjectValue,
	note: (text: string) => void,
	now: number,
): Promise<string | undefined | null> {
	const reason = string(event.reason).toLowerCase();
	const actor = login(event.actor);
	if (reason === "merged" || account(actor) === app) return undefined;
	const number = Number(pull.number);
	const current = string(pull.headRefOid);
	const at = string(event.createdAt);
	const own = requeuedHeads(state, number);
	// The dropped head is the PR's head when it entered the queue: the removal's `beforeCommit` is the
	// merge group's own commit, never the PR's head. The enqueue time does not depend on the head.
	const first = await pickOf(github, string(pull.id), event, current, app, own);
	const enqueued = first.queued ?? first.pick.at;
	const known = await headBefore(github, pull, Date.parse(enqueued), `the head ${number} was enqueued at`, note);
	// An unknown head never authorizes the fixer: wait for GitHub to list the push, then end the pick.
	if (known === null && now - Date.parse(at) < UNLISTED) return null;
	const head = known ?? current;
	// A hold recorded for this removal, as before a crash, ends the pick even once it clears.
	const prior = readRemoval(state, number);
	const held = (prior?.event === string(event.id) && prior.verdict === "held") || isHeld(pull);
	const { pick, queued } = head === current ? first : await pickOf(github, string(pull.id), event, head, app, own);
	const verdict: Verdict =
		known === null
			? "unknown"
			: head !== current
				? "pushed"
				: reason === "manual"
					? "removed"
					: !FIXABLE.includes(reason)
						? "unrecognized"
						: held
							? "held"
							: "fix";
	const build =
		reason === "failed_checks" || reason === "checks_timed_out"
			? await failedBuild(
					github,
					repository,
					base.ref,
					number,
					queued ?? new Date(Date.parse(at) - LOOKBACK).toISOString(),
					at,
					reason === "checks_timed_out",
				)
			: { jobs: [] };
	const built = /^[0-9a-f]{40}$/.test(build.base ?? "") ? build.base! : base.sha;

	const log = removalLog(
		state,
		number,
		at,
		`The merge queue removed ${string(pull.url)} at ${head} for ${reason} (${actor || "unknown"}), on ${base.ref} at ${built}.`,
		build.jobs,
	);
	const blocks = jobBlocks(build.jobs);
	const missing =
		build.jobs.length === 0 && reason !== "merge_conflict" && FIXABLE.includes(reason)
			? `\n\nThe watcher found no failing \`merge_group\` job for it before ${at}.`
			: "";
	const entry: Entry = {
		id: string(pull.id),
		number,
		url: string(pull.url),
		title: string(pull.title),
		enabledAt: pick.at,
		head,
		approved: head,
		repository: pull.headRepository == null ? repository : string(object(pull.headRepository).nameWithOwner),
		branch: string(pull.headRefName),
		maintainerCanModify: pull.maintainerCanModify === true,
	};
	const removal: Removal = {
		event: string(event.id),
		at,
		number,
		url: entry.url,
		reason,
		actor,
		head,
		current,
		pick,
		verdict,
		jobs: build.jobs.map(({ log: _, ...job }) => job),
		log,
		...(verdict === "fix"
			? {
					failure: {
						plan: { repository, base: { ref: base.ref, sha: built }, queue: [entry], eject: [] },
						ejections: [],
						numbers: [number],
						log,
						tip: head,
						reason: reason === "merge_conflict" ? "merge_conflict" : "failed_checks",
						blame: [number],
					} satisfies QueueFailure,
				}
			: {}),
	};
	// Recorded before its comment, so a hold ends the pick whatever becomes of the comment. A removal
	// GitHub showed late never replaces the record of a newer one.
	if ((prior?.at ?? "") <= at) {
		save(join(state, `removal-${number}.json`), removal);
		// Any other verdict ends the pick: its fixer history goes, so a later enqueue starts afresh.
		if (verdict !== "fix") endPick(state, number, pick.at);
	}
	const said = post(
		github,
		{ repository },
		{ number, enabledAt: pick.at },
		`quest land watch: the merge queue removed this pull request at ${head} because ${because(reason, actor, base.ref)} (\`${reason.replace(/[^a-z_]/g, "")}\`).${AFTER[verdict](current, fixing)}${missing}`,
		`removed ${string(event.id)}`,
		"quest land watch",
		undefined,
		(room) => jobsSection(blocks, room),
	);
	// A held removal's comment is the hold's, so it is best-effort: a refusal fails no pass and is not retried.
	if (verdict === "held")
		await said.catch((error: unknown) =>
			note(`quest land watch: hold comment on ${number} not posted: ${String(error)}`),
		);
	else await said;
	return `removed ${number} ${reason} ${verdict}`;
}

/**
 * One pass over the base's open PRs: handle each removal from the merge queue since the last pass,
 * oldest first, and remember each one handled, so a restart neither misses nor repeats one. The
 * first pass starts `SETTLE` before it. A PR closed before a pass reads its removal is not read.
 * Then it enqueues each armed pick GitHub left out of the queue. With a fixer, `fix` then starts it on the PRs the queue dropped and collects its rounds.
 */
export async function watchPass(
	repository: Repository,
	options: Pick<WatchOptions, "base" | "state">,
	deps: GitHubDependencies,
	fix?: FixContext,
): Promise<string[]> {
	const github = new GitHub(deps);
	const name = `${repository.owner}/${repository.repo}`;
	const path = join(options.state, "watch.json");
	const started = new Date(deps.now()).toISOString();
	const progress: Progress = existsSync(path)
		? (JSON.parse(readFileSync(path, "utf8")) as Progress)
		: { since: started, handled: {} };
	const since = new Date(Date.parse(progress.since) - SETTLE).toISOString();
	const ref = options.base ?? (await defaultBranch(github, repository));
	const app = account(string(object((await github.graphql("query { viewer { login } }", {})).viewer).login));

	const pulls: ObjectValue[] = [];
	let sha: string | undefined;
	for (let after: string | null = null; ;) {
		const data = object(
			(
				await github.graphql(OPEN, {
					owner: repository.owner,
					name: repository.repo,
					base: ref,
					qualified: `refs/heads/${ref}`,
					since,
					after,
				})
			).repository,
		);
		if (data.ref == null) throw new Error(`${name} has no branch ${ref}`);
		sha ??= string(object(object(data.ref).target).oid);
		const page = object(data.pullRequests);
		pulls.push(...array(page.nodes));
		if (object(page.pageInfo).hasNextPage !== true) break;
		after = string(object(page.pageInfo).endCursor);
	}

	const output: string[] = [];
	const open = new Set<number>();
	for (const pull of pulls) {
		const number = Number(pull.number);
		open.add(number);
		for (const event of await removalsOf(github, pull, since)) {
			const at = string(event.createdAt);
			const id = string(event.id);
			const handled = (progress.handled[number] ??= {});
			if (id in handled) continue;
			const line = await handle(
				github,
				name,
				{ ref, sha: sha! },
				options.state,
				app,
				fix !== undefined,
				pull,
				event,
				(text) => output.push(text),
				deps.now(),
			);
			// Not handled yet: a later pass within SETTLE reads it again.
			if (line === null) continue;
			if (line) output.push(line);
			handled[id] = at;
			save(path, progress);
		}
	}
	output.push(...(await dequeueSignaled(github, repository, pulls)));
	output.push(...(await enqueueArmed(github, ref, pulls, progress, (text) => output.push(text))));
	// The next pass reads from SETTLE before this one's start; nothing older can come back.
	const kept = new Date(Date.parse(started) - SETTLE).toISOString();
	for (const [number, handled] of Object.entries(progress.handled)) {
		for (const [id, at] of Object.entries(handled)) if (at < kept) delete handled[id];
		if (!open.has(Number(number)) || Object.keys(handled).length === 0) delete progress.handled[Number(number)];
	}
	progress.since = started;
	save(path, progress);
	if (fix)
		output.push(...(await advanceFixes(name, { ref, sha: sha! }, options.state, fix, deps, { kind: "github" })));
	return output;
}

/** The repository's default branch. */
/**
 * Whether `base` lands through the watcher's own queue, since its rules have no `merge_queue` rule.
 * Rules GitHub does not answer with fail the pass, which then does nothing.
 */
export async function ownQueue(github: GitHub, repository: Repository, base: string): Promise<boolean> {
	const path = `/repos/${repository.owner}/${repository.repo}/rules/branches/${encodeURIComponent(base)}?per_page=100`;
	return !(await github.all(path)).some((rule) => rule.type === "merge_queue");
}

type Permissions = Record<string, "read" | "write">;

const same = (a: Repository, b: Repository) =>
	a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();

/**
 * The installation token permissions the watcher asks for. On GitHub's merge queue, `api` reads the
 * queue's events, comments, and the `merge_group` logs (`actions: read`), and enqueues the armed picks
 * GitHub left out of the queue, which `enqueuePullRequest` needs `merge_queues: write` for; with a fixer
 * it also re-enqueues, which needs `contents: write` for arming auto-merge, edits the PR body's Review,
 * and reads the PR's own checks for the fixer (`checks: read` and `statuses: read`). The `own` queue
 * also disarms and arms auto-merge, cancels a build's runs (`actions: write`), posts each pick's queue
 * check (`checks: write`), and reads the base's classic protection (`administration: read`), as
 * `quest land serve` does. `push` lease-pushes a fix, a merge, a queue branch, or a landing, and
 * `pushWorkflows` one that carries a workflow change; `read` fetches.
 */
export function watchPermissions(
	fixing: boolean,
	own = false,
): {
	api: Permissions;
	push?: Permissions;
	pushWorkflows?: Permissions;
	read?: Permissions;
} {
	const push: Permissions = { contents: "write", pull_requests: "write" };
	if (own)
		return {
			api: {
				contents: "write",
				pull_requests: "write",
				actions: "write",
				checks: "write",
				statuses: "read",
				administration: "read",
			},
			push,
			pushWorkflows: { ...push, workflows: "write" },
			read: { contents: "read" },
		};
	if (!fixing) return { api: { contents: "read", pull_requests: "write", actions: "read", merge_queues: "write" } };
	return {
		api: {
			contents: "write",
			pull_requests: "write",
			actions: "read",
			merge_queues: "write",
			checks: "read",
			statuses: "read",
		},
		push,
		pushWorkflows: { ...push, workflows: "write" },
		read: { contents: "read" },
	};
}

/**
 * Watch the queue of `repository`'s base, one pass a minute, until the process stops: GitHub's merge
 * queue where the base's rules have one, otherwise the watcher's own, each pass deciding from the rules.
 * With a fixer, the PRs a queue drops are fixed from the daemon's private repository in the state directory.
 */
export async function watch(
	root: string,
	repository: Repository,
	options: WatchOptions,
	warn: (text: string) => void,
): Promise<void> {
	// The wrapper runs in the fixer's checkout, where a relative path would name the PR's own file.
	if (options.fixer) {
		options.fixer = resolve(options.fixer);
		accessSync(options.fixer, constants.X_OK);
	}
	if (options.bump.length > 0) checkTools();
	if (options.bump.some((target) => same(target, repository)))
		throw new Error("--bump names the watched repository, which cannot bump its own pin");
	const now = { fetch, now: Date.now };
	const mint = (wanted: Permissions) => installationToken(repository, options, wanted, now);
	// Each mode's token is minted only once a pass needs it, and the mode is read with neither, so an
	// installation granted only one mode's permissions still runs it.
	const probe = apiDependencies(() => mint({ contents: "read" }), { ...now, sleep, warn });
	const unlock = await startDaemon(root, repository, options, () => defaultBranch(new GitHub(probe), repository));
	const base = options.base!;
	try {
		const fixing = options.fixer !== undefined;
		const github = watchPermissions(fixing);
		const own = watchPermissions(fixing, true);
		const deps = apiDependencies(() => mint(github.api), { ...now, sleep, warn });
		const ownDeps = apiDependencies(() => mint(own.api), { ...now, sleep, warn });
		const token = (workflows: boolean) => mint(workflows ? own.pushWorkflows! : own.push!);
		const read = authenticatedRead(() => mint(own.read!));
		const trusted = privateRepository(options.state);
		const fix: FixContext | undefined = options.fixer
			? {
					root: trusted,
					fixer: options.fixer,
					jobs: options.fixerJobs,
					effort: options.fixerEffort,
					tags: options.fixerTag,
					timeout: 60,
					token,
					read,
				}
			: undefined;
		const queue: OwnQueue = {
			root: trusted,
			state: options.state,
			method: options.method,
			timeout: options.timeout,
			refuseForks: options.refuseForks === true,
			token,
			read,
		};
		const connections = new Map<string, BumpConnection>();
		const bump: BumpContext | undefined =
			options.bump.length === 0
				? undefined
				: {
						source: repository,
						targets: options.bump,
						state: options.state,
						reader: () => mint({ contents: "read" }),
						tools: hostTools(repository, options.state),
						connect: (target) => {
							const key = `${target.owner}/${target.repo}`;
							let connection = connections.get(key);
							if (connection === undefined) {
								const scoped = (wanted: Permissions) => installationToken(target, options, wanted, now);
								const push: Permissions = { contents: "write", pull_requests: "write" };
								connection = {
									remote: `https://github.com/${key}.git`,
									deps: apiDependencies(() => scoped(BUMP_PERMISSIONS), { ...now, sleep, warn }),
									token: (workflows) => scoped(workflows ? { ...push, workflows: "write" } : push),
									read: authenticatedRead(() => scoped({ contents: "read" })),
								};
								connections.set(key, connection);
							}
							return connection;
						},
					};
		await daemonLoop(async () => {
			pruneLogs(options.state, deps.now(), deps.warn);
			const api = new GitHub(probe);
			let again = false;
			if (await ownQueue(api, repository, base)) {
				const pass = await ownPass(repository, base, queue, ownDeps, fix);
				for (const line of pass.lines) warn(line);
				again = pass.again;
			} else {
				for (const line of await leaveOwnQueue(repository, base, queue, ownDeps, fixing)) warn(line);
				for (const line of await watchPass(repository, { ...options, base }, deps, fix)) warn(line);
			}
			if (bump) {
				const ref = `/repos/${repository.owner}/${repository.repo}/git/ref/heads/${encodeURIComponent(base)}`;
				const sha = string(object(object(await (await api.request(ref)).json()).object).sha);
				for (const line of await bumpPass(bump, sha)) warn(line);
			}
			return again;
		}, deps);
	} finally {
		unlock();
	}
}
