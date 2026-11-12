// What holds a PR's head from landing besides its checks: an online reviewer's finding on the head that no writer has
// answered, and a maintainer decision recorded in a comment after the head was committed that nothing has answered.
import { type GitHub, type ObjectValue, type Repository, array, object, string } from "./github";
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

/** The marker a comment opens with to record a maintainer decision, after markup such as `**` but not in a quote. */
export const DECISION = /^[^A-Za-z>]*Maintainer decision\b/i;

/** Repository permissions that can push, whose decisions and answers count. */
const WRITE = ["admin", "maintain", "write"];

/** A body's first line of prose, past markup such as a bot's HTML comments and images, cut short. */
const firstLine = (body: string) =>
	body
		.replace(/<!--[\s\S]*?-->|<[^>\n]*>/g, "")
		.split("\n")
		.map((line) => line.replace(/\*\*|__/g, "").trim())
		.find((line) => /[A-Za-z]/.test(line))
		?.slice(0, 120) ?? "";

/** The `#...` anchor of a GitHub URL. */
const anchorOf = (url: string) => url.slice(url.lastIndexOf("#"));

/**
 * The signals holding `pull`'s head, given which accounts can push to its repository. A finding is an online
 * reviewer's, from its latest pass over the head: a review thread it opened that is unresolved with no writer's reply,
 * or a `[P<n>]` line of that pass's body that no writer's later comment answers. A comment answers each pass it links,
 * else, when its first word takes a side as `online-review` reads answers, the latest pass before it with findings. A
 * decision is a writer's comment opening with {@link DECISION}, posted after the head was committed, that no writer's
 * later comment links: a head committed before a decision cannot have applied it. A bot is never a writer.
 */
export function signals(pull: Activity, writers: ReadonlySet<string>): Signal[] {
	const writer = (actor: unknown) => !isBot(actor) && writers.has(login(actor) ?? "");
	const found: Signal[] = [];
	const reviews = pull.reviews.map((review) => ({
		id: String(review.id),
		url: String(review.url),
		reviewer: reviewerOf(review),
		body: typeof review.body === "string" ? review.body : "",
		at: Date.parse(String(review.submittedAt)),
		head: review.commit != null && String(object(review.commit).oid) === pull.head,
	}));
	const byId = new Map(reviews.map((review) => [review.id, review]));
	const comments = pull.comments
		.map((comment) => ({
			author: comment.author,
			writer: writer(comment.author),
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
			opener.body.startsWith("Automated review by") &&
			comment.pullRequestReview != null &&
			byId.get(String(object(comment.pullRequestReview).id))?.reviewer === opener.reviewer;
		if (replies.some((reply) => !own(reply) && writer(reply.author))) continue;
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
	const passes = [...latest.values()]
		.map((pass) => ({ ...pass, titles: bodyFindings(pass.body), answered: false }))
		.filter((pass) => pass.titles.length > 0)
		.sort((a, b) => a.at - b.at);
	for (const comment of comments) {
		if (!comment.writer) continue;
		const linked = passes.filter((pass) => comment.at >= pass.at && comment.body.includes(anchorOf(pass.url)));
		const targets =
			linked.length > 0
				? linked
				: classify(comment.body) === "unclassified"
					? []
					: passes.filter((pass) => pass.at <= comment.at).slice(-1);
		for (const pass of targets) pass.answered = true;
	}
	for (const pass of passes)
		if (!pass.answered)
			for (const title of pass.titles)
				found.push({ kind: "finding", url: pass.url, author: pass.reviewer!, text: title });

	const committed = Date.parse(pull.committed);
	for (const decision of comments) {
		if (!decision.writer || !DECISION.test(decision.body) || decision.at <= committed) continue;
		const anchor = anchorOf(decision.url);
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

/**
 * Which of `logins` can push to `repository`. An author association of OWNER can; MEMBER and COLLABORATOR may only
 * read, so their permission is read; any other association cannot.
 */
async function writersOf(
	client: GitHub,
	repository: Repository,
	actors: { actor: unknown; association: unknown }[],
): Promise<Set<string>> {
	const writers = new Set<string>();
	const asked = new Set<string>();
	for (const { actor, association } of actors) {
		const name = login(actor);
		if (name === null || isBot(actor)) continue;
		if (association === "OWNER") writers.add(name);
		else if ((association === "MEMBER" || association === "COLLABORATOR") && !asked.has(name)) {
			asked.add(name);
			const response = await client.request(
				`/repos/${repository.owner}/${repository.repo}/collaborators/${encodeURIComponent(name)}/permission`,
				{ allow: [404] },
			);
			if (response.status !== 404 && WRITE.includes(string(object(await response.json()).permission)))
				writers.add(name);
		}
	}
	return writers;
}

/** The signals on each PR's current head, by number, with the head they were read for. */
export async function readSignals(
	client: GitHub,
	repository: Repository,
	numbers: number[],
): Promise<Map<number, { head: string; signals: Signal[] }>> {
	const pulls = await readActivity(client, repository, numbers);
	const actors = [...pulls.values()].flatMap((pull) => [
		...pull.comments.map((comment) => ({ actor: comment.author, association: comment.authorAssociation })),
		...pull.reviewThreads.flatMap((thread) =>
			array(object(thread.comments).nodes).map((comment) => ({
				actor: comment.author,
				association: comment.authorAssociation,
			})),
		),
	]);
	const writers = await writersOf(client, repository, actors);
	return new Map([...pulls].map(([number, pull]) => [number, { head: pull.head, signals: signals(pull, writers) }]));
}

/** Signals as one line each, for a refusal or a comment. */
export function describe(found: Signal[]): string {
	return found.map((signal) => `${signal.kind} by ${signal.author}: ${signal.text} (${signal.url})`).join("; ");
}
