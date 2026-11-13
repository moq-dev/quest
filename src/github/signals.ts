// What holds a PR's head from landing besides its checks: an online reviewer's finding on the head that no writer has
// answered, and a maintainer decision recorded in a comment after the head was committed that nothing has answered.
import { type GitHub, type ObjectValue, type Repository, array, object, string } from "./client";
import { type Activity, bodyFindings, isBot, login, readActivity, reviewerOf } from "./online-review";

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

/** The picked heads whose signals a later commit carries unread, and when the pick was made. */
export interface Carried {
	heads: string[];
	picked: string;
}

/**
 * The marker a comment's first line opens with to record a maintainer decision, after markup such as `**` but not in
 * a quote or code, which four leading spaces or a tab also start.
 */
export const DECISION = /^ {0,3}(?![ \t])[^A-Za-z>`~\n]*Maintainer decision\b/i;

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

/** Whether `body` links `url`'s anchor whole, not as the start of a longer ID such as `#issuecomment-90` for `-9`. */
const links = (body: string, url: string) =>
	body
		.split(anchorOf(url))
		.slice(1)
		.some((rest) => !/^[\w-]/.test(rest));

/**
 * The signals holding `pull`'s head, given which accounts can push to its repository. A finding is an online
 * reviewer's, from its latest pass over the head: a review thread it opened that is unresolved with no writer's reply,
 * or a `[P<n>]` line of that pass's body that no writer's later comment links. A
 * decision is a writer's comment opening with {@link DECISION}, posted after the head was committed, that no writer's
 * later comment links: a head committed before a decision cannot have applied it. A bot is never a writer.
 * `carried` names heads a writer picked that a commit since carries forward unread, such as the land fixer's: findings on
 * them hold too, and so does a decision posted after its pick.
 */
export function signals(pull: Activity, writers: ReadonlySet<string>, carried?: Carried): Signal[] {
	const writer = (actor: unknown) => !isBot(actor) && writers.has(login(actor) ?? "");
	const found: Signal[] = [];
	const heads = new Set([pull.head, ...(carried?.heads ?? [])]);
	const reviews = pull.reviews.map((review) => ({
		id: String(review.id),
		url: String(review.url),
		// A review names its reviewer in its body only under a bot's or a writer's account, so a forged one replaces nothing.
		reviewer: isBot(review.author) || writer(review.author) ? reviewerOf(review) : null,
		body: typeof review.body === "string" ? review.body : "",
		at: Date.parse(String(review.submittedAt)),
		commit: review.commit != null ? String(object(review.commit).oid) : "",
		// A dismissed review is withdrawn: it holds nothing.
		head: review.state !== "DISMISSED" && review.commit != null && heads.has(String(object(review.commit).oid)),
	}));
	const byId = new Map(reviews.map((review) => [review.id, review]));
	const opened = new Set(
		pull.reviewThreads.flatMap((thread) => {
			const review = array(object(thread.comments).nodes)[0]?.pullRequestReview;
			return review ? [String(object(review).id)] : [];
		}),
	);
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
		// A named reviewer posts under a person's account, so only its name, on the reply or the review holding it, tells
		// its replies from an answer.
		const own = (comment: ObjectValue) =>
			opener.body.startsWith("Automated review by") &&
			(reviewerOf(comment) === opener.reviewer ||
				(comment.pullRequestReview != null &&
					byId.get(String(object(comment.pullRequestReview).id))?.reviewer === opener.reviewer));
		if (replies.some((reply) => !own(reply) && writer(reply.author))) continue;
		found.push({
			kind: "finding",
			url: String(first!.url ?? opener.url),
			author: opener.reviewer,
			text: firstLine(String(first!.body ?? "")),
		});
	}

	// Each reviewer's latest pass over each head lists what it still finds there; a pass may only open threads. A late
	// pass over a carried head says nothing of another.
	const latest = new Map<string, (typeof reviews)[number]>();
	for (const review of reviews)
		if (review.reviewer !== null && review.head && (review.body.trim() !== "" || opened.has(review.id))) {
			const key = `${review.reviewer}\n${review.commit}`;
			const prior = latest.get(key);
			if (!prior || prior.at <= review.at) latest.set(key, review);
		}
	const passes = [...latest.values()]
		.map((pass) => ({ ...pass, titles: bodyFindings(pass.body).map((finding) => finding.title), answered: false }))
		.filter((pass) => pass.titles.length > 0)
		.sort((a, b) => a.at - b.at);
	// A writer answers a pass by linking it; an answer word alone cannot tell which finding it meant.
	for (const pass of passes)
		pass.answered = comments.some(
			(comment) => comment.writer && comment.at >= pass.at && links(comment.body, pass.url),
		);
	for (const pass of passes)
		if (!pass.answered)
			for (const title of pass.titles)
				found.push({ kind: "finding", url: pass.url, author: pass.reviewer!, text: title });

	const committed = Math.min(Date.parse(pull.committed), carried ? Date.parse(carried.picked) : Infinity);
	for (const decision of comments) {
		if (!decision.writer || !DECISION.test(decision.body) || decision.at <= committed) continue;
		if (comments.some((reply) => reply.writer && reply.at > decision.at && links(reply.body, decision.url)))
			continue;
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

/** The signals on each PR's current head, by number, with the head they were read for, and those `carried` carries. */
export async function readSignals(
	client: GitHub,
	repository: Repository,
	numbers: number[],
	carried?: ReadonlyMap<number, Carried>,
): Promise<Map<number, { head: string; signals: Signal[] }>> {
	const pulls = await readActivity(client, repository, numbers);
	for (const [number, pull] of pulls)
		if (pull.moved) throw new Error(`the head of PR #${number} changed while it was read; retry`);
	const actors = [...pulls.values()].flatMap((pull) => [
		...pull.reviews.map((review) => ({ actor: review.author, association: review.authorAssociation })),
		...pull.comments.map((comment) => ({ actor: comment.author, association: comment.authorAssociation })),
		...pull.reviewThreads.flatMap((thread) =>
			array(object(thread.comments).nodes).map((comment) => ({
				actor: comment.author,
				association: comment.authorAssociation,
			})),
		),
	]);
	const writers = await writersOf(client, repository, actors);
	return new Map(
		[...pulls].map(([number, pull]) => [
			number,
			{ head: pull.head, signals: signals(pull, writers, carried?.get(number)) },
		]),
	);
}

/** Signals as one line each, for a refusal or a comment. */
export function describe(found: Signal[]): string {
	return found.map((signal) => `${signal.kind} by ${signal.author}: ${signal.text} (${signal.url})`).join("; ");
}
