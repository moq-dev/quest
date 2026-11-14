// `quest usage`: which harness, model, and effort worked on each PR, in which role and at what token cost, and how
// the work went by the PR's own record. token-max reads and prices the sessions, on this host and any SSH host
// named; quest ties each to a PR by the branches and repositories token-max exports for it.
import { spawnSync } from "node:child_process";
import { type RecordedRisk, type Size, SIZES, TIERS, type Tier, handedBack, questBranch, recordedRisk } from "../core";
import type { Arm } from "./models";
import { recorded } from "./models-record";
import { type ClaimDependencies, upstream } from "./claims";
import { repositoryPath } from "../github/client";
import { git } from "./git";
import { fixes } from "./land-fixer";
import { MERGER } from "./land-watch-fix";
import { githubRepository, requireRemote } from "./github";
import { type GitHub, type ObjectValue, type Repository, link } from "../github/client";
import { type OnlineReview, readOnlineReviews } from "../github/online-review";
import {
	type Counts,
	type ReviewSummary,
	classifierSessions,
	findingsText,
	parseReview,
	reviewSessions,
	severityText,
} from "./review-record";
import { SEVERITIES } from "./review";
import { ROLES, type Role, type SessionRecord, WAIT_KINDS } from "../core";
import { buildRecords } from "./records";
import { type LoggedWait, readWaits } from "./waits";

/** A session's tokens, and their cost at the model's API list price, which subscriptions do not bill. */
export interface Tokens {
	input: number;
	cacheWrite: number;
	cacheRead: number;
	output: number;
	cost: number;
	/** False when the cost is a lower bound: a request went unpriced or a transcript line was unreadable. */
	complete: boolean;
}

/** One model and effort's spend in a session; token-max names neither when the transcript does not. */
export type Spent = { model: string | null; effort: string | null } & Tokens;

/** One session as `token-max sessions` exports and prices it. */
export interface Session {
	/** The `--ssh` destination it was read on, or null for this host. */
	host: string | null;
	harness: string;
	/** The harness's own ID, as `quest review` records it; null when the transcript names none. */
	id: string | null;
	/** The ID of the session that spawned it, as a sub-agent's or a Codex review's parent; null for a top session. */
	parent: string | null;
	review: boolean;
	cwd: string | null;
	/** The GitHub repositories, as lowercase `owner/repo`, its host resolved for it; null when it could not. */
	repositories: string[] | null;
	/** Each branch it named, with the first and last time, in epoch milliseconds. */
	branches: { name: string; first: number; last: number }[];
	/** Epoch milliseconds of its first and last request in the window. */
	start: number;
	end: number;
	models: Spent[];
	cost: number;
	/** False when its cost is a lower bound: a request went unpriced, or a line was unreadable or unfinished. */
	complete: boolean;
	/** Transcript lines token-max could not read, which its cost leaves out. */
	skippedLines: number;
	/** Its transcript files, on its host. */
	files: string[];
}

/** One session's record, on a PR it worked on, and the host it was read on, or null for this one. */
export type SessionRow = SessionRecord & { host: string | null };
/** One PR's record and the sessions that worked on it. */
export interface PullRow {
	number: number;
	url: string;
	title: string;
	branch: string;
	/** The head repository, lowercased as `owner/repo`, or null once a fork's is deleted. */
	repository: string | null;
	state: "open" | "closed" | "merged";
	draft: boolean;
	/** Its body has a `## Waiting` section, so it was handed back to the maintainer. */
	handedBack: boolean;
	size: Size | null;
	implementers: { harness: string; model: string; effort: string; size: Size | null; arm: Arm | null }[];
	/** The `Implementer:` items it cannot read, which count toward no implementer. */
	unread: string[];
	/** Each reviewer the PR's `## Review` record names, with its latest round and its tally. */
	review: ReviewSummary[];
	/** The risk tier the record names for its head, null when it names none. */
	risk: RecordedRisk | null;
	/** Who made each mechanical fix the land fixer recorded, or `quest land watch` for a base merge it made alone. */
	landFixes: string[];
	/** Later PRs that list it under `## Caused by`. */
	fixedBy: number[];
	/** Each online reviewer's passes and findings, as GitHub shows them. */
	online: OnlineReview[];
	sessions: SessionRow[];
}

export interface SpendRow extends Tokens {
	size: Size | null;
	role: Role;
	harness: string;
	model: string | null;
	effort: string | null;
	sessions: number;
}

/** Spend at list price over the PRs it was found on, which leave out PRs whose sessions no host reported. */
export type Spend = {
	pulls: number;
	/** The part of `cost` split evenly with other seats of its model and effort that nothing told apart. */
	split: number;
} & Tokens;

/** First rounds summed over the reviewed PRs whose every counted tally records one. */
export interface FirstRounds {
	pulls: number;
	findings: Counts["findings"];
}

export interface AccuracyRow {
	/** The implementer's own size, as its line ends with it, else the PR's. */
	size: Size | null;
	harness: string;
	model: string;
	effort: string;
	pulls: number;
	merged: number;
	handedBack: number;
	/** PRs whose record tallies their reviews; a record written before tallies counts for none of what follows. */
	reviewed: number;
	/** The reviewers' latest rounds on the reviewed PRs that have a score, and the scores' sum, leaving out the shadow's. */
	scored: number;
	score: number;
	/** Every reviewer's findings but the shadow's across every round on the reviewed PRs, and as `rounds`, each PR's most rounds. */
	tally: Omit<Counts, "first">;
	firstRounds: FirstRounds;
	/** Its writing sessions' spend on its merged PRs, so `spent.cost / spent.pulls` is its cost per merged PR. */
	spent: Spend;
	/** The land fixer's model-run fixes, leaving out the watcher's own base merges. */
	landFixes: number;
	/** Later PRs naming these PRs under `## Caused by`. */
	fixes: number;
}

/** One local reviewer seat over the PRs reported, by the PR's size, since review efforts follow it. */
export interface ReviewerRow {
	size: Size | null;
	harness: string;
	model: string;
	effort: string;
	shadow: boolean;
	/** PRs whose record tallies this reviewer, each branch counted once, and its findings across every round. */
	reviewed: number;
	tally: Omit<Counts, "first">;
	firstRounds: FirstRounds;
	/** Its reviewing sessions' spend, so `spent.cost / spent.pulls` is its cost per PR reviewed. */
	spent: Spend;
}

/** One writer A/B arm at one size, over the PRs every Implementer line of which names it. */
export interface ArmRow extends Omit<AccuracyRow, "size" | "spent"> {
	size: Size;
	arm: Arm;
	/** The sessions on its PRs in every role, and their spend. */
	sessions: number;
	spend: Tokens;
}

/** The PRs of one risk tier, or of none (`tier` null): how many merged, how many a reviewer raised, and later fixed. */
export interface TierRow {
	tier: Tier | null;
	pulls: number;
	merged: number;
	/** PRs a reviewer judged riskier than the classifier did. */
	raised: number;
	/** PRs a later PR names under `## Caused by`. */
	culprits: number;
}

/** One online reviewer over the merged PRs reported. */
export interface OnlineRow {
	reviewer: string;
	/** Merged PRs reported, whether or not it reviewed them. */
	merged: number;
	/** Those it reviewed, and those whose last head it reviewed. */
	reviewed: number;
	finalHead: number;
	findings: number;
	accepted: number;
	declined: number;
	unclassified: number;
	unanswered: number;
}

export interface Usage {
	repository: string;
	since: string;
	/** Whether token-max ran; without it, the report holds only the PRs' records. */
	priced: boolean;
	pulls: PullRow[];
	spend: SpendRow[];
	accuracy: AccuracyRow[];
	reviewers: ReviewerRow[];
	/** The writer A/B's arms, while it runs. */
	arms: ArmRow[];
	tiers: TierRow[];
	online: OnlineRow[];
	/** The sessions on no PR reported here, from every repository and agent token-max reads; null when narrowed. */
	unattributed: ({ sessions: number } & Tokens) | null;
	/** Copies of a session found on several hosts, left out for its costliest copy, and the hosts they came from. */
	folded: { copies: number; hosts: (string | null)[] };
	/** Each session reported whose cost is a lower bound, with the transcript lines token-max could not read. */
	incomplete: { host: string | null; harness: string; session: string | null; skippedLines: number }[];
}

export interface UsageOptions {
	/** `YYYY-MM-DD`, local time. */
	since: string;
	quest?: string;
	pr?: number;
	/** SSH destinations whose sessions are attributed too, beside this host's. */
	ssh?: string[];
}

export interface UsageDependencies extends ClaimDependencies {
	/** token-max's sessions since an instant on this host and each SSH destination, or null when it is not installed. */
	sessions(since: Date, ssh: string[]): Session[] | null;
	/** The waits logged on this host that ended since an instant, epoch ms. */
	waits(since: number): LoggedWait[];
}

/** The install hint printed when token-max is missing. */
export const TOKEN_MAX_MISSING =
	"token-max is not installed, so no session tokens or cost are reported; install it with `cargo install --locked --git https://github.com/kixel-ai/token-max`";

/** The local date `days` before `now`, as `YYYY-MM-DD`. */
export function daysBefore(now: Date, days: number): string {
	const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
	return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

/** Run `token-max sessions` from PATH, or return null when it is not installed. */
export function runTokenMax(since: Date, ssh: string[]): Session[] | null {
	const hosts = ssh.flatMap((host) => ["--ssh", host]);
	const args = ["sessions", "--since", since.toISOString(), ...hosts, ...(ssh.length ? ["--include-local"] : [])];
	const result = spawnSync("token-max", args, { encoding: "utf8", maxBuffer: 1 << 30 });
	if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
		if (ssh.length) throw new Error("token-max is not installed, so --ssh cannot read other hosts' sessions");
		return null;
	}
	if (result.error) throw result.error;
	// token-max prints its error as one JSON object, naming the host that failed.
	if (result.status !== 0) throw new Error(`token-max sessions exited ${result.status}: ${result.stderr.trim()}`);
	return parseSessions(result.stdout);
}

/** The sessions `token-max sessions` printed, one JSON object per line, failing on any field it lacks. */
export function parseSessions(text: string): Session[] {
	const fail = (what: string): never => {
		throw new Error(`token-max printed a session without ${what}`);
	};
	const count = (value: unknown, what: string): number =>
		typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fail(what);
	const word = (value: unknown, what: string): string =>
		typeof value === "string" && value !== "" ? value : fail(what);
	const optional = (value: unknown, what: string): string | null => (value === null ? null : word(value, what));
	const flag = (value: unknown, what: string): boolean => (typeof value === "boolean" ? value : fail(what));
	const time = (value: unknown, what: string): number => {
		const at = Date.parse(word(value, what));
		return Number.isNaN(at) ? fail(what) : at;
	};
	return text
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => {
			const row = JSON.parse(line) as Record<string, unknown> | null;
			if (row === null || typeof row !== "object") return fail("a JSON object");
			const repositories = row.repositories;
			if (repositories !== null && !Array.isArray(repositories)) fail("a repository list");
			const branches = Array.isArray(row.branches) ? row.branches : fail("a branch list");
			const models = Array.isArray(row.models) ? row.models : fail("a model list");
			// A session's unreadable or unfinished lines may hide any model's requests, so each model's cost is then
			// a lower bound too, though token-max marks only the session.
			const complete = flag(row.complete, "its completeness");
			return {
				host: optional(row.host, "a host"),
				harness: word(row.harness, "a harness"),
				id: optional(row.session, "a session ID"),
				parent: optional(row.parent, "a parent"),
				review: flag(row.review, "a review mark"),
				cwd: optional(row.cwd, "a directory"),
				// A repository that is not on GitHub can head no PR here, so only GitHub's count.
				repositories:
					repositories === null
						? null
						: (repositories as unknown[]).flatMap((url) => {
								const named = githubRepository(word(url, "a repository URL"));
								return named ? [key(named)] : [];
							}),
				branches: branches.map((b: Record<string, unknown>) => ({
					name: word(b?.name, "a branch name"),
					first: time(b.first, "a branch's first time"),
					last: time(b.last, "a branch's last time"),
				})),
				start: time(row.start, "a start"),
				end: time(row.end, "an end"),
				models: models.map((m: Record<string, unknown>) => ({
					model: optional(m?.model, "a model"),
					effort: optional(m.effort, "an effort"),
					input: count(m.inputTokens, "an input token count"),
					cacheWrite: count(m.cacheWriteTokens, "a cache write token count"),
					cacheRead: count(m.cacheReadTokens, "a cache read token count"),
					output: count(m.outputTokens, "an output token count"),
					cost: count(m.costUsd, "a model's cost"),
					complete: flag(m.complete, "a model's completeness") && complete,
				})),
				cost: count(row.costUsd, "a cost"),
				complete,
				skippedLines: count(row.skippedLines, "a skipped line count"),
				files: (Array.isArray(row.files) ? row.files : fail("a file list")).map((f: unknown) =>
					word(f, "a file"),
				),
			};
		});
}

/**
 * Each session once, keeping its costliest copy where several hosts hold it, as when history was copied between
 * them, since counting every copy would inflate the cost per PR. Returns the copies it left out too.
 */
export function fold(sessions: Session[]): { kept: Session[]; dropped: Session[] } {
	const best = new Map<string, Session>();
	const dropped: Session[] = [];
	const id = (session: Session) => JSON.stringify([session.harness, session.id]);
	for (const session of sessions) {
		if (session.id === null) continue;
		const other = best.get(id(session));
		if (other === undefined) best.set(id(session), session);
		else if (session.cost > other.cost) {
			dropped.push(other);
			best.set(id(session), session);
		} else dropped.push(session);
	}
	const kept = sessions.filter((session) => session.id === null || best.get(id(session)) === session);
	return { kept, dropped };
}

/** A PR as `quest usage` reads it from GitHub. */
export interface Pull {
	number: number;
	url: string;
	title: string;
	branch: string;
	/** The head repository, lowercased as `owner/repo`, or null once a fork's is deleted. */
	repository: string | null;
	state: PullRow["state"];
	draft: boolean;
	created: number;
	closed: number | null;
	body: string;
}

/** `repository` as lowercase `owner/repo`. */
export const key = (repository: Repository) => `${repository.owner}/${repository.repo}`.toLowerCase();

function pull(row: ObjectValue): Pull {
	const head = row.head as ObjectValue;
	// Only the head names the branch: a fork's PR may share a branch name with its base, as `main` often does.
	const name = (head?.repo as ObjectValue | null)?.full_name;
	return {
		number: Number(row.number),
		url: String(row.html_url),
		title: String(row.title),
		branch: String(head?.ref),
		repository: typeof name === "string" ? name.toLowerCase() : null,
		state: row.merged_at ? "merged" : row.state === "open" ? "open" : "closed",
		draft: row.draft === true,
		created: Date.parse(String(row.created_at)),
		closed: typeof row.closed_at === "string" ? Date.parse(row.closed_at) : null,
		body: typeof row.body === "string" ? row.body : "",
	};
}

/** The PRs of `repository` updated since `since`, newest update first, read until the listing passes it. */
export async function updatedPulls(client: GitHub, repository: Repository, since: number): Promise<Pull[]> {
	const pulls: Pull[] = [];
	let next: string | undefined =
		`${repositoryPath(repository)}/pulls?state=all&sort=updated&direction=desc&per_page=100`;
	while (next) {
		const page = await client.list(next);
		for (const row of page.rows) {
			if (Date.parse(String(row.updated_at)) < since) return pulls;
			pulls.push(pull(row));
		}
		next = link(page.response, "next");
	}
	return pulls;
}

/**
 * The PR numbers of `repository` that `body`'s `## Caused by` section names as culprits: each bullet that opens with
 * `[owner/repo#N](url) - why`. A link anywhere else on a line, as context or a "fixed by" aside, names no culprit.
 */
export function causes(body: string, repository: Repository): number[] {
	const heading = /^## Caused by[ \t]*\r?$/m.exec(body);
	if (!heading) return [];
	const rest = body.slice(heading.index + heading[0].length);
	const section = rest.slice(0, /^## /m.exec(rest)?.index ?? rest.length);
	const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const name = `${escape(repository.owner)}/${escape(repository.repo)}`;
	const culprit = new RegExp(`^- \\[${name}#(\\d+)\\]\\(https://github\\.com/${name}/pull/(\\d+)\\) - \\S`, "gim");
	const found = [...section.matchAll(culprit)].filter((match) => match[1] === match[2]);
	return [...new Set(found.map((match) => Number(match[1])))];
}

const sized = (value: string | null | undefined): Size | null =>
	(SIZES as readonly string[]).includes(value ?? "") ? (value as Size) : null;

/**
 * A merged PR's reviews with its last round's open findings settled when all of them are low, since the review
 * rule fixes or refutes those before merge without another round; nothing records which, so they count as settled.
 */
function settledOnMerge(reviews: ReviewSummary[], merged: boolean): ReviewSummary[] {
	const settles =
		merged &&
		reviews.every(
			({ tally, open }) => open.high === 0 && open.medium === 0 && (tally === null || tally.open === open.low),
		);
	if (!settles) return reviews;
	return reviews.map((review) =>
		review.tally === null
			? review
			: { ...review, tally: { ...review.tally, settled: review.tally.settled + review.tally.open, open: 0 } },
	);
}

/** Each PR's record, without its sessions yet. */
function pullRows(pulls: Pull[], repository: Repository): PullRow[] {
	const fixedBy = new Map<number, number[]>();
	// A fix counts once it lands: an open or abandoned one, such as a closed duplicate, fixed nothing.
	for (const each of pulls.filter((pull) => pull.state === "merged"))
		for (const cause of causes(each.body, repository))
			if (cause !== each.number) fixedBy.set(cause, [...(fixedBy.get(cause) ?? []), each.number]);
	return pulls.map((each) => {
		const own = recorded(each.body);
		return {
			number: each.number,
			url: each.url,
			title: each.title,
			branch: each.branch,
			repository: each.repository,
			state: each.state,
			draft: each.draft,
			handedBack: each.draft && handedBack(each.body),
			size: own.sizes.map(sized).find((s) => s !== null) ?? null,
			implementers: own.implementers.flatMap(({ fields }) =>
				fields ? [{ ...fields, size: sized(fields.size) }] : [],
			),
			unread: own.implementers.filter(({ fields }) => fields === null).map(({ item }) => item),
			review: settledOnMerge(parseReview(each.body), each.state === "merged"),
			risk: recordedRisk(each.body),
			landFixes: fixes(each.body),
			fixedBy: (fixedBy.get(each.number) ?? []).sort((a, b) => a - b),
			online: [],
			sessions: [],
		};
	});
}

const add = (to: Tokens, from: Tokens) => {
	to.input += from.input;
	to.cacheWrite += from.cacheWrite;
	to.cacheRead += from.cacheRead;
	to.output += from.output;
	to.cost += from.cost;
	to.complete &&= from.complete;
};
const zero = (): Tokens => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0, complete: true });

/**
 * Which repositories the directory `cwd` on `host` belongs to: those token-max resolved for the session, else those
 * it resolved for another session in that exact directory on the same host, as a Codex log records after the
 * checkout is deleted; null when nothing tells, since a branch name alone may be another repository's. A directory
 * above it never tells, since a nested clone may be another repository's.
 */
function owners(sessions: Session[]): (session: Session) => string[] | null {
	const where = (session: Session) => JSON.stringify([session.host, session.cwd]);
	const known = new Map<string, Set<string>>();
	for (const session of sessions)
		if (session.cwd !== null && session.repositories?.length) {
			const names = known.get(where(session)) ?? new Set();
			for (const name of session.repositories) names.add(name);
			known.set(where(session), names);
		}
	return (session) => {
		if (session.repositories?.length) return session.repositories;
		const names = session.cwd === null ? undefined : known.get(where(session));
		return names ? [...names] : null;
	};
}

/**
 * The PR each session's own branch heads: the one whose head branch it last named, among those still open when the
 * session reached the branch and headed from a repository its host resolved for it. `evidence` holds every exported
 * copy, folded ones included, since a dropped copy may be the only one naming its directory's repository.
 */
function attribute(
	sessions: Session[],
	evidence: Session[],
	pulls: Pull[],
): { own: Map<Session, Pull>; known: (session: Session) => string[] | null } {
	const byBranch = new Map<string, Pull[]>();
	for (const each of [...pulls].sort((a, b) => a.created - b.created))
		byBranch.set(each.branch, [...(byBranch.get(each.branch) ?? []), each]);
	const own = new Map<Session, Pull>();
	const owned = owners(evidence);
	for (const session of sessions) {
		// Another repository may use the same branch name, so a session counts only where its repository is known.
		const known = owned(session);
		if (known === null) continue;
		for (const seen of [...session.branches].sort((a, b) => b.last - a.last)) {
			// A branch can head a new PR after an earlier one closed: take the one open when the session reached it.
			const open = (byBranch.get(seen.name) ?? []).filter(
				(each) =>
					(each.closed === null || each.closed >= seen.first) &&
					each.repository !== null &&
					known.includes(each.repository),
			);
			// A checkout with remotes for both a fork and its upstream cannot tell which one's branch it was on.
			if (new Set(open.map((each) => each.repository)).size > 1) continue;
			const found = open[0];
			if (found) {
				own.set(session, found);
				break;
			}
		}
	}
	return { own, known: owned };
}

/** What `sessionRecords` builds from. */
export interface RecordSources {
	/** The base repository as lowercase `owner/repo`. */
	repository: string;
	/** The sessions to attribute, each once. */
	sessions: Session[];
	/** Every exported copy, folded ones included, for the repositories each directory belongs to. */
	evidence: Session[];
	/** The repository's PRs in the window. */
	pulls: Pull[];
	/** The waits logged on this host. */
	waits: LoggedWait[];
	/** The sessions to build records for; by default, those on a PR. */
	emit?: Set<Session>;
	/** The window's start, epoch ms. */
	since: number;
}

/** Each session's record, attributed to the PRs in the window, whose review records name their reviewers and classifier. */
export function sessionRecords(sources: RecordSources): Map<Session, SessionRecord> {
	const { repository, sessions, evidence, pulls, waits, emit, since } = sources;
	// Only the reviewer sessions are read, so no PR author can stop every session's record with a body this version
	// cannot parse.
	const reviewers = new Set(pulls.flatMap((pull) => reviewSessions(pull.body)));
	const classifiers = new Set(pulls.flatMap((pull) => classifierSessions(pull.body)));
	return buildRecords({
		repository,
		sessions,
		...attribute(sessions, evidence, pulls),
		reviewers,
		classifiers,
		waits,
		emit,
		since,
	});
}

/** A row of a session with no ID, by its host and transcript files, which no two sessions share. */
const anonymous = new WeakMap<SessionRow, string>();

/** One session across the PR rows it appears on. */
const identity = (session: SessionRow) => JSON.stringify([session.harness, session.session ?? anonymous.get(session)]);

function spendRows(pulls: PullRow[]): SpendRow[] {
	const rows = new Map<string, SpendRow & { seen: Set<string> }>();
	for (const each of pulls)
		for (const session of each.sessions)
			for (const spent of session.models) {
				const id = JSON.stringify([each.size, session.role, session.harness, spent.model, spent.effort]);
				let row = rows.get(id);
				if (!row) {
					row = {
						size: each.size,
						role: session.role,
						harness: session.harness,
						model: spent.model,
						effort: spent.effort,
						sessions: 0,
						...zero(),
						seen: new Set(),
					};
					rows.set(id, row);
				}
				if (!row.seen.has(identity(session))) row.sessions++;
				row.seen.add(identity(session));
				add(row, portion(session, spent));
			}
	const roles: readonly Role[] = ROLES;
	return [...rows.values()]
		.map(({ seen: _, ...row }) => row)
		.sort((a, b) =>
			order(
				[a.size, roles.indexOf(a.role), a.harness, a.model, a.effort],
				[b.size, roles.indexOf(b.role), b.harness, b.model, b.effort],
			),
		);
}

const noCounts = (): Omit<Counts, "first"> => ({
	rounds: 0,
	findings: { high: 0, medium: 0, low: 0 },
	fixed: 0,
	refuted: 0,
	settled: 0,
	open: 0,
});
const noFirst = (): FirstRounds => ({ pulls: 0, findings: { high: 0, medium: 0, low: 0 } });
const noSpend = (): Spend => ({ pulls: 0, split: 0, ...zero() });

/** Add one PR's `tallies` of a cell to its counts, its rounds as their most, and to its first rounds when all have one. */
function count(to: { tally: Omit<Counts, "first">; firstRounds: FirstRounds }, tallies: Counts[]) {
	to.tally.rounds += Math.max(...tallies.map((tally) => tally.rounds));
	for (const tally of tallies) {
		for (const severity of SEVERITIES) to.tally.findings[severity] += tally.findings[severity];
		to.tally.fixed += tally.fixed;
		to.tally.refuted += tally.refuted;
		to.tally.settled += tally.settled;
		to.tally.open += tally.open;
	}
	if (tallies.every((tally) => tally.first !== null)) {
		to.firstRounds.pulls++;
		for (const tally of tallies)
			for (const severity of SEVERITIES) to.firstRounds.findings[severity] += tally.first![severity];
	}
}

/**
 * A PR's spend split among `seats`, as its record names them: spend whose `seat` is known, as a reviewer's session its
 * record names, to that seat; each model's other spend to the seats of that model, of its effort where both name one;
 * and spend of a model no seat names, as a sub-agent on a smaller model, to the seat that took the most, the PR's
 * main one. Spend that fits several seats goes to the first, the PR's writer, when an implementing session spent it,
 * and to the others when an iterating one did; what still fits several is split evenly among them and counted as
 * `split`, rather than given to one. Returns each seat's share, by index, and nothing without a seat.
 */
export function share(
	spent: (Spent & { role?: Role; seat?: number })[],
	seats: { model: string; effort: string }[],
): Map<number, Tokens & { split: number }> {
	const shares = new Map<number, Tokens & { split: number }>();
	if (seats.length === 0) return shares;
	const into = (seat: number, from: Tokens, split = false) => {
		const to = shares.get(seat) ?? { split: 0, ...zero() };
		add(to, from);
		if (split) to.split += from.cost;
		shares.set(seat, to);
	};
	const rest: Spent[] = [];
	for (const each of spent) {
		if (each.seat !== undefined) {
			into(each.seat, each);
			continue;
		}
		const same = seats.flatMap((seat, i) => (seat.model === each.model ? [i] : []));
		const effort = each.effort ?? "unknown";
		const exact = same.filter((i) => seats[i]!.effort === effort);
		const loose = same.filter((i) => seats[i]!.effort === "unknown" || effort === "unknown");
		let fits = exact.length > 0 ? exact : loose.length > 0 ? loose : same;
		if (fits.length > 1 && each.role === "implementing" && fits.includes(0)) fits = [0];
		else if (fits.length > 1 && each.role === "iterating" && fits.some((i) => i !== 0))
			fits = fits.filter((i) => i !== 0);
		if (fits.length === 0) rest.push(each);
		else for (const seat of fits) into(seat, part(each, fits.length), fits.length > 1);
	}
	if (rest.length > 0) {
		const main = [...shares].reduce<[number, Tokens] | undefined>(
			(best, entry) => (best === undefined || entry[1].cost > best[1].cost ? entry : best),
			undefined,
		);
		for (const each of rest) into(main?.[0] ?? 0, each);
	}
	return shares;
}

/** A session's spend on one PR: on several, as a coordinator is, it counts toward each in equal shares. */
const portion = (session: SessionRow, spent: Spent): Spent =>
	session.pulls.length > 1 ? { ...spent, ...part(spent, session.pulls.length) } : spent;
const shareOf = (session: SessionRow): Spent[] => session.models.map((spent) => portion(session, spent));

/** One `n`th of `tokens`. */
function part(tokens: Tokens, n: number): Tokens {
	return {
		input: tokens.input / n,
		cacheWrite: tokens.cacheWrite / n,
		cacheRead: tokens.cacheRead / n,
		output: tokens.output / n,
		cost: tokens.cost / n,
		complete: tokens.complete,
	};
}

const noOutcomes = (): Omit<AccuracyRow, "size" | "harness" | "model" | "effort" | "spent"> => ({
	pulls: 0,
	merged: 0,
	handedBack: 0,
	reviewed: 0,
	scored: 0,
	score: 0,
	tally: noCounts(),
	firstRounds: noFirst(),
	landFixes: 0,
	fixes: 0,
});

/** Add a PR's outcomes to a writer's or arm's row, counting its tallies only when it is its branch's `latest`. */
function outcome(row: ReturnType<typeof noOutcomes>, each: PullRow, latest: Set<PullRow>) {
	row.pulls++;
	if (each.state === "merged") row.merged++;
	if (each.handedBack) row.handedBack++;
	row.fixes += each.fixedBy.length;
	row.landFixes += each.landFixes.filter((by) => by !== MERGER).length;
	// The shadow's findings measure an effort step, not the writer, so they stay out of the writer's row.
	const counted = latest.has(each) ? each.review.filter((review) => review.tally !== null && !review.shadow) : [];
	if (counted.length === 0) return;
	row.reviewed++;
	for (const { score } of counted)
		if (score !== null) {
			row.scored++;
			row.score += score;
		}
	count(
		row,
		counted.map((review) => review.tally!),
	);
}

/**
 * A branch's saved tallies span every PR from it, so only one of its PRs that `counts` counts them: the one whose
 * record holds the latest tally, as the most rounds show, since each round rewrites only its own PR's record; the
 * newest breaks a tie. A deleted fork has no repository, so its PR stands alone.
 */
function tallied(pulls: PullRow[], counts: (pull: PullRow) => boolean): Set<PullRow> {
	const branch = (each: PullRow) => JSON.stringify([each.repository ?? each.number, each.branch]);
	const rounds = (each: PullRow) =>
		each.review.reduce((sum, review) => sum + (review.shadow ? 0 : (review.tally?.rounds ?? 0)), 0);
	const latest = new Map<string, PullRow>();
	for (const each of pulls) {
		if (!counts(each) || each.review.every((review) => review.tally === null)) continue;
		const other = latest.get(branch(each));
		if (
			other === undefined ||
			rounds(each) > rounds(other) ||
			(rounds(each) === rounds(other) && each.number > other.number)
		)
			latest.set(branch(each), each);
	}
	return new Set(latest.values());
}

function accuracyRows(pulls: PullRow[]): AccuracyRow[] {
	const rows = new Map<string, AccuracyRow>();
	const latest = tallied(pulls, (each) => each.implementers.length > 0);
	for (const each of pulls) {
		// A session that pushed twice is one implementer of the PR, whether or not each line names its size.
		const distinct = [
			...new Map(
				each.implementers.map(({ harness, model, effort, size }) => {
					const at = { harness, model, effort, size: size ?? each.size };
					return [JSON.stringify(at), at];
				}),
			).values(),
		];
		const writing = each.sessions
			.filter((session) => session.role === "implementing" || session.role === "iterating")
			.flatMap((session) => shareOf(session).map((spent) => ({ ...spent, role: session.role })));
		const shares =
			each.state === "merged" ? share(writing, distinct) : new Map<number, Tokens & { split: number }>();
		for (const [i, implementer] of distinct.entries()) {
			const size = implementer.size;
			const id = JSON.stringify([size, implementer.harness, implementer.model, implementer.effort]);
			let row = rows.get(id);
			if (!row) {
				row = {
					size,
					harness: implementer.harness,
					model: implementer.model,
					effort: implementer.effort,
					...noOutcomes(),
					spent: noSpend(),
				};
				rows.set(id, row);
			}
			outcome(row, each, latest);
			const spent = shares.get(i);
			if (spent) {
				row.spent.pulls++;
				row.spent.split += spent.split;
				add(row.spent, spent);
			}
		}
	}
	return [...rows.values()].sort((a, b) =>
		order([a.size, a.harness, a.model, a.effort], [b.size, b.harness, b.model, b.effort]),
	);
}

function reviewerRows(pulls: PullRow[]): ReviewerRow[] {
	const rows = new Map<string, ReviewerRow>();
	const latest = tallied(pulls, () => true);
	const row = (each: PullRow, review: ReviewSummary) => {
		const id = JSON.stringify([each.size, review.harness, review.model, review.effort, review.shadow]);
		let found = rows.get(id);
		if (!found) {
			found = {
				size: each.size,
				harness: review.harness,
				model: review.model,
				effort: review.effort,
				shadow: review.shadow,
				reviewed: 0,
				tally: noCounts(),
				firstRounds: noFirst(),
				spent: noSpend(),
			};
			rows.set(id, found);
		}
		return found;
	};
	for (const each of pulls) {
		// A session its record names, or that one's sub-agent, is that reviewer's, so a routed and a shadow reviewer
		// at one effort are told apart.
		const named = (session: SessionRow) => {
			const at = each.review.findIndex(
				(review) =>
					review.session !== null &&
					(review.session === session.session || review.session === session.parent),
			);
			return at < 0 ? undefined : at;
		};
		const reviewing = each.sessions
			.filter((session) => session.role === "reviewing")
			.flatMap((session) => shareOf(session).map((spent) => ({ ...spent, seat: named(session) })));
		for (const [i, spent] of share(reviewing, each.review)) {
			const to = row(each, each.review[i]!).spent;
			to.pulls++;
			to.split += spent.split;
			add(to, spent);
		}
		if (!latest.has(each)) continue;
		for (const review of each.review.filter((review) => review.tally !== null)) {
			const to = row(each, review);
			to.reviewed++;
			count(to, [review.tally!]);
		}
	}
	return [...rows.values()].sort((a, b) =>
		order(
			[a.size, a.harness, a.model, a.effort, String(a.shadow)],
			[b.size, b.harness, b.model, b.effort, String(b.shadow)],
		),
	);
}

/**
 * The writer A/B's rollup: each sized PR whose every Implementer line names the same arm counts in it, under the
 * size and writer its first line names, with every session's spend on it; a writer off its arm, such as a fallback
 * that names none, leaves its PR in neither.
 */
function armRows(pulls: PullRow[]): ArmRow[] {
	const rows = new Map<string, ArmRow>();
	const seen = new Map<ArmRow, Set<string>>();
	const latest = tallied(pulls, (each) => each.implementers.length > 0);
	for (const each of pulls) {
		const first = each.implementers[0];
		if (!first?.arm || each.size === null || each.unread.length > 0) continue;
		if (each.implementers.some((implementer) => implementer.arm !== first.arm)) continue;
		const { harness, model, effort, arm } = first;
		const id = JSON.stringify([each.size, arm, harness, model, effort]);
		let row = rows.get(id);
		if (!row) {
			row = { size: each.size, arm, harness, model, effort, ...noOutcomes(), sessions: 0, spend: zero() };
			rows.set(id, row);
		}
		outcome(row, each, latest);
		const counted = seen.get(row) ?? new Set<string>();
		seen.set(row, counted);
		for (const session of each.sessions) {
			// A session on several PRs of the arm, as a coordinator is, counts once, its shares adding up to its cost.
			if (!counted.has(identity(session))) row.sessions++;
			counted.add(identity(session));
			for (const spent of shareOf(session)) add(row.spend, spent);
		}
	}
	return [...rows.values()].sort((a, b) =>
		order([a.size, a.arm, a.harness, a.model, a.effort], [b.size, b.arm, b.harness, b.model, b.effort]),
	);
}

/** One row per risk tier among `pulls`, lowest first, and PRs with none last. */
function tierRows(pulls: PullRow[]): TierRow[] {
	return [...TIERS, null].flatMap((tier) => {
		const rows = pulls.filter((each) => (each.risk?.tier ?? null) === tier);
		if (rows.length === 0) return [];
		return [
			{
				tier,
				pulls: rows.length,
				merged: rows.filter((each) => each.state === "merged").length,
				raised: rows.filter((each) => each.risk !== null && each.risk.tier !== each.risk.classified).length,
				culprits: rows.filter((each) => each.fixedBy.length > 0).length,
			},
		];
	});
}

function onlineRows(pulls: PullRow[]): OnlineRow[] {
	const merged = pulls.filter((each) => each.state === "merged");
	const rows = new Map<string, OnlineRow>();
	for (const each of merged)
		for (const review of each.online) {
			let row = rows.get(review.reviewer);
			if (!row) {
				row = {
					reviewer: review.reviewer,
					merged: merged.length,
					reviewed: 0,
					finalHead: 0,
					findings: 0,
					accepted: 0,
					declined: 0,
					unclassified: 0,
					unanswered: 0,
				};
				rows.set(review.reviewer, row);
			}
			row.reviewed++;
			if (review.finalHead) row.finalHead++;
			row.findings += review.findings;
			row.accepted += review.accepted;
			row.declined += review.declined;
			row.unclassified += review.unclassified;
			row.unanswered += review.unanswered;
		}
	return [...rows.values()].sort((a, b) => a.reviewer.localeCompare(b.reviewer));
}

/** Rollup rows by size, smallest first and unsized last, then by each further field. */
function order(
	[size, ...a]: [Size | null, ...(string | number | null)[]],
	[other, ...b]: [Size | null, ...(string | number | null)[]],
): number {
	const rank = (s: Size | null) => (s === null ? SIZES.length : SIZES.indexOf(s));
	if (rank(size) !== rank(other)) return rank(size) - rank(other);
	for (const [i, x] of a.entries()) {
		const y = b[i] ?? "";
		if (String(x ?? "") !== String(y))
			return typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y));
	}
	return 0;
}

/** The usage report for the GitHub repository of the checkout at `root`'s `origin`. */
export async function usage(root: string, options: UsageOptions, deps: UsageDependencies): Promise<Usage> {
	const top = git(root, ["rev-parse", "--show-toplevel"]);
	const up = await upstream(top, requireRemote(top, "origin"), deps);
	if (up.github === null) throw new Error("origin is not on GitHub");
	const { client, repository } = up.github;
	const since = new Date(`${options.since}T00:00:00`).getTime();
	const branch = options.quest === undefined ? undefined : questBranch(options.quest);
	// Caused-by links come from every PR in the window, even when the report narrows to one.
	const all = await updatedPulls(client, repository, since);
	const pulls = all.filter(
		(each) =>
			(options.pr === undefined || each.number === options.pr) &&
			(branch === undefined || each.branch === branch),
	);
	const narrowed = options.pr !== undefined || branch !== undefined;
	const allRows = pullRows(all, repository);
	const rows = allRows.filter((row) => pulls.some((each) => each.number === row.number));
	const byNumber = new Map(rows.map((row) => [row.number, row]));
	const exported = deps.sessions(new Date(since), options.ssh ?? []);
	const { kept, dropped } = fold(exported ?? []);
	let unattributed: Usage["unattributed"] = null;
	let incomplete: Session[] = [];
	let folded: Session[] = dropped;
	if (exported !== null) {
		// Every PR in the window competes for a session, so narrowing never hands one PR another's sessions.
		const records = sessionRecords({
			repository: key(repository),
			sessions: kept,
			evidence: exported,
			pulls: all,
			waits: deps.waits(since),
			since,
		});
		const attributed: Session[] = [];
		const left: Session[] = [];
		for (const session of kept) {
			const record = records.get(session);
			const on = record?.pulls.flatMap((number) => byNumber.get(number) ?? []) ?? [];
			for (const row of on) {
				const each = { ...record!, host: session.host };
				if (each.session === null) anonymous.set(each, JSON.stringify([session.host, session.files]));
				row.sessions.push(each);
			}
			if (on.length) attributed.push(session);
			else if (!record?.pulls.length) left.push(session);
		}
		const reported = narrowed ? attributed : [...attributed, ...left];
		if (!narrowed) {
			unattributed = { sessions: left.length, ...zero() };
			for (const session of left) for (const spent of session.models) add(unattributed, spent);
		}
		incomplete = reported.filter((session) => !session.complete);
		// A narrowed report counts only the folded copies of the sessions it reports.
		const ids = new Set(reported.map((session) => `${session.harness}\0${session.id}`));
		folded = dropped.filter((session) => ids.has(`${session.harness}\0${session.id}`));
	}
	const online = await readOnlineReviews(
		client,
		repository,
		rows.map((row) => row.number),
	);
	for (const row of rows) row.online = online.get(row.number) ?? [];
	return {
		repository: key(repository),
		since: options.since,
		priced: exported !== null,
		pulls: rows,
		spend: spendRows(rows),
		accuracy: accuracyRows(rows),
		reviewers: reviewerRows(rows),
		arms: armRows(rows),
		tiers: tierRows(rows),
		online: onlineRows(rows),
		unattributed,
		folded: { copies: folded.length, hosts: [...new Set(folded.map((session) => session.host))] },
		incomplete: incomplete.map((session) => ({
			host: session.host,
			harness: session.harness,
			session: session.id,
			skippedLines: session.skippedLines,
		})),
	};
}

const compact = (n: number) =>
	n >= 1e9
		? `${(n / 1e9).toFixed(1)}B`
		: n >= 1e6
			? `${(n / 1e6).toFixed(1)}M`
			: n >= 1e3
				? `${(n / 1e3).toFixed(1)}k`
				: String(n);
const tokens = (t: Tokens) =>
	`in ${compact(t.input)}, cache ${compact(t.cacheWrite)} written ${compact(t.cacheRead)} read, out ${compact(t.output)}, ~$${t.cost.toFixed(2)}${t.complete ? "" : " or more"}`;
const mean = (sum: number, count: number) => (count ? (sum / count).toFixed(1) : "-");
const firsts = (f: FirstRounds) => `first rounds ${f.pulls}: ${severityText(f.findings)}`;
const per = (s: Spend, what: string) =>
	s.pulls
		? `~$${(s.cost / s.pulls).toFixed(2)}${s.complete ? "" : " or more"} per ${what} over ${s.pulls}${s.split ? `, ~$${s.split.toFixed(2)} of it split with other seats` : ""}`
		: `no ${what} priced`;
const percent = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)}%` : "-");
const answers = (r: Omit<OnlineReview, "reviewer" | "finalHead">) =>
	`${r.findings} finding${r.findings === 1 ? "" : "s"}: ${r.accepted} accepted, ${r.declined} declined, ${r.unclassified} unclassified, ${r.unanswered} unanswered`;

/** Seconds under a minute, hours past two, else minutes. */
const duration = (ms: number) =>
	ms < 60_000
		? `${Math.round(ms / 1000)}s`
		: ms >= 7_200_000
			? `${(ms / 3_600_000).toFixed(1)}h`
			: `${Math.round(ms / 60_000)}m`;

/**
 * The time a PR's sessions spent in each kind of wait, a shared session's in its share, and how many sessions'
 * waits are unknown, as for those read on another host; empty when there is nothing to say.
 */
function waitTotals(sessions: SessionRow[]): string {
	const totals = new Map<string, number>();
	let unknown = 0;
	for (const s of sessions) {
		if (s.waits === null) unknown++;
		for (const w of s.waits ?? [])
			totals.set(w.kind, (totals.get(w.kind) ?? 0) + (Date.parse(w.end) - Date.parse(w.start)) / s.pulls.length);
	}
	const parts = WAIT_KINDS.filter((kind) => totals.has(kind)).map((kind) => `${kind} ${duration(totals.get(kind)!)}`);
	if (unknown) parts.push(`unknown for ${unknown} session${unknown === 1 ? "" : "s"} on other hosts`);
	return parts.join(", ");
}

/** Rows of cells, each column padded to its widest cell. */
function table(rows: string[][]): string[] {
	const widths = rows.reduce<number[]>((w, row) => row.map((cell, i) => Math.max(w[i] ?? 0, cell.length)), []);
	return rows.map((row) =>
		row
			.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!)))
			.join("  ")
			.trimEnd(),
	);
}

/** The report as plain lines: each PR, then the rollups. */
export function usageLines(report: Usage): string[] {
	const lines = [
		`${report.repository}, PRs updated and sessions active since ${report.since}; costs (~$) estimate API list prices`,
	];
	for (const row of report.pulls) {
		const state = `${row.state}${row.draft ? (row.handedBack ? " draft, handed back" : " draft") : ""}`;
		lines.push(
			"",
			`#${row.number} ${row.size ?? "-"} ${row.risk?.tier ?? "-"} ${state}: ${row.title} (${row.branch})`,
		);
		if (row.risk)
			lines.push(
				`  risk: ${row.risk.tier}, ${row.risk.reason}${row.risk.tier === row.risk.classified ? "" : `; raised from ${row.risk.classified} by a reviewer`}`,
			);
		for (const i of row.implementers) {
			const notes = [i.size, i.arm && `arm ${i.arm}`].filter(Boolean).join(", ");
			lines.push(`  implementer: ${i.harness}, ${i.model}, ${i.effort} effort${notes ? ` (${notes})` : ""}`);
		}
		for (const item of row.unread) lines.push(`  unread: ${item}`);
		for (const r of row.review)
			lines.push(
				`  review: ${r.harness}, ${r.model}, ${r.effort} effort${r.shadow ? ", shadow" : ""}; ${r.round === null ? "not in the latest run" : `round ${r.round}, score ${r.score ?? "-"}/10`}; ${r.tally === null ? "no tally" : `rounds ${r.tally.rounds}, ${findingsText(r.tally)}`}`,
			);
		for (const o of row.online)
			lines.push(`  online review: ${o.reviewer}, ${o.finalHead ? "" : "not "}at the final head; ${answers(o)}`);
		if (row.landFixes.length) lines.push(`  land fixes: ${row.landFixes.join("; ")}`);
		if (row.fixedBy.length) lines.push(`  fixed later by: ${row.fixedBy.map((n) => `#${n}`).join(", ")}`);
		const sessions = row.sessions.flatMap((s) =>
			s.models.map((m) => [
				"   ",
				s.role,
				s.host ?? "local",
				s.harness,
				m.model ?? "-",
				m.effort ?? "-",
				`${tokens(m)}${s.pulls.length > 1 ? `, 1/${s.pulls.length} here` : ""}`,
			]),
		);
		if (sessions.length) lines.push("  sessions:", ...table(sessions));
		const waited = waitTotals(row.sessions);
		if (waited) lines.push(`  waits: ${waited}`);
	}
	if (report.spend.length)
		lines.push(
			"",
			"Spend by size, role, and model:",
			...table(
				report.spend.map((s) => [
					" ",
					s.size ?? "-",
					s.role,
					s.harness,
					s.model ?? "-",
					s.effort ?? "-",
					`${s.sessions}x`,
					tokens(s),
				]),
			),
		);
	if (report.accuracy.length)
		lines.push(
			"",
			"Accuracy by size and implementer:",
			...table(
				report.accuracy.map((a) => [
					" ",
					a.size ?? "-",
					a.harness,
					a.model,
					a.effort,
					`${a.pulls} PRs, ${a.merged} merged, ${a.handedBack} handed back, ${a.reviewed} reviewed: score ${mean(a.score, a.scored)}, rounds ${mean(a.tally.rounds, a.reviewed)}, ${findingsText({ ...a.tally, first: null })}, ${firsts(a.firstRounds)}; ${a.landFixes} land fixes, ${a.fixes} later fixes; ${per(a.spent, "merged PR")}`,
				]),
			),
		);
	if (report.reviewers.length)
		lines.push(
			"",
			"Local reviewers by PR size:",
			...table(
				report.reviewers.map((r) => [
					" ",
					r.size ?? "-",
					r.harness,
					r.model,
					`${r.effort}${r.shadow ? ", shadow" : ""}`,
					`${r.reviewed} reviewed: rounds ${mean(r.tally.rounds, r.reviewed)}, ${findingsText({ ...r.tally, first: null })}, ${firsts(r.firstRounds)}; ${per(r.spent, "PR reviewed")}`,
				]),
			),
		);
	if (report.arms.length)
		lines.push(
			"",
			"Writer A/B by size and arm:",
			...table(
				report.arms.map((a) => [
					" ",
					a.size,
					a.arm,
					a.harness,
					a.model,
					a.effort,
					`${a.pulls} PRs, ${a.merged} merged, ${a.handedBack} handed back, ${a.reviewed} reviewed: rounds ${mean(a.tally.rounds, a.reviewed)}, ${findingsText({ ...a.tally, first: null })}, ${firsts(a.firstRounds)}; ${a.fixes} later fixes; ${a.sessions} sessions, ${tokens(a.spend)}`,
				]),
			),
		);
	if (report.tiers.length)
		lines.push(
			"",
			"By risk tier:",
			...table(
				report.tiers.map((t) => [
					" ",
					t.tier ?? "-",
					`${t.pulls} PRs, ${t.merged} merged, ${t.raised} raised by a reviewer, ${t.culprits} later fixed`,
				]),
			),
		);
	if (report.online.length)
		lines.push(
			"",
			"Online reviewers over merged PRs:",
			...table(
				report.online.map((o) => [
					" ",
					o.reviewer,
					`reviewed ${o.reviewed}/${o.merged} (${percent(o.reviewed, o.merged)}), final head ${o.finalHead} (${percent(o.finalHead, o.merged)}), ${mean(o.findings, o.reviewed)} findings per PR reviewed, ${percent(o.accepted, o.findings)} accepted; ${answers(o)}`,
				]),
			),
		);
	const u = report.unattributed;
	if (u) lines.push("", `Unattributed: ${u.sessions} sessions on no PR here, any repository or agent: ${tokens(u)}`);
	const host = (name: string | null) => name ?? "local";
	const { folded, incomplete } = report;
	if (folded.copies)
		lines.push(
			"",
			`Folded ${folded.copies} ${folded.copies === 1 ? "copy" : "copies"} of sessions found on several hosts, keeping each one's costliest; left out from ${folded.hosts.map(host).join(", ")}`,
		);
	if (incomplete.length)
		lines.push(
			"",
			"Lower bounds: these sessions had a request token-max could not price, or a line it could not read or that was unfinished:",
			...table(
				incomplete.map((s) => [
					" ",
					host(s.host),
					s.harness,
					s.session ?? "-",
					`${s.skippedLines} unreadable lines`,
				]),
			),
		);
	return lines;
}

/** The dependencies `quest usage` runs with. */
export function usageDependencies(github: ClaimDependencies): UsageDependencies {
	return { ...github, sessions: runTokenMax, waits: (since) => readWaits(since) };
}
