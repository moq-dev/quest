// The merge queue watcher's fixer rounds: each PR the queue dropped for a failure or a conflict is fixed in
// the background and re-enqueued at the back of the queue, or handed back to a person.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isHoldLabel } from "../core";
import { array, GitHub, type GitHubDependencies, GitHubGraphQLError, object, type ObjectValue, string } from "./github";
import { type Queued, lacksApproval, queueHead } from "../github/merge";
import { UNREFUSED } from "./hold";
import { type Carried, describe, readSignals } from "./signals";
import { baseRemote, enqueue, type Entry, type LandMethod, mergeBase, type RemoteRead } from "./land";
import { resolutionSection, type Resolution } from "./land-apply";
import { checksSection } from "./land-checks";
import { type Cause, EFFORT_VARIABLE, type FixResult, knownFlaky, parseFixResult, readFixResult } from "./land-fix";
import {
	author,
	COLLECTION_ATTEMPTS,
	comment,
	conflictFailure,
	FixerRefusal,
	SignalRefusal,
	handbackLog,
	fixerMarkdown,
	fixerText,
	history,
	type History,
	carriedBy,
	historyPath,
	identity,
	importFix,
	launch,
	type Outcome,
	post,
	prepare,
	type Process,
	publishHead,
	review,
	type Round,
	saveRound,
	settle,
	stopReason,
	stopRule,
} from "./land-fixer";
import { push, remoteHead } from "./land-head";
import { save } from "./land-daemon";
import type { Removal } from "./land-watch";
import {
	type Disable,
	type FlakyTest,
	questName,
	readFlaky,
	RECENT,
	recordFlaky,
	saveFlaky,
	writeKnownFlaky,
} from "./land-watch-flaky";

/** What the watcher needs to run the fixer on the PRs the queue drops. */
export interface FixContext {
	/** The daemon's private repository, which no PR's checkout controls. */
	root: string;
	/** The credential-free fixer wrapper, called with the failure log and the PR's number. */
	fixer: string;
	/** The most fixer jobs that run at once; other dropped PRs wait for a slot, oldest first. */
	jobs: number;
	/** The fixer's `model_reasoning_effort`, passed to its wrapper in `QUEST_LAND_FIXER_EFFORT`. */
	effort: string;
	/** Minutes a fixer may run from its admission. */
	timeout: number;
	/** Patterns of tags, such as `deploy-*`, fetched from GitHub into each fixer checkout so its checks can read them. */
	tags: string[];
	/** Patterns of branches fetched from GitHub into each fixer checkout as `origin/<branch>`, for checks that diff against them. */
	branches: string[];
	token: (workflows: boolean) => Promise<string>;
	read: RemoteRead;
}

/** One round of the fixer on one dropped PR, in `watch-job-<name>.json`, from its start until it is collected. */
interface WatchJob extends Process {
	repository: string;
	/** The base the round works on: the `merge_group` build's, or the current one for a conflict. */
	base: { ref: string; sha: string };
	/** The PR at the head the queue dropped; `enabledAt` is its pick's enqueue. */
	entry: Entry;
	/** When the queue dropped it. */
	dropped: string;
	reason: "failed_checks" | "merge_conflict";
	/** The fixer's input, which a handback's comment quotes: the failure log, then the PR's own checks. */
	log: string;
	/** The failure's signature when the fixer names none: the failing job and step, or the conflict's base. */
	failure: string;
	/** A failed build's failing `merge_group` jobs, by URL, which a flaky verdict records. */
	runs?: string[];
	/** A clean merge of the base with the quest merge driver, which needs no fixer; `result` holds its head. */
	merged?: boolean;
	result?: FixResult;
	/** The head this round published on the PR, so a restart neither validates nor pushes it again. */
	published?: string;
	/** The head being put back in the queue, recorded before asking GitHub, so a restart finds its own request. */
	requeuing?: string;
	/** How GitHub took the head back, once it did: the round succeeded, and only its comments may remain. */
	requeued?: Queued;
	/** Why the round ended in a handback, recorded before posting it, so a restart keeps the reason. */
	handback?: string;
	/** A finding or decision on the head handed it back, so its marker says `unanswered_signal`. */
	signaled?: boolean;
	/** A validated fix whose push GitHub refused, handed back for `quest land apply`. */
	resolution?: Resolution;
	/** Passes that failed to collect it, so one that keeps failing is set aside rather than holding a fixer slot. */
	failures?: number;
}

/**
 * The queue a pass puts PRs back in: GitHub's merge queue, or the watcher's own, whose picks are
 * auto-merge requests pinned to their heads, as `quest merge --land` arms them, with `method`.
 */
export type QueueMode = { kind: "github" } | { kind: "own"; method: LandMethod };

const JOB = /^watch-job-.*\.json$/;
const REMOVAL = /^removal-\d+\.json$/;
/** The merge driver's own result, not an agent's: it is recorded in the PR's Review under this name. */
/** How the watcher signs the base merges it makes itself, with no model. */
export const MERGER = "quest land watch";
/** How a requeue comment says the fixer found the failure was not the PR's, by its cause. */
const JUDGED: Record<Cause, string> = {
	flaky: "judged the failure flaky",
	base: "found the failure on the base too",
	environment: "traced the failure to the runner's environment",
};

const PULL = `query($id: ID!) { node(id: $id) { ... on PullRequest {
	number repository { nameWithOwner } state baseRefName headRefOid mergeStateStatus reviewDecision mergeQueueEntry { enqueuedAt } autoMergeRequest { enabledAt }
	labels(first: 100) { nodes { name } }
	headRepository { nameWithOwner }
} } }`;

export async function readPull(github: GitHub, id: string): Promise<ObjectValue> {
	return object((await github.graphql(PULL, { id })).node);
}

/** Whether another session holds the PR with a hold label, such as `/quest-iterate`'s `quest:active`. */
export const isHeld = (pull: ObjectValue): boolean =>
	array(object(pull.labels).nodes).some((label) => isHoldLabel(string(label.name)));

/** What the watcher says on a held PR, whatever step found the hold and whether a fix was pushed. */
export const HELD =
	"Another session holds this pull request, so the watcher stops acting on it and leaves it to that session: the hold ends the pick, and a maintainer enqueues it again once that session is done.";

/**
 * Say once, best-effort, that the watcher left a held PR to its session. The caller has already ended
 * the pick in its state, so a comment GitHub refuses is only warned about and never retried.
 */
async function sayHeld(
	github: GitHub,
	repository: string,
	entry: Pick<Entry, "number" | "enabledAt">,
	warn: (text: string) => void,
): Promise<void> {
	try {
		await post(github, { repository }, entry, `quest land watch: ${HELD}`, "held", MERGER);
	} catch (error) {
		warn(`quest land watch: hold comment on ${entry.number} not posted: ${String(error)}`);
	}
}

/** A hold found right before a push or a re-enqueue. */
class Held extends Error {
	constructor() {
		super("held by another session");
	}
}

/**
 * Whether the PR is in the merge queue, or armed since `since` to join it once its required checks
 * pass. An older request is not a pick of the head the queue dropped.
 */
const queued = (pull: ObjectValue, since = "") =>
	pull.mergeQueueEntry != null ||
	(pull.autoMergeRequest != null && string(object(pull.autoMergeRequest).enabledAt) > since);

const removalPath = (state: string, number: number) => join(state, `removal-${number}.json`);

/** The latest removal the watcher recorded for PR `number`, if any. */
export function readRemoval(state: string, number: number): Removal | undefined {
	const path = removalPath(state, number);
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Removal) : undefined;
}

/**
 * The heads the watcher put back in the queue for the pick `history` keeps, while that pick lasts: a
 * handback ends it. An enqueue of one of them by the App continues the pick, whether the watcher made
 * it, GitHub's auto-merge did, or a workflow that picks every push to its PRs, as moq's Dependabot one does.
 */
export function requeuedHeads(state: string, number: number): { pick: string; heads: string[] } | undefined {
	const record = history(state, number);
	if (!record || record.rounds.at(-1)?.outcome === "handback") return undefined;
	return { pick: record.pick, heads: record.rounds.flatMap((round) => (round.after ? [round.after] : [])) };
}

/**
 * End the pick `pick` of PR `number`, as a writer's push or a person's removal does: its history goes,
 * so no later App enqueue continues it, and a round still running for it is not applied.
 */
export function endPick(state: string, number: number, pick: string): void {
	if (history(state, number)?.pick === pick) rmSync(historyPath(state, number), { force: true });
}

/** The failing job and step the watcher found, as a failure's signature when the fixer names none. */
function jobFailure(removal: Removal): string {
	const job = removal.jobs[0];
	if (!job) return removal.reason;
	return `${job.workflow} / ${job.name}${job.step ? `: ${job.step}` : ""}`;
}

/** The running jobs, by file name. Unreadable ones are reported, and wait for a person. */
function jobs(state: string, deps: Pick<GitHubDependencies, "warn">): Map<string, WatchJob> {
	const found = new Map<string, WatchJob>();
	for (const name of readdirSync(state).filter((name) => JOB.test(name))) {
		try {
			found.set(name, JSON.parse(readFileSync(join(state, name), "utf8")) as WatchJob);
		} catch (error) {
			deps.warn(`quest land watch: unreadable fixer job ${name}: ${String(error)}`);
		}
	}
	return found;
}

/**
 * Start the fixer on the dropped PRs waiting for it, oldest removal first, then collect the jobs that
 * finished. A conflict is first merged with the quest merge driver, which needs no fixer slot.
 */
export async function advanceFixes(
	repository: string,
	base: { ref: string; sha: string },
	state: string,
	context: FixContext,
	deps: GitHubDependencies,
	queue: QueueMode,
): Promise<string[]> {
	const github = new GitHub(deps);
	// Collect first, so a finished job's slot is free, and a clean merge once it is made.
	const output = await collectAll(github, state, context, deps, queue);
	const waiting = readdirSync(state)
		.filter((name) => REMOVAL.test(name))
		.map((name) => JSON.parse(readFileSync(join(state, name), "utf8")) as Removal)
		.filter((removal) => removal.failure && removal.taken === undefined)
		.sort((a, b) => a.at.localeCompare(b.at) || a.number - b.number);
	let running = [...jobs(state, deps).values()].filter((job) => !job.merged).length;
	for (const removal of waiting) {
		const line = await take(github, repository, base, state, context, deps, removal, running < context.jobs);
		if (line?.startsWith("fixing ")) running++;
		if (line) output.push(line);
	}
	output.push(...(await collectAll(github, state, context, deps, queue, true)));
	output.push(...(await advanceDisables(github, repository, state, context, deps, queue)));
	return output;
}

/**
 * Collect every finished job, or only the clean merges with `merges`. One that fails to collect is
 * handed back, or retried on the next pass.
 */
async function collectAll(
	github: GitHub,
	state: string,
	context: FixContext,
	deps: GitHubDependencies,
	queue: QueueMode,
	merges = false,
): Promise<string[]> {
	const output: string[] = [];
	for (const [name, job] of jobs(state, deps)) {
		if (merges && !job.merged) continue;
		const path = join(state, name);
		try {
			output.push(...(await collect(github, state, path, job, context, deps, queue)));
		} catch (error) {
			// A round that keeps failing, as when GitHub refuses its handback, is set aside, so it frees its
			// fixer slot for the other dropped PRs. Only the pass's full collection counts, once.
			if (!merges) job.failures = (job.failures ?? 0) + 1;
			if ((job.failures ?? 0) >= COLLECTION_ATTEMPTS) {
				deps.warn(
					`quest land watch: set aside ${job.entry.number} from ${name} after ${COLLECTION_ATTEMPTS} failed collections: ${String(error)}`,
				);
				finish(path, job);
				output.push(`set aside ${job.entry.number}`);
				continue;
			}
			// Once a round has asked GitHub to take its head back, it may already be in the queue: it never
			// becomes a handback on an error, and the next pass retries it, which re-enqueues only if needed.
			if (job.requeuing !== undefined) {
				save(path, job);
				deps.warn(`quest land watch: fixer round ${name} pending: ${String(error)}`);
				continue;
			}
			// Keep the first reason: a GitHub error while handing back a crash must not replace the crash.
			job.handback ??= `fixer collection failed: ${String(error)}`;
			try {
				save(path, job);
				output.push(...(await collect(github, state, path, job, context, deps, queue)));
			} catch (failure) {
				deps.warn(`quest land watch: handback pending for ${name}: ${String(failure)}`);
			}
		}
	}
	return output;
}

/**
 * Take a removal waiting for the fixer, if its PR still waits as the queue dropped it, unheld: merge a
 * conflict's base with the quest merge driver, or start the fixer when `slot` allows. Returns what it
 * did, if anything.
 */
async function take(
	github: GitHub,
	repository: string,
	current: { ref: string; sha: string },
	state: string,
	context: FixContext,
	deps: GitHubDependencies,
	removal: Removal,
	slot: boolean,
): Promise<string | undefined> {
	const failure = removal.failure!;
	const entry = failure.plan.queue[0];
	const number = removal.number;
	const mark = (taken: string) => save(removalPath(state, number), { ...removal, taken } satisfies Removal);
	const pull = await readPull(github, entry.id);
	// The pick ended while the PR waited: closed, retargeted, a writer's push, or a writer's new enqueue.
	const why =
		pull.state !== "OPEN"
			? "closed"
			: string(pull.baseRefName) !== failure.plan.base.ref
				? "retargeted"
				: string(pull.headRefOid) !== removal.head
					? "pushed"
					: queued(pull, removal.at)
						? "picked"
						: undefined;
	if (why) {
		mark(why);
		return `dropped ${number} ${why}`;
	}
	// A job already started on it, as before a crash that lost this record, takes it.
	const started = [...jobs(state, deps).entries()].find(
		([, job]) => job.entry.number === number && job.dropped === removal.at,
	);
	if (started) {
		mark(`${started[1].merged ? "merged" : "fixer"} ${started[0]}`);
		return undefined;
	}
	if (isHeld(pull)) {
		mark("held");
		endPick(state, number, entry.enabledAt);
		await sayHeld(github, repository, entry, deps.warn);
		return `dropped ${number} held`;
	}
	const conflict = removal.reason === "merge_conflict";
	// A conflict is merged with the current base; a failed build is fixed on the base it was built on.
	const base = conflict ? current : failure.plan.base;
	// Without a fixer slot, only a conflict's merge with a base it was not yet tried on can go ahead.
	if (!slot && !(conflict && removal.unmerged !== base.sha)) return undefined;
	// The round begins its pick's history, unless it continues that pick.
	if (history(state, number)?.pick !== entry.enabledAt)
		save(historyPath(state, number), { pick: entry.enabledAt, rounds: [] } satisfies History);
	const tags = context.tags.map((pattern) => `+refs/tags/${pattern}:refs/tags/${pattern}`);
	// Pruning drops a tag GitHub no longer has, so a check never reads one deleted there.
	await context.read(context.root, [
		"fetch",
		"--quiet",
		"--no-tags",
		"--prune",
		baseRemote({ repository }),
		base.sha,
		removal.head,
		...tags,
	]);
	let log = removal.log;
	if (conflict) {
		const name = `job-${Date.now().toString(36)}-${number}`;
		const path = join(state, `conflict-${number}-${base.sha.slice(0, 12)}.log`);
		if (removal.unmerged !== base.sha) {
			const merged = mergeBase(context.root, removal.head, base.sha);
			if ("head" in merged) {
				const job: WatchJob = {
					checkout: "",
					started: deps.now(),
					repository,
					base,
					entry,
					dropped: removal.at,
					reason: "merge_conflict",
					log: removal.log,
					failure: conflictFailure(base.sha),
					merged: true,
					result: {
						number,
						action: "fixed",
						head: merged.head,
						reason: `merged ${base.ref} at ${base.sha} with the quest merge driver`,
						agent: MERGER,
					},
				};
				save(join(state, `watch-${name}.json`), job);
				mark(`merged watch-${name}.json`);
				return `merged ${number} ${merged.head}`;
			}
			writeFileSync(
				path,
				`The merge queue removed ${removal.url} at ${removal.head}: it conflicts with ${base.ref} at ${base.sha}, even with the quest merge driver.\n\n${merged.detail}\n`,
				{ mode: 0o600 },
			);
			// The conflict stands until the base moves: retry the merge only then.
			removal = { ...removal, unmerged: base.sha };
			save(removalPath(state, number), removal);
		}
		if (existsSync(path)) log = path;
	}
	if (!slot) return undefined;
	// The fixer reads the PR's own checks on the dropped head after the queue's log, as a signal only.
	const input = join(state, `fixer-input-${number}-${deps.now().toString(36)}.log`);
	writeFileSync(
		input,
		`${readFileSync(log, "utf8").trimEnd()}\n\n${await checksSection(github, repository, entry.id, removal.head)}`,
		{ mode: 0o600 },
	);
	log = input;

	const branches = await fixerBranches(context, repository, base.ref);
	if (branches.length)
		await context.read(context.root, [
			"fetch",
			"--quiet",
			"--no-tags",
			baseRemote({ repository }),
			...branches.map((branch) => branch.sha),
		]);

	const checkout = mkdtempSync(join(state, "fix-"));
	try {
		const packs = prepare(
			context.root,
			checkout,
			[
				`${removal.head}:refs/heads/batch`,
				`${removal.head}:refs/heads/pr-${number}`,
				...tags,
				...branches.map((branch) => `${branch.sha}:refs/remotes/origin/${branch.name}`),
			],
			// Start at the base: the agent loads its instructions and tooling only from code already landed.
			base,
		);
		if (!conflict) writeKnownFlaky(state, checkout);
		const job: WatchJob = {
			checkout,
			started: deps.now(),
			daemon: identity(process.pid),
			packs,
			repository,
			base,
			entry,
			dropped: removal.at,
			reason: conflict ? "merge_conflict" : "failed_checks",
			log,
			failure: conflict ? conflictFailure(base.sha) : jobFailure(removal),
			...(conflict ? {} : { runs: removal.jobs.map((item) => item.url) }),
		};
		const name = `job-${basename(checkout)}`;
		await launch(join(state, `watch-${name}.json`), job, context.fixer, log, [number], {
			[EFFORT_VARIABLE]: context.effort,
		});
		mark(`fixer watch-${name}.json`);
		return `fixing ${number}`;
	} catch (error) {
		rmSync(checkout, { recursive: true, force: true });
		throw error;
	}
}

/**
 * GitHub's branches that a `--fixer-branch` pattern matches, other than the base, which the round pins itself.
 * Matched here rather than by a fetch refspec, so a pattern naming a branch GitHub no longer has matches nothing.
 */
async function fixerBranches(
	context: FixContext,
	repository: string,
	base: string,
): Promise<{ name: string; sha: string }[]> {
	if (!context.branches.length) return [];
	const glob = (pattern: string) =>
		pattern
			.split("*")
			.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*");
	const match = new RegExp(`^(?:${context.branches.map(glob).join("|")})$`);
	const listed = await context.read(context.root, ["ls-remote", "--heads", baseRemote({ repository })]);
	return listed
		.split("\n")
		.map((line) => /^([0-9a-f]{40}|[0-9a-f]{64})\trefs\/heads\/(.+)$/.exec(line))
		.filter((found) => found !== null && found[2] !== base && match.test(found[2]))
		.map((found) => ({ name: found![2], sha: found![1] }));
}

/** End a job: its checkout and its records go, and its output log stays for diagnosis on the host. */
function finish(path: string, job: WatchJob): void {
	if (job.checkout) rmSync(job.checkout, { recursive: true, force: true });
	rmSync(`${path}.exit`, { force: true });
	rmSync(path);
}

/**
 * Collect a finished round: record it in its pick's history, and either put the PR back in the queue,
 * at a fixed head or unchanged, or hand it back, as a stop rule, the fixer, or a refusal says. A
 * round whose pick ended while it ran, or whose PR another session holds, is dropped, and the PR says
 * so. Returns what it did.
 */
async function collect(
	github: GitHub,
	state: string,
	path: string,
	job: WatchJob,
	context: FixContext,
	deps: GitHubDependencies,
	queue: QueueMode,
): Promise<string[]> {
	const { entry } = job;
	const number = entry.number;
	if (
		!job.result &&
		!job.error &&
		!job.handback &&
		!settle(path, job, deps, context.timeout, () => {
			job.result = parseFixResult(readFixResult(job.checkout), [number], knownFlaky(job.checkout))[0];
		})
	)
		return [];
	const name = basename(path);
	const result = job.result;
	const head = result?.action === "fixed" ? result.head : entry.head;
	const attribution = author(result);
	const plan = { repository: job.repository };
	const marked = { number, enabledAt: entry.enabledAt };
	// The fixer's own note goes first, so the watcher's outcome comment follows it.
	const note = async () => {
		if (result?.comment)
			await post(
				github,
				plan,
				marked,
				`${attribution} land fixer note:\n\n${fixerMarkdown(result.comment)}`,
				`note ${name}`,
				attribution,
			);
	};
	// Say how the round went back to the queue, once GitHub took it.
	const announce = async (requeued: Queued, result: FixResult): Promise<string[]> => {
		await note();
		const what = job.merged
			? `with ${job.base.ref} at ${job.base.sha} merged in by the quest merge driver`
			: result.action === "fixed"
				? `with the land fixer's fix (${fixerText(attribution)}): ${fixerText(result.reason)}`
				: `unchanged, since the land fixer ${JUDGED[("cause" in result && result.cause) || "flaky"]}: ${fixerText(result.failure ?? ("reason" in result ? result.reason : ""))}`;
		const how =
			requeued === "armed"
				? `armed auto-merge on this pull request at ${head}, so it joins the back of the merge queue once its required checks pass`
				: `re-enqueued this pull request at ${head}, at the back of the merge queue`;
		await post(github, plan, marked, `quest land watch: ${how}, ${what}.`, `requeued ${name}`, MERGER);
		finish(path, job);
		return [`requeued ${number} ${head}`];
	};
	if (job.requeued && result) return announce(job.requeued, result);
	const pull = await readPull(github, entry.id);
	const current = string(pull.headRefOid);
	const record = history(state, number);

	if (pull.state !== "OPEN") {
		finish(path, job);
		return [`dropped ${number} closed`];
	}
	// The queue dropped the PR again since. A round that already asked GitHub to re-enqueue its head is
	// done, as before a restart: that removal is handled on its own, never undone by enqueuing it again.
	const latest = readRemoval(state, number);
	const newer = latest !== undefined && latest.at > job.dropped;
	if (newer && job.requeuing !== undefined) {
		finish(path, job);
		return [`requeued ${number} ${job.requeuing}`];
	}
	// The pick ended while the round ran: a writer's push, a writer's new enqueue, or the queue dropping a
	// newer enqueue of it. Its result is not applied; a head or request this round made is still its own.
	const ours = job.published !== undefined && current === job.published;
	const retargeted = string(pull.baseRefName) !== job.base.ref;
	const ended = retargeted
		? `it was retargeted to ${fixerText(string(pull.baseRefName))} while the fixer ran, so it no longer lands on ${fixerText(job.base.ref)}`
		: current !== entry.head && !ours
			? `its head moved to ${current} while the fixer ran, and a push by anyone but the land fixer ends the pick`
			: record?.pick !== entry.enabledAt || newer
				? "the pick it was fixing ended: the pull request was enqueued, or removed, again while the fixer ran"
				: queued(pull, job.dropped) && !ours && job.requeuing === undefined
					? "a maintainer enqueued it again while the fixer ran, and that pick stands"
					: undefined;
	// Leave a held PR to its session: the pick and the round end first, and the hold's comment replaces
	// the fixer's note.
	const leave = async (): Promise<string[]> => {
		endPick(state, number, entry.enabledAt);
		finish(path, job);
		await sayHeld(github, job.repository, marked, deps.warn);
		return [`dropped ${number} held`];
	};
	// A head this round already asked GitHub to queue, and GitHub took, stays: the hold came after it.
	if (isHeld(pull) && !(job.requeuing !== undefined && queued(pull, job.dropped))) return leave();
	if (ended) {
		await note();
		await post(
			github,
			plan,
			marked,
			`quest land watch: the land fixer's result for ${entry.head} was not applied: ${ended}.`,
			`ended ${name}`,
			MERGER,
		);
		finish(path, job);
		return [`dropped ${number} ended`];
	}

	let handback = job.handback ?? job.error;
	let round: Round | undefined;
	const said: string[] = [];
	const conflict = job.reason === "merge_conflict";
	const failure = conflict || !result ? job.failure : (result.failure ?? job.failure);
	if (!handback && result) {
		// Requeued unchanged, a failed build fails for the cause the fixer named; one it named no cause
		// outside the PR for, like a conflict that still conflicts, gets no new commit and goes back.
		const outcome: Outcome = job.merged
			? "merged"
			: result.action === "fixed"
				? "fixed"
				: result.action === "requeue"
					? conflict
						? "unchanged"
						: (result.cause ?? "unchanged")
					: "handback";
		// Only a flaky verdict counts for its test across every PR, whatever becomes of this pick.
		if (outcome === "flaky" && result.action === "requeue")
			said.push(
				...recordFlaky(context.root, state, {
					job: name,
					number,
					dropped: job.dropped,
					jobs: job.runs ?? [],
					base: job.base,
					checkout: job.checkout,
					packs: job.packs,
					failure,
					result,
					attribution,
				}),
			);
		const rule = stopRule(
			record!.rounds.filter((item) => item.job !== name),
			{ outcome, failure },
		);
		if (rule) handback = stopReason(rule, { outcome, failure });
		round = rule
			? { job: name, outcome: "handback", before: entry.head, failure, rule }
			: { job: name, outcome, before: entry.head, failure, ...(outcome === "handback" ? {} : { after: head }) };
		saveRound(state, number, record!, round);
	}

	if (!handback && result && result.action !== "handback") {
		try {
			if (result.action === "fixed") {
				if (job.published === undefined) {
					if (job.merged) {
						if (entry.repository !== job.repository && !entry.maintainerCanModify)
							throw new FixerRefusal("fork does not allow maintainer edits");
					} else
						await importFix(
							context.root,
							state,
							job,
							entry,
							job.checkout,
							job.packs,
							head,
							context.read,
							entry.head,
							deps.warn,
						);
					job.published = head;
					save(path, job);
				}
				// Validating the fix takes a while, and a session may have taken the PR since. A head already
				// pushed needs no push, and `requeue` checks the hold before any enqueue.
				if (!ours && isHeld(await readPull(github, entry.id))) throw new Held();
				await publishHead(github, context.root, job, entry, entry.head, current, head, deps, context.token, {
					reason: result.reason,
					attribution,
				});
			}
			if (job.requeuing === undefined) {
				job.requeuing = head;
				save(path, job);
			}
			job.requeued = await requeue(
				github,
				entry.id,
				head,
				job.base.ref,
				job.dropped,
				queue,
				carriedBy(state, number, head),
			);
			save(path, job);
		} catch (failure) {
			if (failure instanceof Held) return [...said, ...(await leave())];
			if (!(failure instanceof FixerRefusal)) throw failure;
			handback = failure.message;
			if (failure.resolution) job.resolution = failure.resolution;
			if (failure instanceof SignalRefusal) job.signaled = true;
		}
	}

	if (job.requeued && result) return [...said, ...(await announce(job.requeued, result))];
	// Anything else is a handback.
	await note();
	// Every handback ends the pick with a round of its own, a crash's or a timeout's too, so the App's
	// next enqueue of a head this pick put back starts a new pick.
	if (round?.outcome !== "handback") {
		saveRound(state, number, history(state, number)!, {
			...(round ?? { job: name, before: entry.head, failure }),
			outcome: "handback",
		});
	}
	if (handback) {
		job.handback = handback;
		save(path, job);
	}
	// The marker `quest status` reads for why the PR stopped landing.
	await comment(
		github,
		plan,
		marked,
		handback
			? `${handback.slice(0, 300)}. Recommendation: run /quest-iterate before picking it again.`
			: result?.action === "handback"
				? `${result.diagnosis.slice(0, 200)}. Recommendation: ${result.recommendation.slice(0, 200)}`
				: "missing result; run /quest-iterate",
		`handback ${name}`,
		attribution,
		handbackLog(job.log, !handback && result?.action === "handback" ? result.log : undefined),
		job.signaled ? "unanswered_signal" : job.reason,
		job.resolution ? (room) => resolutionSection(number, job.resolution!, room) : undefined,
	);
	finish(path, job);
	return [...said, `handback ${number}`];
}

/**
 * Put `head` back in `base`'s queue, at the back: GitHub's merge queue, or the watcher's own, by arming
 * auto-merge pinned to it. A PR queued or armed at it since the queue dropped it, at `dropped`, needs
 * no enqueue: a restart finds its own request, and a workflow may pick the fixer's push first. A
 * refusal, or a PR retargeted from `base`, hands the PR back; a hold leaves it to the session that holds it. A signal
 * on `head` or on the `carried` pick it replaces, queued or not, takes it out of the queue and hands it back.
 */
async function requeue(
	github: GitHub,
	id: string,
	head: string,
	base: string,
	dropped: string,
	queue: QueueMode,
	carried?: Carried,
): Promise<Queued> {
	const how = (pull: ObjectValue): Queued => (pull.mergeQueueEntry != null ? "enqueued" : "armed");
	let pull = await readPull(github, id);
	if (string(pull.baseRefName) !== base) throw new FixerRefusal(`retargeted from ${base} before it was re-enqueued`);
	if (string(pull.headRefOid) !== head) throw new FixerRefusal("head moved before it was re-enqueued");
	if (!queued(pull, dropped) && isHeld(pull)) throw new Held();
	// A finding or decision that arrived while the fixer ran holds the head as it would a writer's pick, even one a
	// workflow already queued. The fixer's own commit, which read neither, answers none on the pick it replaces.
	const [owner, repo] = string(object(pull.repository).nameWithOwner).split("/");
	const number = Number(pull.number);
	const held = (
		await readSignals(github, { owner: owner!, repo: repo! }, [number], carried && new Map([[number, carried]]))
	).get(number)!;
	if (held.head !== head) throw new FixerRefusal("head moved before it was re-enqueued");
	if (held.signals.length > 0) {
		if (pull.mergeQueueEntry != null) {
			await github.graphql("mutation($id: ID!) { dequeuePullRequest(input: { id: $id }) { clientMutationId } }", {
				id,
			});
			// Dequeuing can disarm auto-merge too, and GitHub refuses to disable a request that is gone.
			pull = await readPull(github, id);
		}
		if (string(pull.headRefOid) === head && queued(pull, dropped) && pull.autoMergeRequest != null)
			await github.graphql(
				"mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }",
				{ id },
			);
		throw new SignalRefusal(`its head is held by ${describe(held.signals)}`);
	}
	if (!queued(pull, dropped)) {
		try {
			if (queue.kind === "own") await enqueue(github, id, head, queue.method);
			else
				await queueHead((query, variables) => github.graphql(query, variables), {
					id,
					head,
					mergeState: string(pull.mergeStateStatus),
					unapproved: lacksApproval(pull.reviewDecision),
					method: "merge",
				});
		} catch (error) {
			if (!(error instanceof GitHubGraphQLError) || error.types.some((type) => UNREFUSED.includes(type ?? "")))
				throw error;
			pull = await readPull(github, id);
			if (string(pull.headRefOid) !== head || !queued(pull, dropped))
				throw new FixerRefusal(`GitHub refused to re-enqueue ${head}: ${error.message}`);
			return how(pull);
		}
		pull = await readPull(github, id);
	}
	return how(pull);
}

/**
 * Open each validated disable as a PR of its own and enqueue it like any other, with no maintainer's
 * pick: its Review records the fixer's change. A disable that fails to advance is retried on the next
 * pass; one GitHub refuses, or another session holds, is left for a maintainer.
 */
async function advanceDisables(
	github: GitHub,
	repository: string,
	state: string,
	context: FixContext,
	deps: GitHubDependencies,
	queue: QueueMode,
): Promise<string[]> {
	const output: string[] = [];
	const tests = readFlaky(state);
	for (const test of tests) {
		if (!test.disable || test.disable.done !== undefined) continue;
		try {
			output.push(
				await openDisable(
					github,
					repository,
					context,
					test,
					test.disable,
					() => saveFlaky(state, tests),
					deps.warn,
					queue,
				),
			);
		} catch (error) {
			deps.warn(`quest land watch: disable of ${test.disable.quest} pending: ${String(error)}`);
		}
	}
	return output;
}

/** A failing job's link, for a disable's PR body; only GitHub's own URLs. */
const jobLinks = (jobs: string[]) =>
	jobs
		.filter((url) => /^https:\/\/github\.com\/[\w./-]+$/.test(url))
		.map((url, index) => `[job ${index + 1}](${url})`)
		.join(", ") || "no failing job found";

/**
 * Push `disable` to its own `quest-land/flaky-<sha>` branch, open it on the base it was committed on,
 * and put it in the merge queue, recording each step with `record`, so a restart repeats none.
 * Returns what it did.
 */
async function openDisable(
	github: GitHub,
	repository: string,
	context: FixContext,
	test: FlakyTest,
	disable: Disable,
	record: () => void,
	warn: (text: string) => void,
	queue: QueueMode,
): Promise<string> {
	const name = questName(disable.quest);
	if (disable.id === undefined) {
		const branch = `quest-land/flaky-${disable.head.slice(0, 12)}`;
		const ref = `refs/heads/${branch}`;
		const remote = `https://github.com/${repository}.git`;
		// A retry after a restart finds its own push already there.
		if ((await remoteHead(context.root, remote, ref, context.read)) !== disable.head) {
			const pushed = await push(github, context.root, {
				remote,
				from: disable.base.sha,
				to: disable.head,
				ref,
				lease: "",
				token: context.token,
			});
			// Retried on the next pass: a push fails as often for an outage as for a rule.
			if (pushed.status !== 0) throw new Error(`push failed: ${pushed.stderr.trim()}`);
		}
		const head = `${repository.split("/")[0]}:${branch}`;
		const [open] = await github.all(`/repos/${repository}/pulls?head=${encodeURIComponent(head)}&state=open`);
		const seen = test.verdicts
			.slice(-RECENT)
			.map((verdict) => `#${verdict.number} (${jobLinks(verdict.jobs)})`)
			.join(", ");
		const reason = `skip the flaky ${test.failure}, and add ${disable.quest} to fix or delete it`;
		const pull =
			open ??
			object(
				await (
					await github.request(`/repos/${repository}/pulls`, {
						body: {
							title: `quest land: disable the flaky test ${name}`,
							head,
							base: disable.base.ref,
							body: `The land fixer judged ${fixerText(test.failure)} flaky ${test.verdicts.length} times, most recently in the \`merge_group\` builds of ${seen}. This pull request skips it and adds its follow-up quest, \`${disable.quest}\`, to fix or delete it. quest land watch enqueues it like any other pull request, and fixes it if the queue drops it.${review("", disable.head, reason, disable.attribution)}\n\n(written by ${disable.attribution})`,
						},
					})
				).json(),
			);
		disable.number = Number(pull.number);
		disable.id = string(pull.node_id);
		record();
	}
	const entry = { number: disable.number!, enabledAt: disable.head };
	try {
		disable.done = await requeue(github, disable.id, disable.head, disable.base.ref, "", queue);
	} catch (error) {
		if (error instanceof Held) {
			// Left for a maintainer, as a refused one is, once recorded.
			disable.done = "held";
			record();
			await sayHeld(github, repository, entry, warn);
			return `disable held ${name} ${disable.number}`;
		}
		if (!(error instanceof FixerRefusal)) throw error;
		await post(
			github,
			{ repository },
			entry,
			`quest land watch: ${fixerText(error.message)}, so this pull request waits for a maintainer to enqueue it.`,
			"refused",
			MERGER,
		);
		disable.done = error.message;
		record();
		return `disable refused ${name}: ${error.message}`;
	}
	record();
	return `disabled ${name} ${disable.number}`;
}
