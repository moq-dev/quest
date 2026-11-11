// `quest usage`: which harness, model, and effort worked on each PR, in which role and at what token cost, and how
// the work went by the PR's own record. ccusage reads and prices the sessions; quest ties each to a PR by the
// branch its log names, reading only that metadata and never a prompt or reply.
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Size, SIZES, handedBack, questBranch } from "../core";
import { implementer, recorded } from "../github/models";
import { type ClaimDependencies, repositoryPath, upstream } from "./claims";
import { discoveryEnv, git } from "./git";
import { fixes } from "./land-fixer";
import { MERGER } from "./land-watch-fix";
import { type GitHub, type ObjectValue, type Repository, githubRepository, link, requireRemote } from "./github";
import { type ReviewSummary, parseReview } from "./review-record";

/** A session's tokens, and their cost at the model's API list price, which subscriptions do not bill. */
export interface Tokens {
	input: number;
	cacheWrite: number;
	cacheRead: number;
	output: number;
	cost: number;
}

/** One session as ccusage prices it: its harness (ccusage's agent), its ID there, and its spend per model. */
export interface Priced {
	harness: string;
	id: string;
	models: ({ model: string } & Tokens)[];
}

/** Where a session spent its tokens, as far as its log tells. */
export interface SessionLog {
	/** Epoch milliseconds of its first record. */
	started: number;
	/** Each branch its log names, with the first and last time it does, and the directory it last ran in there. */
	branches: Map<string, { first: number; last: number; cwd: string | null }>;
	/** The repository its checkout fetched from, when the log names it; Claude Code's does not. */
	repository: Repository | null;
	effort: string | null;
	/** Codex marks the sessions `codex exec review` starts. */
	review: boolean;
}

export type Role = "implementing" | "iterating" | "reviewing";

/** One session attributed to a PR. */
export interface SessionRow {
	harness: string;
	session: string;
	role: Role;
	effort: string | null;
	models: ({ model: string } & Tokens)[];
}

/** One PR's record and the sessions that worked on it. */
export interface PullRow {
	number: number;
	url: string;
	title: string;
	branch: string;
	state: "open" | "closed" | "merged";
	draft: boolean;
	/** Its body has a `## Waiting` section, so it was handed back to the maintainer. */
	handedBack: boolean;
	size: Size | null;
	implementers: { harness: string; model: string; effort: string; size: Size | null }[];
	/** Each reviewer's latest round, as the PR's `## Review` record names them. */
	review: ReviewSummary[];
	/** Who made each mechanical fix the land fixer recorded, or `quest land watch` for a base merge it made alone. */
	landFixes: string[];
	/** Later PRs that list it under `## Caused by`. */
	fixedBy: number[];
	sessions: SessionRow[];
}

export interface SpendRow extends Tokens {
	size: Size | null;
	role: Role;
	harness: string;
	model: string;
	effort: string | null;
	sessions: number;
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
	reviewed: number;
	/** The reviewers' latest rounds on these PRs that have a score, and the scores' sum. */
	scored: number;
	score: number;
	/** The sum of each reviewed PR's longest session's rounds. */
	rounds: number;
	/** Sums over every reviewer's latest round. */
	findings: number;
	fixed: number;
	refuted: number;
	/** The land fixer's model-run fixes, leaving out the watcher's own base merges. */
	landFixes: number;
	/** Later PRs naming these PRs under `## Caused by`. */
	fixes: number;
}

export interface Usage {
	repository: string;
	since: string;
	/** Whether ccusage ran; without it, the report holds only the PRs' records. */
	priced: boolean;
	pulls: PullRow[];
	spend: SpendRow[];
	accuracy: AccuracyRow[];
	/** The sessions on no PR reported here, from every repository and agent ccusage reads; null when narrowed. */
	unattributed: ({ sessions: number } & Tokens) | null;
}

export interface UsageOptions {
	/** `YYYY-MM-DD`, local time. */
	since: string;
	quest?: string;
	pr?: number;
}

export interface UsageDependencies extends ClaimDependencies {
	/** ccusage's sessions since a `YYYY-MM-DD` date, or null when it is not installed. */
	ccusage(since: string): Priced[] | null;
	env: NodeJS.ProcessEnv;
	home: string;
}

/** The install hint printed when ccusage is missing. */
export const CCUSAGE_MISSING =
	"ccusage is not installed, so no session tokens or cost are reported; install it with `npm install -g ccusage`";

/** The local date `days` before `now`, as `YYYY-MM-DD`. */
export function daysBefore(now: Date, days: number): string {
	const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
	return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

/** Run `ccusage session --json` from PATH, or return null when it is not installed. */
export function runCcusage(since: string, env: NodeJS.ProcessEnv): Priced[] | null {
	const result = spawnSync("ccusage", ["session", "--json", "--since", since.replaceAll("-", "")], {
		encoding: "utf8",
		env,
		maxBuffer: 1 << 30,
	});
	if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`ccusage session --json exited ${result.status}: ${result.stderr.trim()}`);
	return parseCcusage(result.stdout);
}

/** The sessions `ccusage session --json` printed, failing on any field it lacks. */
export function parseCcusage(text: string): Priced[] {
	const rows: unknown = (JSON.parse(text) as { session?: unknown } | null)?.session;
	if (!Array.isArray(rows)) throw new Error("ccusage session --json printed no session list");
	const count = (value: unknown, what: string): number => {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
			throw new Error(`ccusage printed a session without a ${what}`);
		return value;
	};
	const word = (value: unknown, what: string): string => {
		if (typeof value !== "string" || value === "") throw new Error(`ccusage printed a session without a ${what}`);
		return value;
	};
	return rows.map((row: Record<string, unknown>) => {
		const models = row?.modelBreakdowns;
		if (!Array.isArray(models)) throw new Error("ccusage printed a session without modelBreakdowns");
		return {
			harness: word(row.agent, "agent"),
			id: word(row.period, "session ID"),
			models: models.map((m: Record<string, unknown>) => ({
				model: word(m?.modelName, "model name"),
				input: count(m.inputTokens, "input token count"),
				cacheWrite: count(m.cacheCreationTokens, "cache write token count"),
				cacheRead: count(m.cacheReadTokens, "cache read token count"),
				output: count(m.outputTokens, "output token count"),
				cost: count(m.cost, "cost"),
			})),
		};
	});
}

/**
 * Visit each line of the file at `path`, reading it in bounded chunks since logs reach gigabytes. The last line is
 * marked incomplete when no newline ends it, as while its session is still writing it.
 */
function eachLine(path: string, visit: (line: string, complete: boolean) => void): void {
	const fd = openSync(path, "r");
	try {
		const chunk = Buffer.alloc(1 << 22);
		let rest = Buffer.alloc(0);
		for (let read = readSync(fd, chunk); read > 0; read = readSync(fd, chunk)) {
			const data = rest.length ? Buffer.concat([rest, chunk.subarray(0, read)]) : chunk.subarray(0, read);
			let start = 0;
			for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
				if (end > start) visit(data.toString("utf8", start, end), true);
				start = end + 1;
			}
			rest = Buffer.from(data.subarray(start));
		}
		if (rest.length) visit(rest.toString("utf8"), false);
	} finally {
		closeSync(fd);
	}
}

/** One JSON record of a log line, or null for an incomplete last line. */
function parseLine(path: string, line: string, complete: boolean): Record<string, unknown> | null {
	try {
		return JSON.parse(line) as Record<string, unknown>;
	} catch (error) {
		if (!complete) return null;
		throw new Error(`${path} has a line that is not JSON: ${(error as Error).message}`);
	}
}

/** Claude Code's session logs by session ID, from each config directory ccusage reads. */
function claudeLogs(deps: UsageDependencies): Map<string, string> {
	const configured = deps.env.CLAUDE_CONFIG_DIR?.split(",")
		.map((dir) => dir.trim())
		.filter(Boolean);
	const dirs = configured?.length ? configured : [join(deps.home, ".config", "claude"), join(deps.home, ".claude")];
	const logs = new Map<string, string>();
	for (const dir of dirs) {
		const projects = join(dir, "projects");
		if (!existsSync(projects)) continue;
		for (const project of readdirSync(projects, { withFileTypes: true })) {
			if (!project.isDirectory()) continue;
			for (const file of readdirSync(join(projects, project.name)))
				if (file.endsWith(".jsonl") && !logs.has(file.slice(0, -6)))
					logs.set(file.slice(0, -6), join(projects, project.name, file));
		}
	}
	return logs;
}

/** What a Claude Code log tells: every record carries its checkout's branch, and each reply its effort. */
export function readClaudeLog(path: string): SessionLog {
	const log: SessionLog = { started: NaN, branches: new Map(), repository: null, effort: null, review: false };
	eachLine(path, (line, complete) => {
		const record = parseLine(path, line, complete);
		const at = typeof record?.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
		if (record === null || Number.isNaN(at)) return;
		if (!(at >= log.started)) log.started = at;
		const branch = record.gitBranch;
		if (typeof branch === "string" && branch !== "" && branch !== "HEAD") {
			const seen = log.branches.get(branch);
			const cwd = typeof record.cwd === "string" ? record.cwd : null;
			if (seen) {
				seen.last = Math.max(seen.last, at);
				seen.cwd = cwd ?? seen.cwd;
			} else log.branches.set(branch, { first: at, last: at, cwd });
		}
		if (record.type === "assistant" && typeof record.effort === "string") log.effort = record.effort;
	});
	return log;
}

/** What a Codex rollout tells: its first record names the checkout's branch and remote, and each turn its effort. */
export function readCodexLog(path: string): SessionLog {
	let log: SessionLog | undefined;
	eachLine(path, (line, complete) => {
		if (log === undefined) {
			const meta = parseLine(path, line, complete);
			const payload = meta?.payload as Record<string, unknown> | undefined;
			const at = Date.parse(String(payload?.timestamp ?? meta?.timestamp));
			if (meta?.type !== "session_meta" || Number.isNaN(at))
				throw new Error(`${path} does not start with a Codex session_meta record`);
			const repo = payload?.git as Record<string, unknown> | undefined;
			const branch = typeof repo?.branch === "string" && repo.branch !== "" ? repo.branch : null;
			const url = typeof repo?.repository_url === "string" ? repo.repository_url : null;
			const cwd = typeof payload?.cwd === "string" ? payload.cwd : null;
			log = {
				started: at,
				branches: new Map(branch ? [[branch, { first: at, last: at, cwd }]] : []),
				repository: url === null ? null : githubRepository(url),
				effort: null,
				review: (payload?.source as Record<string, unknown> | undefined)?.subagent === "review",
			};
			return;
		}
		// A turn context is small, unlike the replies and tool output, so only its lines are parsed.
		if (!line.includes('"type":"turn_context"')) return;
		const effort = (parseLine(path, line, complete)?.payload as Record<string, unknown> | undefined)?.effort;
		if (typeof effort === "string") log.effort = effort;
	});
	if (log === undefined) throw new Error(`${path} is empty`);
	return log;
}

/** The log of each priced session, found where its harness keeps it, or null for one quest cannot read. */
function sessionLogs(sessions: Priced[], deps: UsageDependencies): (SessionLog | null)[] {
	let claude: Map<string, string> | undefined;
	const codex = deps.env.CODEX_HOME || join(deps.home, ".codex");
	return sessions.map((session) => {
		if (session.harness === "claude") {
			claude ??= claudeLogs(deps);
			const path = claude.get(session.id);
			return path === undefined ? null : readClaudeLog(path);
		}
		if (session.harness === "codex") {
			// ccusage names a rollout by its path under the sessions directory, or under the flat archive.
			if (session.id.split("/").includes(".."))
				throw new Error(`ccusage named a Codex session outside its home: ${session.id}`);
			const path = ["sessions", "archived_sessions"]
				.map((dir) => join(codex, dir, `${session.id}.jsonl`))
				.find((each) => existsSync(each));
			return path === undefined ? null : readCodexLog(path);
		}
		return null;
	});
}

interface Pull {
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

const key = (repository: Repository) => `${repository.owner}/${repository.repo}`.toLowerCase();

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
async function updatedPulls(client: GitHub, repository: Repository, since: number): Promise<Pull[]> {
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

/** The PR numbers of `repository` that `body`'s `## Caused by` section links. */
function causes(body: string, repository: Repository): number[] {
	const heading = /^## Caused by[ \t]*\r?$/m.exec(body);
	if (!heading) return [];
	const rest = body.slice(heading.index + heading[0].length);
	const section = rest.slice(0, /^## /m.exec(rest)?.index ?? rest.length);
	const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const url = new RegExp(
		`https://github\\.com/${escape(repository.owner)}/${escape(repository.repo)}/pull/(\\d+)`,
		"gi",
	);
	return [...new Set([...section.matchAll(url)].map((match) => Number(match[1])))];
}

const sized = (value: string | null | undefined): Size | null =>
	(SIZES as readonly string[]).includes(value ?? "") ? (value as Size) : null;

/** Each PR's record, without its sessions yet. */
function pullRows(pulls: Pull[], repository: Repository): PullRow[] {
	const fixedBy = new Map<number, number[]>();
	for (const each of pulls)
		for (const cause of causes(each.body, repository))
			if (cause !== each.number) fixedBy.set(cause, [...(fixedBy.get(cause) ?? []), each.number]);
	return pulls.map((each) => {
		const own = recorded(each.body);
		return {
			number: each.number,
			url: each.url,
			title: each.title,
			branch: each.branch,
			state: each.state,
			draft: each.draft,
			handedBack: each.draft && handedBack(each.body),
			size: own.sizes.map(sized).find((s) => s !== null) ?? null,
			implementers: own.implementers.flatMap(({ item }) => {
				const fields = implementer(item);
				return fields ? [{ ...fields, size: sized(fields.size) }] : [];
			}),
			review: parseReview(each.body),
			landFixes: fixes(each.body),
			fixedBy: (fixedBy.get(each.number) ?? []).sort((a, b) => a - b),
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
};
const zero = (): Tokens => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0 });

/**
 * The ID a harness gives a session, as `quest review` records it: Claude Code's is ccusage's, and Codex's is the
 * thread ID that ends the rollout's file name.
 */
function sessionId(session: Priced): string {
	if (session.harness !== "codex") return session.id;
	return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(session.id)?.[1] ?? session.id;
}

/** The GitHub repositories the checkout at `cwd` has remotes for, or null once it is no checkout to ask. */
function checkoutRepositories(cwd: string): string[] | null {
	if (!existsSync(cwd)) return null;
	const remotes = spawnSync("git", ["-C", cwd, "remote", "-v"], { encoding: "utf8", env: discoveryEnv() });
	if (remotes.status !== 0) return null;
	return remotes.stdout.split("\n").flatMap((line) => {
		const named = githubRepository(line.split(/\s+/)[1] ?? "");
		return named ? [key(named)] : [];
	});
}

/**
 * Which repositories the directory `cwd` belongs to: its checkout's remotes while it exists, else the remote a
 * Codex log names for that exact directory, as a reviewer run in the same checkout records; null when nothing
 * tells, since a branch name alone may be another repository's. A directory above it never tells, since a
 * nested clone may be another repository's.
 */
function owners(logs: (SessionLog | null)[]): (cwd: string) => string[] | null {
	const logged = new Map<string, Set<string>>();
	for (const log of logs)
		if (log?.repository)
			for (const seen of log.branches.values())
				if (seen.cwd) logged.set(seen.cwd, (logged.get(seen.cwd) ?? new Set()).add(key(log.repository)));
	const cache = new Map<string, string[] | null>();
	return (cwd) => {
		if (!cache.has(cwd)) {
			const names = logged.get(cwd);
			cache.set(cwd, checkoutRepositories(cwd) ?? (names ? [...names] : null));
		}
		return cache.get(cwd)!;
	};
}

/**
 * Attribute each priced session to the PR whose head branch its log last named, among those still open when the
 * session reached the branch and headed from the repository its log, checkout, or directory names, and give it a role: reviewing when
 * a PR's review record names it or Codex marks it a review, implementing when it began before its PR opened, and
 * iterating otherwise. Returns the sessions on no PR here.
 */
function attribute(
	sessions: Priced[],
	logs: (SessionLog | null)[],
	pulls: Pull[],
	rows: Map<number, PullRow>,
	reviewers: Set<string>,
): Priced[] {
	const byBranch = new Map<string, Pull[]>();
	for (const each of [...pulls].sort((a, b) => a.created - b.created))
		byBranch.set(each.branch, [...(byBranch.get(each.branch) ?? []), each]);
	const unattributed: Priced[] = [];
	const owned = owners(logs);
	sessions.forEach((session, index) => {
		const log = logs[index];
		const branches = log ? [...log.branches].sort((a, b) => b[1].last - a[1].last) : [];
		let found: Pull | undefined;
		for (const [branch, seen] of branches) {
			// Another repository may use the same branch name, so a session counts only where its repository is known.
			const known = log!.repository ? [key(log!.repository)] : seen.cwd ? owned(seen.cwd) : null;
			if (known === null) continue;
			// A branch can head a new PR after an earlier one closed: take the one open when the session reached it.
			const open = (byBranch.get(branch) ?? []).filter(
				(each) =>
					(each.closed === null || each.closed >= seen.first) &&
					each.repository !== null &&
					known.includes(each.repository),
			);
			// A checkout with remotes for both a fork and its upstream cannot tell which one's branch it was on.
			if (new Set(open.map((each) => each.repository)).size > 1) continue;
			found = open[0];
			if (found) break;
		}
		const row = found && rows.get(found.number);
		if (!found || !row || !log) {
			unattributed.push(session);
			return;
		}
		const id = sessionId(session);
		row.sessions.push({
			harness: session.harness,
			session: id,
			role:
				log.review || reviewers.has(id)
					? "reviewing"
					: log.started < found.created
						? "implementing"
						: "iterating",
			effort: log.effort,
			models: session.models,
		});
	});
	return unattributed;
}

function spendRows(pulls: PullRow[]): SpendRow[] {
	const rows = new Map<string, SpendRow>();
	for (const each of pulls)
		for (const session of each.sessions)
			for (const spent of session.models) {
				const id = JSON.stringify([each.size, session.role, session.harness, spent.model, session.effort]);
				let row = rows.get(id);
				if (!row) {
					row = {
						size: each.size,
						role: session.role,
						harness: session.harness,
						model: spent.model,
						effort: session.effort,
						sessions: 0,
						...zero(),
					};
					rows.set(id, row);
				}
				row.sessions++;
				add(row, spent);
			}
	const roles: Role[] = ["implementing", "iterating", "reviewing"];
	return [...rows.values()].sort((a, b) =>
		order(
			[a.size, roles.indexOf(a.role), a.harness, a.model, a.effort],
			[b.size, roles.indexOf(b.role), b.harness, b.model, b.effort],
		),
	);
}

function accuracyRows(pulls: PullRow[]): AccuracyRow[] {
	const rows = new Map<string, AccuracyRow>();
	for (const each of pulls) {
		// A session that pushed twice is one implementer of the PR, whether or not each line names its size.
		const distinct = new Map(
			each.implementers.map((i) => {
				const at = { ...i, size: i.size ?? each.size };
				return [JSON.stringify(at), at];
			}),
		);
		for (const implementer of distinct.values()) {
			const size = implementer.size;
			const id = JSON.stringify([size, implementer.harness, implementer.model, implementer.effort]);
			let row = rows.get(id);
			if (!row) {
				row = {
					size,
					harness: implementer.harness,
					model: implementer.model,
					effort: implementer.effort,
					pulls: 0,
					merged: 0,
					handedBack: 0,
					reviewed: 0,
					scored: 0,
					score: 0,
					rounds: 0,
					findings: 0,
					fixed: 0,
					refuted: 0,
					landFixes: 0,
					fixes: 0,
				};
				rows.set(id, row);
			}
			row.pulls++;
			if (each.state === "merged") row.merged++;
			if (each.handedBack) row.handedBack++;
			row.fixes += each.fixedBy.length;
			row.landFixes += each.landFixes.filter((by) => by !== MERGER).length;
			if (each.review.length > 0) {
				row.reviewed++;
				row.rounds += Math.max(...each.review.map((review) => review.round));
			}
			for (const review of each.review) {
				if (review.score !== null) {
					row.scored++;
					row.score += review.score;
				}
				row.findings += review.findings;
				row.fixed += review.fixed;
				row.refuted += review.refuted;
			}
		}
	}
	return [...rows.values()].sort((a, b) =>
		order([a.size, a.harness, a.model, a.effort], [b.size, b.harness, b.model, b.effort]),
	);
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
	const rows = pullRows(all, repository).filter((row) => pulls.some((each) => each.number === row.number));
	const byNumber = new Map(rows.map((row) => [row.number, row]));
	const priced = deps.ccusage(options.since);
	let unattributed: Usage["unattributed"] = null;
	if (priced !== null) {
		const reviewers = new Set(rows.flatMap((row) => row.review.map((review) => review.session)));
		// Every PR in the window competes for a session, so narrowing never hands one PR another's sessions.
		const left = attribute(priced, sessionLogs(priced, deps), all, byNumber, reviewers);
		if (!narrowed) {
			unattributed = { sessions: left.length, ...zero() };
			for (const session of left) for (const spent of session.models) add(unattributed, spent);
		}
	}
	return {
		repository: key(repository),
		since: options.since,
		priced: priced !== null,
		pulls: rows,
		spend: spendRows(rows),
		accuracy: accuracyRows(rows),
		unattributed,
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
	`in ${compact(t.input)}, cache ${compact(t.cacheWrite)} written ${compact(t.cacheRead)} read, out ${compact(t.output)}, ~$${t.cost.toFixed(2)}`;
const mean = (sum: number, count: number) => (count ? (sum / count).toFixed(1) : "-");

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
		lines.push("", `#${row.number} ${row.size ?? "-"} ${state}: ${row.title} (${row.branch})`);
		for (const i of row.implementers)
			lines.push(`  implementer: ${i.harness}, ${i.model}, ${i.effort} effort${i.size ? ` (${i.size})` : ""}`);
		for (const r of row.review)
			lines.push(
				`  review: ${r.harness}, ${r.model}, ${r.effort} effort; round ${r.round}, score ${r.score ?? "-"}/10, ${r.findings} open, last round ${r.fixed} fixed and ${r.refuted} refuted`,
			);
		if (row.landFixes.length) lines.push(`  land fixes: ${row.landFixes.join("; ")}`);
		if (row.fixedBy.length) lines.push(`  fixed later by: ${row.fixedBy.map((n) => `#${n}`).join(", ")}`);
		const sessions = row.sessions.flatMap((s) =>
			s.models.map((m) => ["   ", s.role, s.harness, m.model, s.effort ?? "-", tokens(m)]),
		);
		if (sessions.length) lines.push("  sessions:", ...table(sessions));
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
					s.model,
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
					`${a.pulls} PRs, ${a.merged} merged, ${a.handedBack} handed back, ${a.reviewed} reviewed: score ${mean(a.score, a.scored)}, rounds ${mean(a.rounds, a.reviewed)}, ${a.findings} open, ${a.fixed} fixed, ${a.refuted} refuted; ${a.landFixes} land fixes, ${a.fixes} later fixes`,
				]),
			),
		);
	const u = report.unattributed;
	if (u) lines.push("", `Unattributed: ${u.sessions} sessions on no PR here, any repository or agent: ${tokens(u)}`);
	return lines;
}

/** The dependencies `quest usage` runs with. */
export function usageDependencies(github: ClaimDependencies): UsageDependencies {
	return { ...github, ccusage: (since) => runCcusage(since, process.env), env: process.env, home: homedir() };
}
