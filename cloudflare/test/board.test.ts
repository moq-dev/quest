import { describe, expect, it } from "vitest";
import { finished } from "../scripts/history";
import { render } from "../src/board/markdown";
import { type Board, blobHref, findDoc, findGroup, only, questHref, readBoard, trail } from "../src/board/model";
import type { Project } from "../src/board/project";

const docs: Record<string, string> = {
	"quest/README.md": "# Quests\n\n## Goal\n\nShip it.\n",
	"quest/m0/README.md": "# First release\n\n## Goal\n\nThe *first* release.\n",
	"quest/m0/epic/README.md": "# An epic\n\n## Goal\n\nGrouped work.\n",
	"quest/m0/epic/ready.md": "# [S] Ready quest\n\n## Goal\n\nDo it.\n",
	"quest/m0/epic/blocked.md":
		"# [M] Blocked quest\n\n## Goal\n\nLater.\n\n## Required\n\n- [Ready](/quest/m0/epic/ready.md) - needs it\n",
	"quest/m0/epic/taken.md":
		"# [XL] Taken quest\n\n## Goal\n\nMine.\n\n## Claim\n\n- Jane Doe (github:jdoe) on https://example.com/jdoe/repo since 2026-10-02\n",
	"quest/m0/epic/turned.md": "# [XS] Turned-in quest\n\n## Goal\n\nDone soon.\n",
	"quest/m0/solo.md": "# [L] Solo quest\n\n## Goal\n\nAlone.\n",
	"quest/m0/loose.md": "# [S] Loose quest\n\n## Goal\n\nNo blockers either.\n",
};

function project(overrides: Partial<Project> = {}): Project {
	return {
		name: "demo",
		title: "acme/demo",
		web: "https://example.com/acme/demo",
		commit: "a".repeat(40),
		date: "2026-10-07",
		documents: Object.entries(docs).map(([path, content]) => ({ path, content })),
		completed: [
			{ path: "quest/m0/epic/old.md", title: "[L] Old quest", date: "2026-10-01", commit: "b".repeat(40) },
		],
		changes: [{ quest: "quest/m0/epic/turned.md", author: "@sam", href: "/repos/demo/changes/sam" }],
		issues: [],
		...overrides,
	};
}

const status = (board: Board, path: string) => board.quests.get(path)?.status;

describe("board model", () => {
	const board = readBoard(project());

	it("uses open changes and dependencies, ignoring legacy Claim sections", () => {
		expect(status(board, "quest/m0/epic/ready.md")).toEqual({ kind: "available" });
		expect(status(board, "quest/m0/epic/blocked.md")).toEqual({
			kind: "blocked",
			requires: [{ title: "Ready quest", href: "/repos/demo/quest/m0/epic/ready" }],
		});
		expect(status(board, "quest/m0/epic/taken.md")).toEqual({ kind: "available" });
		expect(status(board, "quest/m0/epic/turned.md")?.kind).toBe("turn-in");
		expect(board.counts).toEqual({ available: 4, pending: 0, blocked: 1, "turn-in": 1, accepted: 0 });
	});

	it("groups milestones and epics by their directories, in path order", () => {
		const [milestone] = board.milestones;
		expect(milestone).toMatchObject({ number: "0", title: "First release", summary: "The first release." });
		expect(milestone.items.map((item) => (item.kind === "quest" ? item.quest.path : item.epic.path))).toEqual([
			"quest/m0/epic/README.md",
			"quest/m0/loose.md",
			"quest/m0/solo.md",
		]);
		expect(trail(board, "quest/m0/epic/ready.md").map((group) => group.title)).toEqual([
			"First release",
			"An epic",
		]);
		expect(trail(board, "quest/m0/epic/README.md").map((group) => group.title)).toEqual(["First release"]);
	});

	it("weights progress by difficulty and counts finished quests from history", () => {
		// Finished: L (5). Open: S 2, M 3, XL 8, XS 1 in the epic; L 5 and S 2 outside it.
		expect(findGroup(board, "quest/m0/epic/README.md")!.progress).toEqual({
			done: 1,
			total: 5,
			weight: 5,
			totalWeight: 19,
		});
		expect(board.milestones[0].progress).toEqual({ done: 1, total: 7, weight: 5, totalWeight: 26 });
		expect(board.finished[0]).toMatchObject({ name: "Old quest", size: "L", milestone: "Milestone 0" });
	});

	it("filters by status, dropping empty epics", () => {
		const items = only(board.milestones[0].items, "blocked");
		expect(items).toHaveLength(1);
		expect(items[0].kind === "epic" && items[0].epic.items.length).toBe(1);
	});

	it("names an epic's page by its branch, not its directory", () => {
		expect(questHref(project(), "quest/m0/epic/README.md")).toBe("/repos/demo/quest/m0/epic/README");
		expect(findDoc(board, "quest/m0/epic/README")?.path).toBe("quest/m0/epic/README.md");
		expect(findDoc(board, "quest/m0/epic")).toBeNull();
	});

	it("encodes each board and forge path segment", () => {
		const source = project();
		const path = "quest/m0/an epic#/name#?%.md";
		expect(questHref(source, path)).toBe("/repos/demo/quest/m0/an%20epic%23/name%23%3F%25");
		expect(questHref(source, "quest/m0/an epic#/README.md")).toBe("/repos/demo/quest/m0/an%20epic%23/README");
		expect(blobHref(source, path)).toBe(
			`https://example.com/acme/demo/blob/${source.commit}/quest/m0/an%20epic%23/name%23%3F%25.md`,
		);
		expect(blobHref(source, path, "#goal")).toBe(
			`https://example.com/acme/demo/blob/${source.commit}/quest/m0/an%20epic%23/name%23%3F%25.md#goal`,
		);
		expect(blobHref(project({ web: null }), path)).toBeNull();
	});
});

describe("quest markdown", () => {
	const known = (path: string) => path in docs;

	it("escapes HTML and drops unsafe links and images", () => {
		const [goal] = render(
			project(),
			"quest/m0/solo.md",
			'# T\n\n## Goal\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1)) ![pic](https://example.com/p.png) <b onclick="x">b</b>\n',
			known,
		);
		expect(goal.heading).toBe("Goal");
		expect(goal.html).not.toContain("<script");
		expect(goal.html).not.toContain("<b ");
		expect(goal.html).not.toContain("javascript:");
		expect(goal.html).not.toContain("<img");
		expect(goal.html).toContain("&#60;script&#62;");
	});

	it("escapes text after an inline raw tag, closed or not", () => {
		for (const tag of ["code", "pre", "kbd", "script"]) {
			for (const close of [`</${tag}>`, ""]) {
				const [goal] = render(
					project(),
					"quest/m0/solo.md",
					`## Goal\n\na <${tag}> <img src=x onerror=alert(1)// ${close}\n\nlater <b>bold</b>\n`,
					known,
				);
				expect(goal.html).not.toMatch(/<(img|b)\b/);
			}
		}
	});

	it("opens quest links on the board and other files where the repository is published", () => {
		const [plan] = render(
			project(),
			"quest/m0/solo.md",
			"## Plan\n\n[epic](/quest/m0/epic/README.md#goal) [ready](epic/ready.md) [docs](../../docs/a.md) [web](https://example.com)\n",
			known,
		);
		expect(plan.html).toContain('href="/repos/demo/quest/m0/epic/README#goal"');
		expect(plan.html).toContain('href="/repos/demo/quest/m0/epic/ready"');
		expect(plan.html).toContain(`href="https://example.com/acme/demo/blob/${project().commit}/docs/a.md"`);
		expect(plan.html).toContain('href="https://example.com"');
		const [unpublished] = render(
			project({ web: null }),
			"quest/m0/solo.md",
			"## Plan\n\n[docs](/docs/a.md)\n",
			known,
		);
		expect(unpublished.html).toBe("<p>docs</p>\n");
	});

	it("keeps fragments on forge links at the snapshot commit", () => {
		const source = project();
		const [plan] = render(source, "quest/m0/solo.md", "## Plan\n\n[docs](/docs/a.md#goal)\n", known);
		expect(plan.html).toContain(`href="https://example.com/acme/demo/blob/${source.commit}/docs/a.md#goal"`);
	});
});

describe("finished quests from history", () => {
	const commit = (sha: string, date: string, ...changes: string[]) => `\0${sha} ${date}\n\n${changes.join("\n")}\n`;
	const titles: Record<string, string> = {
		"old^:quest/a0/epic/done.md": "# [M] Done before the rename\n",
		"plan^:quest/a0/dropped.md": "# [S] Dropped\n",
	};
	const read = (rev: string, path: string) => titles[`${rev}:${path}`];

	it("counts deletions that shipped work, following later directory renames", () => {
		const log = [
			commit("rename", "2026-10-09", "R100\tquest/a0/README.md\tquest/m0/README.md", "M\tsrc/a.ts"),
			commit("plan", "2026-10-08", "D\tquest/a0/dropped.md"),
			commit("old", "2026-10-07", "D\tquest/a0/epic/done.md", "M\tsrc/b.ts", "D\tquest/AGENTS.md"),
		].join("");
		const now = new Set(["quest/README.md", "quest/m0/README.md", "quest/m0/epic/README.md"]);
		expect(finished(log, now, read)).toEqual([
			{ path: "quest/m0/epic/done.md", title: "[M] Done before the rename", date: "2026-10-07", commit: "old" },
		]);
	});

	it("follows a rename made in the same commit that finishes a quest", () => {
		// Git lists changes by path, so the deletion can come before the rename.
		const log = commit(
			"rename",
			"2026-10-09",
			"D\tquest/a0/a.md",
			"R100\tquest/a0/b.md\tquest/m0/b.md",
			"M\tsrc/a.ts",
		);
		const read = () => "# [S] Finished with the rename\n";
		expect(finished(log, new Set(["quest/m0/b.md"]), read).map((c) => c.path)).toEqual(["quest/m0/a.md"]);
	});

	it("skips a quest that still exists, moved too far for Git to pair the rename", () => {
		const log = commit("move", "2026-10-09", "D\tquest/m0/a.md", "A\tquest/m0/epic/a.md", "M\tsrc/a.ts");
		const read = () => "# [S] Moved\n";
		expect(finished(log, new Set(["quest/m0/a.md"]), read)).toEqual([]);
	});
});
