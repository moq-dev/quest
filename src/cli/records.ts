// Each session's record, as `quest usage` prints it and the stop hook sends it: its PRs, role, spend, and waits.
import { type Role, type SessionRecord, type SessionWait, type TimeSplit, branchQuest } from "../core";
import { type TranscriptFacts, transcriptFacts } from "./transcript";
import type { Pull, Session } from "./usage";
import type { LoggedWait } from "./waits";

/** The role the first quest skill a session ran gives it; a skill not listed gives none. */
const SKILL_ROLES: Record<string, Role> = {
	"quest-plan": "planning",
	"quest-audit": "planning",
	"quest-recurring": "planning",
	"quest-import": "planning",
	"quest-grill": "planning",
	"quest-delete": "planning",
	"quest-export": "planning",
	"quest-start": "implementing",
	"quest-iterate": "iterating",
	"quest-review": "reviewing",
	"quest-merge": "merging",
	"quest-complete": "merging",
	"quest-run": "coordinating",
	"quest-spawn": "coordinating",
};

/** Branch prefixes of the skills whose PRs plan quests. */
const PLANNING = ["quest-plan/", "quest-audit/", "quest-recurring/", "quest-import/"];

/** What the records are built from. */
export interface RecordInput {
	/** The base repository as lowercase `owner/repo`. */
	repository: string;
	/** The sessions to build records for, each once. */
	sessions: Session[];
	/** The PR each session's own branch heads, from `attribute`. */
	own: Map<Session, Pull>;
	/** The repositories a session is known to be in, or null when unknown. */
	known?: (session: Session) => string[] | null;
	/** Session IDs a PR's review record names as reviewers, and as its risk classifier. */
	reviewers: Set<string>;
	classifiers: Set<string>;
	/** The waits logged on this host, which only its own sessions (host null) are given. */
	waits: LoggedWait[];
	/** The sessions to build records for; by default, those on a PR. Every session still counts for lineage. */
	emit?: Set<Session>;
	/** The window's start, epoch ms: a person's wait that ended before it, like a logged one, is left out. */
	since: number;
	/**
	 * A local session's time split given its timed waits and the window's start, or null while it has none; every
	 * split is null without it.
	 */
	split?: (session: Session, waits: SessionWait[], since: number) => TimeSplit | null;
}

const id = (harness: string, session: string) => `${harness}\0${session}`;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * A record for each session that `emit` names, or that worked on a PR. A session's PRs are its own, else its parent's, else, for one that spawned
 * sub-agents, every PR they worked on. Its role is classifying when a PR's review record names it as the risk
 * classifier, reviewing when Codex marks it a review or a PR's review record
 * names it, else the one its first quest skill gives, else its parent's unless that is coordinating, else coordinating for a
 * session whose PRs are only its sub-agents', planning on a planning skill's branch, and implementing or iterating
 * by whether it started before its PR opened. Transcripts and waits are read only for this host's sessions.
 */
export function buildRecords(input: RecordInput): Map<Session, SessionRecord> {
	const named = input.sessions.filter((s): s is Session & { id: string } => s.id !== null);
	const byId = new Map(named.map((s) => [id(s.harness, s.id), s]));
	const children = new Map<Session, Session[]>();
	for (const s of input.sessions) {
		const parent = s.parent === null ? undefined : byId.get(id(s.harness, s.parent));
		if (parent && parent !== s) children.set(parent, [...(children.get(parent) ?? []), s]);
	}
	const parentOf = (s: Session) => (s.parent === null ? undefined : byId.get(id(s.harness, s.parent)));

	const descendants = (s: Session, seen = new Set<Session>()): Pull[] => {
		seen.add(s);
		return (children.get(s) ?? []).flatMap((child) => {
			if (seen.has(child)) return [];
			const own = input.own.get(child);
			return own ? [own, ...descendants(child, seen)] : descendants(child, seen);
		});
	};
	// Bounded by the sessions' count, so a cycle in recorded lineage cannot loop.
	const pullsOf = (s: Session, depth = 0): { pulls: Pull[]; via: "own" | "parent" | "children" | "none" } => {
		const own = input.own.get(s);
		if (own) return { pulls: [own], via: "own" };
		const parent = parentOf(s);
		if (parent && depth < input.sessions.length) {
			// A session known to be in another repository keeps out of its parent's PRs, as a sub-agent in another
			// checkout does.
			const known = input.known?.(s) ?? null;
			const inherited = pullsOf(parent, depth + 1).pulls.filter(
				(p) => known === null || (p.repository !== null && known.includes(p.repository)),
			);
			if (inherited.length) return { pulls: inherited, via: "parent" };
		}
		const found = descendants(s);
		const unique = [...new Map(found.map((p) => [p.number, p])).values()].sort((a, b) => a.number - b.number);
		return unique.length ? { pulls: unique, via: "children" } : { pulls: [], via: "none" };
	};

	const facts = new Map<Session, TranscriptFacts | null>();
	const factsOf = (s: Session): TranscriptFacts | null => {
		if (s.host !== null) return null;
		if (!facts.has(s)) facts.set(s, readFacts(s));
		return facts.get(s)!;
	};

	const roleOf = (s: Session, depth = 0): Role => {
		if (s.id !== null && input.classifiers.has(s.id)) return "classifying";
		if (s.review || (s.id !== null && input.reviewers.has(s.id))) return "reviewing";
		const skill = factsOf(s)?.skill;
		const fromSkill = skill ? SKILL_ROLES[skill] : undefined;
		if (fromSkill) return fromSkill;
		const own = input.own.get(s);
		const parent = parentOf(s);
		// A sub-agent with no skill of its own works for its parent, unless that parent hands out whole PRs.
		if (parent && depth < input.sessions.length) {
			const inherited = roleOf(parent, depth + 1);
			if (inherited !== "coordinating") return inherited;
		}
		const branch = own?.branch ?? lastBranch(s);
		if (branch && PLANNING.some((prefix) => branch.startsWith(prefix))) return "planning";
		if (!own) return pullsOf(s).via === "children" ? "coordinating" : "implementing";
		return s.start < own.created ? "implementing" : "iterating";
	};

	const waits = assignWaits(named, input.waits, parentOf, input.since);
	const records = new Map<Session, SessionRecord>();
	for (const s of input.sessions) {
		const { pulls, via } = pullsOf(s);
		if (input.emit ? !input.emit.has(s) : pulls.length === 0) continue;
		const own = input.own.get(s);
		const branch = own?.branch ?? (via === "none" ? lastBranch(s) : pulls.length === 1 ? pulls[0]!.branch : null);
		const local = factsOf(s);
		const person: SessionWait[] = (local?.questions ?? [])
			.filter((q) => q.end >= input.since)
			.map((q) => ({
				kind: "person",
				start: iso(q.start),
				end: iso(q.end),
				until: null,
			}));
		const timed: SessionWait[] | null =
			local === null
				? null
				: [
						...(waits.get(s) ?? []).map(({ kind, start, end, until }) => ({ kind, start, end, until })),
						...person,
					].sort((a, b) => a.start.localeCompare(b.start));
		records.set(s, {
			harness: s.harness,
			session: s.id,
			parent: s.parent,
			repository: input.repository,
			branch,
			quest: branch?.startsWith("quest/") ? branchQuest(branch) : null,
			pulls: pulls.map((p) => p.number),
			role: roleOf(s),
			models: s.models.map((m) => ({
				model: m.model,
				effort: m.effort,
				input: m.input,
				cacheWrite: m.cacheWrite,
				cacheRead: m.cacheRead,
				output: m.output,
				cost: m.cost,
				complete: m.complete,
			})),
			cost: s.cost,
			complete: s.complete,
			start: iso(s.start),
			end: iso(s.end),
			waits: timed,
			split: timed === null || !input.split ? null : input.split(s, timed, input.since),
		});
	}
	return records;
}

/**
 * A local session's transcript facts, or null when they cannot be read: a file deleted since token-max read it, or
 * one with lines token-max could not read either, whose cost is already a lower bound. Any other failure is a shape
 * quest does not know, and throws.
 */
function readFacts(s: Session): TranscriptFacts | null {
	try {
		return transcriptFacts(s.harness, s.files);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || s.skippedLines > 0) return null;
		throw error;
	}
}

/** The branch a session named last, or null. */
function lastBranch(s: Session): string | null {
	return [...s.branches].sort((a, b) => b.last - a.last)[0]?.name ?? null;
}

/**
 * Each logged wait's session on this host. A wait names the sessions in its command's environment; where it names
 * several, as when one harness started the other, the innermost is the one that started last. A Claude sub-agent's
 * commands carry its parent's ID, so a wait goes to the one sub-agent of it running then in the wait's directory,
 * the deepest checkout matching, and stays with the parent when none or several match.
 */
function assignWaits(
	sessions: (Session & { id: string })[],
	logged: LoggedWait[],
	parentOf: (s: Session) => Session | undefined,
	since: number,
): Map<Session, LoggedWait[]> {
	const local = sessions.filter((s) => s.host === null);
	const byId = new Map(local.map((s) => [id(s.harness, s.id), s]));
	const assigned = new Map<Session, LoggedWait[]>();
	for (const wait of logged) {
		const start = Date.parse(wait.start);
		const end = Date.parse(wait.end);
		// A session's start is its first request in the window, so before the window no start orders a wait: any
		// session it names may own it, and a sub-agent owns it by running at any point of it.
		const clipped = start < since;
		const named = wait.sessions.flatMap((n) => byId.get(id(n.harness, n.session)) ?? []);
		const owner = named.filter((s) => clipped || s.start <= start).sort((a, b) => b.start - a.start)[0];
		if (!owner) continue;
		const inside = (dir: string | null) =>
			dir !== null && (wait.directory === dir || wait.directory.startsWith(dir.endsWith("/") ? dir : `${dir}/`));
		const running = local.filter(
			(s) =>
				s.harness === "claude" &&
				parentOf(s) === owner &&
				(clipped ? s.start <= end : s.start <= start) &&
				start <= s.end &&
				inside(s.cwd),
		);
		const depth = Math.max(-1, ...running.map((s) => s.cwd!.length));
		const deepest = running.filter((s) => s.cwd!.length === depth);
		// A parent waits on its foreground sub-agent, so the one sub-agent running there is the waiter.
		const target = deepest.length === 1 ? deepest[0]! : owner;
		assigned.set(target, [...(assigned.get(target) ?? []), wait]);
	}
	return assigned;
}
