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
 * The size and implementing models `body`'s `## Models` section records: its `Size:` item, or null, and
 * the model each `Implementer: <harness>, <model>, <effort> effort` item names, `unknown` included.
 * An `Implementer:` item that names no model is an error, never a session to ignore.
 */
export function recorded(body: string): { size: string | null; models: string[] } {
	const found = section(body);
	if (!found) return { size: null, models: [] };
	const items = body
		.slice(found.start, found.end)
		.split(/\r?\n/)
		.map((line) => line.replace(/^\s*[-*]\s+/, "").trim());
	const size = items.flatMap((item) => /^Size:\s*(\S+)$/.exec(item)?.[1] ?? []);
	if (size.length > 1) throw new Error(`the PR's ## Models record names ${size.length} sizes`);
	const models = items
		.filter((item) => item.startsWith("Implementer:"))
		.map((item) => {
			const model = item.slice("Implementer:".length).split(",")[1]?.trim();
			if (!model) throw new Error(`the PR's ## Models record names no model in: ${item}`);
			return model;
		});
	return { size: size[0] ?? null, models };
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
