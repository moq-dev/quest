// Reading who holds a PR: its `quest:*` labels, the events that added them, and a draft its starter still holds.
// Taking and releasing holds stays in the CLI.
import { handedBack, isHoldLabel, latestHold } from "../core";
import {
	GitHub,
	type GitHubDependencies,
	type ObjectValue,
	type PullRequest,
	array,
	object,
	repositoryPath,
	string,
} from "./client";
import { lacksApproval } from "./merge";

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

/** A timeline event on a PR, as the hold reader reads it: when, and the label it added. */
export interface LabelEvent {
	id: string;
	time: number;
	/** The label it added; `null` for any other event. */
	label: string | null;
}

/** A PR and its hold labels, as one read sees them. */
export interface Snapshot {
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
	events: LabelEvent[];
}

/** A hold label on a PR, and the event that took it when the timeline still shows it. */
export interface HoldFact {
	label: string;
	/** Null when the acquisition is older than the available timeline. */
	token: string | null;
	takenAt: string | null;
	age: string | null;
	/** GitHub's verified event URL; the opaque GraphQL token is not a browser anchor. */
	eventUrl: string | null;
}

/** The PR head a hold read saw, its holds, and its starter's hold on a draft not handed back. */
export interface HoldReport {
	head: string;
	holds: HoldFact[];
	starter: { lastActive: string; age: string; url: string } | null;
}

/** Read `pr` and its hold labels. */
export async function readSnapshot(github: GitHub, pr: PullRequest): Promise<Snapshot> {
	const data = await github.graphql(READ, {
		owner: pr.owner,
		repo: pr.repo,
		number: pr.number,
	});
	const repository = data.repository;
	if (repository === null) {
		throw new Error(`cannot read ${pr.owner}/${pr.repo}; check the repository and token`);
	}
	const pull = object(repository).pullRequest;
	if (pull === null) throw new Error(`${pr.owner}/${pr.repo}#${pr.number} is not a pull request`);
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

/** Read `pr`'s holds without changing its labels. */
export async function readHoldStatus(pr: PullRequest, deps: GitHubDependencies): Promise<HoldReport> {
	const github = new GitHub(deps);
	const snapshot = await readSnapshot(github, pr);
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
		for (const event of await github.all(`${repositoryPath(pr)}/issues/${pr.number}/events?per_page=100`)) {
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

/** Whether a PR is an open draft its starter still holds: one not handed back with `## Waiting`. */
export function starterHeld(snapshot: Snapshot): boolean {
	return snapshot.state === "OPEN" && snapshot.draft && !handedBack(snapshot.body);
}

function event(row: ObjectValue): LabelEvent {
	const labeled = row.__typename === "LabeledEvent";
	return {
		id: string(row.id),
		time: Date.parse(string(row.createdAt)),
		label: labeled ? string(object(row.label).name) : null,
	};
}

/** How long ago `time` was, roughly: just now, minutes, hours, then days. */
export function ago(now: number, time: number): string {
	const minutes = Math.max(0, Math.round((now - time) / 60_000));
	if (minutes === 0) return "just now";
	const [count, unit] =
		minutes < 60
			? [minutes, "minute"]
			: minutes < 48 * 60
				? [Math.round(minutes / 60), "hour"]
				: [Math.round(minutes / 1440), "day"];
	return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}
