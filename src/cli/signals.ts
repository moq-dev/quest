// What holds a PR's head from landing besides its checks: an online reviewer's finding on the head that nobody has
// answered, and a maintainer decision recorded in a comment after the head was committed that nothing has answered.
import type { GitHub, ObjectValue, Repository } from "./github";
import { array, object } from "./github";
import { type Activity, bodyFindings, classify, isBot, login, readActivity, reviewerOf } from "./online-review";

/** One signal on a PR's head that holds it from landing until it is fixed or answered. */
export interface Signal {
	/** `finding`: an online reviewer's, on the head. `decision`: a marked comment newer than the head's commit. */
	kind: "finding" | "decision";
	/** The review, thread, or comment that raised it. */
	url: string;
	author: string;
	/** The finding's title or thread's first line, or the decision's first line. */
	text: string;
}

/** The marker a comment opens with to record a maintainer decision, after any markup such as `**`. */
export const DECISION = /^[^A-Za-z]*Maintainer decision\b/i;

/** Comment author associations of accounts with write access, whose decisions and answers count. */
const WRITERS = ["OWNER", "MEMBER", "COLLABORATOR"];

/** A body's first line of prose, past markup such as a bot's HTML comments, cut short. */
const firstLine = (body: string) =>
	body
		.replace(/<!--[\s\S]*?-->|<[^>\n]*>/g, "")
		.split("\n")
		.map((line) => line.replace(/\*\*\s*\*\*/g, "").trim())
		.find((line) => /[A-Za-z]/.test(line))
		?.slice(0, 120) ?? "";

/**
 * The signals holding `pull`'s head. A finding is an online reviewer's, from its latest pass over the head: a review
 * thread it opened that is unresolved with no reply from anyone else, or a `[P<n>]` line of that pass's body that no
 * later comment answers, by linking the pass or taking a side in its first word as `online-review` reads answers. A
 * decision is a comment by a writer opening with {@link DECISION}, posted after the head was committed, that no
 * writer's later comment links: a head committed before a decision cannot have applied it.
 */
export function signals(pull: Activity): Signal[] {
	const found: Signal[] = [];
	const reviews = pull.reviews.map((review) => ({
		id: String(review.id),
		url: String(review.url),
		reviewer: reviewerOf(review),
		author: login(review.author) ?? "-",
		body: typeof review.body === "string" ? review.body : "",
		at: Date.parse(String(review.submittedAt)),
		head: review.commit != null && String(object(review.commit).oid) === pull.head,
	}));
	const byId = new Map(reviews.map((review) => [review.id, review]));
	const comments = [...pull.comments]
		.map((comment) => ({
			author: comment.author,
			writer: WRITERS.includes(String(comment.authorAssociation)) && !isBot(comment.author),
			body: String(comment.body ?? ""),
			url: String(comment.url ?? ""),
			at: Date.parse(String(comment.createdAt)),
		}))
		.sort((a, b) => a.at - b.at);

	for (const thread of pull.reviewThreads) {
		if (thread.isResolved === true) continue;
		const [first, ...replies] = array(object(thread.comments).nodes);
		const opener = first?.pullRequestReview ? byId.get(String(object(first.pullRequestReview).id)) : undefined;
		if (!opener?.reviewer || !opener.head) continue;
		// A named reviewer posts under a person's account, so only its own reviews tell its replies from an answer.
		const own = (comment: ObjectValue) =>
			opener.body.startsWith("Automated review by")
				? comment.pullRequestReview != null &&
					byId.get(String(object(comment.pullRequestReview).id))?.reviewer === opener.reviewer
				: login(comment.author) === opener.reviewer;
		if (replies.some((reply) => !own(reply))) continue;
		found.push({
			kind: "finding",
			url: String(first!.url ?? opener.url),
			author: opener.reviewer,
			text: firstLine(String(first!.body ?? "")),
		});
	}

	// Each reviewer's latest pass over the head lists what it still finds there.
	const latest = new Map<string, (typeof reviews)[number]>();
	for (const review of reviews)
		if (review.reviewer !== null && review.head && review.body.trim() !== "") {
			const prior = latest.get(review.reviewer);
			if (!prior || prior.at <= review.at) latest.set(review.reviewer, review);
		}
	const reviewers = new Set(reviews.flatMap((review) => (review.reviewer === null ? [] : [review.reviewer])));
	for (const pass of latest.values()) {
		const titles = bodyFindings(pass.body);
		if (!titles.length) continue;
		const anchor = pass.url.slice(pass.url.lastIndexOf("#"));
		const answered = comments.some(
			(comment) =>
				comment.at >= pass.at &&
				!isBot(comment.author) &&
				!reviewers.has(login(comment.author) ?? "") &&
				(comment.body.includes(anchor) || classify(comment.body) !== "unclassified"),
		);
		if (answered) continue;
		for (const title of titles) found.push({ kind: "finding", url: pass.url, author: pass.reviewer!, text: title });
	}

	const committed = pull.committed === undefined ? Number.NaN : Date.parse(pull.committed);
	for (const decision of comments) {
		if (!decision.writer || !DECISION.test(decision.body)) continue;
		// An unknown commit time cannot show the head applied it.
		if (decision.at <= committed) continue;
		const anchor = decision.url.slice(decision.url.lastIndexOf("#"));
		if (comments.some((reply) => reply.writer && reply.at > decision.at && reply.body.includes(anchor))) continue;
		found.push({
			kind: "decision",
			url: decision.url,
			author: login(decision.author) ?? "-",
			text: firstLine(decision.body),
		});
	}
	return found;
}

/** The signals on each PR's current head, by number, with the head they were read for. */
export async function readSignals(
	client: GitHub,
	repository: Repository,
	numbers: number[],
): Promise<Map<number, { head: string; signals: Signal[] }>> {
	const pulls = await readActivity(client, repository, numbers);
	return new Map([...pulls].map(([number, pull]) => [number, { head: pull.head, signals: signals(pull) }]));
}

/** Signals as one line each, for a refusal or a comment. */
export function describe(found: Signal[]): string {
	return found.map((signal) => `${signal.kind} by ${signal.author}: ${signal.text} (${signal.url})`).join("; ");
}
