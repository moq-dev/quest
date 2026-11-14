// The record of one agent session that `quest` sends to Kixel Code, which stores exactly this shape, and that
// `quest usage` prints. One session is one record: a resend under the same harness and session ID replaces it.

/** What a session did for its PRs. */
export const ROLES = ["planning", "implementing", "iterating", "reviewing", "merging", "coordinating"] as const;
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

/** One agent session, as `quest` sends it. */
export interface SessionRecord {
	/** `claude` or `codex`. */
	harness: string;
	/** The harness's own session ID; a Claude sub-agent's is its agent ID. */
	session: string;
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
		session: text(value.session, "session"),
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
	};
	if (new Set(record.pulls).size !== record.pulls.length) fail("a PR listed twice");
	if (Date.parse(record.end) < Date.parse(record.start)) fail("it ends before it starts");
	return record;
}

/** An upload's body, failing whole on any malformed record or a session sent twice. */
export function parseUpload(value: unknown): RecordUpload {
	if (!isObject(value)) return fail("the upload is not an object");
	exact(value, ["records"], "the upload");
	if (!Array.isArray(value.records)) return fail("the upload has no record list");
	const records = value.records.map(parseRecord);
	const ids = new Set(records.map((r) => `${r.harness}\0${r.session}`));
	if (ids.size !== records.length) fail("the upload holds a session twice");
	return { records };
}
