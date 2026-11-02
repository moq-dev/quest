// `quest iterate`, `ready`, `merge`, and `release`: one session works on a PR at
// a time. It holds the `quest:active` label, and the ID of the timeline event
// that added the label is its hold token, since sessions often share an account.
// `quest merge` takes no label: the pinned auto-merge it enables is the queue signal.
import { ACTIVE_LABEL, handedBack, isHoldLabel, latestHold, heldToken } from "../core";
import { cleanAutoMergeRefusal, immediateMerge } from "../github/merge";
import { repositoryPath } from "./claims";
import {
	array,
	GitHub,
	type GitHubDependencies,
	object,
	type ObjectValue,
	type PullRequest,
	requirements,
	string,
} from "./github";
import { LAND_CHECK, enqueue } from "./land";
import { Refusal, ago } from "./start";

export type Method = "merge" | "squash" | "rebase";

/** The PR, its `quest:*` labels, and the timeline events that add a label. */
const READ = `query HoldOwnership($owner: String!, $repo: String!, $number: Int!) {
	repository(owner: $owner, name: $repo) {
		pullRequest(number: $number) {
			id url state isDraft body updatedAt baseRefName headRefOid mergeStateStatus isMergeQueueEnabled
			labels(first: 100) { nodes { name } }
			timelineItems(last: 100, itemTypes: [LABELED_EVENT]) {
				nodes { __typename ... on LabeledEvent { id createdAt label { name } } }
			}
		}
	}
}`;

interface Event {
	id: string;
	time: number;
	/** The label it added; `null` for any other event. */
	label: string | null;
}

interface Snapshot {
	id: string;
	url: string;
	state: "OPEN" | "CLOSED" | "MERGED";
	draft: boolean;
	body: string;
	updatedAt: string;
	base: string;
	head: string;
	mergeState: string;
	queue: boolean;
	/** The hold labels on the PR. */
	labels: string[];
	/** Oldest first. */
	events: Event[];
}

/** A session's hold: its label and the token naming the event that added it. */
export interface Hold {
	label: string;
	token: string;
}

export interface HoldFact {
	label: string;
	/** Null when the acquisition is older than the available timeline. */
	token: string | null;
	takenAt: string | null;
	age: string | null;
	/** GitHub's verified event URL; the opaque GraphQL token is not a browser anchor. */
	eventUrl: string | null;
}
export interface HoldReport {
	head: string;
	holds: HoldFact[];
	starter: { lastActive: string; age: string; url: string } | null;
}

/** Read ownership facts through the state commands' reader, without changing labels. */
export async function readHoldStatus(pr: PullRequest, deps: GitHubDependencies): Promise<HoldReport> {
	const labels = new Labels(pr, deps);
	const snapshot = await labels.read();
	const holds =
		snapshot.state !== "OPEN"
			? []
			: snapshot.labels.map((label): HoldFact => {
					const event = latestHold(snapshot.events, label);
					return {
						label,
						token: event?.id ?? null,
						takenAt: event ? new Date(event.time).toISOString() : null,
						age: event ? ago(deps.now(), event.time) : null,
						eventUrl: null,
					};
				});
	if (holds.some((hold) => hold.token !== null)) {
		// REST publishes event URLs and the same node IDs the ownership tokens use.
		for (const event of await labels.github.all(`${repositoryPath(pr)}/issues/${pr.number}/events?per_page=100`)) {
			const hold = holds.find((hold) => hold.token === event.node_id);
			if (hold && event.event === "labeled" && object(event.label).name === hold.label)
				hold.eventUrl = string(event.url);
		}
	}
	return {
		head: snapshot.head,
		holds,
		starter: starterHeld(snapshot)
			? {
					lastActive: snapshot.updatedAt,
					age: ago(deps.now(), Date.parse(snapshot.updatedAt)),
					url: snapshot.url,
				}
			: null,
	};
}

function starterHeld(snapshot: Snapshot): boolean {
	return snapshot.state === "OPEN" && snapshot.draft && !handedBack(snapshot.body);
}

/** Take `pr`, or keep the hold `token` names. Prints nothing; returns the hold. */
export async function take(pr: PullRequest, token: string | undefined, deps: GitHubDependencies): Promise<Hold> {
	const { hold } = await acquire(new Labels(pr, deps), token);
	return hold;
}

/**
 * While `token` holds `pr`, hand it to reviewers: drop its `## Decisions needed`
 * section and mark a draft ready for review. The hold stays.
 */
export async function finish(pr: PullRequest, token: string, deps: GitHubDependencies): Promise<Hold> {
	const labels = new Labels(pr, deps);
	const { hold, snapshot } = await acquire(labels, token);
	return holding(hold, async () => {
		if (handedBack(snapshot.body)) {
			await labels.github.request(`${repositoryPath(pr)}/pulls/${pr.number}`, {
				method: "PATCH",
				body: { body: withoutHandBack(snapshot.body) },
			});
		}
		if (snapshot.draft) {
			await labels.github.graphql(
				`mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }`,
				{ id: snapshot.id },
			);
		}
	});
}

/** The repository setting that allows each merge method. */
const ALLOWS: Record<Method, string> = {
	merge: "allow_merge_commit",
	squash: "allow_squash_merge",
	rebase: "allow_rebase_merge",
};

/** Each merge method as GitHub's settings name it. */
const METHOD_NAMES: Record<Method, string> = {
	merge: "merge commits",
	squash: "squash merges",
	rebase: "rebase merges",
};

/**
 * The method an ungated landing uses: the one `named`, which the repository must allow, else the
 * only one it allows, else a merge commit. Settings hidden from the token leave GitHub to refuse.
 */
function mergeMethod(repository: ObjectValue, named: Method | undefined, url: string): Method {
	const methods = Object.keys(ALLOWS) as Method[];
	if (methods.some((method) => typeof repository[ALLOWS[method]] !== "boolean")) return named ?? "merge";
	const allowed = methods.filter((method) => repository[ALLOWS[method]] === true);
	if (named !== undefined) {
		if (allowed.includes(named)) return named;
		throw new Refusal(
			`${url} repository does not allow ${METHOD_NAMES[named]}; it allows ${allowed.map((method) => METHOD_NAMES[method]).join(", ") || "none"}`,
		);
	}
	if (allowed.length === 1) return allowed[0];
	if (allowed.includes("merge")) return "merge";
	if (allowed.length === 0) throw new Refusal(`${url} repository allows no merge method`);
	throw new Refusal(
		`${url} repository does not allow merge commits; pass --${allowed.join(" or --")}, as its landing instructions in CONTRIBUTING.md or AGENTS.md name`,
	);
}

/**
 * Land `sha`, which must still be the head of `pr`, while no session holds it:
 * enable auto-merge bound to it, which enters the merge queue when the base has one,
 * or merge at once when GitHub would refuse auto-merge because nothing is left to wait for.
 * A base that requires the `quest land` check queues it for `quest land` instead:
 * squash auto-merge whose commit body pins `sha`. It takes no label.
 * `named` is the method the caller asked for; otherwise {@link mergeMethod} picks one.
 */
export async function land(
	pr: PullRequest,
	sha: string,
	named: Method | undefined,
	deps: GitHubDependencies,
	direct = false,
): Promise<void> {
	const labels = new Labels(pr, deps);
	const current = (snapshot: Snapshot) => {
		if (snapshot.head.toLowerCase() !== sha.toLowerCase()) {
			throw new Refusal(`${snapshot.url} head moved to ${snapshot.head}; check the new head before landing it`);
		}
	};
	const snapshot = await labels.read();
	open(snapshot);
	current(snapshot);
	unheld(snapshot, undefined, deps.now());
	// The policy below is decided for the base read above; reread before landing, since a retarget decides nothing.
	const unchanged = async () => {
		const fresh = await labels.read();
		open(fresh);
		current(fresh);
		unheld(fresh, undefined, deps.now());
		if (fresh.base !== snapshot.base) {
			throw new Refusal(`${snapshot.url} was retargeted from ${snapshot.base} to ${fresh.base}; land it again`);
		}
	};
	const gated = (await requirements(labels.github, pr, snapshot.base)).checks.some(
		(check) => check.name === LAND_CHECK,
	);
	if (gated) {
		if (named !== undefined && named !== "squash")
			deps.warn(`${snapshot.url} lands through quest land, which squashes`);
		await unchanged();
		await enqueue(labels.github, snapshot.id, snapshot.head);
		return;
	}
	// A merge queue is the repository's own gate: it applies its own method and needs no auto-merge setting.
	let method: Method = named ?? "merge";
	if (!snapshot.queue) {
		const repository = object(await (await labels.github.request(repositoryPath(pr))).json());
		method = mergeMethod(repository, named, snapshot.url);
		if (!direct) {
			// GitHub shows the merge settings only to writers; fail closed, with a next step.
			if (typeof repository.allow_auto_merge !== "boolean")
				throw new Refusal(
					`${snapshot.url} repository's auto-merge setting is not visible to this token, so a direct merge cannot be ruled out; follow its landing instructions in CONTRIBUTING.md or AGENTS.md`,
				);
			if (!repository.allow_auto_merge)
				throw new Refusal(
					`${snapshot.url} repository has auto-merge disabled; follow its landing instructions in CONTRIBUTING.md or AGENTS.md (for example, its label queue). Only use --direct if the user explicitly asks`,
				);
		}
	}
	// The batch gate tests its own current-base chain. Ungated landings need that base in the PR head.
	const comparison = object(
		await (
			await labels.github.request(
				`${repositoryPath(pr)}/compare/${encodeURIComponent(snapshot.base)}...${snapshot.head}?per_page=1`,
			)
		).json(),
	);
	if (comparison.status !== "ahead" && comparison.status !== "identical") {
		const base = string(object(comparison.base_commit).sha);
		throw new Refusal(
			`${snapshot.url} head ${snapshot.head} does not contain ${snapshot.base} at ${base}; merge the base and rerun the repository's checks before landing`,
		);
	}
	if (snapshot.queue && named !== undefined && named !== "merge") {
		deps.warn(`${snapshot.url} lands through a merge queue, which applies its own merge method`);
	}
	await unchanged();
	const submit = (mutation: "mergePullRequest" | "enablePullRequestAutoMerge") =>
		labels.github.graphql(
			`mutation($id: ID!, $sha: GitObjectID!, $method: PullRequestMergeMethod!) {
				${mutation}(input: { pullRequestId: $id, expectedHeadOid: $sha, mergeMethod: $method }) { clientMutationId }
			}`,
			{ id: snapshot.id, sha: snapshot.head, method: method.toUpperCase() },
		);
	if (immediateMerge(snapshot.mergeState, snapshot.queue)) {
		await submit("mergePullRequest");
		return;
	}
	try {
		await submit("enablePullRequestAutoMerge");
	} catch (error) {
		if (snapshot.queue || !cleanAutoMergeRefusal(error instanceof Error ? error.message : null)) throw error;
		// GitHub may finish computing UNKNOWN while it handles auto-merge. Reread once, without polling.
		const fresh = await labels.read();
		current(fresh);
		unheld(fresh, undefined, deps.now());
		if (
			fresh.state !== "OPEN" ||
			fresh.draft ||
			fresh.base !== snapshot.base ||
			!immediateMerge(fresh.mergeState, fresh.queue) ||
			(await requirements(labels.github, pr, fresh.base)).checks.some((check) => check.name === LAND_CHECK)
		)
			throw error;
		await submit("mergePullRequest");
	}
}

/**
 * Finish `work` under `hold`, which may be a label just swapped in for the caller's.
 * A failure names the hold, so the caller keeps the token it needs to release or retry.
 */
async function holding(hold: Hold, work: () => Promise<void>): Promise<Hold> {
	try {
		await work();
	} catch (error) {
		const message = `${error instanceof Error ? error.message : String(error)}; this session holds ${hold.label} as token ${hold.token}`;
		throw error instanceof Refusal ? new Refusal(message) : new Error(message, { cause: error });
	}
	return hold;
}

/** Remove the label `token` holds. A label already gone is released; one added again since is not ours. */
export async function release(pr: PullRequest, token: string, deps: GitHubDependencies): Promise<string> {
	const labels = new Labels(pr, deps);
	const snapshot = await labels.read();
	const event = snapshot.events.find((candidate) => candidate.id === token && candidate.label !== null);
	if (!event?.label) throw new Refusal(unknown(snapshot, token));
	if (!snapshot.labels.includes(event.label)) {
		deps.warn(`${event.label} is already off ${snapshot.url}`);
		return event.label;
	}
	held(snapshot, token);
	await labels.remove(event.label);
	return event.label;
}

/**
 * Take `pr` with `quest:active`, refusing while it is merged or closed, while
 * another session holds a hold label, or while it is a draft its starter still
 * holds. With `token`, the hold it names is kept, or swapped for `quest:active`
 * when it names another label, such as one an older quest version added.
 */
async function acquire(labels: Labels, token: string | undefined): Promise<{ hold: Hold; snapshot: Snapshot }> {
	const label = ACTIVE_LABEL;
	const snapshot = await labels.read();
	open(snapshot);
	const mine = token === undefined ? undefined : held(snapshot, token);
	unheld(snapshot, mine, labels.deps.now());
	if (mine === label) return { hold: { label, token: token! }, snapshot };

	await labels.add(label);
	const after = await labels.read();
	const ours = latestHold(after.events, label);
	if (!ours) throw new Error(`added ${label} to ${after.url}, but its timeline does not show it`);
	// Another session took the PR at the same time: the first label added keeps it.
	const rival = after.labels.find((name) => {
		if (name === label || name === mine) return false;
		const added = latestHold(after.events, name);
		return !added || after.events.indexOf(added) < after.events.indexOf(ours);
	});
	if (rival !== undefined) {
		await labels.remove(label);
		throw new Refusal(holder(after, rival, labels.deps.now()));
	}
	if (mine !== undefined) await labels.remove(mine);
	return { hold: { label, token: ours.id }, snapshot: { ...after, labels: [label] } };
}

function open(snapshot: Snapshot): void {
	if (snapshot.state !== "OPEN") {
		throw new Refusal(`${snapshot.url} is ${snapshot.state.toLowerCase()}; a push now would bring its branch back`);
	}
}

/**
 * Refuse while another session holds the PR: a hold label other than `mine`,
 * or, when this session holds none, a draft its starter still holds.
 */
function unheld(snapshot: Snapshot, mine: string | undefined, now: number): void {
	const other = snapshot.labels.find((name) => name !== mine);
	if (other !== undefined) throw new Refusal(holder(snapshot, other, now));
	if (mine === undefined && starterHeld(snapshot)) {
		throw new Refusal(
			`${snapshot.url} is a draft its starter still holds: its body has no ## Decisions needed section, so taking it over is the user's choice`,
		);
	}
}

/** The label `token` holds on the PR, or a refusal when it holds none. */
function held(snapshot: Snapshot, token: string): string {
	const event = snapshot.events.find((candidate) => candidate.id === token && candidate.label !== null);
	if (!event?.label) throw new Refusal(unknown(snapshot, token));
	if (!snapshot.labels.includes(event.label)) {
		throw new Refusal(
			`${event.label} is off ${snapshot.url} since ${token} added it, so this session no longer holds it`,
		);
	}
	if (heldToken(snapshot, event.label) !== token) {
		throw new Refusal(
			`${event.label} was added to ${snapshot.url} again after ${token}, so another session holds it`,
		);
	}
	return event.label;
}

function unknown(snapshot: Snapshot, token: string): string {
	return `${token} is not an event that added a label to ${snapshot.url} among its last 100`;
}

/** Who holds `label`, for a person deciding whether to wait or take over a stale hold. */
function holder(snapshot: Snapshot, label: string, now: number): string {
	const added = latestHold(snapshot.events, label);
	const since = added ? `, added ${ago(now, added.time)} as token ${added.id}` : "";
	return `${snapshot.url} is held by ${label}${since}; if it looks stale, ask the user before releasing it`;
}

/** `body` without its `## Decisions needed` sections, each running to the next heading of level 1 or 2. */
export function withoutHandBack(body: string): string {
	const kept: string[] = [];
	let skipping = false;
	for (const line of body.split("\n")) {
		if (handedBack(line)) skipping = true;
		else if (/^#{1,2}[ \t]/.test(line)) skipping = false;
		if (!skipping) kept.push(line);
	}
	return kept.join("\n").trimEnd();
}

/** One PR's labels on GitHub. */
class Labels {
	readonly github: GitHub;
	/** The PR's REST path as an issue, where its labels live. */
	readonly issue: string;

	constructor(
		private readonly pr: PullRequest,
		readonly deps: GitHubDependencies,
	) {
		this.github = new GitHub(deps);
		this.issue = `${repositoryPath(pr)}/issues/${pr.number}`;
	}

	async read(): Promise<Snapshot> {
		const data = await this.github.graphql(READ, {
			owner: this.pr.owner,
			repo: this.pr.repo,
			number: this.pr.number,
		});
		const repository = data.repository;
		if (repository === null) {
			throw new Error(`cannot read ${this.pr.owner}/${this.pr.repo}; check the repository and token`);
		}
		const pull = object(repository).pullRequest;
		if (pull === null) throw new Error(`${this.pr.owner}/${this.pr.repo}#${this.pr.number} is not a pull request`);
		const row = object(pull);
		return {
			id: string(row.id),
			url: string(row.url),
			state: string(row.state) as Snapshot["state"],
			draft: row.isDraft === true,
			body: typeof row.body === "string" ? row.body : "",
			updatedAt: string(row.updatedAt),
			base: string(row.baseRefName),
			head: string(row.headRefOid),
			mergeState: string(row.mergeStateStatus),
			queue: row.isMergeQueueEnabled === true,
			labels: array(object(row.labels).nodes)
				.map((label) => string(label.name))
				.filter(isHoldLabel),
			events: array(object(row.timelineItems).nodes).map(event),
		};
	}

	async add(label: string): Promise<void> {
		await this.github.request(`${this.issue}/labels`, { body: { labels: [label] } });
	}

	/** Remove `label`; one already gone is fine. */
	async remove(label: string): Promise<void> {
		await this.github.request(`${this.issue}/labels/${encodeURIComponent(label)}`, {
			method: "DELETE",
			allow: [404],
		});
	}
}

function event(row: ObjectValue): Event {
	const labeled = row.__typename === "LabeledEvent";
	return {
		id: string(row.id),
		time: Date.parse(string(row.createdAt)),
		label: labeled ? string(object(row.label).name) : null,
	};
}
