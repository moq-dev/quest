import { check, parse, ready } from "quest/core";
import { describe, expect, it } from "vitest";

// The Worker shares the CLI's core. This runs it inside workerd, the runtime
// the Worker deploys to. `tsc -p src/core` is what keeps Node APIs out of it.
describe("quest/core", () => {
	it("checks a tree and finds ready work", () => {
		const docs = [
			parse("quest/README.md", "# Quests\n\n## Goal\n\nShip it.\n"),
			parse("quest/one.md", "# [S] One\n\n## Goal\n\nThe first quest.\n"),
		];
		const paths = new Set(docs.map((doc) => doc.path));
		expect(check(docs, (path) => paths.has(path))).toEqual([]);
		expect(ready(docs)).toEqual(["quest/one.md"]);
	});

	it("reports a quest and an epic that share a path", () => {
		const docs = [
			parse("quest/README.md", "# Quests\n\n## Goal\n\nShip it.\n"),
			parse("quest/one.md", "# [S] One\n\n## Goal\n\nA quest.\n"),
			parse("quest/one/README.md", "# [S] Epic\n\n## Goal\n\nAn epic's remaining work.\n"),
		];
		const paths = new Set(docs.map((doc) => doc.path));
		expect(check(docs, (path) => paths.has(path))).toEqual([
			{
				path: "quest/one.md",
				line: null,
				message: "quest path collides with quest/one/README.md; rename one of these documents",
			},
		]);
	});
});
