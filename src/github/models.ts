// A pull request body's `## Models` record, which names the PR's size and each session that implemented it.

import { SIZES } from "../core";
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

// Display names and IDs compare alike: `Opus 5.5`, `Claude Opus 5.5`, and `claude-opus-5-5` share a key, as do
// `DeepSeek V4.1 Flash` and `opencode-go/deepseek-v4.1-flash`.
const key = (name: string) =>
	name
		.toLowerCase()
		.replace(/^.*\//, "")
		.replace(/[\s.]+/g, "-")
		.replace(/^claude-/, "");
const KNOWN = new Map(
	[...Object.values(WRITERS), ...Object.values(REVIEWERS), [SECOND_REVIEWER]]
		.flat()
		.map(({ model }) => [key(model), model]),
);

/**
 * The model ID `name` means: a listed model by its ID or display name, a Claude harness's `<Family> <version>` as
 * its `claude-` ID, else `name` itself when it reads as an ID.
 */
function modelId(name: string, harness: string): string | null {
	const listed = KNOWN.get(key(name));
	if (listed) return listed;
	if (/^claude\b/i.test(harness) && /^(claude )?[a-z]+ \d+(\.\d+)*$/i.test(name)) return `claude-${key(name)}`;
	return /^(unknown|[a-z][\w./-]*\d[\w./-]*)$/.test(name) ? name : null;
}

/**
 * The fields of an `Implementer: <harness>, <model>, <effort> effort` item, as agents write it: the model by ID or
 * display name, the harness or effort left out, the effort bare or `effort not reported`, and a size among the
 * notes of a parenthetical it ends with, as `(iterate, XS)`. Null when it names no model or has more fields; a lone
 * field reads only as a listed model's ID or display name, or as an ID.
 */
export function implementer(item: string): Implementer | null {
	let rest = item.trim().replace(/^Implementer:\s*/, "");
	const notes = /\s*\(([^()]*)\)$/.exec(rest);
	if (notes) rest = rest.slice(0, notes.index);
	const parts = rest.split(/,\s*/).map((part) => part.trim());
	if (parts.length > 3) return null;
	const size = notes?.[1]!.split(/,\s*/).find((note) => (SIZES as readonly string[]).includes(note)) ?? null;
	// A lone field is a model only as a listed name or an ID, since `unknown` or another name alone may be a harness.
	if (parts.length === 1) {
		const id = modelId(parts[0]!, "");
		return id !== null && id !== "unknown" ? { harness: "unknown", model: id, effort: "unknown", size } : null;
	}
	// The model is the last field, or the one before the effort.
	const effortless = parts.length === 2 && modelId(parts[1]!, parts[0]!) !== null;
	const at = effortless ? 1 : parts.length - 2;
	const harness = parts.slice(0, at).join(", ") || "unknown";
	const model = modelId(parts[at]!, harness);
	if (model === null) return null;
	let effort = "unknown";
	if (!effortless && !/^(effort not reported|unknown effort)$/i.test(parts.at(-1)!)) {
		const named = /^(\S+)(?: effort)?$/.exec(parts.at(-1)!);
		if (!named) return null;
		effort = named[1]!;
	}
	return { harness, model, effort, size };
}
