import { describe, expect, it } from "vitest";
import { render, rewrite } from "../src/board/markdown";
import { readBoard } from "../src/board/model";
import type { Project } from "../src/board/project";

const project: Project = {
	name: "demo",
	title: "acme/demo",
	web: "https://example.com/acme/demo",
	commit: "a".repeat(40),
	date: "2026-10-07",
	documents: [
		{ path: "quest/README.md", content: "# Quests\n\n## Goal\n\nShip it.\n" },
		{ path: "quest/x#y.md", content: "# [S] One\n\n## Goal\n\nFirst.\n" },
		{
			path: "quest/two.md",
			content: "# [S] Two\n\n## Goal\n\nLater.\n\n## Required\n\n- [One](/quest/x%23y.md#goal)\n",
		},
	],
	completed: [],
	changes: [],
	issues: [],
};

describe("decoded board Markdown links", () => {
	it.each([
		["/quest/with%20space.md", "quest/with space.md", "/repos/demo/quest/with%20space"],
		["x%23y.md#sec", "quest/x#y.md", "/repos/demo/quest/x%23y#sec"],
		["/quest/100%25.md", "quest/100%.md", "/repos/demo/quest/100%25"],
		["/quest/x%2523y.md", "quest/x%23y.md", "/repos/demo/quest/x%2523y"],
		["/quest%2Fone.md", "quest/one.md", "/repos/demo/quest/one"],
	])("opens the decoded quest for %s", (target, path, expected) => {
		expect(rewrite(project, "quest/from.md", target, (candidate) => candidate === path)).toBe(expected);
	});

	it("encodes literal forge filenames while preserving the original fragment", () => {
		expect(rewrite(project, "quest/from.md", "../docs/x%23y%25.md#sec", () => false)).toBe(
			`https://example.com/acme/demo/blob/${project.commit}/docs/x%23y%25.md#sec`,
		);
	});

	it.each(["/quest/100%.md", "/quest/bad%FF.md", "/%2E%2E/README.md", "/%2Fquest/one.md"])(
		"drops links that cannot resolve safely: %s",
		(target) => {
			expect(rewrite(project, "quest/from.md", target, () => true)).toBeNull();
			const [plan] = render(project, "quest/from.md", `## Plan\n\n[Name](${target})\n`, () => true);
			expect(plan.html).toBe("<p>Name</p>\n");
		},
	);

	it("renders encoded quest links and derives the same dependency status", () => {
		const board = readBoard(project);
		const [required] = render(project, "quest/two.md", project.documents[2].content, (path) =>
			board.docs.has(path),
		).filter((section) => section.heading === "Required");
		expect(required.html).toContain('href="/repos/demo/quest/x%23y#goal"');
		expect(board.quests.get("quest/x#y.md")?.status).toEqual({ kind: "available" });
		expect(board.quests.get("quest/two.md")?.status).toEqual({
			kind: "blocked",
			requires: [{ title: "One", href: "/repos/demo/quest/x%23y" }],
		});
	});
});
