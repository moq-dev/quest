// A PR body's `## Review` record, which `quest review` writes and `quest status` reads.

import { markdown } from "./doc";

/**
 * Where the body of the first `## Review` section runs: from after its heading's line to the next level-1
 * or level-2 heading's line, or the end. Only top-level headings count, as Markdown parses them, so an
 * example inside a code fence, a list, or a quote is text. Null without one.
 */
export function reviewSection(body: string): { start: number; end: number } | null {
	const lineStart = (offset: number) => body.lastIndexOf("\n", offset - 1) + 1;
	let start: number | undefined;
	for (const node of markdown(body).children) {
		if (node.type !== "heading" || node.depth > 2) continue;
		const from = node.position!.start.offset!;
		if (start !== undefined) return { start, end: lineStart(from) };
		const to = node.position!.end.offset!;
		if (node.depth === 2 && /^##[ \t]+Review[ \t]*$/.test(body.slice(lineStart(from), to)))
			start = body[to] === "\r" ? to + 1 : to;
	}
	return start === undefined ? null : { start, end: body.length };
}
