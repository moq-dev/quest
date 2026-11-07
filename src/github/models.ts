// A pull request body's `## Models` record, which names the PR's size and each session that implemented it.

const SECTION = /^## Models[ \t]*\r?$/m;

/** Where `body`'s `## Models` section runs, after its heading, or null without one. */
function section(body: string): { start: number; end: number } | null {
	const heading = SECTION.exec(body);
	if (!heading) return null;
	const start = heading.index + heading[0].length;
	const next = /^## /m.exec(body.slice(start));
	return { start, end: next ? start + next.index : body.length };
}

/** The `Implementer:` items of `body`'s `## Models` section, each as its line without the bullet. */
export function implementers(body: string): string[] {
	const found = section(body);
	if (!found) return [];
	return body
		.slice(found.start, found.end)
		.split(/\r?\n/)
		.flatMap((line) => /^- (Implementer: .+?)\s*$/.exec(line)?.[1] ?? []);
}

/**
 * What `body`'s `## Models` section records: each `Size:` item's whole value, even a blank or malformed one, and each
 * `Implementer: <harness>, <model>, <effort> effort` item with the model it names, or null when it names none.
 * The caller checks only the fields it uses, so a flag that replaces one is not blocked by a malformed one.
 */
export function recorded(body: string): { sizes: string[]; implementers: { item: string; model: string | null }[] } {
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
			.map((item) => ({ item, model: item.slice("Implementer:".length).split(",")[1]?.trim() || null })),
	};
}

/** `body` with `line` as an item of its `## Models` section, which it gains when it has none. */
export function withModels(body: string, line: string): string {
	const item = `- ${line}`;
	if (body.split(/\r?\n/).some((each) => each.trim() === item)) return body;
	const found = section(body);
	if (!found) return `${body.trimEnd()}\n\n## Models\n\n${item}\n`;
	const { start, end } = found;
	const gap = body.slice(start, end).trim() ? "\n" : "\n\n";
	return `${body.slice(0, end).trimEnd()}${gap}${item}\n${end < body.length ? "\n" : ""}${body.slice(end)}`;
}
