// The merge queue watcher's fixer rounds: each PR the queue dropped for a failure or a conflict is fixed in
// the background and re-enqueued at the back of the queue, or handed back to a person.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { GitHub, type GitHubDependencies, GitHubGraphQLError, object, type ObjectValue, string } from "./github";
import { queueHead, UNREFUSED } from "./hold";
import { baseRemote, type Entry, mergeBase, type RemoteRead } from "./land";
import { resolutionSection, type Resolution } from "./land-apply";
import { EFFORT_VARIABLE, type FixResult, parseFixResult, readFixResult } from "./land-fix";
import {
	author,
	cited,
	comment,
	conflictFailure,
	FixerRefusal,
	fixerLog,
	fixerMarkdown,
	fixerText,
	history,
	type History,
	historyPath,
	identity,
	importFix,
	launch,
	type Outcome,
	post,
	prepare,
	type Process,
	publishHead,
	type Round,
	saveRound,
	settle,
	stopReason,
	stopRule,
} from "./land-fixer";
import { save } from "./land-serve";
import type { Removal } from "./land-watch";

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
	/** The failure log the fixer reads, which a handback's comment quotes. */
	log: string;
	/** The failure's signature when the fixer names none: the failing job and step, or the conflict's base. */
	failure: string;
	/** A clean merge of the base with the quest merge driver, which needs no fixer; `result` holds its head. */
	merged?: boolean;
	result?: FixResult;
	/** The head this round published on the PR, so a restart neither validates nor pushes it again. */
	published?: string;
	/** The head being put back in the queue, recorded before asking GitHub, so a restart finds its own request. */
	requeuing?: string;
	/** How GitHub took the head back, once it did: the round succeeded, and only its comments may remain. */
	requeued?: Requeue;
	/** Why the round ended in a handback, recorded before posting it, so a restart keeps the reason. */
	handback?: string;
	/** A validated fix whose push GitHub refused, handed back for `quest land apply`. */
	resolution?: Resolution;
}

const JOB = /^watch-job-.*\.json$/;
const REMOVAL = /^removal-\d+\.json$/;
/** The merge driver's own result, not an agent's: it is recorded in the PR's Review under this name. */
const MERGER = "quest land watch";

const PULL = `query($id: ID!) { node(id: $id) { ... on PullRequest {
	state headRefOid mergeStateStatus mergeQueueEntry { enqueuedAt } autoMergeRequest { enabledAt }
} } }`;

async function readPull(github: GitHub, id: string): Promise<ObjectValue> {
	return object((await github.graphql(PULL, { id })).node);
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
): Promise<string[]> {
	const github = new GitHub(deps);
	// Collect first, so a finished job's slot is free, and a clean merge once it is made.
	const output = await collectAll(github, state, context, deps);
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
	output.push(...(await collectAll(github, state, context, deps, true)));
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
	merges = false,
): Promise<string[]> {
	const output: string[] = [];
	for (const [name, job] of jobs(state, deps)) {
		if (merges && !job.merged) continue;
		const path = join(state, name);
		try {
			output.push(...(await collect(github, state, path, job, context, deps)));
		} catch (error) {
			// Once a round has asked GitHub to take its head back, it may already be in the queue: it never
			// becomes a handback on an error, and the next pass retries it, which re-enqueues only if needed.
			if (job.requeuing !== undefined) {
				deps.warn(`quest land watch: fixer round ${name} pending: ${String(error)}`);
				continue;
			}
			// Keep the first reason: a GitHub error while handing back a crash must not replace the crash.
			job.handback ??= `fixer collection failed: ${String(error)}`;
			try {
				save(path, job);
				output.push(...(await collect(github, state, path, job, context, deps)));
			} catch (failure) {
				deps.warn(`quest land watch: handback pending for ${name}: ${String(failure)}`);
			}
		}
	}
	return output;
}

/**
 * Take a removal waiting for the fixer, if its PR still waits as the queue dropped it: merge a
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
	// The pick ended while the PR waited: closed, a writer's push, or a writer's new enqueue.
	if (pull.state !== "OPEN" || string(pull.headRefOid) !== removal.head || queued(pull, removal.at)) {
		const why = pull.state !== "OPEN" ? "closed" : string(pull.headRefOid) !== removal.head ? "pushed" : "picked";
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
	const conflict = removal.reason === "merge_conflict";
	// A conflict is merged with the current base; a failed build is fixed on the base it was built on.
	const base = conflict ? current : failure.plan.base;
	// Without a fixer slot, only a conflict's merge with a base it was not yet tried on can go ahead.
	if (!slot && !(conflict && removal.unmerged !== base.sha)) return undefined;
	// The round begins its pick's history, unless it continues that pick.
	if (history(state, number)?.pick !== entry.enabledAt)
		save(historyPath(state, number), { pick: entry.enabledAt, rounds: [] } satisfies History);
	await context.read(context.root, [
		"fetch",
		"--quiet",
		"--no-tags",
		baseRemote({ repository }),
		base.sha,
		removal.head,
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

	const checkout = mkdtempSync(join(state, "fix-"));
	try {
		const packs = prepare(
			context.root,
			checkout,
			[
				`${removal.head}:refs/heads/batch`,
				`${base.sha}:refs/heads/base`,
				`${removal.head}:refs/heads/pr-${number}`,
			],
			// Start at the base: the agent loads its instructions and tooling only from code already landed.
			base.sha,
		);
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

/** End a job: its checkout and its records go, and its output log stays for diagnosis on the host. */
function finish(path: string, job: WatchJob): void {
	if (job.checkout) rmSync(job.checkout, { recursive: true, force: true });
	rmSync(`${path}.exit`, { force: true });
	rmSync(path);
}

/**
 * Collect a finished round: record it in its pick's history, and either put the PR back in the queue,
 * at a fixed head or unchanged, or hand it back, as a stop rule, the fixer, or a refusal says. A
 * round whose pick ended while it ran is dropped, and the PR says so. Returns what it did.
 */
async function collect(
	github: GitHub,
	state: string,
	path: string,
	job: WatchJob,
	context: FixContext,
	deps: GitHubDependencies,
): Promise<string[]> {
	const { entry } = job;
	const number = entry.number;
	if (
		!job.result &&
		!job.error &&
		!job.handback &&
		!settle(path, job, deps, context.timeout, () => {
			job.result = parseFixResult(readFixResult(job.checkout), [number])[0];
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
	const announce = async (requeued: Requeue, result: FixResult): Promise<string[]> => {
		await note();
		const what = job.merged
			? `with ${job.base.ref} at ${job.base.sha} merged in by the quest merge driver`
			: result.action === "fixed"
				? `with the land fixer's fix (${fixerText(attribution)}): ${fixerText(result.reason)}`
				: `unchanged, since the land fixer judged the failure flaky: ${fixerText(result.failure ?? ("reason" in result ? result.reason : ""))}`;
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
	const ended =
		current !== entry.head && !ours
			? `its head moved to ${current} while the fixer ran, and a push by anyone but the land fixer ends the pick`
			: record?.pick !== entry.enabledAt || newer
				? "the pick it was fixing ended: the pull request was enqueued, or removed, again while the fixer ran"
				: queued(pull, job.dropped) && !ours && job.requeuing === undefined
					? "a maintainer enqueued it again while the fixer ran, and that pick stands"
					: undefined;
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
	const conflict = job.reason === "merge_conflict";
	const failure = conflict || !result ? job.failure : (result.failure ?? job.failure);
	if (!handback && result) {
		// Requeued unchanged, a failed build is flaky by the fixer's judgment; a conflict still conflicts.
		const outcome: Outcome = job.merged
			? "merged"
			: result.action === "fixed"
				? "fixed"
				: result.action === "requeue"
					? conflict
						? "unchanged"
						: "flaky"
					: "handback";
		const rule = stopRule(
			record!.rounds.filter((item) => item.job !== name),
			{ outcome, failure },
		);
		if (rule) handback = stopReason(rule, failure);
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
						await importFix(context.root, state, job, entry, job.checkout, job.packs, head, context.read);
					job.published = head;
					save(path, job);
				}
				await publishHead(github, context.root, job, entry, entry.head, current, head, deps, context.token, {
					reason: result.reason,
					attribution,
				});
			}
			if (job.requeuing === undefined) {
				job.requeuing = head;
				save(path, job);
			}
			job.requeued = await requeue(github, entry.id, head, job.dropped);
			save(path, job);
		} catch (failure) {
			if (!(failure instanceof FixerRefusal)) throw failure;
			handback = failure.message;
			if (failure.resolution) job.resolution = failure.resolution;
		}
	}

	if (job.requeued && result) return announce(job.requeued, result);
	// Anything else is a handback.
	await note();
	// Every handback ends the pick with a round of its own, a crash's or a timeout's too, so the App's
	// next enqueue of a head this pick put back starts a new pick.
	if (round?.outcome !== "handback") {
		const { after: _, ...rest } = round ?? { job: name, before: entry.head, failure };
		saveRound(state, number, history(state, number)!, { ...rest, outcome: "handback" });
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
		!handback && result?.action === "handback" && result.log ? cited(job.log, result.log) : fixerLog(path),
		job.reason,
		job.resolution ? (room) => resolutionSection(number, job.resolution!, room) : undefined,
	);
	finish(path, job);
	return [`handback ${number}`];
}

/** How `head` went back: enqueued, or armed to join the queue once its required checks pass. */
type Requeue = "enqueued" | "armed";

/**
 * Put `head` back in the merge queue, at the back. A PR queued or armed at it since the queue dropped
 * it, at `dropped`, needs nothing more: a restart finds its own request, and a workflow may pick the
 * fixer's push first. A refusal hands the PR back.
 */
async function requeue(github: GitHub, id: string, head: string, dropped: string): Promise<Requeue> {
	const how = (pull: ObjectValue): Requeue => (pull.mergeQueueEntry != null ? "enqueued" : "armed");
	let pull = await readPull(github, id);
	if (string(pull.headRefOid) !== head) throw new FixerRefusal("head moved before it was re-enqueued");
	if (!queued(pull, dropped)) {
		try {
			await queueHead(github, id, head, string(pull.mergeStateStatus));
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
