import { branchQuest, handedBack, isHoldLabel, landed, parse, questBranch, ready } from "quest/core";
import type { Project, Snapshot } from "../board/project";
import { GitHubError, type GitHubRepository, ProjectChanged } from "./service";
import { positiveId } from "./webhook";

type Cursor = string | null | false;
type Marks = { issues: string | null; pulls: string | null };
export type Scan = {
	/** Newest updates first; inclusive watermarks preserve ties and replay updates that move ahead during a pass. */
	history: {
		id: string;
		issues: Cursor;
		pulls: Cursor;
		complete: boolean;
		since?: Marks;
		watermark?: Marks;
		full?: boolean;
	};
	/** Pages only what availability depends on: open PRs and quest branches. */
	occupancy: {
		open: Cursor;
		refs: Cursor;
		pulls: string[];
		claims: string[];
		/** Observed tips; absent until old cached observations are refreshed. */
		heads?: Record<string, string>;
		complete: boolean;
	};
};
type Connection<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
type Entity = {
	databaseId: string;
	number: number;
	title: string;
	state: string;
	updatedAt: string;
	/** When it closed or merged; absent in older observations. */
	closedAt?: string | null;
	author: { login: string } | null;
	comments: { totalCount: number };
};
export type Pull = Entity & {
	headRefName: string;
	headRefOid: string;
	/** Whether its head is on a different repository; absent in older observations. */
	isCrossRepository?: boolean;
	isDraft: boolean;
	/** Its body has a `## Decisions needed` section; the body itself is not kept. Absent in older observations. */
	handedBack?: boolean;
	reviewDecision: string | null;
	/** GitHub's merge readiness for the App, such as CLEAN, BLOCKED, or DIRTY; absent in older observations. */
	mergeStateStatus?: string;
	/** The `quest:*` label a session holds it with, such as a queued merge's; absent in older observations. */
	hold?: string | null;
	reviews: { totalCount: number };
	latestReviews: {
		nodes: { state: string; author: { login: string } | null; commit: { oid: string } | null }[];
		pageInfo: { hasNextPage: boolean };
	};
	commits: { nodes: { commit: { oid: string; statusCheckRollup: { state: string } | null } }[] };
};
/** A quest branch, its tip, and the merged PRs from it, newest first. */
type QuestRef = {
	name: string;
	prefix: string;
	target: { oid: string } | null;
	associatedPullRequests: { nodes: { headRefOid: string }[] };
};
export type ActivityPage = {
	issues?: Connection<Entity>;
	pullRequests?: Connection<Pull>;
	open?: Connection<Pull>;
	refs?: Connection<QuestRef>;
	/** Stale entities read by number, in the order requested; null when GitHub no longer has one. */
	[stale: `s${number}`]: Entity | Pull | null | undefined;
};
/** An entity a webhook named since it was last read, and how many times. */
export type Stale = { kind: "issue" | "pull"; id: string; number: number; stale: number };
export type Activity = {
	kind: "issue" | "pull";
	id: string;
	number: number;
	firstSeen: number;
	changedAt: number;
	data: Entity | Pull | null;
	missing: number;
};
export type ProjectState = {
	project: Project;
	activity: Activity[];
	claims: string[];
	/** Each claimed branch at the same occupancy observation as `claims`. */
	branchHeads: Record<string, string>;
	complete: boolean;
	observedAt: number;
	revision: number;
	/** PRs the latest occupancy pass found open, or null until it completes after the last invalidating webhook. */
	open: string[] | null;
	/** Why the last background read failed, until a read or refresh succeeds. */
	failure: string | null;
};

/**
 * How long a closed issue or PR stays in the activity log. Only the log shows
 * closed entities, so after this its row is pruned when history next reads it.
 * 30 days keeps a month of closed history while bounding storage: about 2.5k
 * rows on moq-dev/moq (measured 2026-10-21), against 6.3k unpruned and growing.
 */
export const RETENTION = 30 * 24 * 60 * 60 * 1000;

const entityFields =
	"databaseId:fullDatabaseId number title state updatedAt closedAt author { login } comments { totalCount }";
const pullFields = `${entityFields} headRefName headRefOid isCrossRepository isDraft reviewDecision mergeStateStatus labels(first:20) { nodes { name } } reviews { totalCount } latestReviews(first:20) { nodes { state author {login} commit {oid} } pageInfo {hasNextPage} } commits(last:1) { nodes { commit { oid statusCheckRollup { state } } } }`;
// Cursor variables are declared only for unfinished connections (GraphQL rejects
// unused variables). Fixed page sizes bound subrequests, independent of tree size.
export function activityQuery({ history, occupancy }: Scan, stale: Stale[] = []) {
	const fields: string[] = [];
	const variables = ["$owner: String!", "$name: String!"];
	if (history.issues !== false) {
		variables.push("$issues: String");
		fields.push(
			`issues(first:50,after:$issues,orderBy:{field:UPDATED_AT,direction:DESC}) { nodes { ${entityFields} } pageInfo { hasNextPage endCursor } }`,
		);
	}
	if (history.pulls !== false) {
		variables.push("$pulls: String");
		fields.push(
			`pullRequests(first:50,after:$pulls,orderBy:{field:UPDATED_AT,direction:DESC}) { nodes { ${pullFields} } pageInfo { hasNextPage endCursor } }`,
		);
	}
	if (occupancy.open !== false) {
		variables.push("$open: String");
		fields.push(
			`open:pullRequests(states:OPEN,first:100,after:$open,orderBy:{field:CREATED_AT,direction:ASC}) { nodes { ${pullFields} } pageInfo { hasNextPage endCursor } }`,
		);
	}
	if (occupancy.refs !== false) {
		variables.push("$refs: String");
		fields.push(
			'refs(refPrefix:"refs/heads/quest/",first:100,after:$refs) { nodes { name prefix target { oid } associatedPullRequests(states:MERGED,first:10,orderBy:{field:CREATED_AT,direction:DESC}) { nodes { headRefOid } } } pageInfo { hasNextPage endCursor } }',
		);
	}
	// Numbers come from validated webhook pointers and are interpolated as integers.
	stale.forEach((entity, i) => {
		if (!positiveId(entity.number)) throw new GitHubError("Invalid entity observation");
		fields.push(
			entity.kind === "pull"
				? `s${i}:pullRequest(number:${entity.number}) { ${pullFields} }`
				: `s${i}:issue(number:${entity.number}) { ${entityFields} }`,
		);
	});
	return `query(${variables.join(",")}) { repository(owner:$owner,name:$name) { ${fields.join("\n")} } }`;
}

function next<T>(connection: Connection<T> | undefined, cursor: Cursor) {
	if (cursor === false) return false;
	if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo)
		throw new GitHubError("Incomplete project activity");
	if (!connection.pageInfo.hasNextPage) return false;
	if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor)
		throw new GitHubError("Invalid project activity cursor");
	return connection.pageInfo.endCursor;
}

/**
 * The quest `branch` is named for, as `quest start` names it. A branch
 * convention is evidence of association, never execution authority.
 */
export function associatedQuest(branch: string, paths: Set<string>) {
	const path = branchQuest(branch);
	return paths.has(path) ? path : null;
}

function validate(kind: "issue" | "pull", item: Entity) {
	if (
		typeof item.databaseId !== "string" ||
		!/^[1-9]\d*$/.test(item.databaseId) ||
		!positiveId(item.number) ||
		typeof item.title !== "string" ||
		!Number.isFinite(Date.parse(item.updatedAt))
	)
		throw new GitHubError("Invalid entity observation");
	if (kind === "pull") {
		const pull = item as Pull;
		if (!/^[a-f0-9]{40}$/.test(pull.headRefOid) || pull.commits.nodes.at(-1)?.commit.oid !== pull.headRefOid)
			throw new GitHubError("Pull request head changed; refresh again");
	}
}

/**
 * What is kept of an observed entity: a PR's body only as whether it hands
 * its draft back, and its labels only as the `quest:*` one a session holds it with.
 */
function observed(kind: "issue" | "pull", item: Entity): Entity {
	if (kind === "issue") return item;
	const { body, labels, ...pull } = item as Pull & { body?: unknown; labels?: { nodes: { name: unknown }[] } };
	const names = (labels?.nodes ?? []).map((label) => label.name);
	const hold = names.find((name): name is string => typeof name === "string" && isHoldLabel(name)) ?? null;
	return { ...pull, handedBack: typeof body === "string" && handedBack(body), hold } as Pull;
}

/**
 * A draft its starter still holds: claimed work in progress until its body
 * hands it back with `## Decisions needed`, as the guide defines.
 */
export function owned(pull: Pull) {
	return pull.isDraft && !pull.handedBack;
}

/** Closed for longer than `RETENTION`. */
function expired(item: Entity, now: number) {
	return item.state !== "OPEN" && typeof item.closedAt === "string" && Date.parse(item.closedAt) < now - RETENTION;
}

/** Entities that webhooks named since they were last read by number, oldest first. */
export async function staleEntities(db: D1Database, repository: number) {
	return (
		await db
			.prepare(
				"SELECT kind,id,number,stale FROM github_project_activity WHERE repository=? AND stale>0 ORDER BY changedAt,id LIMIT 50",
			)
			.bind(repository)
			.all<Stale>()
	).results;
}

export async function reconcile(
	db: D1Database,
	repo: GitHubRepository,
	snapshot: Snapshot,
	scan: Scan,
	page: ActivityPage,
	stale: Stale[],
	revision: number,
	epoch: string,
) {
	const now = Date.now();
	const { history, occupancy } = scan;
	const since = history.since ?? { issues: null, pulls: null };
	const watermark = { ...(history.watermark ?? since) };
	const progress = (kind: keyof Marks, connection: Connection<Entity> | undefined, cursor: Cursor): Cursor => {
		const after = next(connection, cursor);
		if (cursor === false) return false;
		for (const item of connection!.nodes) validate(kind === "issues" ? "issue" : "pull", item);
		const lower = since[kind];
		// Keep a conservative boundary from the first page, frozen for the entire pass.
		// Later updates can move ahead of the cursor, but are at or above this boundary
		// and will be replayed next time. Never advance from a later page or stale read.
		if (cursor === null && connection!.nodes.length) {
			const oldest = connection!.nodes.reduce((a, b) =>
				Date.parse(a.updatedAt) < Date.parse(b.updatedAt) ? a : b,
			).updatedAt;
			watermark[kind] = lower && Date.parse(lower) > Date.parse(oldest) ? lower : oldest;
		}
		return lower && connection!.nodes.some((item) => Date.parse(item.updatedAt) < Date.parse(lower))
			? false
			: after;
	};
	const updated: Scan = {
		history: {
			id: history.id,
			issues: progress("issues", page.issues, history.issues),
			pulls: progress("pulls", page.pullRequests, history.pulls),
			complete: false,
			since,
			watermark,
			full: history.full,
		},
		occupancy: {
			open: next(page.open, occupancy.open),
			refs: next(page.refs, occupancy.refs),
			pulls: [...occupancy.pulls],
			claims: [...occupancy.claims],
			heads: { ...occupancy.heads },
			complete: false,
		},
	};
	if (occupancy.refs !== false)
		for (const ref of page.refs!.nodes) {
			const tip = ref.target?.oid;
			const merged = ref.associatedPullRequests?.nodes;
			if (
				typeof ref.name !== "string" ||
				ref.prefix !== "refs/heads/quest/" ||
				typeof tip !== "string" ||
				!Array.isArray(merged)
			)
				throw new GitHubError("Invalid branch observation");
			// A branch left at a merged PR's head holds nothing: its work landed.
			const pulls = merged.map((pull) => ({ head: pull.headRefOid, merged: true }));
			if (landed(tip, pulls) !== undefined) continue;
			// Ref.name is relative to the requested prefix.
			updated.occupancy.claims.push(`quest/${ref.name}`);
			updated.occupancy.heads![`quest/${ref.name}`] = tip;
		}
	updated.history.complete = updated.history.issues === false && updated.history.pulls === false;
	updated.occupancy.complete = updated.occupancy.open === false && updated.occupancy.refs === false;
	// Keyed by identity: an open PR can arrive from both PR connections at once.
	// `stale` is the webhook count a read by number saw, so only it is cleared.
	const entities = new Map<string, { kind: string; item: Entity; stale: number }>();
	for (const [kind, connection, cursor, open] of [
		["issue", page.issues, history.issues, false],
		["pull", page.pullRequests, history.pulls, false],
		["pull", page.open, occupancy.open, true],
	] as const) {
		if (cursor === false) continue;
		for (const item of connection!.nodes) {
			validate(kind, item);
			const lower = since[kind === "issue" ? "issues" : "pulls"];
			if (!open && lower && Date.parse(item.updatedAt) < Date.parse(lower)) continue;
			entities.set(`${kind}/${item.databaseId}`, { kind, item: observed(kind, item), stale: 0 });
			if (open) updated.occupancy.pulls.push(item.databaseId);
		}
	}
	// A read by number is the latest, so it replaces a page's copy.
	const gone: Stale[] = [];
	stale.forEach((entity, i) => {
		const item = page[`s${i}`];
		if (item === undefined) throw new GitHubError("Incomplete project activity");
		if (item) validate(entity.kind, item);
		// A number GitHub no longer resolves to this entity, such as a deleted issue.
		if (!item || item.databaseId !== entity.id) gone.push(entity);
		else
			entities.set(`${entity.kind}/${entity.id}`, {
				kind: entity.kind,
				item: observed(entity.kind, item),
				stale: entity.stale,
			});
	});
	// Long-closed entities lose their rows, unless a webhook named one again since it was read.
	const kept = [...entities.values()].filter((entity) => !expired(entity.item, now));
	const pruned = [...entities.values()]
		.filter((entity) => expired(entity.item, now))
		.map(({ kind, item, stale }) => ({ kind, id: item.databaseId, stale }));
	updated.occupancy.claims = [...new Set(updated.occupancy.claims)];
	updated.occupancy.pulls = [...new Set(updated.occupancy.pulls)];
	const current = "EXISTS(SELECT 1 FROM github_project_state WHERE repository=? AND revision=? AND epoch=?)";
	// GitHub reports UNKNOWN while it computes mergeability, and may send no
	// event once it has. A recorded PR at the same head keeps its last known
	// merge state; at a new head it keeps its changedAt, so the change is news
	// once a definite state arrives. A newly seen PR is news either way.
	const prior = "github_project_activity.data";
	const unknown = `json_extract(excluded.data,'$.mergeStateStatus')='UNKNOWN' AND ${prior} IS NOT NULL`;
	const keeps = `${unknown} AND json_extract(${prior},'$.headRefOid')=json_extract(excluded.data,'$.headRefOid') AND json_extract(${prior},'$.mergeStateStatus') IS NOT NULL`;
	const data = `CASE WHEN ${keeps} THEN json_set(excluded.data,'$.mergeStateStatus',json_extract(${prior},'$.mergeStateStatus')) ELSE excluded.data END`;
	// json_each keeps the transaction to five statements and a few bindings,
	// within D1's free query budget and SQLite's bound-parameter limit.
	const statements = [
		db
			.prepare(
				`INSERT INTO github_project_activity(repository,kind,id,number,firstSeen,changedAt,data,seenIn,stale)
 SELECT ?,json_extract(value,'$.kind'),json_extract(value,'$.item.databaseId'),json_extract(value,'$.item.number'),?,?,json_extract(value,'$.item'),?,json_extract(value,'$.stale')
 FROM json_each(?) WHERE ${current}
 ON CONFLICT(repository,kind,id) DO UPDATE SET number=excluded.number,changedAt=CASE WHEN ${unknown} AND NOT (${keeps}) THEN github_project_activity.changedAt WHEN ${prior} IS NOT ${data} THEN excluded.changedAt ELSE github_project_activity.changedAt END,data=${data},seenIn=excluded.seenIn,missing=0,stale=CASE WHEN excluded.stale>0 AND github_project_activity.stale=excluded.stale THEN 0 ELSE github_project_activity.stale END`,
			)
			.bind(repo.id, now, now, history.id, JSON.stringify(kept), repo.id, revision, epoch),
		db
			.prepare(
				`DELETE FROM github_project_activity WHERE repository=? AND (EXISTS(SELECT 1 FROM json_each(?) WHERE json_extract(value,'$.kind')=github_project_activity.kind AND json_extract(value,'$.id')=github_project_activity.id AND json_extract(value,'$.stale')=github_project_activity.stale) OR (stale=0 AND json_extract(data,'$.state')<>'OPEN' AND json_extract(data,'$.closedAt')<?)) AND ${current}`,
			)
			.bind(repo.id, JSON.stringify(pruned), new Date(now - RETENTION).toISOString(), repo.id, revision, epoch),
		db
			.prepare(
				`UPDATE github_project_activity SET missing=1,stale=CASE WHEN stale=json_extract(value,'$.stale') THEN 0 ELSE stale END
 FROM json_each(?) WHERE repository=? AND kind=json_extract(value,'$.kind') AND github_project_activity.id=json_extract(value,'$.id') AND ${current}`,
			)
			.bind(JSON.stringify(gone), repo.id, repo.id, revision, epoch),
		db
			.prepare(
				// An entity updated mid-pass can move ahead of an update-ordered cursor, so absence is
				// not deletion: mark it stale, and the next read checks it by number before it goes missing.
				`UPDATE github_project_activity SET stale=stale+1 WHERE repository=? AND missing=0 AND (seenIn IS NULL OR seenIn<>?) AND ?=1 AND ${current}`,
			)
			.bind(
				repo.id,
				history.id,
				updated.history.complete && since.issues === null && since.pulls === null ? 1 : 0,
				repo.id,
				revision,
				epoch,
			),
		db
			.prepare(
				"UPDATE github_project_state SET snapshot=?,scan=?,observedAt=?,invalidated=0,failure=NULL,revision=revision+1 WHERE repository=? AND revision=? AND epoch=?",
			)
			.bind(JSON.stringify(snapshot), JSON.stringify(updated), now, repo.id, revision, epoch),
	];
	const result = await db.batch(statements);
	if (result.at(-1)!.meta.changes !== 1) throw new ProjectChanged();
}

type PublishedBranch = { branch: string; head: string | null; pending: string | null; pull: number | null };

/**
 * Whether `quest` is ready and unclaimed, or occupied only by the failed job's
 * own published branch and PR. Never while occupancy is unknown.
 */
export function startable(state: ProjectState, quest: string, failed: PublishedBranch | null) {
	const { available, changes, documents } = state.project;
	if (!available) return false;
	if (available.includes(quest)) return true;
	if (!failed || failed.branch !== questBranch(quest)) return false;
	const retry = continued(state, failed);
	const tip = state.branchHeads[failed.branch];
	// A failed publication owns its observed branch at a recorded commit even
	// before a PR exists. A different PR still blocks it through `changes` below.
	const ownsBranch = tip !== undefined && (tip === failed.head || tip === failed.pending);
	// An already recorded upstream PR can have moved since the job failed; the
	// publication's branch verification will turn that change into a decision.
	const ownsPull = state.activity.some((item) => {
		const pull = item.kind === "pull" && item.number === retry ? (item.data as Pull | null) : null;
		return (
			!item.missing &&
			state.open?.includes(item.id) &&
			pull?.state === "OPEN" &&
			pull.headRefName === questBranch(quest) &&
			pull.isCrossRepository === false
		);
	});
	return (
		(!state.claims.includes(quest) || ownsBranch || ownsPull) &&
		changes.every((change) => change.quest !== quest || change.number === retry) &&
		ready(documents.map((d) => parse(d.path, d.content))).includes(quest)
	);
}

/**
 * The open pull request a retry of a failed job continues: the one the job
 * recorded, or else the only open pull request observed on the job's branch
 * at a commit the job published, which it opened without recording the
 * number. Matching the commit, not only the branch name, keeps a
 * contributor's pull request from a same-named branch a claim.
 */
function continued(state: ProjectState, job: PublishedBranch) {
	if (job.pull !== null || state.open === null) return job.pull;
	const open = new Set(state.open);
	const published = [job.head, job.pending].filter((commit) => commit !== null);
	const pulls = state.activity.filter((item) => {
		const pull = item.kind === "pull" && !item.missing && open.has(item.id) ? (item.data as Pull | null) : null;
		return (
			pull?.state === "OPEN" &&
			pull.isCrossRepository === false &&
			pull.headRefName === job.branch &&
			published.includes(pull.headRefOid)
		);
	});
	return pulls.length === 1 ? pulls[0]!.number : null;
}

/** Open entities and unread webhook pointers; migration 0015's partial index matches this term exactly. */
const LIVE = "(data IS NULL OR json_extract(data,'$.state')='OPEN')";

type Row = Omit<Activity, "data"> & { data: string | null };
const parsed = (rows: Row[]): Activity[] =>
	rows.map((item) => ({ ...item, data: item.data ? JSON.parse(item.data) : null }));

/** Where `readActivity` resumes: the last shown row's position, newest first. */
const CURSOR = /^(\d+)-(issue|pull)-([1-9]\d*)$/;

/**
 * One page of a project's activity log, open and closed alike, newest first,
 * and the cursor of the next page. An unreadable cursor starts from the top.
 */
export async function readActivity(db: D1Database, repository: number, before: string | null = null, limit = 50) {
	const at = before ? CURSOR.exec(before) : null;
	const rows = (
		await db
			.prepare(
				`SELECT kind,id,number,firstSeen,changedAt,data,missing FROM github_project_activity
 WHERE repository=?1 AND (?2 IS NULL OR (firstSeen,kind,id)<(?2,?3,?4))
 ORDER BY firstSeen DESC,kind DESC,id DESC LIMIT ?5`,
			)
			.bind(repository, at ? Number(at[1]) : null, at?.[2] ?? null, at?.[3] ?? null, limit + 1)
			.all<Row>()
	).results;
	const items = parsed(rows.slice(0, limit));
	const last = items.at(-1);
	return { items, next: rows.length > limit && last ? `${last.firstSeen}-${last.kind}-${last.id}` : null };
}

export async function readState(db: D1Database, repo: GitHubRepository): Promise<ProjectState | null> {
	const records = await db.batch([
		db
			.prepare(
				"SELECT snapshot,scan,observedAt,revision,invalidated,failure FROM github_project_state WHERE repository=?",
			)
			.bind(repo.id),
		// Only open entities and unread pointers decide the board, the inbox, and
		// jobs, so this read grows with open work, not history.
		db
			.prepare(
				`SELECT kind,id,number,firstSeen,changedAt,data,missing FROM github_project_activity WHERE repository=? AND ${LIVE} ORDER BY firstSeen DESC,kind DESC,id DESC`,
			)
			.bind(repo.id),
	]);
	const row = records[0]!.results[0] as
		| {
				snapshot: string | null;
				scan: string | null;
				observedAt: number;
				revision: number;
				invalidated: number;
				failure: string | null;
		  }
		| undefined;
	if (!row?.snapshot || !row.scan) return null;
	const snapshot: Snapshot = JSON.parse(row.snapshot);
	const scan: Scan = JSON.parse(row.scan);
	const activity = parsed(records[1]!.results as Row[]);
	const paths = new Set(snapshot.documents.map((d) => d.path));
	// A PR's activity row can still say OPEN until history rereads it, so only
	// PRs in the latest occupancy pass count as open.
	const open = new Set(scan.occupancy.pulls);
	const changes = activity
		.filter((item) => item.kind === "pull" && open.has(item.id) && !item.missing && item.data?.state === "OPEN")
		.flatMap((item) => {
			const pull = item.data as Pull;
			const quest = associatedQuest(pull.headRefName, paths);
			return quest
				? [
						{
							quest,
							author: pull.author?.login ?? "GitHub contributor",
							href: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
							number: pull.number,
							owned: owned(pull),
						},
					]
				: [];
		});
	const claims = scan.occupancy.claims
		.map((ref) => associatedQuest(ref, paths))
		.filter((q): q is string => q !== null);
	const occupied = new Set([...claims, ...changes.map((c) => c.quest)]);
	// Unknown until every open PR and quest branch is read since the last
	// webhook that could have opened, closed, or claimed a quest.
	const settled = scan.occupancy.complete && row.invalidated === 0;
	const available = settled
		? ready(snapshot.documents.map((d) => parse(d.path, d.content))).filter((path) => !occupied.has(path))
		: null;
	const project: Project = {
		...snapshot,
		name: `github/${repo.owner}/${repo.name}`,
		href: `/projects/github/${repo.owner}/${repo.name}/board`,
		title: `${repo.owner}/${repo.name}`,
		web: `https://github.com/${repo.owner}/${repo.name}`,
		changes,
		claims,
		issues: activity
			.filter((item) => item.kind === "issue" && !item.missing && item.data?.state === "OPEN")
			.map((item) => ({ path: `issues/${item.number}`, title: item.data!.title })),
		available,
	};
	return {
		project,
		activity,
		claims,
		branchHeads: scan.occupancy.heads ?? {},
		complete: scan.history.complete,
		observedAt: row.observedAt,
		revision: row.revision,
		open: settled ? scan.occupancy.pulls : null,
		failure: row.failure,
	};
}
