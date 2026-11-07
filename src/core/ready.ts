// Whether a quest can be started, read from the same `Required` sections and
// epic directories the rules validate.
//
// Readiness is a property of the tree alone, which is what makes it cheap and
// deterministic: a finished quest is deleted, so a blocker that still resolves
// is still open. Liveness is the other question - a quest can be ready,
// coherent, and already done by some other PR - and answering it means asking
// the forge, so it belongs to the flow that is already talking to it.

import { type Doc, children, entries, has, isEpic, rooted } from "./doc";
import { comparePaths, normalize } from "./path";

/** One thing standing between a quest and being started. */
export interface Blocker {
	/**
	 * The quest or epic that has to finish first. `null` is an entry that
	 * is not a quest, which `quest check` rejects and nothing here can clear.
	 */
	path: string | null;
	/** The dependency as written, whitespace collapsed. */
	text: string;
	/**
	 * The still-open quests under a required epic, which is what an
	 * epic blocker actually means. Empty for every other blocker: a
	 * required quest's own blockers are its readiness, not this one's.
	 */
	blockers: Blocker[];
}

/** What names the blocker: the document, or the entry's own words. */
export function label(blocker: Blocker): string {
	return blocker.path ?? blocker.text;
}

/** The whole chain, one blocker per line, indented two spaces per level of nesting. */
export function renderBlocker(blocker: Blocker, depth = 0): string[] {
	return [`${"  ".repeat(depth)}${label(blocker)}`, ...blocker.blockers.flatMap((b) => renderBlocker(b, depth + 1))];
}

/**
 * What blocks `doc`: its `Required` entries, then, for an epic, its children,
 * each epic among them expanded into the quests it still holds. Empty means ready.
 */
export function blockers(docs: Doc[], doc: Doc): Blocker[] {
	return expand(docs, new Map(docs.map((d) => [d.path, d])), doc, [doc.path]);
}

/**
 * The quest document `path` names, written as the tree writes it
 * (`/quest/m0/one.md`) or as the shell completes it (`quest/m0/one.md`).
 */
export function lookup(docs: Doc[], path: string): Doc | null {
	for (const candidate of [normalize(path), normalize(path.replace(/^\//, ""))]) {
		const doc = docs.find((d) => d.path === candidate);
		if (doc) return doc;
	}
	return null;
}

/** Every document's path in tree order, which is path order: each epic before its children. */
export function treeOrder(docs: Doc[]): string[] {
	return docs.map((doc) => doc.path).sort(comparePaths);
}

/**
 * Every quest that can be started now, in tree order.
 *
 * An epic is not listed while its directory holds other quests; a README with
 * none left is the epic's own remaining work and lists like any other quest.
 * A quest is ready when it has no `## Required` heading.
 */
export function ready(docs: Doc[]): string[] {
	const byPath = new Map(docs.map((doc) => [doc.path, doc]));
	return treeOrder(docs).filter((path) => {
		const doc = byPath.get(path)!;
		return !isEpic(docs, doc) && !has(doc, "Required");
	});
}

/** The blockers of one document: its `Required` entries, then an epic's children. */
function expand(docs: Doc[], byPath: Map<string, Doc>, doc: Doc, stack: string[]): Blocker[] {
	const found: Blocker[] = [];
	// A heading left standing after its last blocker still reads as blocked to
	// everything that greps for it, including `quest check`, which reports it.
	// Calling it ready here would make this the one tool that disagrees.
	const required = entries(doc, "Required");
	const kids = children(docs, doc);
	if (has(doc, "Required") && required.length === 0) {
		found.push({
			path: null,
			text: "an empty '## Required' section, which blocks the quest until the heading is removed",
			blockers: [],
		});
	}
	for (const entry of required) {
		// A bullet that does not open with a link into the tree is invalid, and
		// nothing here can clear it, so it is a blocker with nothing under it.
		const target = entry.target === null ? null : rooted(entry.target);
		// An old child list's entry is listed below, with the children.
		if (target !== null && kids.includes(target)) continue;
		found.push(blocker(docs, byPath, target !== null && byPath.has(target) ? target : null, entry.text, stack));
	}
	for (const child of kids) found.push(blocker(docs, byPath, child, child, stack));
	return found;
}

function blocker(docs: Doc[], byPath: Map<string, Doc>, path: string | null, text: string, stack: string[]): Blocker {
	// Only an epic expands. A required QUEST is the blocker itself, and its
	// own chain is the answer to running this on that quest instead; printing
	// it here buries the entries that were asked for under a repeated subtree.
	// The stack guard is for a tree nobody has run `quest check` on yet, where an
	// epic requiring an ancestor must print rather than recurse forever.
	let nested: Blocker[] = [];
	if (path !== null && isEpic(docs, byPath.get(path)!) && !stack.includes(path)) {
		stack.push(path);
		nested = expand(docs, byPath, byPath.get(path)!, stack);
		stack.pop();
	}
	return { path, text, blockers: nested };
}
