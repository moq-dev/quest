// A repository's landing queues, read from GitHub alone: GitHub's merge queue
// on a base that has one, and otherwise the watcher's own queue (`quest land
// watch`). Order and builds come from the open pull requests; drops and the
// fixer's outcomes from the watcher's marked comments, which it posts in both
// modes. Everything here is untrusted GitHub content, rendered as text.

/** The check run each pick in the watcher's own queue carries; `QUEUE_CHECK` in `src/cli/land-queue.ts`. */
export const QUEUE_CHECK = "quest queue";

/** How far back a repository's comments are read for drops. */
export const DROP_WINDOW = 24 * 60 * 60_000;

const contexts = `contexts(first: 100) { nodes { __typename
 ... on CheckRun { status detailsUrl } ... on StatusContext { state targetUrl } } }`;

/** One page of a repository's open pull requests, with what landing order and builds need. */
export const OPEN_PULLS = `query($owner: String!, $name: String!, $after: String) { repository(owner: $owner, name: $name) {
 pullRequests(states: OPEN, first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes {
  number title url baseRefName isMergeQueueEnabled autoMergeRequest { enabledAt }
  mergeQueueEntry { position state headCommit { statusCheckRollup { ${contexts} } } }
  commits(last: 1) { nodes { commit { checkSuites(first: 10, filterBy: { checkName: "${QUEUE_CHECK}" }) { nodes {
   checkRuns(first: 1, filterBy: { checkName: "${QUEUE_CHECK}" }) { nodes { status title detailsUrl } } } } } } } } } } }`;

/** The fields read about a pull request a drop names, which may have closed since. */
export const DROPPED_FIELDS = "number title url baseRefName isMergeQueueEnabled";

type Rollup = {
	contexts: {
		nodes: ({
			__typename: string;
			status?: string;
			detailsUrl?: string | null;
			state?: string;
			targetUrl?: string | null;
		} | null)[];
	};
} | null;
/** A pull request as `OPEN_PULLS` reads it. */
export type OpenPull = {
	number: number;
	title: string;
	url: string;
	baseRefName: string;
	isMergeQueueEnabled: boolean | null;
	autoMergeRequest: { enabledAt: string } | null;
	mergeQueueEntry: { position: number; state: string; headCommit: { statusCheckRollup: Rollup } | null } | null;
	commits: {
		nodes: {
			commit: {
				checkSuites: {
					nodes: {
						checkRuns: { nodes: { status: string; title: string | null; detailsUrl: string | null }[] };
					}[];
				} | null;
			};
		}[];
	};
};
/** A pull request a drop names, as `DROPPED_FIELDS` reads it. */
export type DroppedPull = Pick<OpenPull, "number" | "title" | "url" | "baseRefName" | "isMergeQueueEnabled">;
/** An issue comment, as GitHub's REST API lists them. */
export type Comment = {
	html_url: string;
	issue_url: string;
	body?: string | null;
	created_at: string;
	author_association?: string;
	user: { type?: string } | null;
};

export type PullRef = { number: number; title: string; url: string };
/** A pull request in a base's queue, in landing order. */
export type QueueEntry = PullRef & {
	/** Where it stands, as GitHub or the watcher's queue check says. */
	status: string;
	/** Its build in progress, when it has one, and the run to follow. */
	build: { url: string | null } | null;
};
/** What became of a dropped pick: the watcher's next word on it. */
export type Outcome = {
	kind: "requeued" | "handback" | "ended" | "refused" | "held";
	text: string;
	url: string;
	at: string;
};
export type Drop = {
	pull: PullRef;
	/** GitHub's removal reason, such as `merge_conflict`, or null when the comment names none. */
	reason: string | null;
	text: string;
	/**
	 * What the watcher said it does next, in the removal comment itself: the fixer taking it, or
	 * why the pick ends there, as for a hold, a push, or a person's removal, which get no later word.
	 */
	next: string | null;
	url: string;
	at: string;
	outcome: Outcome | null;
};
export type LandingQueue = {
	base: string;
	mode: "merge-queue" | "own";
	entries: QueueEntry[];
	drops: Drop[];
};

const MARKER = /<!-- quest land fixer: (\S+) (removed|requeued|handback|ended|refused|held)\b[^>]*-->/;
const OUTCOMES = new Set<Outcome["kind"]>(["requeued", "handback", "ended", "refused", "held"]);

/** The comment's first paragraph as one bounded line, without the watcher's prefix. */
function excerpt(body: string) {
	return line(body.split(/\n\s*\n/, 1)[0] ?? "");
}
function line(text: string) {
	return text
		.replace(/^quest land watch: /, "")
		.replace(/[\x00-\x1f\x7f]+/g, " ")
		.trim()
		.slice(0, 300);
}

/** A removal comment's second paragraph when it is prose, rather than its failing jobs' logs or its marker. */
function next(body: string) {
	const second = body.split(/\n\s*\n/)[1];
	return second && /^[A-Z]/.test(second) ? line(second) : null;
}

/** A watcher comment on a pull request: a drop or an outcome. Only an app or a writer speaks for the watcher. */
type Said = { number: number; pick: string; kind: "removed" | Outcome["kind"]; body: string; url: string; at: string };
function said(comment: Comment): Said | null {
	const trusted =
		comment.user?.type === "Bot" || ["OWNER", "MEMBER", "COLLABORATOR"].includes(comment.author_association ?? "");
	const match = trusted && typeof comment.body === "string" ? MARKER.exec(comment.body) : null;
	const number = Number(comment.issue_url.split("/").at(-1));
	if (!match || !Number.isSafeInteger(number) || number < 1) return null;
	return {
		number,
		pick: match[1]!,
		kind: match[2] as Said["kind"],
		body: comment.body!,
		url: comment.html_url,
		at: comment.created_at,
	};
}

/** The pull request numbers the comments' drops name, which the open pull requests may not include. */
export function droppedNumbers(comments: Comment[]): number[] {
	return [...new Set(comments.flatMap((c) => (said(c)?.kind === "removed" ? [said(c)!.number] : [])))];
}

/** The URL of a merge group's build to follow: its first unfinished check, else its first. */
function buildURL(rollup: Rollup): string | null {
	const nodes = (rollup?.contexts.nodes ?? []).flatMap((node) => {
		if (!node) return [];
		const run = node.__typename === "CheckRun";
		const url = run ? node.detailsUrl : node.targetUrl;
		if (!url) return [];
		return [
			{ url, pending: run ? node.status !== "COMPLETED" : node.state === "PENDING" || node.state === "EXPECTED" },
		];
	});
	const url = (nodes.find((node) => node.pending) ?? nodes[0])?.url ?? null;
	// An Actions check links its job; the run holds every job of the build.
	return url?.replace(/(\/actions\/runs\/\d+)\/job\/\d+$/, "$1") ?? null;
}

const QUEUE_STATES: Record<string, string> = {
	QUEUED: "Queued",
	AWAITING_CHECKS: "Building",
	MERGEABLE: "Passed, merging",
	UNMERGEABLE: "Failing",
	LOCKED: "Merging",
};

/**
 * Each base's queue: its pull requests in landing order with their builds, and the drops since
 * `since`, newest first, each with the watcher's outcome. Bases with nothing queued or dropped are left out.
 */
export function landingQueues(
	open: OpenPull[],
	dropped: DroppedPull[],
	comments: Comment[],
	since: number,
): LandingQueue[] {
	const queues = new Map<string, LandingQueue>();
	const queue = (base: string, mergeQueue: boolean) => {
		let found = queues.get(base);
		if (!found)
			queues.set(base, (found = { base, mode: mergeQueue ? "merge-queue" : "own", entries: [], drops: [] }));
		if (mergeQueue) found.mode = "merge-queue";
		return found;
	};
	const ref = (pull: DroppedPull): PullRef => ({ number: pull.number, title: pull.title, url: pull.url });

	// GitHub's queue in position order, then the picks armed to join it once their checks pass.
	const queued = open
		.filter((pull) => pull.mergeQueueEntry)
		.sort((a, b) => a.mergeQueueEntry!.position - b.mergeQueueEntry!.position);
	for (const pull of queued) {
		const entry = pull.mergeQueueEntry!;
		const building = entry.state === "AWAITING_CHECKS";
		queue(pull.baseRefName, true).entries.push({
			...ref(pull),
			status: QUEUE_STATES[entry.state] ?? entry.state.toLowerCase(),
			build: building ? { url: buildURL(entry.headCommit?.statusCheckRollup ?? null) } : null,
		});
	}
	const armed = open
		.filter((pull) => pull.autoMergeRequest && !pull.mergeQueueEntry)
		.sort((a, b) => Date.parse(a.autoMergeRequest!.enabledAt) - Date.parse(b.autoMergeRequest!.enabledAt));
	for (const pull of armed) {
		if (pull.isMergeQueueEnabled) {
			queue(pull.baseRefName, true).entries.push({
				...ref(pull),
				status: "Waiting on its checks to join",
				build: null,
			});
			continue;
		}
		// The own queue's order is the order picks were armed; its check says where each stands.
		const run = pull.commits.nodes[0]?.commit.checkSuites?.nodes.flatMap((suite) => suite.checkRuns.nodes)[0];
		const live = run && run.status !== "COMPLETED" ? run : null;
		queue(pull.baseRefName, false).entries.push({
			...ref(pull),
			status: live?.title ?? "Waiting on its checks",
			build: live?.status === "IN_PROGRESS" ? { url: live.detailsUrl } : null,
		});
	}
	// A base whose open picks all left still shows its recent drops in its own mode.
	const pulls = new Map<number, DroppedPull>([...dropped, ...open].map((pull) => [pull.number, pull]));

	const words = comments
		.flatMap((comment) => said(comment) ?? [])
		.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
	words.forEach((word, i) => {
		if (word.kind !== "removed" || Date.parse(word.at) < since) return;
		const pull = pulls.get(word.number);
		if (!pull) return;
		// The outcome is the watcher's next word on the same pick, before any later drop of it.
		let outcome: Outcome | null = null;
		for (const next of words.slice(i + 1)) {
			if (next.number !== word.number || next.pick !== word.pick) continue;
			if (next.kind === "removed") break;
			outcome = { kind: next.kind, text: excerpt(next.body), url: next.url, at: next.at };
			break;
		}
		queue(pull.baseRefName, pull.isMergeQueueEnabled === true).drops.unshift({
			pull: ref(pull),
			reason: /\(`([a-z_]+)`\)/.exec(word.body)?.[1] ?? null,
			text: excerpt(word.body),
			next: next(word.body),
			url: word.url,
			at: word.at,
			outcome,
		});
	});
	return [...queues.values()].sort((a, b) => a.base.localeCompare(b.base));
}
