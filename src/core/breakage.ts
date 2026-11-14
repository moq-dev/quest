// A breakage: what a merged PR broke, as `quest` sends it to Kixel Code beside the session records. It comes from a
// later PR naming the culprit under `## Caused by`, or from an incident a deploy or alert reports. Reverts and red
// default-branch runs are left to the store, which reads them from the forge itself.
import { SIZES, type Size } from "./doc";
import { parser } from "./parse";
import { TIERS, type Tier } from "./risk";

/** Who or what found a breakage, cheapest first: a person or customer finding it costs more than a check. */
export const FINDERS = ["check", "reviewer", "queue", "canary", "person", "customer"] as const;
export type Finder = (typeof FINDERS)[number];

/** One writer or reviewer seat as the culprit's PR body records it. */
export interface Seat {
	harness: string;
	model: string;
	effort: string;
}

/** The PR that caused a breakage, with what its body records of how it was made and checked. */
export interface Culprit {
	number: number;
	/** When it merged, ISO 8601 UTC; null when it never did, as a closed PR whose commits landed elsewhere. */
	merged: string | null;
	/** Its risk tier, from its `## Review` record; null when it records none or one this version cannot read. */
	tier: Tier | null;
	/** Its size, from its `## Models` record. */
	size: Size | null;
	/** The writers its `Implementer:` lines name. */
	writers: Seat[];
	/** The local reviewers its `## Review` record names, the guardrail it passed. */
	reviewers: Seat[];
}

/**
 * One breakage. One naming an incident is keyed by its repository and that ID, else by its repository, culprit, and
 * fix, so a resend replaces it. An open incident closes when it is reported again with its culprit, or when a merged
 * fix's `## Caused by` names it: the fix's record, holding culprit, fix, and incident, then replaces it. A store
 * replacing an incident keeps its earlier `at`, and its finder when the fix names none, since the fix opened later.
 */
export interface BreakageRecord {
	/** The culprit's repository as lowercase `owner/repo`. */
	repository: string;
	/** Null only for an incident whose culprit is not known yet. */
	culprit: Culprit | null;
	/** The PR naming the culprit under `## Caused by`, or null for an incident a fix has not closed. */
	fix: number | null;
	/** The ID its reporter gave an incident, such as the alert's URL, or null for a fix naming no incident. */
	incident: string | null;
	/** Null when the fix's `## Caused by` line does not say. */
	found: Finder | null;
	/** When it was found, ISO 8601 UTC: the incident's report, else the fix PR's opening. */
	at: string;
}

const { fail, isObject, text, maybe, instant, oneOf, exact, pull, repository } = parser("breakage record");

const seat = (value: unknown): Seat => {
	if (!isObject(value)) return fail("a seat");
	exact(value, ["harness", "model", "effort"], "a seat");
	return {
		harness: text(value.harness, "a seat's harness"),
		model: text(value.model, "a seat's model"),
		effort: text(value.effort, "a seat's effort"),
	};
};

const seats = (value: unknown, what: string): Seat[] => (Array.isArray(value) ? value.map(seat) : fail(what));

function culprit(value: unknown): Culprit {
	if (!isObject(value)) return fail("the culprit");
	exact(value, ["number", "merged", "tier", "size", "writers", "reviewers"], "the culprit");
	return {
		number: pull(value.number, "the culprit's number"),
		merged: value.merged === null ? null : instant(value.merged, "the culprit's merge"),
		tier: value.tier === null ? null : oneOf(value.tier, TIERS, "the culprit's tier"),
		size: value.size === null ? null : oneOf(value.size, SIZES, "the culprit's size"),
		writers: seats(value.writers, "the culprit's writers"),
		reviewers: seats(value.reviewers, "the culprit's reviewers"),
	};
}

/** `value` as a breakage, failing on any missing, extra, or ill-typed field, or one naming neither fix nor incident. */
export function parseBreakage(value: unknown): BreakageRecord {
	if (!isObject(value)) return fail("not an object");
	exact(value, ["repository", "culprit", "fix", "incident", "found", "at"], "the breakage");
	const incident = maybe(value.incident, "the incident");
	if (incident !== null && /[\r\n]/.test(incident)) fail("the incident spans lines");
	const record: BreakageRecord = {
		repository: repository(value.repository, "repository"),
		culprit: value.culprit === null ? null : culprit(value.culprit),
		fix: value.fix === null ? null : pull(value.fix, "the fix"),
		incident,
		found: value.found === null ? null : oneOf(value.found, FINDERS, "how it was found"),
		at: instant(value.at, "when it was found"),
	};
	if (record.fix === null && record.incident === null) fail("it names neither a fix nor an incident");
	if (record.fix !== null && record.culprit === null) fail("a fix names no culprit");
	if (record.fix !== null && record.fix === record.culprit?.number) fail("a PR fixes itself");
	return record;
}

/** The identity a store replaces a breakage by. */
export const breakageKey = (b: BreakageRecord): string =>
	JSON.stringify(b.incident === null ? [b.repository, b.culprit?.number, b.fix] : [b.repository, b.incident]);
