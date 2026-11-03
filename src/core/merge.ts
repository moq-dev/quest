// Resolving three-way merge conflicts in a quest's link lists, for the
// `quest resolve` merge driver.
//
// Git's line merge already applies every edit only one side made. What is left
// are conflicts, and the common one in a quest tree is a link list both sides
// touched: the base branch deleting finished quests' lines while a branch
// inserts a new quest next to them. Such a conflict merges item by item: keep
// what neither side removed and add what either side inserted. Anything else,
// including prose, a heading, or an item both sides rewrote, stays a conflict.
// A `Required` list the merge empties loses its heading too, since an empty
// one would block its quest forever.

import { parse } from "./doc";
import { LIST_SECTIONS } from "./rules";

/** Lines on which neither side conflicts, without their `\n`. */
export type Clean = string[];

/** One conflicting region, as each version has it. */
export interface Conflict {
	ours: string[];
	base: string[];
	theirs: string[];
}

/** A file merged by lines: clean regions and conflicts, in order. */
export type Chunk = Clean | Conflict;

const SIDES = ["ours", "base", "theirs"] as const;
type Side = (typeof SIDES)[number];

/** A list entry as one side has it: the destination of its opening link, its section, and its source lines. */
interface Item {
	key: string;
	section: string;
	lines: string[];
}

/** Labels, in order, that the conflict markers carry; `quest resolve` asks git for these. */
export const LABELS: Record<Side, string> = { ours: "ours", base: "base", theirs: "theirs" };

/**
 * Split `git merge-file --diff3` output, written with `size`-character
 * markers and the supplied labels (defaulting to `LABELS`), into chunks.
 */
export function chunks(text: string, size: number, labels = LABELS): Chunk[] {
	const marker = (char: string, label?: string) => char.repeat(size) + (label === undefined ? "" : ` ${label}`);
	const start = marker("<", labels.ours);
	const base = marker("|", labels.base);
	const split = marker("=");
	const end = marker(">", labels.theirs);

	const out: Chunk[] = [];
	let clean: Clean = [];
	let conflict: Conflict | null = null;
	let side: Side = "ours";
	for (const line of text.split("\n")) {
		// Git writes markers with the file's own line ending.
		const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
		if (conflict === null && bare === start) {
			if (clean.length > 0) out.push(clean);
			clean = [];
			conflict = { ours: [], base: [], theirs: [] };
			side = "ours";
		} else if (conflict !== null && side === "ours" && bare === base) {
			side = "base";
		} else if (conflict !== null && side === "base" && bare === split) {
			side = "theirs";
		} else if (conflict !== null && side === "theirs" && bare === end) {
			out.push(conflict);
			conflict = null;
		} else if (conflict !== null) {
			conflict[side].push(line);
		} else {
			clean.push(line);
		}
	}
	if (conflict !== null) throw new Error("unterminated conflict in merge output");
	out.push(clean);
	return out;
}

/**
 * Join chunks back into a file. A conflict is written with standard
 * `size`-character markers, with its base section only when `diff3` is set.
 */
export function render(chunks: Chunk[], size: number, diff3: boolean, labels = LABELS): string {
	const lines: string[] = [];
	for (const chunk of chunks) {
		if (Array.isArray(chunk)) {
			lines.push(...chunk);
			continue;
		}
		// A conflict's lines keep their own `\r`, so its markers take the same ending.
		const eol = [...chunk.ours, ...chunk.base, ...chunk.theirs].some((line) => line.endsWith("\r")) ? "\r" : "";
		lines.push(`${"<".repeat(size)} ${labels.ours}${eol}`, ...chunk.ours);
		if (diff3) lines.push(`${"|".repeat(size)} ${labels.base}${eol}`, ...chunk.base);
		lines.push(`${"=".repeat(size)}${eol}`, ...chunk.theirs, `${">".repeat(size)} ${labels.theirs}${eol}`);
	}
	return lines.join("\n");
}

/**
 * Resolve every conflict that only edits the entries of one link list
 * (`Required`, `Related`, or `Closes`). Kept are the base entries neither side
 * removed, with the one side's edit when only one side changed one, and
 * inserted are the entries either side added, after the entry that precedes
 * them on that side, ours before theirs. Entries are matched by their opening
 * link's destination. A `Required` section this leaves with nothing but
 * blank lines is dropped with its heading. Every other conflict is returned as
 * it was.
 */
export function resolveLists(path: string, merged: Chunk[]): Chunk[] {
	const items = {
		ours: lists(path, merged, "ours"),
		base: lists(path, merged, "base"),
		theirs: lists(path, merged, "theirs"),
	};
	const emptied = new Set<number>();
	const resolved = merged.map((chunk, index) => {
		const [ours, base, theirs] = SIDES.map((side) => items[side].get(index));
		if (ours === undefined || base === undefined || theirs === undefined) return chunk;
		const lines = mergeItems(ours, base, theirs);
		if (lines === null) return chunk;
		if (lines.length === 0 && base.some((item) => item.section === "Required")) emptied.add(index);
		return lines;
	});
	return emptied.size === 0 ? resolved : dropEmptyRequired(path, resolved, emptied);
}

/**
 * `merged` without each `Required` heading whose section holds one of the
 * `emptied` resolutions and otherwise only blank lines, with no conflict left
 * in it, along with that section's lines. As `quest rm` does, a blank line
 * left doubled by the removal goes too.
 */
function dropEmptyRequired(path: string, merged: Chunk[], emptied: Set<number>): Chunk[] {
	// The document with every conflict taken from ours; `clean` marks lines outside a conflict.
	// `at` and `open` hold where each emptied list and each remaining conflict
	// sits, as the index of the line after it, since either can have no lines.
	const lines: string[] = [];
	const clean: boolean[] = [];
	const at: number[] = [];
	const open: number[] = [];
	merged.forEach((chunk, index) => {
		if (emptied.has(index)) at.push(lines.length);
		if (!Array.isArray(chunk)) open.push(lines.length);
		const own = Array.isArray(chunk) ? chunk : chunk.ours;
		lines.push(...own);
		clean.push(...own.map(() => Array.isArray(chunk)));
	});
	const doc = parse(path, lines.join("\n"));
	// A trailing newline leaves an empty last element, which is not a line.
	const count = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;

	// Indices, 0-based, of the lines to drop.
	const dropped = new Set<number>();
	doc.headings.forEach((heading, index) => {
		if (heading.text !== "Required" || !clean[heading.line - 1]) return;
		const next = doc.headings[index + 1];
		if (next !== undefined && !clean[next.line - 1]) return;
		// The section's body is the 0-based lines from `heading.line` up to `end`.
		const end = next === undefined ? count : next.line - 1;
		const inside = (line: number) => line >= heading.line && line <= end;
		if (!at.some(inside) || open.some(inside)) return;
		const body = Array.from({ length: end - heading.line }, (_, i) => heading.line + i);
		if (!body.every((i) => lines[i].trim() === "")) return;
		dropped.add(heading.line - 1);
		for (const i of body) dropped.add(i);
	});
	if (dropped.size === 0) return merged;

	// Removing a block between two blank lines would leave both; keep one.
	let line = 0;
	let gap = false;
	let blank = false;
	return merged.map((chunk) => {
		if (!Array.isArray(chunk)) {
			line += chunk.ours.length;
			gap = false;
			blank = false;
			return chunk;
		}
		const kept: string[] = [];
		for (const text of chunk) {
			if (dropped.has(line++)) {
				gap = true;
				continue;
			}
			const empty = text.trim() === "";
			if (!(gap && empty && blank)) {
				kept.push(text);
				blank = empty;
			}
			gap = false;
		}
		return kept;
	});
}

/**
 * For the document with every conflict taken from `side`, the entries each
 * conflict holds on that side, keyed by the conflict's index. A conflict is
 * missing when its lines are anything but whole entries of one link list,
 * each opening with an inline link.
 */
function lists(path: string, merged: Chunk[], side: Side): Map<number, Item[]> {
	const lines: string[] = [];
	const ranges = new Map<number, [number, number]>();
	merged.forEach((chunk, index) => {
		if (Array.isArray(chunk)) {
			lines.push(...chunk);
		} else {
			ranges.set(index, [lines.length + 1, lines.length + chunk[side].length]);
			lines.push(...chunk[side]);
		}
	});
	const doc = parse(path, lines.join("\n"));

	const out = new Map<number, Item[]>();
	for (const [index, [first, last]] of ranges) {
		const entries = doc.entries.filter((entry) => entry.end >= first && entry.line <= last);
		let next = first;
		let section: string | null | undefined;
		const valid = entries.every((entry) => {
			// Entries tile the range: no line outside one, and none reaching past it.
			const ok =
				entry.line === next &&
				entry.end <= last &&
				entry.target !== null &&
				entry.section !== null &&
				LIST_SECTIONS.includes(entry.section) &&
				(section === undefined || section === entry.section);
			next = entry.end + 1;
			section = entry.section;
			return ok;
		});
		if (!valid || next !== last + 1) continue;
		const items = entries.map((entry) => ({
			key: entry.target!,
			section: entry.section!,
			lines: lines.slice(entry.line - 1, entry.end),
		}));
		if (items.every((item) => selfContained(path, item))) out.set(index, items);
	}
	return out;
}

/**
 * Whether an entry's own lines name its destination. A reference-style link
 * takes it from a definition outside the conflict, which the clean regions
 * show only as merged, so a side that re-targeted the entry there would look
 * unchanged.
 */
function selfContained(path: string, item: Item): boolean {
	return parse(path, item.lines.join("\n")).entries[0]?.target === item.key;
}

/** The merged entries' lines, or `null` when the sides disagree on an entry or reorder the ones they share. */
function mergeItems(ours: Item[], base: Item[], theirs: Item[]): string[] | null {
	const [o, b, t] = [ours, base, theirs].map((items) => new Map(items.map((item) => [item.key, item])));
	if (o.size !== ours.length || b.size !== base.length || t.size !== theirs.length) return null;

	const kept: Item[] = [];
	for (const item of base) {
		const mine = o.get(item.key);
		const other = t.get(item.key);
		if (mine === undefined || other === undefined) {
			// A removal wins only over a side that left the entry as it was.
			const survivor = mine ?? other;
			if (survivor !== undefined && !same(survivor, item)) return null;
			continue;
		}
		if (same(mine, other) || same(other, item)) kept.push(mine);
		else if (same(mine, item)) kept.push(other);
		else return null;
	}

	// Each side must keep the shared entries in base order: a reorder is a priority change.
	const keys = new Set(kept.map((item) => item.key));
	const order = kept.map((item) => item.key).join("\n");
	for (const side of [ours, theirs]) {
		if (
			side
				.filter((item) => keys.has(item.key))
				.map((item) => item.key)
				.join("\n") !== order
		)
			return null;
	}

	// Inserts, grouped under the kept entry that precedes them on their side.
	const after = new Map<string | null, Item[]>();
	const inserted = new Map<string, Item>();
	for (const side of [ours, theirs]) {
		let anchor: string | null = null;
		for (const item of side) {
			if (keys.has(item.key)) {
				anchor = item.key;
				continue;
			}
			if (b.has(item.key)) continue;
			const twin = inserted.get(item.key);
			if (twin !== undefined) {
				if (!same(twin, item)) return null;
				continue;
			}
			inserted.set(item.key, item);
			after.set(anchor, [...(after.get(anchor) ?? []), item]);
		}
	}

	const out: string[] = [];
	for (const anchor of [null, ...kept]) {
		if (anchor !== null) out.push(...anchor.lines);
		for (const item of after.get(anchor === null ? null : anchor.key) ?? []) out.push(...item.lines);
	}
	return out;
}

function same(a: Item, b: Item): boolean {
	return a.lines.join("\n") === b.lines.join("\n");
}
