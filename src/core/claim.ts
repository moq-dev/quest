// How a quest's PR and branch say whose move it is. A draft is its starter's
// claim until its body hands it back with a `## Waiting` section, and a branch
// whose work merged holds nothing (the guide's Execution section); the CLI and
// the Worker read both the same way.

import type { Nodes, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";

import { MAINTAINER, type Wait, parseWait } from "./waiting";

// `Decisions needed` is the heading `Waiting` replaced; drafts opened before it
// still hand back with it.
const HAND_BACK = /^(?:Waiting|Decisions needed)$/i;

// Nodes whose rendered text a reader sees as separate from the next.
const BLOCKS = new Set(["blockquote", "code", "heading", "list", "listItem", "paragraph", "table", "tableRow"]);

/** A node's rendered text, as a reader sees it, before whitespace is collapsed. */
function text(node: Nodes): string {
	const gap = BLOCKS.has(node.type) ? " " : "";
	if (node.type === "break") return " ";
	// Tags and comments render as nothing, so `<strong>Maintainer</strong>:` names the maintainer, as the quest
	// parser reads it, while a block such as `<p>Approve it.</p>` keeps the text a reader sees.
	if (node.type === "html") return node.value.replace(/<!--[\s\S]*?-->|<[^>]*>/g, "");
	if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
	if ("value" in node) return node.value + gap;
	return "children" in node ? node.children.map(text).join("") + gap : "";
}

/** One hand-back section of a PR body. */
interface HandBack {
	/** The start of its heading's line. */
	start: number;
	/** The next level-1 or level-2 heading's line, or the body's end. */
	end: number;
	/** Its heading is `Waiting`, whose items open with their party, rather than the older `Decisions needed`. */
	waiting: boolean;
	/** The top-level nodes after its heading. */
	nodes: RootContent[];
}

/**
 * Each hand-back section in a PR body: from the start of its `## Waiting` (or
 * older `## Decisions needed`) heading's line to the next level-1 or level-2
 * heading. Only top-level headings count, as Markdown parses them, so an
 * example inside a code fence, a list, or a quote is text.
 */
function handBacks(body: string): HandBack[] {
	const sections: HandBack[] = [];
	let open: Omit<HandBack, "end"> | undefined;
	for (const node of fromMarkdown(body).children) {
		if (node.type !== "heading" || node.depth > 2) {
			open?.nodes.push(node);
			continue;
		}
		const offset = node.position?.start.offset ?? 0;
		const line = body.lastIndexOf("\n", offset - 1) + 1;
		if (open !== undefined) sections.push({ ...open, end: line });
		const title = text(node).trim();
		open =
			node.depth === 2 && HAND_BACK.test(title)
				? { start: line, waiting: /^waiting$/i.test(title), nodes: [] }
				: undefined;
	}
	if (open !== undefined) sections.push({ ...open, end: body.length });
	return sections;
}

/** Whether a PR body hands its draft back to the maintainer; only the heading's presence matters. */
export function handedBack(body: string): boolean {
	return handBacks(body).length > 0;
}

/**
 * What a PR body hands back: one wait per item of each hand-back section's
 * top-level lists, with lines counted in `body`. A draft hands back to the
 * maintainer, so an item that names no party is theirs, as is every
 * `Decisions needed` item, whose format predates parties. A section without
 * items still hands the draft back, so it reads as one maintainer item
 * holding its prose.
 */
export function handBackWaits(body: string): Wait[] {
	const found: Wait[] = [];
	const collapse = (value: string) => value.replace(/\s+/g, " ").trim();
	for (const { start, waiting, nodes } of handBacks(body)) {
		const items = nodes
			.filter((node) => node.type === "list")
			.flatMap((list) => list.children)
			.map((item): Wait => {
				const entry = { line: item.position?.start.line ?? 1, text: collapse(text(item)) };
				return (waiting ? parseWait(entry) : null) ?? { ...entry, party: MAINTAINER };
			});
		if (items.length === 0)
			items.push({
				line: body.slice(0, start).split("\n").length,
				party: MAINTAINER,
				text: collapse(nodes.map(text).join(" ")) || "the draft hands back without saying what it waits on",
			});
		found.push(...items);
	}
	return found;
}

/** `body` without its hand-back sections, which `quest ready` drops as it marks a draft ready. */
export function withoutHandBack(body: string): string {
	let kept = "";
	let from = 0;
	for (const { start, end } of handBacks(body)) {
		kept += body.slice(from, start);
		from = end;
	}
	return (kept + body.slice(from)).trimEnd();
}

/** A closed PR from a quest's branch: the commit it ended at, and whether it merged. */
export interface ClosedPull {
	head: string;
	merged: boolean;
}

/**
 * The PR that landed a quest branch at `tip`: one from it that merged with
 * `tip` as its head, so the branch holds no claim. One whose PR closed unmerged
 * still holds its quest, since that work may be wanted back, and so does one
 * with commits pushed after its merge. The CLI and the Worker share this rule.
 */
export function landed<P extends ClosedPull>(tip: string, pulls: Iterable<P>): P | undefined {
	for (const pull of pulls) if (pull.merged && pull.head === tip) return pull;
	return undefined;
}
