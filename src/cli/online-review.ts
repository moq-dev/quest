// How the online reviewers did on each PR, read from GitHub: any bot account whose review has a body or opens a
// thread, and any review whose
// body opens with `Automated review by <name>`, as a reviewer posting under a person's account does. A finding is a
// review thread one opens, or a `[P<n>]` line in its review body; whoever answers it says whether it was taken.
import { type GitHub, type ObjectValue, type Repository, array, object } from "./github";

/** One online reviewer's record on one PR. */
export interface OnlineReview {
	/** A bot's login, as `name[bot]`, or the name its review bodies give. */
	reviewer: string;
	/** It reviewed the PR's last head. */
	finalHead: boolean;
	findings: number;
	accepted: number;
	declined: number;
	/** Answered, but the answer opens with neither an accepting nor a declining word. */
	unclassified: number;
	unanswered: number;
}

type Answer = "accepted" | "declined" | "unclassified";

const ACCEPTED = new Set(["fixed", "agreed", "applied", "right", "confirmed", "covered", "taken"]);
const DECLINED = new Set(["declined", "declining", "refuted", "not"]);

/** Whether an answer takes or declines a finding, by its first word. */
export function classify(body: string): Answer {
	const word = /^[^A-Za-z]*([A-Za-z]+)/.exec(body)?.[1]?.toLowerCase() ?? "";
	return ACCEPTED.has(word) ? "accepted" : DECLINED.has(word) ? "declined" : "unclassified";
}

/**
 * The finding lines of a review body, `[P1] ...` or `P1 — ...` with a dash after the bare marker, in a list item or
 * bold or not, each keyed by its
 * title and how many earlier lines of the body share that title.
 */
export function bodyFindings(body: string): string[] {
	const seen = new Map<string, number>();
	return [
		...body.matchAll(
			/^[ \t]*(?:(?:[-*]|\d+[.)])[ \t]+)?(?:\*\*|__)?(?:\[P\d\]|P\d[ \t]+[—–-])(?:\*\*|__)?[ \t:—–-]*(\S.*)$/gm,
		),
	].map((match) => {
		// A later round that relists a finding repeats its title, or its location when it leads; the rest may change.
		const title = match[1]!
			.split(/ [—–] | \(|: |\. /)[0]!
			.replace(/[`*]|__/g, "")
			.replace(/\s+/g, " ")
			.trim()
			.toLowerCase();
		const count = seen.get(title) ?? 0;
		seen.set(title, count + 1);
		return count ? `${title} #${count + 1}` : title;
	});
}

const THREAD_COMMENT = "author { __typename login } authorAssociation body url pullRequestReview { id }";
const FIELDS = {
	reviews: "id url author { __typename login } authorAssociation body submittedAt commit { oid }",
	reviewThreads:
		"id isResolved resolvedBy { __typename login } " +
		`comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { ${THREAD_COMMENT} } }`,
	comments: "author { __typename login } authorAssociation body createdAt url",
} as const;
type Connection = keyof typeof FIELDS;
const CONNECTIONS = Object.keys(FIELDS) as Connection[];
const page = (name: Connection, after: string) =>
	`${name}(first: ${name === "reviewThreads" ? 50 : 100}${after}) { pageInfo { hasNextPage endCursor } nodes { ${FIELDS[name]} } }`;

/** PRs read per query; each brings at most 100 reviews, 50 threads of 100 comments, and 100 comments. */
const BATCH = 10;

/** A PR's last head and its committer date, and its reviews, review threads, and comments as GitHub's GraphQL API gives them. */
export type Activity = Record<Connection, ObjectValue[]> & { head: string; committed: string };

/** Each PR's reviews, review threads, and comments, and its head, read in batches and then in pages. */
export async function readActivity(
	client: GitHub,
	repository: Repository,
	numbers: number[],
): Promise<Map<number, Activity>> {
	const pulls = new Map<number, Activity>();
	const more: { number: number; cursors: Partial<Record<Connection, string>> }[] = [];
	for (let start = 0; start < numbers.length; start += BATCH) {
		const batch = numbers.slice(start, start + BATCH);
		const fields = `headRefOid commits(last: 1) { nodes { commit { oid committedDate } } } ${CONNECTIONS.map((name) => page(name, "")).join(" ")}`;
		const data = await client.graphql(
			`query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${batch
				.map((number) => `p${number}: pullRequest(number: ${number}) { ${fields} }`)
				.join(" ")} } }`,
			{ owner: repository.owner, name: repository.repo },
		);
		const found = object(data.repository);
		for (const number of batch) {
			const value = found[`p${number}`];
			if (value === null || value === undefined)
				throw new Error(`GitHub has no PR #${number} in ${repository.owner}/${repository.repo} for this token`);
			const pull = object(value);
			const commit = object(object(array(object(pull.commits).nodes)[0] ?? {}).commit ?? {});
			if (commit.oid !== pull.headRefOid)
				throw new Error(`the head of PR #${number} changed while it was read; retry`);
			const nodes = { head: String(pull.headRefOid), committed: String(commit.committedDate) } as Activity;
			const cursors: Partial<Record<Connection, string>> = {};
			for (const name of CONNECTIONS) {
				const connection = object(pull[name]);
				nodes[name] = array(connection.nodes);
				const info = object(connection.pageInfo);
				if (info.hasNextPage === true) cursors[name] = String(info.endCursor);
			}
			pulls.set(number, nodes);
			if (Object.keys(cursors).length) more.push({ number, cursors });
		}
	}
	for (const { number, cursors } of more) {
		const nodes = pulls.get(number)!;
		for (let left = cursors; Object.keys(left).length;) {
			const names = CONNECTIONS.filter((name) => left[name] !== undefined);
			const data = await client.graphql(
				`query($owner: String!, $name: String!, $number: Int!, ${names.map((name) => `$${name}: String!`).join(", ")}) { ` +
					`repository(owner: $owner, name: $name) { pullRequest(number: $number) { headRefOid ${names
						.map((name) => page(name, `, after: $${name}`))
						.join(" ")} } } }`,
				{ owner: repository.owner, name: repository.repo, number, ...left },
			);
			const pull = object(object(data.repository).pullRequest);
			// A later page may hold a review of a head pushed since the first read, which that head would misjudge.
			if (pull.headRefOid !== nodes.head)
				throw new Error(`the head of PR #${number} changed while it was read; retry`);
			const next: Partial<Record<Connection, string>> = {};
			for (const name of names) {
				const connection = object(pull[name]);
				nodes[name].push(...array(connection.nodes));
				const info = object(connection.pageInfo);
				if (info.hasNextPage === true) next[name] = String(info.endCursor);
			}
			left = next;
		}
	}
	// A long thread's later comments matter when none of its first hundred answers it.
	for (const nodes of pulls.values())
		for (const thread of nodes.reviewThreads) {
			const comments = object(thread.comments);
			const all = array(comments.nodes);
			for (let info = object(comments.pageInfo); info.hasNextPage === true;) {
				const data = await client.graphql(
					"query($id: ID!, $after: String!) { node(id: $id) { ... on PullRequestReviewThread { " +
						`comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${THREAD_COMMENT} } } } } }`,
					{ id: String(thread.id), after: String(info.endCursor) },
				);
				const page = object(object(data.node).comments);
				all.push(...array(page.nodes));
				info = object(page.pageInfo);
			}
			thread.comments = { nodes: all };
		}
	return pulls;
}

/** An account's login, a bot's as `name[bot]`, which GraphQL gives a bot author without the suffix. */
export function login(actor: unknown): string | null {
	if (actor === null || actor === undefined) return null;
	const { __typename, login } = object(actor);
	if (typeof login !== "string") return null;
	return __typename === "Bot" && !login.endsWith("[bot]") ? `${login}[bot]` : login;
}

/** Whose review this is: the name its body opens with, else its bot author, else nobody's. */
export function reviewerOf(review: ObjectValue): string | null {
	const named = /^Automated review by (.+)/.exec(typeof review.body === "string" ? review.body : "");
	if (named) return named[1]!.trim();
	return object(review.author ?? {}).__typename === "Bot" ? login(review.author) : null;
}

/** Whether an author is a bot account, such as a reviewer or the land watcher, whose comments answer nothing. */
export const isBot = (actor: unknown) => actor != null && object(actor).__typename === "Bot";

/** The anchor GitHub links a review by. */
const ANCHOR = /#pullrequestreview-\w+/g;

/** Each online reviewer's record on one PR, from its reviews, threads, and comments. */
export function onlineReviews(pull: Activity): OnlineReview[] {
	const reviews = pull.reviews.map((review) => ({
		id: String(review.id),
		url: String(review.url),
		reviewer: reviewerOf(review),
		body: typeof review.body === "string" ? review.body : "",
		at: Date.parse(String(review.submittedAt)),
		commit: review.commit ? String(object(review.commit).oid) : null,
	}));
	const byId = new Map(reviews.map((review) => [review.id, review]));
	const records = new Map<string, OnlineReview>();
	const record = (reviewer: string) => {
		let found = records.get(reviewer);
		if (!found) {
			found = {
				reviewer,
				finalHead: false,
				findings: 0,
				accepted: 0,
				declined: 0,
				unclassified: 0,
				unanswered: 0,
			};
			records.set(reviewer, found);
		}
		return found;
	};
	const tally = (reviewer: string, answer: Answer | "unanswered") => {
		const found = record(reviewer);
		found.findings++;
		found[answer]++;
	};

	// A review that only replies in threads has an empty body; one that opens a thread or has a body is a pass.
	const opened = new Set<string>();
	for (const thread of pull.reviewThreads) {
		const [first, ...replies] = array(object(thread.comments).nodes);
		const opener = first?.pullRequestReview ? byId.get(String(object(first.pullRequestReview).id)) : undefined;
		const reviewer = opener?.reviewer;
		if (!opener || !reviewer) continue;
		opened.add(opener.id);
		// A named reviewer posts under a person's account, so only its own reviews tell its replies from an answer.
		const own = (comment: ObjectValue) =>
			opener.body.startsWith("Automated review by")
				? comment.pullRequestReview != null &&
					byId.get(String(object(comment.pullRequestReview).id))?.reviewer === reviewer
				: login(comment.author) === reviewer;
		const answer = replies.find((reply) => !own(reply));
		if (answer) tally(reviewer, classify(String(answer.body ?? "")));
		else
			tally(
				reviewer,
				thread.isResolved === true && login(thread.resolvedBy) === reviewer ? "accepted" : "unanswered",
			);
	}

	const passes = reviews
		.filter((review) => review.reviewer !== null && (review.body.trim() !== "" || opened.has(review.id)))
		.sort((a, b) => a.at - b.at);
	for (const pass of passes) {
		const found = record(pass.reviewer!);
		if (pass.commit === pull.head) found.finalHead = true;
	}

	// A body finding is one title across a reviewer's passes; a pass after its last listing no longer finds it.
	const listed = new Map<string, { reviewer: string; last: number; answer: Answer | null }>();
	const lists = passes.map((pass, index) => {
		const titles = bodyFindings(pass.body);
		for (const title of titles) {
			const id = JSON.stringify([pass.reviewer, title]);
			listed.set(id, { reviewer: pass.reviewer!, last: index, answer: listed.get(id)?.answer ?? null });
		}
		return titles.map((title) => JSON.stringify([pass.reviewer, title]));
	});
	// A comment answers each pass it links, else the latest before it with findings, when it links one or its first
	// word takes a side; a reviewer bot's own comments, such as its summaries and outage notices, answer nothing.
	const reviewers = new Set(passes.map((pass) => pass.reviewer));
	for (const comment of [...pull.comments].sort(
		(a, b) => Date.parse(String(a.createdAt)) - Date.parse(String(b.createdAt)),
	)) {
		const author = login(comment.author);
		if (author !== null && reviewers.has(author)) continue;
		if (isBot(comment.author)) continue;
		const body = String(comment.body ?? "");
		const at = Date.parse(String(comment.createdAt));
		const links = new Set([...body.matchAll(ANCHOR)].map((match) => match[0]));
		const answer = classify(body);
		let targets = passes.flatMap((pass, index) =>
			links.has(pass.url.slice(pass.url.lastIndexOf("#"))) ? [index] : [],
		);
		if (!targets.length && answer !== "unclassified") {
			for (const [index, pass] of passes.entries()) if (pass.at <= at && lists[index]!.length) targets = [index];
		}
		for (const target of targets)
			for (const id of lists[target]!) {
				const finding = listed.get(id)!;
				finding.answer ??= answer;
			}
	}
	for (const finding of listed.values()) {
		const later = passes.some((pass, index) => index > finding.last && pass.reviewer === finding.reviewer);
		tally(finding.reviewer, finding.answer ?? (later ? "accepted" : "unanswered"));
	}

	return [...records.values()].sort((a, b) => a.reviewer.localeCompare(b.reviewer));
}

/** Each PR's online reviews, by number. */
export async function readOnlineReviews(
	client: GitHub,
	repository: Repository,
	numbers: number[],
): Promise<Map<number, OnlineReview[]>> {
	const pulls = await readActivity(client, repository, numbers);
	return new Map([...pulls].map(([number, pull]) => [number, onlineReviews(pull)]));
}
