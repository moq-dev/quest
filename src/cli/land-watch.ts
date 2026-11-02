// The merge queue watcher: notice each PR GitHub's merge queue drops unmerged, record why, and say so on it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	array,
	GitHub,
	type GitHubDependencies,
	link,
	object,
	type ObjectValue,
	type Repository,
	string,
} from "./github";
import type { Entry } from "./land";
import { fixerText, post, redactTokens } from "./land-fixer";
import {
	apiDependencies,
	daemonLoop,
	EXCERPT,
	excerpt,
	type Failure,
	installationToken,
	save,
	startDaemon,
} from "./land-serve";

export interface WatchOptions {
	base?: string;
	/** Empty for the default, `defaultState`, which `quest land serve` shares. */
	state: string;
	appId: string;
}

/**
 * What a removal means for its pick: the fixer's to take (`fix`), or the end of the pick, left alone
 * until a writer enqueues the PR again: a push since the queue dropped it (`pushed`), a person's
 * removal (`removed`), or a reason the watcher does not know (`unrecognized`).
 */
export type Verdict = "fix" | "pushed" | "removed" | "unrecognized";

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
	failure?: Failure;
}

/** The watcher's progress, in `watch.json`. */
interface Progress {
	/** The start of the last complete pass; each pass reads the removals since `SETTLE` before it. */
	since: string;
	/** Per open PR: its latest handled removal's time, and every removal handled at that time. */
	handled: Record<number, { at: string; ids: string[] }>;
}

/** How far back of the last pass each pass reads again, for an event GitHub shows late. */
export const SETTLE = 10 * 60_000;
/** How long before a removal its `merge_group` runs are looked for, when its enqueue is unknown. */
const LOOKBACK = 24 * 60 * 60_000;
/** Conclusions of a run or job that failed its build. */
const FAILED = ["failure", "timed_out", "startup_failure"];
/** GitHub's removal reasons that a fixer can act on. */
const FIXABLE = ["failed_checks", "checks_timed_out", "merge_conflict"];

const REMOVALS = `pageInfo { hasNextPage endCursor }
	nodes {
		... on RemovedFromMergeQueueEvent {
			id createdAt reason actor { login } enqueuer { login } beforeCommit { oid }
		}
	}`;

const OPEN = `query($owner: String!, $name: String!, $base: String!, $qualified: String!, $since: DateTime!, $after: String) {
	repository(owner: $owner, name: $name) {
		ref(qualifiedName: $qualified) { target { oid } }
		pullRequests(states: OPEN, baseRefName: $base, first: 50, after: $after) {
			pageInfo { hasNextPage endCursor }
			nodes {
				id number url title headRefOid headRefName maintainerCanModify
				headRepository { nameWithOwner }
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
const account = (login: string) => login.replace(/\[bot\]$/, "");
const login = (value: unknown) => (value == null ? "" : string(object(value).login));

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
 * The pick a removal belongs to: the latest enqueue at or before it by anyone but the App, which only
 * enqueues within a pick, and the latest enqueue of any kind, from which its builds are looked for.
 */
async function pickOf(
	github: GitHub,
	id: string,
	removal: ObjectValue,
	app: string,
): Promise<{ pick: QueuePick; queued?: string }> {
	const at = string(removal.createdAt);
	const data = await github.graphql(ENQUEUES, { id });
	const enqueues = array(object(object(data.node).timelineItems).nodes).filter(
		(node) => typeof node.createdAt === "string" && node.createdAt <= at,
	);
	const writer = enqueues.filter((node) => account(login(node.actor)) !== app).at(-1);
	const queued = enqueues.at(-1)?.createdAt as string | undefined;
	if (writer)
		return {
			pick: { by: login(writer.enqueuer) || login(writer.actor), at: string(writer.createdAt) },
			...(queued ? { queued } : {}),
		};
	return { pick: { by: login(removal.enqueuer), at: queued ?? at }, ...(queued ? { queued } : {}) };
}

/** A job log as GitHub serves it, without its byte-order mark or per-line timestamps, and with no token. */
function cleanLog(text: string): string {
	return redactTokens(text.replace(/^\uFEFF/, "").replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z /gm, ""));
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
	const runs: ObjectValue[] = [];
	const created = encodeURIComponent(`${from}..${at}`);
	for (
		let next: string | undefined =
			`/repos/${repository}/actions/runs?event=merge_group&created=${created}&per_page=100`;
		next;
	) {
		const response = await github.request(next);
		runs.push(
			...array(object(await response.json()).workflow_runs).filter(
				(run) => string(run.head_branch).startsWith(prefix) && string(run.created_at) <= at,
			),
		);
		next = link(response, "next");
	}
	runs.sort((a, b) => string(a.created_at).localeCompare(string(b.created_at)));
	const last = runs.at(-1);
	if (!last) return { jobs: [] };
	const group = string(last.head_branch);
	const jobs: (FailedJob & { log: string })[] = [];
	for (const run of runs.filter((item) => item.head_sha === last.head_sha)) {
		const listing = object(
			await (
				await github.request(
					`/repos/${repository}/actions/runs/${Number(run.id)}/jobs?filter=latest&per_page=100`,
				)
			).json(),
		);
		for (const job of array(listing.jobs)) {
			const conclusion = typeof job.conclusion === "string" ? job.conclusion : null;
			const running = job.status !== "completed";
			if (!(conclusion !== null && FAILED.includes(conclusion)) && !(timedOut && running)) continue;
			const step = array(job.steps ?? []).find(
				(item) => typeof item.conclusion === "string" && FAILED.includes(item.conclusion),
			);
			let log = "";
			if (!running) {
				const response = await github.request(`/repos/${repository}/actions/jobs/${Number(job.id)}/logs`, {
					allow: [404, 410],
				});
				log = response.ok
					? cleanLog(await response.text())
					: `(GitHub has no log for this job: HTTP ${response.status})`;
			}
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
	return { jobs, base: group.slice(prefix.length) };
}

/** Why the queue dropped the PR, as the comment's first sentence ends. */
function because(reason: string, actor: string, base: string): string {
	switch (reason) {
		case "failed_checks":
			return "its `merge_group` build failed";
		case "checks_timed_out":
			return "its `merge_group` checks timed out";
		case "merge_conflict":
			return `it conflicts with ${fixerText(base)}`;
		case "manual":
			return `${fixerText(actor)} removed it`;
		default:
			return `of ${fixerText(reason)}`;
	}
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

/** What the watcher does about it, if anything it needs to say. */
const AFTER: Record<Verdict, (current: string) => string> = {
	fix: () => "",
	pushed: (current) =>
		`\n\nIts head has moved to ${current} since, and a push by anyone but the land fixer ends the pick: the watcher leaves this pull request alone until a maintainer enqueues it again.`,
	removed: () =>
		"\n\nA person's removal ends the pick: the watcher leaves this pull request alone until a maintainer enqueues it again.",
	unrecognized: () =>
		"\n\nThe watcher does not recognize this reason, so it leaves this pull request alone until a maintainer enqueues it again.",
};

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
	pull: ObjectValue,
	event: ObjectValue,
): Promise<string | undefined> {
	const reason = string(event.reason).toLowerCase();
	const actor = login(event.actor);
	if (reason === "merged" || account(actor) === app) return undefined;
	const number = Number(pull.number);
	const current = string(pull.headRefOid);
	const head = event.beforeCommit == null ? current : string(object(event.beforeCommit).oid);
	const at = string(event.createdAt);
	const { pick, queued } = await pickOf(github, string(pull.id), event, app);
	const verdict: Verdict =
		head !== current
			? "pushed"
			: reason === "manual"
				? "removed"
				: FIXABLE.includes(reason)
					? "fix"
					: "unrecognized";
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

	const log = join(state, `removal-${number}-${at.replace(/[^0-9TZ]/g, "")}.log`);
	const summary = `The merge queue removed ${string(pull.url)} at ${head} for ${reason} (${actor || "unknown"}), on ${base.ref} at ${built}.`;
	writeFileSync(
		log,
		[
			summary,
			...build.jobs.map(
				(job) =>
					`\n== ${job.workflow} / ${job.name}: ${job.conclusion}${job.step ? ` at step ${job.step}` : ""} (${job.url}) ==\n${job.log}`,
			),
			"",
		].join("\n"),
		{ mode: 0o600 },
	);

	const share = Math.floor(EXCERPT / Math.max(1, build.jobs.length));
	const blocks = build.jobs.map(
		(job) =>
			`\n\n${fixerText(`${job.workflow} / ${job.name}`)} ([job](${job.url})) ${job.conclusion}${job.step ? ` at step ${fixerText(job.step)}` : ""}${job.log ? `:\n\n<pre>${excerpt(job.log.trimEnd(), share)}</pre>` : "."}`,
	);
	const missing =
		build.jobs.length === 0 && reason !== "merge_conflict" && FIXABLE.includes(reason)
			? `\n\nThe watcher found no failing \`merge_group\` job for it before ${at}.`
			: "";
	await post(
		github,
		{ repository },
		{ number, enabledAt: pick.at },
		`quest land watch: the merge queue removed this pull request at ${head} because ${because(reason, actor, base.ref)} (\`${reason.replace(/[^a-z_]/g, "")}\`).${AFTER[verdict](current)}${missing}`,
		`removed ${string(event.id)}`,
		"quest land watch",
		undefined,
		(room) => jobsSection(blocks, room),
	);

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
					} satisfies Failure,
				}
			: {}),
	};
	save(join(state, `removal-${number}.json`), removal);
	return `removed ${number} ${reason} ${verdict}`;
}

/** The latest removal the watcher recorded for PR `number`, if any. */
export function readRemoval(state: string, number: number): Removal | undefined {
	const path = join(state, `removal-${number}.json`);
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Removal) : undefined;
}

/**
 * One pass over the base's open PRs: handle each removal from the merge queue since the last pass,
 * oldest first, and remember each one handled, so a restart neither misses nor repeats one. The
 * first pass starts `SETTLE` before it. A PR closed before a pass reads its removal is not read.
 */
export async function watchPass(
	repository: Repository,
	options: Pick<WatchOptions, "base" | "state">,
	deps: GitHubDependencies,
): Promise<string[]> {
	const github = new GitHub(deps);
	const name = `${repository.owner}/${repository.repo}`;
	const path = join(options.state, "watch.json");
	const started = new Date(deps.now()).toISOString();
	const progress: Progress = existsSync(path)
		? (JSON.parse(readFileSync(path, "utf8")) as Progress)
		: { since: started, handled: {} };
	const since = new Date(Date.parse(progress.since) - SETTLE).toISOString();
	const ref =
		options.base ??
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
			const handled = progress.handled[number];
			if (handled && (at < handled.at || (at === handled.at && handled.ids.includes(id)))) continue;
			const line = await handle(github, name, { ref, sha: sha! }, options.state, app, pull, event);
			if (line) output.push(line);
			progress.handled[number] = handled?.at === at ? { at, ids: [...handled.ids, id] } : { at, ids: [id] };
			save(path, progress);
		}
	}
	for (const number of Object.keys(progress.handled).map(Number))
		if (!open.has(number)) delete progress.handled[number];
	progress.since = started;
	save(path, progress);
	return output;
}

/** Watch the merge queue of `repository`'s base, one pass a minute, until the process stops. */
export async function watch(
	root: string,
	repository: Repository,
	options: WatchOptions,
	warn: (text: string) => void,
): Promise<void> {
	const unlock = await startDaemon(root, repository, options);
	try {
		const deps = apiDependencies(
			() =>
				installationToken(
					repository,
					options,
					{ contents: "read", pull_requests: "write", actions: "read" },
					{ fetch, now: Date.now },
				),
			{ fetch, now: Date.now, sleep, warn },
		);
		await daemonLoop(async () => {
			for (const line of await watchPass(repository, options, deps)) warn(line);
			return false;
		}, deps);
	} finally {
		unlock();
	}
}
