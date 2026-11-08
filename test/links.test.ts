import { describe, expect, test } from "vitest";

import { resolve, rooted } from "../src/core";
import { ONE, Tree } from "./fixture";

function linked(name: string, target: string): Tree {
	return new Tree()
		.write("quest/README.md", "# Quests\n\n## Goal\n\nShip it.\n")
		.write(`quest/${name}`, ONE)
		.write("quest/two.md", `# [S] Two\n\n## Goal\n\nLater.\n\n## Required\n\n- [One](${target})\n`);
}

describe("percent-encoded Markdown links", () => {
	test.each([
		["with space.md", "/quest/with%20space.md"],
		["x#y.md", "/quest/x%23y.md#sec"],
		["100%.md", "/quest/100%25.md"],
		["x%23y.md", "/quest/x%2523y.md"],
		["café.md", "/quest/caf%C3%A9.md"],
		["one.md", "/quest%2Fone.md"],
	])("validation and dependency graph resolve %s", (name, target) => {
		const t = linked(name, target);
		t.append("quest/two.md", `\n## Closes\n\n- [One](${target})\n\n## Related\n\n- [One](${target})\n`);
		t.append(`quest/${name}`, `\n## Plan\n\n[Self](${target})\n`);
		t.accepts();
		expect(t.ready()).toEqual([`quest/${name}`]);
		expect(t.blockers("quest/two.md")).toEqual([`quest/${name}`]);
		expect(rooted(target)).toBe(`quest/${name}`);
	});

	test("angle-bracket spaces still resolve without percent encoding", () => {
		linked("with space.md", "</quest/with space.md>").accepts();
	});

	test.each(["100%.md", "bad%2.md", "bad%GG.md", "bad%FF.md"])(
		"malformed escapes fail even if the literal file exists: %s",
		(name) => {
			const target = `/quest/${name}`;
			linked(name, target).rejects(`link does not resolve: ${target}`);
			expect(rooted(target)).toBeNull();
		},
	);

	test("fragment escapes are kept separate from filename escapes", () => {
		expect(resolve("quest/from.md", "x%23y.md#bad%")).toBe("quest/x#y.md");
	});

	test.each(["/%2E%2E/README.md", "/quest/%2E%2E/%2E%2E/README.md", "/%2Fquest/one.md"])(
		"encoded traversal cannot escape the repository: %s",
		(target) => {
			const t = linked("one.md", "/quest/one.md").write("README.md", "Outside the quest tree.");
			t.append("quest/one.md", `\n## Plan\n\n[Escape](${target})\n`);
			t.rejects(`link does not resolve: ${target}`);
			expect(rooted(target)).toBeNull();
		},
	);

	test("relative encoded separators and traversal resolve inside the repository", () => {
		expect(resolve("quest/nested/from.md", "%2E%2E%2Fone.md")).toBe("quest/one.md");
		expect(resolve("quest/from.md", "%2E%2E%2F%2E%2E%2FREADME.md")).toBeNull();
	});

	test("encoded targets still identify duplicate dependencies and cycles", () => {
		const target = "/quest/x%23y.md#sec";
		const t = linked("x#y.md", target);
		t.append("quest/two.md", "- [Same](/quest%2Fx%23y.md)\n");
		t.rejects("requires /quest%2Fx%23y.md twice");
		t.append("quest/x#y.md", "\n## Required\n\n- [Two](/quest/two.md)\n");
		t.rejects("Required cycle:");
	});
});
