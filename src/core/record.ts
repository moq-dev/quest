// The record of one agent session that `quest` sends to Kixel Code, which stores exactly this shape, and that
// `quest usage` prints. One session is one record: a resend under the same harness and session ID replaces it. A
// host's one sender uploads a session's copies in order, so the latest upload is the newest copy.

/** What a session did for its PRs. */
export const ROLES = [
	"planning",
	"implementing",
	"iterating",
	"reviewing",
	"classifying",
	"merging",
	"coordinating",
] as const;
export type Role = (typeof ROLES)[number];

/**
 * What a session waited on, timed by the tool that waited: queued in `quest gate`, running a gated command, waiting
 * in `quest wait` for PR activity, which `until` names, or for the merge queue to merge or drop the PR, and waiting
 * on a person's answer to a blocking question.
 */
export const WAIT_KINDS = ["gate-queue", "gate-run", "pull", "merge-queue", "person"] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];

/** One timed wait, its instants ISO 8601 UTC. */
export interface SessionWait {
	kind: WaitKind;
	start: string;
	end: string;
	/** For a `pull` or `merge-queue` wait, the first activity `quest wait` printed, as `checks:passed`; null on timeout. */
	until: string | null;
}

/** One model and effort's tokens in a session, and their cost at API list price in USD. */
export interface ModelSpend {
	model: string | null;
	effort: string | null;
	input: number;
	cacheWrite: number;
	cacheRead: number;
	output: number;
	cost: number;
	/** False when the cost is a lower bound: a request went unpriced or a transcript line was unreadable. */
	complete: boolean;
}

/**
 * Where a session's working time went, beyond its timed waits. The list is fixed so splits compare across weeks;
 * change it only with a dated note here, since a change breaks the trend. `idle` is not classified: it is the time
 * between turns, until the next message from a person or a notification. Settled 2026-11-13 from a sample of this
 * host's Claude Code and Codex transcripts.
 */
export const SPLIT_CATEGORIES = [
	"understanding",
	"researching",
	"writing",
	"testing",
	"environment",
	"git",
	"forge",
	"reviewing",
	"rework",
	"coordinating",
	"operating",
	"reporting",
	"circles",
	"waiting",
	"other",
	"idle",
] as const;
export type SplitCategory = (typeof SPLIT_CATEGORIES)[number];

/** One model's tokens in the turns that classified a session, as the CLI reported them. */
export interface SplitUsage {
	harness: string;
	model: string;
	effort: string;
	input: number;
	/** The part of `input` read from the prompt cache. */
	cached: number;
	output: number;
}

/**
 * A session's time and tokens by category, as a cheap model sorted its steps. Its categories' time and its timed
 * waits, without overlap, sum to its transcript's span; their tokens sum to its transcript's.
 */
export interface TimeSplit {
	/** Every category, with its milliseconds and tokens. */
	categories: Record<SplitCategory, { ms: number; tokens: number }>;
	/** One line per classified part where something went wrong, naming no one and quoting no message. */
	notes: string[];
	/**
	 * The time a stronger model sorted again, and the part of it the two sorted differently, or null when no part
	 * was sampled.
	 */
	check: { ms: number; disagreed: number } | null;
	/** What classifying it took, by model. */
	usage: SplitUsage[];
}

/** One agent session, as `quest` sends it. */
export interface SessionRecord {
	/** `claude` or `codex`. */
	harness: string;
	/**
	 * The harness's own session ID; a Claude sub-agent's is its agent ID. Null when its transcript names none, which
	 * `quest usage` still reports but no upload carries, since the store replaces a record by its ID.
	 */
	session: string | null;
	/** The session that spawned it, or null. */
	parent: string | null;
	/** The base repository as lowercase `owner/repo`. */
	repository: string;
	/** Its PR's head branch, else the branch it last named, so a session before its PR opens joins it later. */
	branch: string | null;
	/** The quest file its branch claims, as `quest/m0/foo.md`. */
	quest: string | null;
	/**
	 * The PRs it worked on: its own, else its parent's, else, for a coordinator, every PR its sub-agents worked on.
	 * Its cost counts equally toward each, so a PR's cost is the sum of each record's cost over its PR count.
	 */
	pulls: number[];
	role: Role;
	models: ModelSpend[];
	cost: number;
	complete: boolean;
	/** Its first and last request, ISO 8601 UTC. */
	start: string;
	end: string;
	/** Its timed waits, oldest first; null when they could not be read, as for a session on another host. */
	waits: SessionWait[] | null;
	/** Where the rest of its time went; null until every step is classified, and for a session on another host. */
	split: TimeSplit | null;
}

/** The body of a record upload. */
export interface RecordUpload {
	records: SessionRecord[];
}

const fail = (what: string): never => {
	throw new Error(`malformed session record: ${what}`);
};
const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, what: string): string => (typeof value === "string" && value !== "" ? value : fail(what));
const maybe = (value: unknown, what: string): string | null => (value === null ? null : text(value, what));
const count = (value: unknown, what: string): number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fail(what);
const flag = (value: unknown, what: string): boolean => (typeof value === "boolean" ? value : fail(what));
const instant = (value: unknown, what: string): string => {
	const at = text(value, what);
	return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(at) && !Number.isNaN(Date.parse(at)) ? at : fail(what);
};
const oneOf = <T extends string>(value: unknown, options: readonly T[], what: string): T =>
	options.includes(value as T) ? (value as T) : fail(what);
const exact = (value: Record<string, unknown>, keys: string[], what: string) => {
	const extra = Object.keys(value).find((key) => !keys.includes(key));
	if (extra !== undefined) fail(`${what} has an unknown field ${extra}`);
};

/** `value` as a record, failing on any missing, extra, or ill-typed field, so a store never keeps one in part. */
export function parseRecord(value: unknown): SessionRecord {
	if (!isObject(value)) return fail("not an object");
	const keys = [
		"harness",
		"session",
		"parent",
		"repository",
		"branch",
		"quest",
		"pulls",
		"role",
		"models",
		"cost",
		"complete",
		"start",
		"end",
		"waits",
		"split",
	];
	exact(value, keys, "the record");
	const pulls = Array.isArray(value.pulls) ? value.pulls : fail("pulls");
	const models = Array.isArray(value.models) ? value.models : fail("models");
	const waits = value.waits === null ? null : Array.isArray(value.waits) ? value.waits : fail("waits");
	const repository = text(value.repository, "repository");
	if (!/^[a-z\d._-]+\/[a-z\d._-]+$/.test(repository)) fail("repository is not a lowercase owner/repo");
	const quest = maybe(value.quest, "quest");
	if (quest !== null && !/^quest\/.+\.md$/.test(quest)) fail("quest is not a quest path");
	const record: SessionRecord = {
		harness: text(value.harness, "harness"),
		session: maybe(value.session, "session"),
		parent: maybe(value.parent, "parent"),
		repository,
		branch: maybe(value.branch, "branch"),
		quest,
		pulls: pulls.map((n) => (Number.isSafeInteger(n) && (n as number) > 0 ? (n as number) : fail("a PR number"))),
		role: oneOf(value.role, ROLES, "role"),
		models: models.map((m: unknown) => {
			if (!isObject(m)) return fail("a model");
			exact(m, ["model", "effort", "input", "cacheWrite", "cacheRead", "output", "cost", "complete"], "a model");
			return {
				model: maybe(m.model, "a model name"),
				effort: maybe(m.effort, "an effort"),
				input: count(m.input, "input tokens"),
				cacheWrite: count(m.cacheWrite, "cache write tokens"),
				cacheRead: count(m.cacheRead, "cache read tokens"),
				output: count(m.output, "output tokens"),
				cost: count(m.cost, "a model's cost"),
				complete: flag(m.complete, "a model's completeness"),
			};
		}),
		cost: count(value.cost, "cost"),
		complete: flag(value.complete, "completeness"),
		start: instant(value.start, "start"),
		end: instant(value.end, "end"),
		waits:
			waits?.map((w: unknown) => {
				if (!isObject(w)) return fail("a wait");
				exact(w, ["kind", "start", "end", "until"], "a wait");
				const wait: SessionWait = {
					kind: oneOf(w.kind, WAIT_KINDS, "a wait's kind"),
					start: instant(w.start, "a wait's start"),
					end: instant(w.end, "a wait's end"),
					until: maybe(w.until, "a wait's until"),
				};
				if (Date.parse(wait.end) < Date.parse(wait.start)) fail("a wait ends before it starts");
				if (wait.until !== null && wait.kind !== "pull" && wait.kind !== "merge-queue")
					fail(`a ${wait.kind} wait names what ended it`);
				return wait;
			}) ?? null,
		split: value.split === null ? null : parseSplit(value.split),
	};
	if (new Set(record.pulls).size !== record.pulls.length) fail("a PR listed twice");
	if (record.split !== null && record.waits === null) fail("a split without the waits it leaves out");
	if (Date.parse(record.end) < Date.parse(record.start)) fail("it ends before it starts");
	return record;
}

/** A split, failing on a missing or unknown category, a disagreement past what was checked, or a multi-line note. */
function parseSplit(value: unknown): TimeSplit {
	if (!isObject(value)) return fail("the split");
	exact(value, ["categories", "notes", "check", "usage"], "the split");
	const categories = isObject(value.categories) ? value.categories : fail("the split's categories");
	exact(categories, [...SPLIT_CATEGORIES], "the split's categories");
	const notes = Array.isArray(value.notes) ? value.notes : fail("the split's notes");
	const usage = Array.isArray(value.usage) ? value.usage : fail("the split's usage");
	let check: TimeSplit["check"] = null;
	if (value.check !== null) {
		if (!isObject(value.check)) return fail("the split's check");
		exact(value.check, ["ms", "disagreed"], "the split's check");
		check = {
			ms: count(value.check.ms, "the checked time"),
			disagreed: count(value.check.disagreed, "the disagreed time"),
		};
		if (check.disagreed > check.ms) fail("the check disagrees on more time than it checked");
	}
	return {
		categories: Object.fromEntries(
			SPLIT_CATEGORIES.map((name) => {
				const each = categories[name];
				if (!isObject(each)) return fail(`the split's ${name}`);
				exact(each, ["ms", "tokens"], `the split's ${name}`);
				return [name, { ms: count(each.ms, `${name}'s time`), tokens: count(each.tokens, `${name}'s tokens`) }];
			}),
		) as TimeSplit["categories"],
		notes: notes.map((note) => {
			const line = text(note, "a split note");
			return /[\r\n]/.test(line) || line.length > NOTE_LIMIT ? fail("a split note is not one short line") : line;
		}),
		check,
		usage: usage.map((u: unknown) => {
			if (!isObject(u)) return fail("a split's usage");
			exact(u, ["harness", "model", "effort", "input", "cached", "output"], "a split's usage");
			const input = count(u.input, "a split's input tokens");
			const cached = count(u.cached, "a split's cached tokens");
			if (cached > input) fail("a split's cached tokens exceed its input");
			return {
				harness: text(u.harness, "a split's harness"),
				model: text(u.model, "a split's model"),
				effort: text(u.effort, "a split's effort"),
				input,
				cached,
				output: count(u.output, "a split's output tokens"),
			};
		}),
	};
}

/** The longest note a split keeps, in characters. */
export const NOTE_LIMIT = 300;

/** An upload's body, failing whole on any malformed record, one naming no session, or a session sent twice. */
export function parseUpload(value: unknown): RecordUpload {
	if (!isObject(value)) return fail("the upload is not an object");
	exact(value, ["records"], "the upload");
	if (!Array.isArray(value.records)) return fail("the upload has no record list");
	const records = value.records.map(parseRecord);
	if (records.some((r) => r.session === null)) fail("an uploaded record names no session");
	const ids = new Set(records.map((r) => `${r.harness}\0${r.session}`));
	if (ids.size !== records.length) fail("the upload holds a session twice");
	return { records };
}
