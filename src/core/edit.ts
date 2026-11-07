// Moving and deleting quests, as pure edits of the documents that link to them.
//
// The caller owns the files: it moves or deletes them, then writes back what
// these return. Only root-absolute links are edited, since those are the
// dependency graph. Anything else that mentions a path is prose, which the
// caller reports rather than rewriting.

import { type Doc, type Entry, parse, rooted, withoutFragment } from "./doc";
import { LIST_SECTIONS, finishedMilestone } from "./rules";

/** One quest document as loaded: its repository-relative path and source text. */
export interface Source {
	path: string;
	text: string;
}

/** A link that names a moved path but whose destination is not written as parsed, such as one with escapes. */
export interface Missed {
	path: string;
	line: number;
	target: string;
}

/** What a move changes. */
export interface Moved {
	/** The new text of every document whose links changed, keyed by its path after the move. */
	texts: Map<string, string>;
	/** Links to a moved path that could not be rewritten in place. */
	missed: Missed[];
}

/**
 * Where `path` lands when `from` moves to `to`, or `null` if it stays. `from`
 * is a quest, or an epic directory that moves everything beneath it.
 */
export function relocate(path: string, from: string, to: string): string | null {
	if (path === from) return to;
	return path.startsWith(`${from}/`) ? to + path.slice(from.length) : null;
}

/**
 * Rewrite every root-absolute link to `from`, or to a document under it, to
 * point at its new path under `to`. Fragments are kept; each path segment is
 * percent-encoded the way a Markdown destination needs.
 */
export function move(sources: Source[], from: string, to: string): Moved {
	const texts = new Map<string, string>();
	const missed: Missed[] = [];
	for (const source of sources) {
		const doc = parse(source.path, source.text);
		const edits = new Map<number, { length: number; text: string }>();
		for (const link of doc.links) {
			const target = rooted(link.target);
			const moved = target === null ? null : relocate(target, from, to);
			if (moved === null) continue;
			const at = source.text.indexOf(link.target, link.span[0]);
			if (at < 0 || at + link.target.length > link.span[1]) {
				missed.push({ path: source.path, line: link.line, target: link.target });
				continue;
			}
			const fragment = link.target.slice(withoutFragment(link.target).length);
			// Reference-style links share their definition, which is rewritten once.
			edits.set(at, { length: link.target.length, text: `/${encode(moved)}${fragment}` });
		}
		if (edits.size > 0) texts.set(relocate(source.path, from, to) ?? source.path, splice(source.text, edits));
	}
	return { texts, missed };
}

/**
 * Drop every list entry, in a list section, that opens with a link to a
 * deleted document, and a section heading left with no entries. Then drop
 * every `Required` link to a finished milestone, whether this removal emptied
 * it or the link was already stale, repeating until nothing changes so the
 * result passes `quest check`. Returns the new text of every surviving
 * document that changed.
 */
export function remove(sources: Source[], deleted: (path: string) => boolean): Map<string, string> {
	const texts = new Map(sources.filter((s) => !deleted(s.path)).map((s) => [s.path, s.text]));
	const changed = new Set<string>();
	const linksDeleted = (entry: Entry) => {
		if (entry.section === null || !LIST_SECTIONS.includes(entry.section) || entry.target === null) return false;
		const target = rooted(entry.target);
		return target !== null && deleted(target);
	};
	for (let progress = true; progress;) {
		progress = false;
		const docs = [...texts].map(([path, text]) => parse(path, text));
		const finished = finishedMilestone(docs);
		for (const doc of docs) {
			const text = drop(texts.get(doc.path)!, doc, (entry) => linksDeleted(entry) || finished(doc, entry));
			if (text === null) continue;
			texts.set(doc.path, text);
			changed.add(doc.path);
			progress = true;
		}
	}
	return new Map([...changed].map((path) => [path, texts.get(path)!]));
}

/** `doc` without the list entries `dropping` accepts, or `null` if it has none. */
function drop(text: string, doc: Doc, dropping: (entry: Entry) => boolean): string | null {
	const lines = text.split("\n");
	// A trailing newline leaves an empty last element, which is not a line.
	const count = text.endsWith("\n") ? lines.length - 1 : lines.length;
	const dropped = new Set<number>();
	for (const entry of doc.entries) {
		if (!dropping(entry)) continue;
		for (let line = entry.line; line <= entry.end; line++) dropped.add(line - 1);
	}
	if (dropped.size === 0) return null;

	// A section that lost entries and has nothing left but blank lines goes
	// with its heading: an empty `Required` would block its quest forever.
	doc.headings.forEach((heading, index) => {
		if (!LIST_SECTIONS.includes(heading.text)) return;
		const end = index + 1 < doc.headings.length ? doc.headings[index + 1].line - 1 : count;
		const body = Array.from({ length: end - heading.line }, (_, i) => heading.line + i);
		if (!body.some((i) => dropped.has(i))) return;
		if (!body.every((i) => dropped.has(i) || lines[i].trim() === "")) return;
		dropped.add(heading.line - 1);
		for (const i of body) dropped.add(i);
	});

	// Removing a block between two blank lines would leave both; keep one.
	const out: string[] = [];
	let gap = false;
	lines.forEach((line, i) => {
		if (dropped.has(i)) {
			gap = true;
			return;
		}
		const blank = line.trim() === "";
		if (!(gap && blank && out.length > 0 && out[out.length - 1].trim() === "")) out.push(line);
		gap = false;
	});
	return out.join("\n");
}

/**
 * A repository-relative path as a root-absolute Markdown destination's path.
 * Parentheses are encoded too, since an unmatched one ends an inline link.
 */
function encode(path: string): string {
	return path
		.split("/")
		.map((name) => encodeURIComponent(name).replace(/\(/g, "%28").replace(/\)/g, "%29"))
		.join("/");
}

/** `text` with each replacement, keyed by offset, applied. */
function splice(text: string, edits: Map<number, { length: number; text: string }>): string {
	let out = "";
	let from = 0;
	for (const at of [...edits.keys()].sort((a, b) => a - b)) {
		const edit = edits.get(at)!;
		out += text.slice(from, at) + edit.text;
		from = at + edit.length;
	}
	return out + text.slice(from);
}
