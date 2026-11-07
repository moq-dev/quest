import { describe, expect, it } from "vitest";
import { readBoard } from "../src/board/model";
import type { Project } from "../src/board/project";
import { QuestMap, chart } from "../src/map";

const docs: Record<string, string> = {
	"quest/README.md": "# Quests\n\n## Goal\n\nShip it.\n",
	"quest/m0/README.md": "# First release\n\n## Goal\n\nShip.\n",
	"quest/m0/epic/README.md": "# An epic\n\n## Goal\n\nGrouped.\n",
	// The blocked quest sorts first by path; the map still puts it after its blocker.
	"quest/m0/epic/later.md":
		"# [M] Later\n\n## Goal\n\nLater.\n\n## Required\n\n- [First](/quest/m0/epic/start.md) - needs it\n",
	"quest/m0/epic/start.md": "# [S] First\n\n## Goal\n\nFirst.\n",
	"quest/m0/epic/other.md": "# [XS] Other\n\n## Goal\n\nOther.\n",
	"quest/m0/solo.md": "# [L] Solo\n\n## Goal\n\nAlone.\n",
	// Requiring an epic puts a quest after everything the epic still holds.
	"quest/m0/finale.md":
		"# [XL] Finale\n\n## Goal\n\nLast.\n\n## Required\n\n- [Epic](/quest/m0/epic/README.md) - all of it\n",
};

const project: Project = {
	name: "demo",
	title: "acme/demo",
	web: "https://example.com/acme/demo",
	commit: "a".repeat(40),
	date: "2026-10-07",
	documents: Object.entries(docs).map(([path, content]) => ({ path, content })),
	completed: [],
	changes: [],
	issues: [],
};

describe("quest map", () => {
	const [region] = chart(readBoard(project));

	it("links each milestone to its section of the board", () => {
		expect(region.href).toBe("/repos/demo#m0");
	});

	it("draws epics and the milestone's own quests as paths in path order", () => {
		expect(region.paths.map((path) => path.title)).toEqual(["An epic", "Main path"]);
		expect(region.paths[0].href).toBe("/repos/demo/quest/m0/epic/README");
	});

	it("orders each path by what it requires, then by path", () => {
		const titles = region.paths.map((path) => path.waypoints.map((quest) => quest.title));
		expect(titles).toEqual([
			["Other", "First", "Later"],
			["Solo", "Finale"],
		]);
	});

	it("links waypoints to their board pages", () => {
		expect(region.paths[1].waypoints[0].href).toBe("/repos/demo/quest/m0/solo");
	});

	it("links to the board without a web address", () => {
		const [offline] = chart(readBoard({ ...project, web: null }));
		expect(offline.paths[0].href).toBe("/repos/demo/quest/m0/epic/README");
		expect(offline.paths[1].waypoints[0].href).toBe("/repos/demo/quest/m0/solo");
	});
});

describe("waypoint status", () => {
	const claimed = "\n## Claim\n\n- Sam (github:sam) on https://example.com/sam/demo since 2026-10-07\n";
	const render = async (overrides: Partial<Project>) =>
		String(await QuestMap({ board: readBoard({ ...project, ...overrides }) }));

	it("uses the format's terms, listing what a blocked quest requires", async () => {
		const html = await render({
			documents: [
				...project.documents.filter((doc) => doc.path !== "quest/m0/solo.md"),
				{ path: "quest/m0/solo.md", content: `${docs["quest/m0/solo.md"]}${claimed}` },
			],
		});
		const statuses = [...html.matchAll(/class="waypoint-status [^"]*">([^<]*)</g)].map((match) => match[1]);
		expect(statuses.sort()).toEqual(["blocked", "blocked", "ready", "ready", "ready"]);
		expect(html).toContain('title="Later: blocked\nRequired: First" aria-label="Later, size M, blocked"');
		expect(html).not.toMatch(/Available|Requires|Accepted|turn in|Elite/);
	});

	it("shows a quest with an open change as in review", async () => {
		const html = await render({ changes: [{ quest: "quest/m0/epic/later.md", author: "@sam", href: "/x" }] });
		expect(html).toContain('title="Later: in review"');
	});

	it("survives a Required cycle", async () => {
		const html = await render({
			documents: [
				...project.documents.filter((doc) => doc.path !== "quest/m0/epic/start.md"),
				{
					path: "quest/m0/epic/start.md",
					content:
						"# [S] First\n\n## Goal\n\nFirst.\n\n## Required\n\n- [Later](/quest/m0/epic/later.md) - loop\n",
				},
			],
		});
		expect(html).toContain('aria-label="First, size S, blocked"');
	});

	it("escapes quest titles", async () => {
		const html = await render({
			documents: [
				...project.documents.filter((doc) => doc.path !== "quest/m0/solo.md"),
				{ path: "quest/m0/solo.md", content: '# [L] Keep a < b & "c" > d\n\n## Goal\n\nAlone.\n' },
			],
		});
		expect(html).toContain('title="Keep a &lt; b &amp; &quot;c&quot; &gt; d: ready"');
		expect(html).toContain("Keep a &lt; b &amp; &quot;c&quot; &gt; d</span>");
	});
});
