// Parsing one quest document into the facts every rule reads.
//
// This is a real Markdown AST rather than line matching. The shell version
// that came before it was defeated by a fence longer than three backticks
// (which inverted its fence tracking and silently skipped the rest of the
// file), by a `Required` bullet that wrapped onto a second line (which moved
// the link out of reach of the check that exists to catch it), and by
// reference-style links (which produced a rendered dependency with no edge).
// None of those are special cases here; the parser simply reports the
// structure that Markdown actually has.

import type { Nodes, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";

import { comparePaths, depth, escapes, fileName, join, normalize, parent } from "./path";

/**
 * Where a link sits inside its `## Section`, which is what separates a
 * dependency edge from prose that merely mentions one.
 *
 * - `entry`: the link opens a list item, ignoring any emphasis around it. This
 *   is the shape every `Required` entry must have.
 * - `inside`: somewhere else inside a list item: a sentence that happens to link.
 * - `prose`: outside any list item.
 */
export type Position = "entry" | "inside" | "prose";

/** One Markdown link, located precisely enough to be a graph edge. */
export interface Link {
	/** 1-based source line, for findings. */
	line: number;
	/** The enclosing `## Heading`, or `null` above the first one. */
	section: string | null;
	/** The destination exactly as written, fragment included. */
	target: string;
	/** Where the link sits in its section. */
	position: Position;
	/**
	 * Source offsets bounding where the destination is written: after the
	 * link's text to the end of the link, or after the label of the
	 * definition a reference-style link uses. An edit searches it for `target`.
	 */
	span: [number, number];
}

/** One top-level list entry: the shape a `Required` blocker has. */
export interface Entry {
	/** 1-based source line, for findings. */
	line: number;
	/** 1-based last source line of the item, so an edit can remove it. */
	end: number;
	/** The enclosing `## Heading`, or `null` above the first one. */
	section: string | null;
	/**
	 * The rendered text with whitespace collapsed, so a bullet that wrapped
	 * onto a second line reads as the one line it renders as.
	 */
	text: string;
	/**
	 * The destination of the link that opens the entry, if one does. This is
	 * the `entry` link, so it is a dependency rather than a sentence that
	 * happens to mention one.
	 */
	target: string | null;
}

/** One heading as the rules need to see it. */
export interface Heading {
	/** 1-based source line, for findings. */
	line: number;
	/** The number of `#` marks, 1 through 6. */
	depth: number;
	/** The rendered heading text, trimmed. */
	text: string;
	/**
	 * The source really is `# Text` or `## Text` on its own line. Setext and
	 * decorated headings render the same, but literal syntax is the contract.
	 */
	literal: boolean;
}

/** One parsed quest document: the structure the rules read, nothing else. */
export interface Doc {
	/** Repository-relative, e.g. `quest/m0/one.md`. */
	path: string;
	/** The document's `# ` title, used for a quest's t-shirt size. */
	title: Heading | null;
	/** `## ` headings only. Deeper levels are free-form prose structure. */
	headings: Heading[];
	/**
	 * Every heading at another level, `# ` included, in source order. Free-form
	 * prose structure, except that a section name written here is a mistake the
	 * rules report: readiness and `quest waiting` read only `## ` sections.
	 */
	offLevel: Heading[];
	/** Every link in the document, in source order. */
	links: Link[];
	/**
	 * Every top-level list item, in source order. A heading left behind by its
	 * last entry has none, and a `Required` blocker is one of these whether or
	 * not it carries a link.
	 */
	entries: Entry[];
}

/**
 * Agent instructions are not quests, including the quest/AGENTS.md older
 * versions installed and CLAUDE.md files in adopting repositories. Neither
 * filename is indexed or validated.
 */
const NOT_QUESTS = ["AGENTS.md", "CLAUDE.md"];

/** Whether a file under `quest/` is a quest document: Markdown other than agent instructions. */
export function isQuest(path: string): boolean {
	const name = fileName(path);
	return name.endsWith(".md") && !NOT_QUESTS.includes(name);
}

/**
 * A quest's branch: its path without `.md`, so an epic's is
 * `quest/<path>/README`. The directory form would collide with its children's
 * branches, since git cannot hold `quest/m0/foo` beside `quest/m0/foo/bar`.
 */
export function questBranch(path: string): string {
	return path.replace(/\.md$/, "");
}

/** The t-shirt sizes a quest's title gives it, smallest first. */
export const SIZES = ["XS", "S", "M", "L", "XL"] as const;
export type Size = (typeof SIZES)[number];

/**
 * A quest's size from its literal title, `# [XS|S|M|L|XL] Title`, or null when
 * it has none, as an epic with children does.
 */
export function size(doc: Doc): Size | null {
	const title = doc.title;
	const match = title?.literal ? /^\[([^\]]*?)\] ./s.exec(title.text) : null;
	return match && (SIZES as readonly string[]).includes(match[1]) ? (match[1] as Size) : null;
}

/** The quest file a branch names, whether or not it exists: the branch plus `.md`. */
export function branchQuest(branch: string): string {
	return `${branch}.md`;
}

/** Whether the document has this exact `## ` heading. */
export function has(doc: Doc, heading: string): boolean {
	return doc.headings.some((h) => h.text === heading);
}

/** The top-level entries under a `## ` section, in source order. */
export function entries(doc: Doc, section: string): Entry[] {
	return doc.entries.filter((e) => e.section === section);
}

function isReadme(path: string): boolean {
	return fileName(path) === "README.md";
}

/**
 * The root and the milestones outlive their quests, so an empty one is not a
 * leaf. `quest/README.md` has two components and `quest/m0/README.md` has
 * three; anything nested further is an ordinary epic.
 */
export function permanent(path: string): boolean {
	return isReadme(path) && depth(path) <= 3;
}

/**
 * The epic directory this document belongs to. An epic is a
 * DIRECTORY, so its own entry sits one level further out than a quest's:
 * `quest/m2/drain/README.md` belongs to `quest/m2`, not to `quest/m2/drain`.
 */
export function owner(path: string): string {
	return isReadme(path) ? parent(parent(path)) : parent(path);
}

/**
 * Whether the epic README `readme` holds `path`: it sits anywhere under the
 * epic's directory, so the epic already waits for it.
 */
export function holds(readme: string, path: string): boolean {
	return isReadme(readme) && path !== readme && path.startsWith(`${parent(readme)}/`);
}

/**
 * An epic's children: the quests directly in its directory and the READMEs of
 * the epics one level down, in path order. A quest that is not a README has
 * none.
 */
export function children(docs: readonly Doc[], doc: Doc): string[] {
	if (!isReadme(doc.path)) return [];
	const dir = parent(doc.path);
	return docs
		.map((d) => d.path)
		.filter((path) => owner(path) === dir)
		.sort(comparePaths);
}

/**
 * An epic is a `README.md` whose directory still holds another quest. Any
 * other README is what an epic becomes when its last child merges: the epic's
 * own remaining work, executed like any other quest. The root and the
 * milestones are the exception.
 */
export function isEpic(docs: readonly Doc[], doc: Doc): boolean {
	return permanent(doc.path) || docs.some((d) => holds(doc.path, d.path));
}

/**
 * What must finish before `doc`: its `Required` quests, then, for an epic, its
 * children. An epic's `Required` link to one of its children, left from a tree
 * that listed them, counts once.
 */
export function requires(docs: readonly Doc[], doc: Doc): string[] {
	const kids = children(docs, doc);
	const required = entries(doc, "Required")
		.map((entry) => (entry.target === null ? null : rooted(entry.target)))
		.filter((target): target is string => target !== null && !kids.includes(target));
	return [...required, ...kids];
}

/**
 * Strip a `#fragment`, which addresses a place inside a file rather than a
 * different file. Leaving it on made a phantom graph node that no quest could
 * ever match, so a cycle through an anchored link went unreported.
 */
export function withoutFragment(target: string): string {
	const index = target.indexOf("#");
	return index < 0 ? target : target.slice(0, index);
}

/**
 * A Markdown link's repository-relative path, or `null` when its escapes are
 * malformed or it leaves the repository. Strip the fragment before decoding:
 * `%23` is part of the filename, while a literal `#` starts the fragment.
 */
export function resolve(docPath: string, target: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(withoutFragment(target));
	} catch {
		return null;
	}
	const path = target.startsWith("/") ? normalize(decoded.slice(1)) : join(parent(docPath), decoded);
	return escapes(path) ? null : path;
}

/**
 * A root-absolute target as a repository-relative path, or `null` if it is not
 * root-absolute or cannot resolve safely. The rules and cycle walk use the same
 * decoded, normalized path as link validation.
 */
export function rooted(target: string): string | null {
	return target.startsWith("/") ? resolve("", target) : null;
}

/** Nodes whose children are blocks, so an `html` child is block HTML rather than inline. */
const CONTAINERS = new Set(["root", "blockquote", "listItem"]);

/** Block-level nodes, which separate the words of an entry that spans more than one. */
const BLOCKS = new Set(["paragraph", "heading", "blockquote", "list", "listItem", "code", "table", "thematicBreak"]);

/** Markdown's tree as GitHub renders it, for quests and PR bodies alike. */
export function markdown(text: string): Root {
	// GitHub renders strikethrough and tables, and the Rust parser this replaced
	// enabled both. It enabled no other GFM syntax.
	return fromMarkdown(text, {
		extensions: [gfmStrikethrough(), gfmTable()],
		mdastExtensions: [gfmStrikethroughFromMarkdown(), gfmTableFromMarkdown()],
	});
}

/** Parse already-loaded Markdown. `path` stays repository-relative. */
export function parse(path: string, text: string): Doc {
	const tree = markdown(text);
	// Lines as grep sees them: a bare `\r` does not end one, so a CR-only file is
	// one line and none of its headings are literal, which is what grep finds.
	const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
	const definitions = collectDefinitions(tree, text);

	let title: Heading | null = null;
	const headings: Heading[] = [];
	const offLevel: Heading[] = [];
	const links: Link[] = [];
	const found: Entry[] = [];
	let entry: Entry | null = null;
	let section: string | null = null;

	// Depth of nesting, so a sub-list inside an entry does not read as a
	// second entry, and so `fresh` tracks the innermost item.
	let itemDepth = 0;
	// Entries are the flat, top-level list. A bullet nested under a prose
	// lead-in, or one inside a block quote, is illustration - counting it
	// would let `- evidence:` + an indented link become a real blocker.
	let quoteDepth = 0;
	// Nothing but emphasis has been seen since the current item opened, so a
	// link here is the item's opening link. `**[Blocker](/quest/b.md)**` is
	// still an opener; `A customer who justifies [b](/quest/b.md)` is not.
	let fresh = false;
	let heading: { depth: number; line: number; text: string } | null = null;

	const lineOf = (node: Nodes) => node.position?.start.line ?? 1;
	const offsetOf = (node: Nodes) => node.position?.start.offset ?? 0;
	const endOf = (node: Nodes) => node.position?.end.offset ?? text.length;

	const addText = (value: string) => {
		if (heading) {
			// A setext heading's line endings add nothing, so a wrapped title
			// stays on one line in a finding.
			heading.text += value.replace(/\r\n|\r|\n/g, "");
		} else if (entry) {
			entry.text += value;
		}
		if (value.trim() !== "") fresh = false;
	};

	// Anything that is not a list item, an emphasis wrapper, or text ends the
	// run of content an opening link may follow.
	const other = () => {
		if (itemDepth > 0) fresh = false;
	};

	const link = (node: Nodes, target: string, span: [number, number]) => {
		// Reference-style links resolve to their definition, so they carry an
		// edge like any other link. Only a top-level, unquoted item can hold an
		// entry.
		const position: Position =
			itemDepth === 0 ? "prose" : fresh && itemDepth === 1 && quoteDepth === 0 ? "entry" : "inside";
		fresh = false;
		if (position === "entry" && entry) entry.target = target;
		links.push({ line: lineOf(node), section, target, position, span });
	};

	const enter = (node: Nodes) => {
		switch (node.type) {
			case "heading":
				heading = { depth: node.depth, line: lineOf(node), text: "" };
				if (node.depth > 2) other();
				break;
			case "blockquote":
				quoteDepth++;
				fresh = false;
				break;
			case "listItem":
				if (itemDepth === 0 && quoteDepth === 0) {
					entry = {
						line: lineOf(node),
						end: node.position?.end.line ?? lineOf(node),
						section,
						text: "",
						target: null,
					};
				}
				itemDepth++;
				fresh = true;
				break;
			case "link": {
				// The destination follows the text, which may mention it too.
				const last = node.children.at(-1);
				link(node, node.url, [last ? endOf(last) : offsetOf(node), endOf(node)]);
				break;
			}
			case "linkReference": {
				const definition = definitions.get(node.identifier);
				if (definition === undefined) {
					other();
				} else {
					link(node, definition.url, definition.span);
				}
				break;
			}
			case "text":
			case "inlineCode":
				addText(node.value);
				break;
			case "break":
				if (entry) entry.text += " ";
				break;
			// Emphasis wraps an opening link without displacing it, and so does
			// the paragraph a LOOSE list puts around every item: clearing on its
			// START would classify every entry in a blank-line-separated list as
			// mid-sentence prose. Its END does clear, so a link that opens a
			// SECOND paragraph is inside the item, not opening it.
			case "emphasis":
			case "strong":
			case "paragraph":
				break;
			case "code":
				other();
				addText(node.value);
				break;
			case "image":
				other();
				addText(node.alt ?? "");
				break;
			case "imageReference":
				other();
				addText(node.alt ?? "");
				break;
			default:
				other();
		}
	};

	const exit = (node: Nodes) => {
		switch (node.type) {
			// Text is one leaf that `addText` already judged on entry: only
			// non-blank text ends the run an opening link may follow.
			case "text":
			case "inlineCode":
			case "break":
				break;
			case "heading":
				if (heading) {
					const done = heading;
					heading = null;
					const text = done.text.trim();
					// Exact, not trimmed: `rg '^## Required$'` does not match a line
					// with trailing spaces either, and this rule exists precisely so
					// the two can never disagree.
					const parsed: Heading = {
						line: done.line,
						depth: done.depth,
						text,
						literal: lines[done.line - 1] === `${"#".repeat(done.depth)} ${text}`,
					};
					if (done.depth === 1) title = parsed;
					if (done.depth !== 2) offLevel.push(parsed);
					if (done.depth === 2) {
						section = text;
						headings.push(parsed);
					}
					if (done.depth <= 2) {
						itemDepth = 0;
						entry = null;
						fresh = false;
					} else {
						other();
					}
				} else {
					other();
				}
				break;
			case "blockquote":
				quoteDepth = Math.max(0, quoteDepth - 1);
				fresh = false;
				break;
			case "listItem":
				if (itemDepth === 1 && entry) {
					entry.text = collapse(entry.text);
					found.push(entry);
					entry = null;
				}
				itemDepth = Math.max(0, itemDepth - 1);
				fresh = false;
				break;
			case "emphasis":
			case "strong":
				break;
			case "paragraph":
				fresh = false;
				break;
			default:
				other();
		}
	};

	const walk = (node: Nodes, inline: boolean) => {
		// Definitions render as nothing; the links that use them carry their target.
		if (node.type === "definition") return;
		const block = BLOCKS.has(node.type) || (node.type === "html" && !inline);
		if (block && entry && !heading) entry.text += " ";
		enter(node);
		if ("children" in node) {
			const contains = CONTAINERS.has(node.type);
			for (const child of node.children) walk(child, !contains);
		}
		exit(node);
		if (block && entry && !heading) entry.text += " ";
	};

	for (const child of tree.children) walk(child, false);

	return { path, title, headings, offLevel, links, entries: found };
}

/**
 * The first definition of each reference label, which is the one CommonMark
 * uses, with the span its destination is written in: after the label's `]:`.
 */
function collectDefinitions(tree: Root, text: string): Map<string, { url: string; span: [number, number] }> {
	const definitions = new Map<string, { url: string; span: [number, number] }>();
	const visit = (node: Nodes) => {
		if (node.type === "definition" && !definitions.has(node.identifier)) {
			const start = node.position?.start.offset ?? 0;
			const end = node.position?.end.offset ?? text.length;
			definitions.set(node.identifier, { url: node.url, span: [text.indexOf("]:", start) + 2, end] });
		}
		if ("children" in node) for (const child of node.children) visit(child);
	};
	visit(tree);
	return definitions;
}

/**
 * One line of whitespace-separated words, so a wrapped or loosely indented
 * bullet prints the way it renders.
 */
function collapse(text: string): string {
	return text.split(/\s+/).filter(Boolean).join(" ");
}
