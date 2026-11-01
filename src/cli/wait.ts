// GitHub-specific PR activity waiting stays outside the repository-independent core.
import { createHash } from "node:crypto";

import {
	actor,
	array,
	GitHub,
	type GitHubDependencies,
	GitHubInputError,
	link,
	object,
	type ObjectValue,
	type PullRequest,
	requirements,
	string,
} from "./github";
import { LAND_CHECK } from "./land";
import { classifyCheck, enabledHead } from "./status";

const POLL = 5 * 60_000;
/**
 * The last poll before a timeout starts this long before it, leaving time for its few requests;
 * activity after it is left for the returned cursor. Polling only on the 5-minute schedule left
 * up to 5 minutes before a timeout unread. A longer X-Poll-Interval from GitHub still wins.
 */
const FINAL_POLL = 30_000;
/** The REST page size. A full last page cannot show by itself that a next page has appeared. */
const PAGE = 100;
/** How often setup rereads repository activity while GitHub has yet to list the head's push. */
const LISTING_POLL = 15_000;
const SHA = /^[a-f\d]{7,40}$/i;
/** The timeline records a force push a few seconds after repository activity (1-2s observed). */
const TIMELINE_LAG = 60_000;
/** Reactions on the PR body and on each review; the newest 100 per subject are enough to spot new ones. */
const REACTIONS = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
	viewer { login }
	repository(owner: $owner, name: $repo) {
		pullRequest(number: $number) {
			reactions(last: 100) { nodes { ...reaction } }
			reviews(first: 100, after: $after) {
				pageInfo { hasNextPage endCursor }
				nodes { url reactions(last: 100) { nodes { ...reaction } } }
			}
		}
	}
}
fragment reaction on Reaction { id content createdAt user { login } }`;
/** The head's check runs and commit statuses, with whether the base branch requires each. */
const CHECKS = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
	repository(owner: $owner, name: $repo) {
		pullRequest(number: $number) {
			baseRefName
			headRefOid
			headRefName
			headRepository { nameWithOwner }
			autoMergeRequest { enabledAt commitBody enabledBy { login } }
			commits(last: 1) { nodes { commit { oid statusCheckRollup {
				contexts(first: 100, after: $after) {
					pageInfo { hasNextPage endCursor }
					nodes {
						__typename
						... on CheckRun {
							name status conclusion completedAt detailsUrl isRequired(pullRequestNumber: $number)
							checkSuite { status workflowRun { file { path } } }
						}
						... on StatusContext { context state createdAt targetUrl isRequired(pullRequestNumber: $number) }
					}
				}
			} } } }
		}
	}
}`;

export interface WaitOptions {
	since?: string;
	/** Seconds; omitted means no deadline. */
	timeout?: number;
}

export class WaitTimeout extends Error {
	/** Where to resume, when the wait got far enough to know. */
	constructor(readonly cursor?: string) {
		super("timed out waiting for pull request activity");
	}
}

interface Activity {
	point: string;
	time: number;
	type: string;
	actor: string;
	url: string;
	id: string;
}

/** Each source is read separately, so each keeps its own position. */
type Source = "timeline" | "replies" | "reactions" | "edits";
const SOURCES: Source[] = ["timeline", "replies", "reactions", "edits"];
/** The newest event time read from a source, and the IDs of events at that time. */
interface Mark {
	time: number;
	ids: string[];
}

/** A cursor is a snapshot, since git timestamps cannot describe push order. */
interface Cursor {
	pr: string;
	marks: Record<Source, Mark>;
	commits: string[];
	/** Force pushes at or before the starting point, at their repository-activity time. */
	pushes: { sha: string; time: number }[];
	/** Check results reached at or after `since` are reported once per head, as `<sha>:<outcome>`. */
	checks: { since: number; reported: string[] };
}

/** The check names and workflow files a base branch requires. */
interface Needs {
	names: Set<string>;
	workflows: string[];
}

/** One check run or commit status on the head, with its result once it has one. */
interface Check {
	name: string;
	required: boolean;
	url: string | null;
	/** The workflow file a GitHub Actions job runs in. */
	workflow?: string;
	/** A GitHub Actions job whose workflow run has not finished, so it may still create jobs. */
	running: boolean;
	result?: { outcome: "passed" | "failed"; point: string; time: number };
}

/** Wait until activity, returning plain output lines. Network and time are injected. */
export async function waitForActivity(
	pr: PullRequest,
	options: WaitOptions,
	deps: GitHubDependencies,
): Promise<string[]> {
	const started = deps.now();
	const progress = { resume: options.since };
	try {
		return await watch(pr, options, deps, started, progress);
	} catch (error) {
		// This also covers a deadline expiring while a response body is read.
		if (options.timeout !== undefined && deps.now() - started >= options.timeout * 1000)
			throw new WaitTimeout(progress.resume);
		throw error;
	}
}

async function watch(
	pr: PullRequest,
	options: WaitOptions,
	deps: GitHubDependencies,
	started: number,
	progress: { resume?: string },
): Promise<string[]> {
	// Cursors are case-sensitive base64url; a recased one would otherwise be misreported as a bad timestamp.
	if (options.since && /^q1\./i.test(options.since) && !options.since.startsWith("q1."))
		throw new GitHubInputError(
			"invalid --since cursor: cursors start with lower-case q1.; pass it exactly as printed",
		);
	if (options.since && !options.since.startsWith("q1.") && !SHA.test(options.since)) {
		try {
			timestamp(options.since);
		} catch (error) {
			throw new GitHubInputError((error as Error).message);
		}
	}
	const name = `${pr.owner}/${pr.repo}#${pr.number}`;
	const base = `/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}`;
	const prUrl = `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`;
	const deadline = options.timeout === undefined ? Infinity : started + options.timeout * 1000;
	const github = new GitHub(deps, deadline);

	let cursor: Cursor;
	let historical: Activity[] = [];
	const baselineCommits = new Set<string>();
	let pushedTips: string[] = [];
	if (options.since?.startsWith("q1.")) {
		cursor = decodeCursor(options.since, name);
	} else {
		const pullResponse = await github.request(`${base}/pulls/${pr.number}`);
		const pull = object(await pullResponse.json());
		const head = object(pull.head);
		const currentSha = string(head.sha);
		// Until setup finishes, a timeout resumes from this head rather than whatever is pushed next.
		progress.resume = options.since ?? currentSha;
		// Verify the listing belongs to this exact head before treating it as
		// baseline membership. A racing push must never be silently swallowed.
		let commitsPath: string | undefined = `${base}/pulls/${pr.number}/commits?per_page=100`;
		let listedHead: string | undefined;
		while (commitsPath) {
			const { rows, response } = await github.list(commitsPath);
			for (const commit of rows) {
				listedHead = string(commit.sha);
				if (!fullSha(listedHead)) throw new Error("invalid GitHub commit SHA");
				baselineCommits.add(listedHead);
			}
			commitsPath = link(response, "next");
		}
		if (listedHead !== currentSha) {
			throw new Error(
				"cannot snapshot PR commits: head changed during setup, or GitHub's 250-commit listing limit was reached; rerun after checking the PR head",
			);
		}
		const point = options.since ?? currentSha;
		const shaPoint = SHA.test(point);
		const time = shaPoint ? undefined : timestamp(point);
		const isPoint = (row: ObjectValue) => string(row.after).startsWith(point.toLowerCase());
		let activities: ObjectValue[] = [];
		if (head.repo !== null) {
			const headRepo = object(head.repo);
			const fullName = string(headRepo.full_name);
			if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) throw new Error("invalid GitHub head repository");
			let warned = false;
			for (;;) {
				activities = [];
				let path: string | undefined =
					`/repos/${fullName}/activity?ref=${encodeURIComponent(string(head.ref))}&per_page=100`;
				while (path) {
					const { rows, response } = await github.list(path);
					activities.push(...rows);
					if (shaPoint ? rows.some(isPoint) : rows.some((row) => timestamp(string(row.timestamp)) <= time!))
						break;
					path = link(response, "next");
				}
				// The head was pushed, but GitHub lists a push seconds to minutes later (14s-6min observed),
				// so a wait started right after pushing reads the listing again until the push appears.
				if (!shaPoint || activities.some(isPoint) || !currentSha.startsWith(point.toLowerCase())) break;
				if (!warned) deps.warn(`GitHub has not listed the push of ${point} yet; waiting for it`);
				warned = true;
				await github.pause(LISTING_POLL);
			}
		} else if (shaPoint) {
			throw new Error("head repository was deleted; pass a timestamp with --since");
		}
		const pushed = activities.filter((row) =>
			["push", "force_push", "branch_creation"].includes(string(row.activity_type)),
		);
		const match = shaPoint ? pushed.find(isPoint) : undefined;
		if (shaPoint && !match) throw new Error(`cannot resolve push time for ${point}; pass a timestamp with --since`);
		const since = time ?? timestamp(string(match!.timestamp));
		// An explicit timestamp includes its own instant; a SHA point excludes its own push.
		const after = (row: ObjectValue) => {
			const pushedAt = timestamp(string(row.timestamp));
			return shaPoint ? pushedAt > since : pushedAt >= since;
		};
		// Force pushes are reported from the timeline alone, so one push prints once.
		const forced = pushed.filter((row) => string(row.activity_type) === "force_push");
		cursor = {
			pr: name,
			marks: {
				timeline: { time: since, ids: [] },
				replies: { time: since, ids: [] },
				reactions: { time: since, ids: [] },
				edits: { time: since, ids: [] },
			},
			commits: [],
			pushes: forced
				.filter((row) => !after(row))
				.map((row) => ({ sha: string(row.after), time: timestamp(string(row.timestamp)) })),
			checks: { since, reported: [] },
		};
		const plain = pushed.filter((row) => string(row.activity_type) !== "force_push" && after(row));
		// A push racing setup is reported once, as a push, not again as a new commit.
		pushedTips = plain.map((row) => string(row.after));
		for (const sha of pushedTips) baselineCommits.add(sha);
		historical = plain.map((row) => ({
			point: string(row.timestamp),
			time: timestamp(string(row.timestamp)),
			type: "pushed",
			actor: actor(row.actor),
			url: `https://github.com/${string(object(head.repo).full_name)}/commit/${string(row.after)}`,
			id: `push:${string(row.after)}:${string(row.timestamp)}`,
		}));
	}

	const seenCommits = new Set([...baselineCommits, ...cursor.commits]);
	// Activity found before a timeout is not printed, so resuming must find it again;
	// a push found during setup comes back as its new commit.
	progress.resume = encodeCursor({
		...cursor,
		commits: [...seenCommits].filter((sha) => !pushedTips.includes(sha)),
	});
	const seen = Object.fromEntries(SOURCES.map((source) => [source, new Set(cursor.marks[source].ids)])) as Record<
		Source,
		Set<string>
	>;
	const fresh = (source: Source, event: Activity) => {
		const mark = cursor.marks[source];
		return event.time > mark.time || (event.time === mark.time && !seen[source].has(event.id));
	};
	/**
	 * Read every page once, then poll the last page conditionally, following it when it fills. A 304
	 * has no Link header and the ETag covers only the body, so a full last page is reread whole to
	 * learn of a next one.
	 */
	const pager = (first: string) => {
		let path = first;
		let etag: string | undefined;
		return async (): Promise<ObjectValue[]> => {
			const rows: ObjectValue[] = [];
			for (;;) {
				const response = await github.request(path, { etag });
				if (response.status === 304) {
					if (!etag) throw new Error("unexpected GitHub 304 without a cached response");
					return rows;
				}
				const page = array(await response.json());
				rows.push(...page);
				const next = link(response, "next");
				if (!next) {
					etag = page.length < PAGE ? (response.headers.get("etag") ?? undefined) : undefined;
					return rows;
				}
				path = next;
				etag = undefined;
			}
		};
	};
	const graphql = (query: string, after: string | null) =>
		github.graphql(query, { owner: pr.owner, repo: pr.repo, number: pr.number, after });
	/** REST has no endpoint for reactions on reviews, and GraphQL also names the waiter. */
	const reactions = async (): Promise<{ viewer: string; events: Activity[] }> => {
		const events: Activity[] = [];
		let viewer: string;
		let after: string | null = null;
		do {
			const data = await graphql(REACTIONS, after);
			viewer = string(object(data.viewer).login);
			const pull = object(object(data.repository).pullRequest);
			const reviews = object(pull.reviews);
			const reacted = (owner: ObjectValue, url: string) =>
				array(object(owner.reactions).nodes).map((row) => reaction(row, url));
			if (after === null) events.push(...reacted(pull, prUrl));
			for (const review of array(reviews.nodes)) events.push(...reacted(review, string(review.url)));
			const page = object(reviews.pageInfo);
			after = page.hasNextPage === true ? string(page.endCursor) : null;
		} while (after !== null);
		return { viewer, events };
	};
	/** GraphQL says which checks the base branch requires, through branch protection or rulesets. */
	const checks = async (): Promise<
		{ head: string; base: string; checks: Check[]; pull: ObjectValue } | undefined
	> => {
		const result: Check[] = [];
		let head: string | undefined;
		let after: string | null = null;
		let pull: ObjectValue;
		do {
			pull = object(object((await graphql(CHECKS, after)).repository).pullRequest);
			const commit = object(array(object(pull.commits).nodes)[0]?.commit);
			// A push racing these pages is read whole on the next poll.
			if (commit.oid !== pull.headRefOid || (head !== undefined && commit.oid !== head)) return undefined;
			head = string(commit.oid);
			if (!fullSha(head)) throw new Error("invalid GitHub head SHA");
			if (commit.statusCheckRollup === null) break;
			const contexts = object(object(commit.statusCheckRollup).contexts);
			result.push(...array(contexts.nodes).map(check));
			const page = object(contexts.pageInfo);
			after = page.hasNextPage === true ? string(page.endCursor) : null;
		} while (after !== null);
		return { head: head!, base: string(pull.baseRefName), checks: result, pull };
	};
	/**
	 * What the base branch requires, read once per wait. Only a requirement says whether a missing
	 * check has yet to start, or whether the repository requires none. The gate's own check is never
	 * on a PR head, so a gated base waits only for the rest.
	 */
	const known = new Map<string, Needs>();
	const required = async (branch: string): Promise<Needs> => {
		const cached = known.get(branch);
		if (cached) return cached;
		const found = await requirements(github, pr, branch);
		const needs = {
			names: new Set(found.checks.map((check) => check.name).filter((name) => name !== LAND_CHECK)),
			workflows: found.workflows,
		};
		known.set(branch, needs);
		return needs;
	};

	/** The head each auto-merge request was enabled on, by when it was enabled, once that can be told. */
	const enabledHeads = new Map<string, string>();
	/** Warnings already printed, so a forbidden activity listing warns once per wait rather than per poll. */
	const warned = new Set<string>();
	const warnOnce = (message: string) => {
		if (!warned.has(message)) deps.warn(message);
		warned.add(message);
	};
	/** Auto-merge left on for a head other than `head`, reported once per head and request. */
	const movedAutoMerge = async (head: string, pull: ObjectValue): Promise<Activity[]> => {
		if (pull.autoMergeRequest == null) return [];
		const request = object(pull.autoMergeRequest);
		const enabledAt = string(request.enabledAt);
		const id = `${head}:auto-merge:${enabledAt}`;
		if (cursor.checks.reported.includes(id)) return [];
		const enabled = enabledHeads.get(enabledAt) ?? (await enabledHead(github, pull, warnOnce));
		if (enabled === null) return [];
		enabledHeads.set(enabledAt, enabled);
		if (enabled === head) return [];
		const point = new Date(deps.now()).toISOString();
		const url = `${prUrl}/commits/${enabled}`;
		return [{ point, time: deps.now(), type: "auto-merge:moved", actor: actor(request.enabledBy), url, id }];
	};

	const timeline = pager(`${base}/issues/${pr.number}/timeline?per_page=${PAGE}`);
	// `since` excludes its own instant and filters by update time, which is never before
	// creation; start a second early so unseen replies at the mark's second are still read.
	const comments = pager(
		`${base}/pulls/${pr.number}/comments?per_page=${PAGE}&since=${new Date(cursor.marks.replies.time - 1000).toISOString()}`,
	);
	// Issue comments are ordered by creation: an old comment can be edited on an
	// earlier page, so reread this update-filtered list from its first page.
	const edits = async () => {
		const rows: ObjectValue[] = [];
		let path: string | undefined =
			`${base}/issues/${pr.number}/comments?per_page=${PAGE}&since=${new Date(cursor.marks.edits.time - 1000).toISOString()}`;
		while (path) {
			const page = await github.list(path);
			rows.push(...page.rows);
			path = link(page.response, "next");
		}
		return rows;
	};
	const found: Record<Source, Activity[]> = { timeline: historical, replies: [], reactions: [], edits: [] };
	for (;;) {
		github.pollInterval = 0;
		const labels: Activity[] = [];
		for (const row of await timeline()) {
			const type = string(row.event);
			if (type === "committed") {
				const sha = string(row.sha);
				if (!fullSha(sha)) throw new Error("invalid GitHub committed SHA");
				if (!seenCommits.has(sha)) {
					found.timeline.push({
						point: sha,
						time: cursor.marks.timeline.time,
						type: "committed",
						actor: actor(row.actor ?? row.committer),
						url: string(row.html_url),
						id: `commit:${sha}`,
					});
				}
				seenCommits.add(sha);
				continue;
			}
			for (const event of timelineActivities(row, prUrl)) {
				if (
					type === "head_ref_force_pushed" &&
					cursor.pushes.some(
						(push) =>
							push.sha === row.commit_id &&
							event.time >= push.time &&
							event.time - push.time <= TIMELINE_LAG,
					)
				)
					continue;
				if (fresh("timeline", event)) (LABELS.includes(type) ? labels : found.timeline).push(event);
			}
		}
		const replies = await comments();
		const { viewer, events } = await reactions();
		// The waiter's own label changes, replies, and reactions never wake it.
		found.timeline.push(...labels.filter((event) => event.actor !== viewer));
		for (const row of replies) {
			// A thread's first comment belongs to a review, which the timeline reports.
			if (row.in_reply_to_id === undefined || row.in_reply_to_id === null) continue;
			const event = timedActivity(row, "replied", "created_at", prUrl);
			if (event.actor !== viewer && fresh("replies", event)) found.replies.push(event);
		}
		found.reactions.push(...events.filter((event) => event.actor !== viewer && fresh("reactions", event)));
		for (const row of await edits()) {
			if (timestamp(string(row.updated_at)) <= timestamp(string(row.created_at))) continue;
			const event = timedActivity(row, "edited", "updated_at", prUrl);
			// GitHub timestamps have second precision: two different edits in that
			// second remain distinct, without storing the comment text in a cursor.
			event.id += `:${createHash("sha256").update(string(row.body)).digest("hex")}`;
			if (event.actor !== viewer && fresh("edits", event)) found.edits.push(event);
		}
		// Check results are state rather than a log, so each poll reads them afresh.
		const head = await checks();
		const reached = head
			? [
					...checkActivities(head.head, head.checks, await required(head.base), cursor.checks, prUrl),
					...(await movedAutoMerge(head.head, head.pull)),
				]
			: [];

		if (reached.length || SOURCES.some((source) => found[source].length)) {
			const marks = Object.fromEntries(
				SOURCES.map((source) => {
					const mark = cursor.marks[source];
					const time = Math.max(mark.time, ...found[source].map((event) => event.time));
					const ids = [
						...(time === mark.time ? mark.ids : []),
						...found[source].filter((event) => event.time === time).map((event) => event.id),
					];
					return [source, { time, ids: [...new Set(ids)] }];
				}),
			) as Record<Source, Mark>;
			const nextCursor = encodeCursor({
				pr: name,
				marks,
				commits: [...seenCommits],
				pushes: cursor.pushes.filter((push) => push.time + TIMELINE_LAG >= marks.timeline.time),
				checks: {
					since: cursor.checks.since,
					// A new head starts over, so only the current head's reports are kept.
					reported: [
						...cursor.checks.reported.filter((id) => !head || id.startsWith(`${head.head}:`)),
						...reached.map((event) => event.id),
					],
				},
			});
			const all = [...SOURCES.flatMap((source) => found[source]), ...reached].sort((a, b) => a.time - b.time);
			const unique = [...new Map(all.map((event) => [event.id, event])).values()];
			return unique.map(
				(event, index) =>
					`${event.point} ${event.type} ${event.actor} ${event.url}${index === unique.length - 1 ? ` ${nextCursor}` : ""}`,
			);
		}
		// GitHub's X-Poll-Interval is a floor: the final poll shortens only the default schedule,
		// and is skipped when that interval runs past it.
		const remaining = deadline - deps.now();
		const next = Math.min(Math.max(POLL, github.pollInterval), remaining - FINAL_POLL);
		await github.pause(next > 0 && next >= github.pollInterval ? next : remaining);
	}
}

// A dequeue or a disabled auto-merge needs the agent. A merge also leaves the queue, a second before "merged".
// A label-driven queue dequeues by removing its label.
const LABELS = ["labeled", "unlabeled"];
const WAKES = [
	...LABELS,
	"reviewed",
	"commented",
	"merged",
	"closed",
	"head_ref_force_pushed",
	"removed_from_merge_queue",
	"auto_merge_disabled",
];

function timelineActivities(row: ObjectValue, prUrl: string): Activity[] {
	const type = string(row.event);
	if (type === "line-commented" || type === "commit-commented") {
		return array(row.comments).map((comment) => timedActivity(comment, type, "created_at", prUrl));
	}
	if (!WAKES.includes(type)) return [];
	if (LABELS.includes(type)) {
		const event = timedActivity(row, type, "created_at", prUrl);
		return [{ ...event, type: `${type}:${string(object(row.label).name).replace(/\s/g, "_")}` }];
	}
	return [timedActivity(row, type, type === "reviewed" ? "submitted_at" : "created_at", prUrl)];
}

/** A check run or commit status, classified as `quest status` does, with when it finished. */
function check(row: ObjectValue): Check {
	const run = row.__typename === "CheckRun";
	const { check: classified, outcome } = classifyCheck(row);
	const suite = run && row.checkSuite ? object(row.checkSuite) : undefined;
	const file = suite?.workflowRun ? object(suite.workflowRun).file : null;
	const found: Check = {
		name: classified.name,
		required: classified.required,
		url: classified.url,
		...(file ? { workflow: string(object(file).path) } : {}),
		running: suite?.workflowRun ? suite.status !== "COMPLETED" : false,
	};
	if (outcome === "pending") return found;
	const point = string(run ? row.completedAt : row.createdAt);
	found.result = { outcome: outcome === "passed" ? "passed" : "failed", point, time: timestamp(point) };
	return found;
}

/**
 * The head's first required failure, and every required check passing once the head is idle, each
 * reported once per head when reached at or after the starting point. A base branch that requires
 * no checks requires them all.
 */
function checkActivities(head: string, all: Check[], needs: Needs, state: Cursor["checks"], prUrl: string): Activity[] {
	const inWorkflow = (entry: Check) => entry.workflow !== undefined && needs.workflows.includes(entry.workflow);
	const required =
		needs.names.size || needs.workflows.length ? all.filter((entry) => entry.required || inWorkflow(entry)) : all;
	const reached = (
		outcome: "passed" | "failed",
		entry: Check | undefined,
		optional = false,
		at = entry?.result,
	): Activity[] => {
		const id = optional ? `${head}:optional:${entry?.name}:${entry?.url}:${at?.point}` : `${head}:${outcome}`;
		if (!entry?.result || !at || at.time < state.since || state.reported.includes(id)) return [];
		return [
			{
				point: at.point,
				time: at.time,
				type: `${optional ? "check" : "checks"}:${outcome}`,
				actor: entry.name.replace(/\s/g, "_"),
				url: entry.url ?? `${prUrl}/checks`,
				id,
			},
		];
	};
	const settled = required.flatMap((entry) => (entry.result ? [{ ...entry, result: entry.result }] : []));
	settled.sort((a, b) => a.result.time - b.result.time);
	const failed = settled.find((entry) => entry.result.outcome === "failed" && entry.result.time >= state.since);
	// A pass waits for the head to go idle, including jobs a running workflow
	// may still create. Its date is the last completion, but its name and link
	// always identify a required check that passed.
	const idle =
		all.every((entry) => entry.result && !entry.running) &&
		[...needs.names].every((name) => all.some((entry) => entry.name === name)) &&
		needs.workflows.every((path) => all.some((entry) => entry.workflow === path));
	const passed =
		idle && settled.length === required.length && settled.every((entry) => entry.result.outcome === "passed")
			? settled.at(-1)
			: undefined;
	const last = idle
		? all.reduce<Check | undefined>(
				(latest, entry) => (!latest || entry.result!.time >= latest.result!.time ? entry : latest),
				undefined,
			)
		: undefined;
	const optional = all.filter((entry) => !required.includes(entry) && entry.result?.outcome === "failed");
	return [
		...reached("failed", failed),
		...optional.flatMap((entry) => reached("failed", entry, true)),
		...reached("passed", passed, false, last?.result),
	];
}

function timedActivity(row: ObjectValue, type: string, timeField: string, fallback: string): Activity {
	const point = string(row[timeField]);
	const id = row.id;
	if (typeof id !== "number" && typeof id !== "string") throw new Error("missing GitHub event ID");
	return {
		point,
		time: timestamp(point),
		type,
		actor: actor(row.actor ?? row.user),
		url: row.html_url === undefined ? fallback : string(row.html_url),
		id: `${type}:${id}`,
	};
}

function reaction(row: ObjectValue, url: string): Activity {
	const point = string(row.createdAt);
	return {
		point,
		time: timestamp(point),
		type: `reacted:${string(row.content).toLowerCase()}`,
		actor: actor(row.user),
		url,
		id: `reacted:${string(row.id)}`,
	};
}

function timestamp(value: string): number {
	const result = Date.parse(value);
	if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(result))
		throw new Error(`invalid timestamp: ${value}; use an ISO 8601 timestamp, a pushed SHA, or a returned cursor`);
	return result;
}

function fullSha(value: unknown): boolean {
	return typeof value === "string" && /^[a-f\d]{40}$/i.test(value);
}

function encodeCursor(cursor: Cursor): string {
	return `q1.${Buffer.from(JSON.stringify(cursor)).toString("base64url")}`;
}

function decodeCursor(value: string, pr: string): Cursor {
	try {
		const parsed = object(JSON.parse(Buffer.from(value.slice(3), "base64url").toString("utf8")));
		const marks = object(parsed.marks);
		const checks = object(parsed.checks);
		// Older resumable cursors predate edited-comment tracking. Start that
		// source at the original baseline so an edit is never silently skipped.
		marks.edits ??= { time: checks.since, ids: [] };
		if (
			parsed.pr !== pr ||
			!SOURCES.every((source) => {
				const mark = object(marks[source]);
				return (
					typeof mark.time === "number" &&
					Number.isFinite(mark.time) &&
					Array.isArray(mark.ids) &&
					mark.ids.every((id) => typeof id === "string")
				);
			}) ||
			!Array.isArray(parsed.commits) ||
			!parsed.commits.every(fullSha) ||
			!Array.isArray(parsed.pushes) ||
			!parsed.pushes.every((push: ObjectValue | null) => fullSha(push?.sha) && Number.isFinite(push?.time)) ||
			!Number.isFinite(checks.since) ||
			!Array.isArray(checks.reported) ||
			!checks.reported.every((id) => typeof id === "string")
		)
			throw new Error();
		return parsed as unknown as Cursor;
	} catch {
		throw new GitHubInputError("invalid --since cursor, or cursor belongs to another pull request");
	}
}
