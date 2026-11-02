// How a quest's PR and branch say whose move it is. A draft is its starter's
// claim until its body hands it back with a `## Waiting` section, and a branch
// whose work merged holds nothing (the guide's Execution section); the CLI and
// the Worker read both the same way.

import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";

// `Decisions needed` is the heading `Waiting` replaced; drafts opened before it
// still hand back with it.
const HAND_BACK = /^(?:Waiting|Decisions needed)$/i;

/** A heading's rendered text. */
function text(node: Nodes): string {
	if ("value" in node) return node.value;
	return "children" in node ? node.children.map(text).join("") : "";
}

/**
 * The source offsets of each hand-back section in a PR body: from the start of
 * its `## Waiting` (or older `## Decisions needed`) heading's line to the next
 * level-1 or level-2 heading. Only top-level headings count, as Markdown parses
 * them, so an example inside a code fence, a list, or a quote is text.
 */
function handBacks(body: string): [number, number][] {
	const sections: [number, number][] = [];
	let open: number | undefined;
	for (const node of fromMarkdown(body).children) {
		if (node.type !== "heading" || node.depth > 2) continue;
		const offset = node.position?.start.offset ?? 0;
		const line = body.lastIndexOf("\n", offset - 1) + 1;
		if (open !== undefined) sections.push([open, line]);
		open = node.depth === 2 && HAND_BACK.test(text(node).trim()) ? line : undefined;
	}
	if (open !== undefined) sections.push([open, body.length]);
	return sections;
}

/** Whether a PR body hands its draft back to the maintainer; only the heading's presence matters. */
export function handedBack(body: string): boolean {
	return handBacks(body).length > 0;
}

/** `body` without its hand-back sections, which `quest ready` drops as it marks a draft ready. */
export function withoutHandBack(body: string): string {
	let kept = "";
	let from = 0;
	for (const [start, end] of handBacks(body)) {
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
