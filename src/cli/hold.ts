// `quest iterate`, `ready`, `merge`, and `release`: one session owns a PR at a
// time. It holds one `quest:<state>` label, and the ID of the timeline event
// that added the label is its hold token, since sessions often share an account.
import { HOLD_PREFIX, MERGE_LABEL, handedBack, isHoldLabel, latestHold, heldToken, spentMergeHold } from "../core";
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

export type State = "iterate" | "ready" | "merge";
export type Method = "merge" | "squash" | "rebase";

/** The PR, its `quest:*` labels, and the timeline events that add a label or start a landing. */
const READ = `query HoldOwnership($owner: String!, $repo: String!, $number: Int!) {
	repository(owner: $owner, name: $repo) {
		pullRequest(number: $number) {
			id url state isDraft body updatedAt baseRefName headRefOid mergeStateStatus isMergeQueueEnabled
			autoMergeRequest { enabledAt }
			mergeQueueEntry { state }
			labels(first: 100) { nodes { name } }
			timelineItems(last: 100, itemTypes: [LABELED_EVENT, AUTO_MERGE_ENABLED_EVENT, ADDED_TO_MERGE_QUEUE_EVENT]) {
				nodes {
					__typename
					... on LabeledEvent { id createdAt label { name } }
					... on AutoMergeEnabledEvent { id createdAt }
					... on AddedToMergeQueueEvent { id createdAt }
				}
			}
		}
	}
}`;

interface Event {
	id: string;
	time: number;
	/** The label it added, or `null` for auto-merge enabled or a merge-queue entry. */
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
	/** Auto-merge is enabled or the PR is in the merge queue. */
	landing: boolean;
	/** The `quest:*` labels on the PR. */
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

/** Take `pr` for `state`, or swap to it from the label `token` holds. Prints nothing; returns the hold. */
export async function take(
	pr: PullRequest,
	state: State,
	token: string | undefined,
	deps: GitHubDependencies,
): Promise<Hold> {
	const { hold } = await acquire(new Labels(pr, deps), state, token);
	return hold;
}

/**
 * Take `pr` for ready, then hand it to reviewers: drop its `## Decisions needed`
 * section and mark a draft ready for review.
 */
export async function finish(pr: PullRequest, token: string, deps: GitHubDependencies): Promise<Hold> {
	const labels = new Labels(pr, deps);
	const { hold, snapshot } = await acquire(labels, "ready", token);
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

/**
 * Take `pr` for merge, then land `sha`, which must still be its head: enable
 * auto-merge bound to it, which enters the merge queue when the base has one,
 * or merge at once when GitHub would refuse auto-merge because nothing is left to wait for.
 * A base that requires the `quest land` check queues it for `quest land` instead:
 * squash auto-merge whose commit body pins `sha`.
 */
export async function land(
	pr: PullRequest,
	token: string,
	sha: string,
	method: Method,
	deps: GitHubDependencies,
	direct = false,
): Promise<Hold> {
	const labels = new Labels(pr, deps);
	const current = (snapshot: Snapshot) => {
		if (snapshot.head.toLowerCase() !== sha.toLowerCase()) {
			throw new Refusal(`${snapshot.url} head moved to ${snapshot.head}; check the new head before landing it`);
		}
	};
	// Pre-check before any label changes, preserving the caller's token on refusal.
	let gated = false;
	let checkedBase = "";
	const { hold, snapshot } = await acquire(labels, "merge", token, async (snapshot) => {
		current(snapshot);
		checkedBase = snapshot.base;
		gated = (await requirements(labels.github, pr, snapshot.base)).checks.some(
			(check) => check.name === LAND_CHECK,
		);
		// A merge queue is the repository's own gate, so it decides; otherwise auto-merge must be on.
		if (!gated && !direct && !snapshot.queue) {
			const repository = object(await (await labels.github.request(repositoryPath(pr))).json());
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
	});
	return holding(hold, async () => {
		// The policy above was decided for the base read before acquiring; a retarget since then decides nothing.
		if (snapshot.base !== checkedBase) {
			throw new Refusal(`${snapshot.url} was retargeted from ${checkedBase} to ${snapshot.base}; land it again`);
		}
		current(snapshot);
		if (gated) {
			if (method !== "squash") deps.warn(`${snapshot.url} lands through quest land, which squashes`);
			await enqueue(labels.github, snapshot.id, snapshot.head);
			return;
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
		if (snapshot.queue && method !== "merge") {
			deps.warn(`${snapshot.url} lands through a merge queue, which applies its own merge method`);
		}
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
			held(fresh, hold.token);
			if (
				fresh.state !== "OPEN" ||
				fresh.draft ||
				!immediateMerge(fresh.mergeState, fresh.queue) ||
				(await requirements(labels.github, pr, fresh.base)).checks.some((check) => check.name === LAND_CHECK)
			)
				throw error;
			await submit("mergePullRequest");
		}
	});
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
 * Take `pr` for `state`, refusing while it is merged or closed, while another
 * session holds a `quest:*` label, or while it is a draft its starter still
 * holds. With `token`, the label it holds is swapped for this state's.
 * `check` refuses before any label changes.
 */
async function acquire(
	labels: Labels,
	state: State,
	token: string | undefined,
	check?: (snapshot: Snapshot) => void | Promise<void>,
): Promise<{ hold: Hold; snapshot: Snapshot }> {
	const label = HOLD_PREFIX + state;
	let snapshot = await labels.read();
	if (snapshot.state !== "OPEN") {
		throw new Refusal(`${snapshot.url} is ${snapshot.state.toLowerCase()}; a push now would bring its branch back`);
	}
	await check?.(snapshot);
	snapshot = await labels.dequeued(snapshot);
	const mine = token === undefined ? undefined : held(snapshot, token);
	const other = snapshot.labels.find((name) => name !== mine);
	if (other !== undefined) throw new Refusal(holder(snapshot, other, labels.deps.now()));
	if (mine === label) return { hold: { label, token: token! }, snapshot };
	if (mine === undefined && starterHeld(snapshot)) {
		throw new Refusal(
			`${snapshot.url} is a draft its starter still holds: its body has no ## Decisions needed section, so taking it over is the user's choice`,
		);
	}

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
			landing: row.autoMergeRequest !== null || row.mergeQueueEntry !== null,
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

	/**
	 * A landing that ended unmerged ends the merge session's hold, so a
	 * `quest:merge` label is spent once a landing started after it was added.
	 */
	async dequeued(snapshot: Snapshot): Promise<Snapshot> {
		if (!spentMergeHold(snapshot)) return snapshot;
		await this.remove(MERGE_LABEL);
		this.deps.warn(
			`${snapshot.url} left the merge queue unmerged, so ${MERGE_LABEL} was removed; quest status shows why under landing-stopped`,
		);
		return { ...snapshot, labels: snapshot.labels.filter((name) => name !== MERGE_LABEL) };
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
