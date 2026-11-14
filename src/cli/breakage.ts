// What a PR body says about breakage: the culprits its `## Caused by` names, and, for a culprit, how it was made and
// checked, as its own body records it.
import { type Culprit, FINDERS, type Finder, SIZES, type Seat, type Size, recordedRisk } from "../core";
import type { Repository } from "../github/client";
import { recorded } from "./models-record";
import { parseReview } from "./review-record";
import type { Pull } from "./usage";

/** One culprit a `## Caused by` section names, and who or what found the breakage and its incident, when its line says. */
export interface Cause {
	number: number;
	found: Finder | null;
	/** The ID of the incident the fix closes, as `quest records incident` reported it. */
	incident: string | null;
}

/**
 * The PRs of `repository` that `body`'s `## Caused by` section names as culprits: each bullet that opens with
 * `[owner/repo#N](url) - why`. A link anywhere else on a line, as context or a "fixed by" aside, names no culprit.
 * A line may end with a parenthesis of either part or both, as `(found by customer; incident <id>)`: who found it,
 * an article allowed, and the incident the fix closes. Each culprit and incident keeps its first line, and a
 * culprit whose lines name incidents drops its line naming none.
 */
export function culprits(body: string, repository: Repository): Cause[] {
	const heading = /^## Caused by[ \t]*\r?$/m.exec(body);
	if (!heading) return [];
	const rest = body.slice(heading.index + heading[0].length);
	const section = rest.slice(0, /^## /m.exec(rest)?.index ?? rest.length);
	const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const name = `${escape(repository.owner)}/${escape(repository.repo)}`;
	const culprit = new RegExp(
		`^- \\[${name}#(\\d+)\\]\\(https://github\\.com/${name}/pull/(\\d+)\\) - \\S[^\\r\\n]*`,
		"gim",
	);
	const tail = new RegExp(
		`\\((?:found by (?:an? |the )?(${FINDERS.join("|")})(?:; |(?=\\))))?(?:incident ([^\\r\\n]+?))?\\)\\s*$`,
		"i",
	);
	const found = new Map<string, Cause>();
	for (const match of section.matchAll(culprit)) {
		if (match[1] !== match[2]) continue;
		const [, by, named] = tail.exec(match[0]) ?? [];
		const cause: Cause = {
			number: Number(match[1]),
			found: (by?.toLowerCase() as Finder | undefined) ?? null,
			incident: named?.trim() || null,
		};
		const id = JSON.stringify([cause.number, cause.incident]);
		if (!found.has(id)) found.set(id, cause);
	}
	// A line naming an incident records its culprit's breakage, so the culprit's line naming none would count it twice.
	const named = new Set([...found.values()].filter((c) => c.incident !== null).map((c) => c.number));
	return [...found.values()].filter((c) => c.incident !== null || !named.has(c.number));
}

/**
 * `pull` as a culprit. Its body is its author's text, so a record this version cannot read leaves the field empty
 * rather than stopping the records of every other PR.
 */
export function culpritOf(pull: Pull): Culprit {
	const own = recorded(pull.body);
	let tier: Culprit["tier"] = null;
	let reviewers: Seat[] = [];
	try {
		tier = recordedRisk(pull.body)?.tier ?? null;
	} catch {
		// Malformed: no tier.
	}
	try {
		reviewers = parseReview(pull.body);
	} catch {
		// Malformed: no reviewers.
	}
	return {
		number: pull.number,
		merged: pull.state === "merged" && pull.closed !== null ? new Date(pull.closed).toISOString() : null,
		tier,
		size: (own.sizes.find((s) => (SIZES as readonly string[]).includes(s)) as Size | undefined) ?? null,
		writers: distinct(own.implementers.flatMap(({ fields }) => (fields ? [fields] : []))),
		reviewers: distinct(reviewers),
	};
}

/** Each seat once, in first-named order, as several Implementer lines or a shadow may repeat one. */
function distinct(seats: Seat[]): Seat[] {
	const seen = new Map<string, Seat>();
	for (const { harness, model, effort } of seats) {
		const id = JSON.stringify([harness, model, effort]);
		if (!seen.has(id)) seen.set(id, { harness, model, effort });
	}
	return [...seen.values()];
}
