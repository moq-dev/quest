// How the online reviewers did on each PR, read from GitHub: any bot account whose review has a body or opens a
// thread, and any review whose
// body opens with `Automated review by <name>`, as a reviewer posting under a person's account does. A finding is a
// review thread one opens, or a `[P<n>]` line in its review body; whoever answers it says whether it was taken.
// The repository's own online reviewer, which REVIEW.md names, also gates `quest merge`: see {@link onlineGate}.
import {
	type GitHub,
	GitHubDeadline,
	type ObjectValue,
	type PullRequest,
	type Repository,
	array,
	link,
	object,
	string,
} from "./github";

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
 * The finding lines of a review body, `[P1] ...` or `P1 — ...` with a dash after the bare marker, each keyed by its
 * title and how many earlier lines of the body share that title.
 */
export function bodyFindings(body: string): string[] {
	const seen = new Map<string, number>();
	return [...body.matchAll(/^[ \t]*(?:[-*][ \t]+)?(?:\[P\d\]|P\d[ \t]+[—–-])[ \t:—–-]*(\S.*)$/gm)].map((match) => {
		// A later round that relists a finding repeats its title, or its location when it leads; the rest may change.
		const title = match[1]!
			.split(/ [—–] | \(|: |\. /)[0]!
			.replaceAll("`", "")
			.replace(/\s+/g, " ")
			.trim()
			.toLowerCase();
		const count = seen.get(title) ?? 0;
		seen.set(title, count + 1);
		return count ? `${title} #${count + 1}` : title;
	});
}

const THREAD_COMMENT = "author { __typename login } body url pullRequestReview { id }";
const FIELDS = {
	reviews: "id url state author { __typename login } body submittedAt commit { oid }",
	reviewThreads:
		"id isResolved resolvedBy { __typename login } " +
		`comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { ${THREAD_COMMENT} } }`,
	comments: "author { __typename login } body createdAt",
} as const;
type Connection = keyof typeof FIELDS;
const CONNECTIONS = Object.keys(FIELDS) as Connection[];
const page = (name: Connection, after: string) =>
	`${name}(first: ${name === "reviewThreads" ? 50 : 100}${after}) { pageInfo { hasNextPage endCursor } nodes { ${FIELDS[name]} } }`;

/** PRs read per query; each brings at most 100 reviews, 50 threads of 100 comments, and 100 comments. */
const BATCH = 10;

/** A PR's last head, and its reviews, review threads, and comments as GitHub's GraphQL API gives them. */
export type Activity = Record<Connection, ObjectValue[]> & { head: string };

/** Each PR's reviews, review threads, and comments, and its head, read in batches and then in pages. */
async function read(client: GitHub, repository: Repository, numbers: number[]): Promise<Map<number, Activity>> {
	const pulls = new Map<number, Activity>();
	const more: { number: number; cursors: Partial<Record<Connection, string>> }[] = [];
	for (let start = 0; start < numbers.length; start += BATCH) {
		const batch = numbers.slice(start, start + BATCH);
		const fields = `headRefOid ${CONNECTIONS.map((name) => page(name, "")).join(" ")}`;
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
			const nodes = { head: String(pull.headRefOid) } as Activity;
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
					`repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${names
						.map((name) => page(name, `, after: $${name}`))
						.join(" ")} } } }`,
				{ owner: repository.owner, name: repository.repo, number, ...left },
			);
			const pull = object(object(data.repository).pullRequest);
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
function login(actor: unknown): string | null {
	if (actor === null || actor === undefined) return null;
	const { __typename, login } = object(actor);
	if (typeof login !== "string") return null;
	return __typename === "Bot" && !login.endsWith("[bot]") ? `${login}[bot]` : login;
}

/** Whose review this is: the name its body opens with, else its bot author, else nobody's. */
function reviewerOf(review: ObjectValue): string | null {
	const named = /^Automated review by (.+)/.exec(typeof review.body === "string" ? review.body : "");
	if (named) return named[1]!.trim();
	return object(review.author ?? {}).__typename === "Bot" ? login(review.author) : null;
}

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
	const pulls = await read(client, repository, numbers);
	return new Map([...pulls].map(([number, pull]) => [number, onlineReviews(pull)]));
}

/** The key of REVIEW.md's front matter that names the repository's online reviewer. */
const DECLARATION = "online-reviewer";

/**
 * The online reviewer REVIEW.md's front matter names, such as `pullfrog[bot]`, or null when it names none.
 * A key given twice or left empty throws, so a typo cannot silently drop the gate.
 */
export function reviewerIn(text: string): string | null {
	const matter = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
	if (!matter) return null;
	const lines = matter[1]!.split(/\r?\n/).filter((line) => line.startsWith(`${DECLARATION}:`));
	if (lines.length === 0) return null;
	if (lines.length > 1) throw new Error(`REVIEW.md names its ${DECLARATION} more than once`);
	const value = lines[0]!
		.slice(DECLARATION.length + 1)
		.trim()
		.replace(/^(["'])(.*)\1$/, "$2")
		.trim();
	if (value === "") throw new Error(`REVIEW.md's ${DECLARATION} is empty`);
	return value;
}

/** The online reviewer REVIEW.md names at `ref`, read from GitHub so a PR cannot drop its own gate; null for none. */
export async function declaredReviewer(client: GitHub, repository: Repository, ref: string): Promise<string | null> {
	const response = await client.request(
		`/repos/${repository.owner}/${repository.repo}/contents/REVIEW.md?ref=${encodeURIComponent(ref)}`,
		{ accept: "application/vnd.github.raw", allow: [404] },
	);
	return response.status === 404 ? null : reviewerIn(await response.text());
}

/**
 * Whether two commits have the same diff from `base` (`git diff <base>...<sha>`), or null when GitHub cannot
 * compare one, such as a diff too large to render; `warn` says why.
 */
export async function sameDiff(
	client: GitHub,
	repository: Repository,
	base: string,
	shas: [string, string],
	warn: (message: string) => void,
): Promise<boolean | null> {
	const diffs: string[] = [];
	for (const sha of shas) {
		let response: Response;
		try {
			response = await client.request(
				`/repos/${repository.owner}/${repository.repo}/compare/${encodeURIComponent(base)}...${sha}`,
				{ accept: "application/vnd.github.diff", allow: [404, 406, 422] },
			);
		} catch (error) {
			// A deadline is the caller's to handle; a forbidden or failing compare is not.
			if (error instanceof GitHubDeadline || !(error instanceof Error)) throw error;
			warn(`cannot compare ${sha} with ${base}: ${error.message}`);
			return null;
		}
		if (!response.ok) {
			warn(`cannot compare ${sha} with ${base}: GitHub answered ${response.status}`);
			return null;
		}
		diffs.push(await response.text());
	}
	return diffs[0] === diffs[1];
}

/** Where the repository's online reviewer stands on a PR's head, as {@link onlineGate} reads it. */
export interface OnlineGate {
	reviewer: string;
	/** The PR's head when it was read. */
	head: string;
	/**
	 * `current`: it reviewed the head, in a review of it or a successful check run of its own app on it, which a
	 * re-review that finds nothing new leaves without a review; `diff-identical`: its latest review is of an earlier head
	 * whose diff from the base matches the head's; `running`: its app's check on the head has not finished;
	 * `missing`: none of these.
	 */
	state: "current" | "diff-identical" | "running" | "missing";
	/** The head it reviewed, or null. */
	reviewed: string | null;
	/** Each review thread it opened on the PR, on any head, that neither it nor a writer resolved, by URL. */
	open: string[];
}

/** Permissions that can push, the only ones besides the reviewer's own whose resolution settles a finding. */
const PUSH = ["admin", "maintain", "write"];

/**
 * How `reviewer`, the repository's online reviewer, stands on `pr`'s head against `base`: whether it reviewed the head
 * or a diff-identical one, and which of its findings, its review threads, are still open. GitHub lets the PR's author
 * resolve a thread too, so a resolution counts only from the reviewer or an account that can push.
 */
export async function onlineGate(
	client: GitHub,
	pr: PullRequest,
	reviewer: string,
	base: string,
	warn: (message: string) => void,
): Promise<OnlineGate> {
	const pull = (await read(client, pr, [pr.number])).get(pr.number)!;
	const head = pull.head;
	const pushers = new Map<string, boolean>();
	const canPush = async (account: string) => {
		if (!pushers.has(account)) {
			const response = await client.request(
				`/repos/${pr.owner}/${pr.repo}/collaborators/${encodeURIComponent(account)}/permission`,
				{ allow: [404] },
			);
			pushers.set(
				account,
				response.status !== 404 && PUSH.includes(string(object(await response.json()).permission)),
			);
		}
		return pushers.get(account)!;
	};
	// A bot's reviews are its own account's; a named reviewer's body names it under a writer's account, which only a
	// writer's own review may claim, so no one else can forge its review.
	// Its own reviews, dismissed ones included, whose threads stay its findings; a pending one is no one else's to see.
	const ids = new Set<string>();
	for (const review of pull.reviews) {
		if (reviewerOf(review) !== reviewer || review.state === "PENDING") continue;
		const author = login(review.author);
		if (reviewer.endsWith("[bot]") ? author === reviewer : author !== null && (await canPush(author)))
			ids.add(String(review.id));
	}
	const opened = new Set(
		pull.reviewThreads.flatMap((thread) => {
			const review = array(object(thread.comments).nodes)[0]?.pullRequestReview;
			return review ? [String(object(review).id)] : [];
		}),
	);
	// A pass over a head has a body or opens a thread; a reply in an older thread also makes an empty review of the
	// head without reviewing it, and a dismissed review is withdrawn.
	const reviews = pull.reviews
		.filter(
			(review) =>
				ids.has(String(review.id)) &&
				review.state !== "DISMISSED" &&
				(String(review.body ?? "").trim() !== "" || opened.has(String(review.id))),
		)
		.map((review) => ({
			commit: review.commit ? string(object(review.commit).oid) : null,
			at: Date.parse(String(review.submittedAt)),
		}))
		.sort((a, b) => a.at - b.at);

	const open: string[] = [];
	for (const thread of pull.reviewThreads) {
		const first = array(object(thread.comments).nodes)[0];
		if (!first?.pullRequestReview || !ids.has(String(object(first.pullRequestReview).id))) continue;
		const resolver = thread.isResolved === true ? login(thread.resolvedBy) : null;
		if (resolver === null || (resolver !== reviewer && !(await canPush(resolver))))
			open.push(String(first.url ?? ""));
	}

	const gate = (state: OnlineGate["state"], reviewed: string | null): OnlineGate => ({
		reviewer,
		head,
		state,
		reviewed,
		open,
	});
	if (reviews.some((review) => review.commit === head)) return gate("current", head);
	// A GitHub App's bot is `<slug>[bot]`; GitHub lists only each check's latest run. GitHub Actions' app runs every
	// workflow job, so its checks say nothing of a review.
	const slug = /^(.+)\[bot\]$/.exec(reviewer)?.[1];
	let running = false;
	if (slug !== undefined && slug !== "github-actions") {
		for (
			let path: string | undefined = `/repos/${pr.owner}/${pr.repo}/commits/${head}/check-runs?per_page=100`;
			path;
		) {
			const response = await client.request(path);
			for (const run of array(object(await response.json()).check_runs)) {
				if (run.app == null || object(run.app).slug !== slug) continue;
				if (run.status !== "completed") running = true;
				else if (run.conclusion === "success") return gate("current", head);
			}
			path = link(response, "next");
		}
	}
	const last = reviews.filter((review) => review.commit !== null).at(-1);
	if (last && (await sameDiff(client, pr, base, [head, last.commit!], warn)))
		return gate("diff-identical", last.commit);
	return gate(running ? "running" : "missing", null);
}

/** Why `quest merge` refuses `gate`'s head, or null when the online reviewer's review lets it land. */
export function onlineRefusal(gate: OnlineGate): string | null {
	const who = `${gate.reviewer}, the online reviewer REVIEW.md names,`;
	if (gate.state === "running") return `${who} is still reviewing it; land it once its check finishes`;
	if (gate.state === "missing")
		return `${who} has not reviewed it or a head with the same diff; land it once it has, asking it to review if it does not start`;
	if (gate.open.length > 0)
		return `${who} has findings no writer resolved: ${gate.open.join(", ")}; fix or refute each in its thread and resolve it, then land it again`;
	return null;
}
