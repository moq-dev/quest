// A pull request body's `## Models` record, which names the PR's size and each session that implemented it.

import { REVIEWERS, SECOND_REVIEWER, WRITERS } from "../cli/models";

const SECTION = /^## Models[ \t]*\r?$/m;

/** Where `body`'s `## Models` section runs, after its heading, or null without one. */
function section(body: string): { start: number; end: number } | null {
	const heading = SECTION.exec(body);
	if (!heading) return null;
	const start = heading.index + heading[0].length;
	const next = /^## /m.exec(body.slice(start));
	return { start, end: next ? start + next.index : body.length };
}

/** The fields an `Implementer:` item names, with its model as an ID and `unknown` for what it leaves out. */
export interface Implementer {
	harness: string;
	model: string;
	effort: string;
	/** The size its own line ends with, as `(iterate, XS)`. */
	size: string | null;
}

/**
 * What `body`'s `## Models` section records: each `Size:` item's whole value, even a blank or malformed one, and each
 * `Implementer:` item with its fields, or null when they do not parse.
 * The caller checks only the fields it uses, so a flag that replaces one is not blocked by a malformed one.
 */
export function recorded(body: string): {
	sizes: string[];
	implementers: { item: string; fields: Implementer | null }[];
} {
	const found = section(body);
	if (!found) return { sizes: [], implementers: [] };
	const items = body
		.slice(found.start, found.end)
		.split(/\r?\n/)
		.map((line) => line.replace(/^\s*[-*]\s+/, "").trim());
	return {
		sizes: items.filter((item) => item.startsWith("Size:")).map((item) => item.slice("Size:".length).trim()),
		implementers: items
			.filter((item) => item.startsWith("Implementer:"))
			.map((item) => ({ item, fields: implementer(item) })),
	};
}

// Display names and IDs compare alike: `Opus 5.5`, `Claude Opus 5.5`, and `claude-opus-5-5` share a key.
const key = (name: string) =>
	name
		.toLowerCase()
		.replace(/[\s.]+/g, "-")
		.replace(/^claude-/, "");
const KNOWN = new Map(
	[...Object.values(WRITERS), ...Object.values(REVIEWERS), [SECOND_REVIEWER]]
		.flat()
		.map(({ model }) => [key(model), model]),
);

/** The model ID `name` means: a listed model by its ID or display name, else `name` itself when it reads as an ID. */
function modelId(name: string): string | null {
	return KNOWN.get(key(name)) ?? (/^(unknown|[a-z][\w./-]*\d[\w./-]*)$/.test(name) ? name : null);
}

/**
 * The fields of an `Implementer: <harness>, <model>, <effort> effort` item, as agents write it: the model by ID or
 * display name, the harness or effort left out or `effort not reported`, and a size its line ends with, as
 * `(iterate, XS)`, beside any note in its parentheses. Null when it names no model or has fields past the effort.
 */
export function implementer(item: string): Implementer | null {
	let rest = item.trim().replace(/^Implementer:\s*/, "");
	const sized = /\s*\(([^()]*)\)$/.exec(rest);
	if (sized) rest = rest.slice(0, sized.index);
	const parts = rest.split(/,\s*/).map((part) => part.trim());
	const at = parts.findIndex((part) => modelId(part) !== null);
	if (at < 0) return null;
	const after = parts.slice(at + 1);
	if (after.length > 1) return null;
	let effort = "unknown";
	if (after.length === 1 && !/^(effort not reported|unknown effort)$/i.test(after[0]!)) {
		const named = /^(\S+)(?: effort)?$/.exec(after[0]!);
		if (!named) return null;
		effort = named[1]!;
	}
	return {
		harness: parts.slice(0, at).join(", ") || "unknown",
		model: modelId(parts[at]!)!,
		effort,
		size: sized?.[1]!.split(", ").at(-1)!.match(/^\w+$/)?.[0] ?? null,
	};
}
