import { expect, test } from "vitest";

import { type Doc, blockers, check, owner, parse, ready, renderBlocker, unblocked, waiting } from "../src/core";

/** A valid tree: each spec quest with its blockers, and the READMEs its directories need as epics. */
function graph(spec: Record<string, string[]>, milestones = ["m0"]): Doc[] {
	const epics = new Set(["quest/README.md", ...milestones.map((name) => `quest/${name}/README.md`)]);
	for (const name of Object.keys(spec)) {
		for (let path = `quest/${name}`; path !== "quest/README.md";) {
			path = `${owner(path)}/README.md`;
			epics.add(path);
		}
	}
	const paths = new Set([...epics, ...Object.keys(spec).map((name) => `quest/${name}`)]);
	return [...paths].map((path) => {
		const dependencies = (spec[path.slice(6)] ?? []).map((name) => `quest/${name}`);
		return parse(
			path,
			`# ${epics.has(path) ? "Epic" : "[S] Work"}\n\n## Goal\n\nWork.\n` +
				(dependencies.length
					? `\n## Required\n\n${dependencies.map((dep) => `- [Work](/${dep})`).join("\n")}\n`
					: ""),
		);
	});
}

test("ranks chains ahead of zero-impact work without changing ready", () => {
	const docs = graph({ "m0/zero.md": [], "m0/a.md": [], "m0/b.md": ["m0/a.md"], "m0/c.md": ["m0/b.md"] });
	expect(ready(docs)).toEqual(["quest/m0/a.md", "quest/m0/zero.md"]);
	expect(unblocked(docs)).toEqual([
		{ path: "quest/m0/a.md", dependents: 2 },
		{ path: "quest/m0/zero.md", dependents: 0 },
	]);
});

test("deduplicates diamonds and counts work that still has another prerequisite", () => {
	const docs = graph({
		"m0/a.md": [],
		"m0/other.md": [],
		"m0/b.md": ["m0/a.md", "m0/other.md"],
		"m0/c.md": ["m0/a.md"],
		"m0/d.md": ["m0/b.md", "m0/c.md"],
	});
	expect(unblocked(docs)).toEqual([
		{ path: "quest/m0/a.md", dependents: 3 },
		{ path: "quest/m0/other.md", dependents: 2 },
	]);
});

test("does not score membership, but reaches real dependents of nested epics", () => {
	const docs = graph({
		"m0/epic/nested/a.md": [],
		"m0/epic/nested/b.md": ["m0/epic/nested/a.md"],
		"m0/epic/zero.md": [],
		"m0/outside.md": ["m0/epic/README.md"],
	});
	expect(unblocked(docs)).toEqual([
		{ path: "quest/m0/epic/nested/a.md", dependents: 2 },
		{ path: "quest/m0/epic/zero.md", dependents: 1 },
	]);
	const membership = graph({ "m0/epic/nested/a.md": [], "m0/epic/zero.md": [] });
	expect(unblocked(membership).map((quest) => quest.dependents)).toEqual([0, 0]);
});

test("an epic's real prerequisites hold back its children", () => {
	const docs = graph({
		"m0/a.md": [],
		"m0/epic/child.md": [],
		"m0/epic/README.md": ["m0/a.md"],
		"m0/outside.md": ["m0/epic/README.md"],
	});
	// The epic gates child.md, so only a.md is ready, and it counts child.md too.
	expect(unblocked(docs)).toEqual([{ path: "quest/m0/a.md", dependents: 3 }]);
});

test("milestone order wins over impact, counting later-milestone dependents", () => {
	const docs = graph(
		{
			"m0/early.md": [],
			"m1/later.md": [],
			"m1/a.md": ["m1/later.md"],
			"m1/b.md": ["m1/later.md"],
			"m1/c.md": ["m0/early.md"],
		},
		["m0", "m1"],
	);
	expect(unblocked(docs)).toEqual([
		{ path: "quest/m0/early.md", dependents: 1 },
		{ path: "quest/m1/later.md", dependents: 2 },
	]);
	expect(unblocked(docs.slice().reverse())).toEqual(unblocked(docs));
	// Milestones rank in path order, which compares their numbers by value.
	const numbered = graph({ "m10/a.md": [], "m2/b.md": [] }, ["m10", "m2"]);
	expect(unblocked(numbered).map((quest) => quest.path)).toEqual(["quest/m2/b.md", "quest/m10/a.md"]);
});

test("breaks ties in path order and treats a completed epic as work", () => {
	const docs = graph({ "m0/z.md": [], "m0/finished/README.md": [], "m0/a.md": [] });
	expect(unblocked(docs)).toEqual(ready(docs).map((path) => ({ path, dependents: 0 })));
	expect(unblocked(docs).map((quest) => quest.path)).toEqual([
		"quest/m0/a.md",
		"quest/m0/finished/README.md",
		"quest/m0/z.md",
	]);
});

test("rejects invalid graphs rather than emitting a plausible ranking", () => {
	expect(() => unblocked(graph({ "m0/a.md": ["m0/b.md"], "m0/b.md": ["m0/a.md"] }))).toThrow("Required cycle");
	expect(() => unblocked(graph({ "m0/a.md": ["m0/missing.md"] }))).toThrow("not a quest document");
});

test("an epic's Required gates every quest under it, two levels down and under a milestone", () => {
	const docs = graph(
		{
			"m0/cut.md": [],
			"m1/README.md": ["m0/cut.md"],
			"m1/a.md": [],
			"m1/epic/nested/b.md": [],
			"m2/epic/README.md": ["m0/cut.md"],
			"m2/epic/deep/c.md": [],
			"m2/free.md": [],
		},
		["m0", "m1", "m2"],
	);
	expect(ready(docs)).toEqual(["quest/m0/cut.md", "quest/m2/free.md"]);
	expect(waiting(docs)).toEqual([]);
	// m1 holds back a.md, its epic, nested, and b.md; m2's epic holds back deep and c.md.
	expect(unblocked(docs)).toEqual([
		{ path: "quest/m0/cut.md", dependents: 7 },
		{ path: "quest/m2/free.md", dependents: 0 },
	]);
	const ungated = docs.map((doc) =>
		doc.path === "quest/m1/README.md" ? parse(doc.path, "# Epic\n\n## Goal\n\nWork.\n") : doc,
	);
	expect(ready(ungated)).toContain("quest/m1/epic/nested/b.md");
});

test("blockers names the gating ancestor and its chain", () => {
	const docs = graph({ "m0/cut.md": [], "m0/epic/README.md": ["m0/cut.md"], "m0/epic/inner/a.md": [] });
	const doc = docs.find((d) => d.path === "quest/m0/epic/inner/a.md")!;
	expect(blockers(docs, doc).flatMap((b) => renderBlocker(b))).toEqual([
		"quest/m0/epic/README.md",
		"  quest/m0/cut.md",
	]);
});

test("a blocker waiting on a quest under the epic requiring it is a cycle", () => {
	const docs = graph({ "m0/x.md": ["m0/epic/a.md"], "m0/epic/README.md": ["m0/x.md"], "m0/epic/a.md": [] });
	expect(check(docs, () => true).some((f) => f.message.startsWith("Required cycle"))).toBe(true);
});
