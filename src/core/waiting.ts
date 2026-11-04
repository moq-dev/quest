// What a quest waits on outside its own work: the `## Waiting` section, where
// each top-level item opens with who acts, `Maintainer:` or an outside party
// such as `moq-dev/moq:`. The same heading hands a draft PR back (claim.ts).

import { type Doc, type Entry, entries } from "./doc";

/** The section a quest names what it waits on in. */
export const WAITING = "Waiting";

/** The party that names the maintainer: a decision or action only they can take. */
export const MAINTAINER = "Maintainer";

/** One item of a `## Waiting` section. */
export interface Wait {
	/** 1-based source line, for findings. */
	line: number;
	/** Who acts, as the item opens: `Maintainer`, or an outside party. */
	party: string;
	/** The condition, and how to check or advance it. */
	text: string;
}

// A party is a short label before the first colon: `Maintainer`, `moq-dev/moq`,
// `Akamai sales`. A longer run reads as a sentence that happens to hold a colon.
const PARTY = /^([^:\s][^:]{0,39}):\s+(\S[\s\S]*)$/;

/** Parse one `## Waiting` item, or `null` when it does not open with its party. */
export function parseWait(entry: Pick<Entry, "line" | "text">): Wait | null {
	const match = PARTY.exec(entry.text.replace(/\s+/g, " ").trim());
	if (!match) return null;
	return { line: entry.line, party: match[1].trim(), text: match[2] };
}

/** `doc`'s waits, in source order; an item without a party is left to `quest check`. */
export function waits(doc: Doc): Wait[] {
	return entries(doc, WAITING)
		.map(parseWait)
		.filter((wait): wait is Wait => wait !== null);
}

/** Whether `wait` is the maintainer's to settle. */
export function onMaintainer(wait: Wait): boolean {
	return wait.party.toLowerCase() === MAINTAINER.toLowerCase();
}
