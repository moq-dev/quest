// `quest iterate`, `ready`, `merge`, and `release`: one session works on a PR at
// a time. It holds the `quest:active` label, and the ID of the timeline event
// that added the label is its hold token, since sessions often share an account.
// `quest merge` takes no label: the pinned auto-merge or merge-queue entry it creates is the queue signal.
import { ACTIVE_LABEL, formatFinding, handedBack, isHoldLabel, latestHold, heldToken, withoutHandBack } from "../core";
import { cleanAutoMergeRefusal, immediateMerge, lacksApproval, queueHead } from "../github/merge";
import { repositoryPath } from "./claims";
import {
	array,
	currentChecks,
	GitHub,
	type GitHubDependencies,
	GitHubGraphQLError,
	object,
	type ObjectValue,
	type PullRequest,
	requirements,
	string,
} from "./github";
import { ALLOWS, LAND_CHECK, METHOD_NAMES, contexts, enqueue } from "./land";
import { QUEUE_CHECK } from "./land-queue";
import type { LandingCheck } from "./landed";
import { classifyCheck } from "./status";
import { describe, readSignals } from "./signals";
import { Refusal, ago } from "./start";

export type Method = "merge" | "squash" | "rebase";

/** The PR, its `quest:*` labels, and the timeline events that add a label. */
const READ = `query HoldOwnership($owner: String!, $repo: String!, $number: Int!) {
	repository(owner: $owner, name: $repo) {
		pullRequest(number: $number) {
			id url state isDraft body updatedAt baseRefName baseRefOid headRefName headRefOid mergeStateStatus reviewDecision isMergeQueueEnabled isInMergeQueue
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
	/** The commit the base branch points at. */
	baseSha: string;
	/** The head branch's name. */
	branch: string;
	head: string;
	mergeState: string;
	/**
	 * The base requires an approval the PR lacks, such as an online reviewer's that a ruleset requires. An admin's
	 * token may merge or enqueue past it, so only auto-merge, which waits for it, may pick such a head.
	 */
	unapproved: boolean;
	queue: boolean;
	/** Whether the PR is in its base's merge queue. */
	queued: boolean;
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
 * While `token` holds `pr`, hand it to reviewers: drop its `## Waiting` section
 * and mark a draft ready for review. The hold stays.
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
 * The method of the auto-merge that queues a PR for `quest land`, which only signals the queue: the
 * one `named`, else squash, else any method both the repository and the base's rulesets allow.
 * Settings hidden from the token count as allowed, leaving GitHub to refuse.
 */
function signalMethod(
	repository: ObjectValue,
	rules: ObjectValue[],
	named: Method | undefined,
	url: string,
	base: string,
): Method {
	const ruled = rules.flatMap((rule) => {
		const methods =
			rule.type === "pull_request" && rule.parameters != null && object(rule.parameters).allowed_merge_methods;
		return Array.isArray(methods) ? [methods] : [];
	});
	const allows = (method: Method) =>
		repository[ALLOWS[method]] !== false && ruled.every((methods) => methods.includes(method));
	if (named !== undefined) {
		if (allows(named)) return named;
		throw new Refusal(
			`${url} cannot land with ${METHOD_NAMES[named]} on ${base}, by its repository settings or rulesets`,
		);
	}
	const method = (["squash", "merge", "rebase"] as const).find(allows);
	if (method === undefined)
		throw new Refusal(`${url} has no merge method its repository and ${base}'s rulesets both allow`);
	return method;
}

/** What `quest merge` lands, and how. */
export interface LandRequest {
	/** The full head SHA to land, which must still be the PR's head. */
	sha: string;
	/** The method the caller asked for; otherwise {@link mergeMethod} picks one on an ungated base. */
	method?: Method;
	/** Merge at once on an ungated base with auto-merge disabled. */
	direct?: boolean;
	check: LandingCheck;
}

/**
 * Land `sha`, which must still be the head of `pr`, while no session holds it:
 * enable auto-merge bound to it, or merge at once when GitHub would refuse auto-merge because
 * nothing is left to wait for. A base with a merge queue gets {@link pick} instead.
 * A base that requires the `quest land` check queues it for `quest land` instead:
 * auto-merge whose commit body pins `sha`, with a method {@link signalMethod} picks.
 * That request only signals the queue: `quest land` lands with its own method. It takes no label.
 * It first refuses a head whose quest check finds anything, so the refusal comes before a queue
 * build is spent, even on a base whose gate checks it again.
 */
export async function land(pr: PullRequest, request: LandRequest, deps: GitHubDependencies): Promise<void> {
	const { sha, method: named, direct = false } = request;
	const labels = new Labels(pr, deps);
	const current = (snapshot: Snapshot) => headAt(snapshot, sha);
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
		// An approval dismissed or a change requested since the first read decides how it may land.
		return { ...snapshot, unapproved: fresh.unapproved };
	};
	await passing(labels.github, pr, snapshot.url, sha);
	await unsignaled(labels.github, pr, snapshot.url, sha);
	const findings = await request.check({
		remote: `https://github.com/${pr.owner}/${pr.repo}.git`,
		base: snapshot.base,
		baseSha: snapshot.baseSha,
		branch: snapshot.branch,
		sha,
		token: deps.token,
	});
	if (findings.length > 0)
		throw new Refusal(
			`${snapshot.url} head ${sha} fails quest check against ${snapshot.base}:\n${findings.map(formatFinding).join("\n")}\nfix the PR, then land it again`,
		);
	const needs = await requirements(labels.github, pr, snapshot.base);
	if (needs.checks.some((check) => check.name === LAND_CHECK)) {
		if (named !== undefined)
			deps.warn(`${snapshot.url} lands through quest land, which applies its own merge method`);
		const repository = object(await (await labels.github.request(repositoryPath(pr))).json());
		const method = signalMethod(repository, needs.rules, named, snapshot.url, snapshot.base);
		await unchanged();
		await enqueue(labels.github, snapshot.id, snapshot.head, method);
		return;
	}
	// A merge queue is the repository's own gate: it applies its own method and needs no auto-merge setting.
	if (snapshot.queue) {
		if (named !== undefined && named !== "merge")
			deps.warn(`${snapshot.url} lands through a merge queue, which applies its own merge method`);
		await pick(labels, await unchanged(), named ?? "merge");
		return;
	}
	const repository = object(await (await labels.github.request(repositoryPath(pr))).json());
	const method = mergeMethod(repository, named, snapshot.url);
	if (!direct) {
		// Otherwise auto-merge must be on.
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
	// The batch gate and a merge queue test the current base themselves. Here nothing does, so the head must contain it.
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
	const { unapproved } = await unchanged();
	// A decision posted since the check above leaves the head as it was, so `expectedHeadOid` would not refuse it.
	await unsignaled(labels.github, pr, snapshot.url, sha);
	if (unapproved && repository.allow_auto_merge !== true)
		throw new Refusal(
			`${snapshot.url} lacks the approval its base requires, which a merge now would bypass; land it once it is approved`,
		);
	const submit = (mutation: "mergePullRequest" | "enablePullRequestAutoMerge") =>
		labels.github.graphql(
			`mutation($id: ID!, $sha: GitObjectID!, $method: PullRequestMergeMethod!) {
				${mutation}(input: { pullRequestId: $id, expectedHeadOid: $sha, mergeMethod: $method }) { clientMutationId }
			}`,
			{ id: snapshot.id, sha: snapshot.head, method: method.toUpperCase() },
		);
	// Only --direct reaches here without auto-merge on; it merges at once rather than arm what GitHub refuses.
	if (!unapproved && (repository.allow_auto_merge !== true || immediateMerge(snapshot.mergeState, snapshot.queue))) {
		await submit("mergePullRequest");
		return;
	}
	try {
		await submit("enablePullRequestAutoMerge");
	} catch (error) {
		if (!cleanAutoMergeRefusal(error instanceof Error ? error.message : null)) throw error;
		// GitHub may finish computing UNKNOWN while it handles auto-merge. Reread once, without polling.
		const fresh = await labels.read();
		current(fresh);
		unheld(fresh, undefined, deps.now());
		if (
			fresh.state !== "OPEN" ||
			fresh.draft ||
			fresh.unapproved ||
			fresh.base !== snapshot.base ||
			!immediateMerge(fresh.mergeState, fresh.queue) ||
			(await requirements(labels.github, pr, fresh.base)).checks.some((check) => check.name === LAND_CHECK)
		)
			throw error;
		await unsignaled(labels.github, pr, snapshot.url, sha);
		await submit("mergePullRequest");
	}
}

/**
 * Refuse a head on which any current check failed, required or not, naming each: landing it
 * would spend a queue build on a known failure. Pending and absent checks do not block, nor does the
 * own queue's informational check, which reports how a past pick ended rather than the head.
 */
async function passing(github: GitHub, pr: PullRequest, url: string, sha: string): Promise<void> {
	const failing = (await currentChecks(github, pr, sha, await contexts(github, pr, sha))).checks
		.filter((context) => context.name !== QUEUE_CHECK)
		.map(classifyCheck)
		.filter(({ outcome }) => outcome === "failing")
		.map(({ check }) => (check.url === null ? check.name : `${check.name} (${check.url})`));
	if (failing.length > 0)
		throw new Refusal(
			`${url} head ${sha} failed ${failing.length === 1 ? "a check" : "checks"}: ${failing.sort().join(", ")}; fix the PR or rerun the check, then land it again`,
		);
}

/**
 * Refuse a head that an online reviewer's unanswered finding or a newer maintainer decision holds, naming each:
 * the review a pick relied on predates them, so landing would skip them.
 */
async function unsignaled(github: GitHub, pr: PullRequest, url: string, sha: string): Promise<void> {
	const read = (await readSignals(github, pr, [pr.number])).get(pr.number)!;
	if (read.head.toLowerCase() !== sha.toLowerCase())
		throw new Refusal(`${url} head moved to ${read.head}; check the new head before landing it`);
	if (read.signals.length > 0)
		throw new Refusal(
			`${url} head ${sha} is held by ${describe(read.signals)}; push a fix, or answer each: reply in a finding's thread, or link its review or the decision in a comment that answers it; then land it again`,
		);
}

/** GraphQL error types that fault the token or the request, not the PR GitHub would enqueue. */
export const UNREFUSED = ["FORBIDDEN", "NOT_FOUND", "INSUFFICIENT_SCOPES", "INTERNAL"];

/**
 * Pick `snapshot`'s head to land through the base's merge queue, as {@link land} checked it, with
 * `queueHead`. The queue builds each PR on the current base, so a head behind it is enqueued
 * as is. GitHub's queue events and auto-merge request record the pick, naming who made it.
 * A pick GitHub refuses, such as one that conflicts or fails its required checks, fails:
 * the PR needs a fix before it can land.
 */
async function pick(labels: Labels, snapshot: Snapshot, method: Method): Promise<void> {
	try {
		await queueHead((query, variables) => labels.github.graphql(query, variables), {
			id: snapshot.id,
			head: snapshot.head,
			mergeState: snapshot.mergeState,
			unapproved: snapshot.unapproved,
			method,
		});
	} catch (error) {
		if (!(error instanceof GitHubGraphQLError) || error.types.some((type) => UNREFUSED.includes(type ?? "")))
			throw error;
		// A head that moved since is no longer the one being landed; say so rather than ask for a fix.
		const fresh = await labels.read();
		open(fresh);
		headAt(fresh, snapshot.head);
		// Already queued, as when this repeats an earlier landing: GitHub refused nothing that matters.
		if (fresh.queued) return;
		throw new Refusal(
			`${snapshot.url}: GitHub refused to enqueue ${snapshot.head} (${error.message}); fix the PR, for example with /quest-iterate, and land it again`,
		);
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
 * holds. With `token`, the hold it names must be this session's own `quest:active`,
 * which is kept.
 */
async function acquire(labels: Labels, token: string | undefined): Promise<{ hold: Hold; snapshot: Snapshot }> {
	const label = ACTIVE_LABEL;
	const snapshot = await labels.read();
	open(snapshot);
	const mine = token === undefined ? undefined : held(snapshot, token);
	unheld(snapshot, mine, labels.deps.now());
	if (mine === label) return { hold: { label, token: token! }, snapshot };
	if (mine !== undefined) {
		throw new Refusal(`${token} names the ${mine} hold on ${snapshot.url}, which this session does not own`);
	}

	await labels.add(label);
	const after = await labels.read();
	const ours = latestHold(after.events, label);
	if (!ours) throw new Error(`added ${label} to ${after.url}, but its timeline does not show it`);
	return { hold: { label, token: ours.id }, snapshot: { ...after, labels: [label] } };
}

/** Refuse once the head is no longer `sha`, the head being landed. */
function headAt(snapshot: Snapshot, sha: string): void {
	if (snapshot.head.toLowerCase() !== sha.toLowerCase()) {
		throw new Refusal(`${snapshot.url} head moved to ${snapshot.head}; check the new head before landing it`);
	}
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
			`${snapshot.url} is a draft its starter still holds: its body has no ## Waiting section, so taking it over is the user's choice`,
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

/**
 * Who holds `label`, for a person deciding whether to wait or take over a stale hold.
 * It never prints the holder's token: a refused session that has it in hand reads
 * it as permission to continue. `quest status` shows it to whoever takes over.
 */
function holder(snapshot: Snapshot, label: string, now: number): string {
	const added = latestHold(snapshot.events, label);
	const since = added ? `, added ${ago(now, added.time)}` : "";
	return `${snapshot.url} is held by ${label}${since}, so stop and report it; taking over a stale hold is the user's choice`;
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
			baseSha: string(row.baseRefOid),
			branch: string(row.headRefName),
			head: string(row.headRefOid),
			mergeState: string(row.mergeStateStatus),
			unapproved: lacksApproval(row.reviewDecision),
			queue: row.isMergeQueueEnabled === true,
			queued: row.isInMergeQueue === true,
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
