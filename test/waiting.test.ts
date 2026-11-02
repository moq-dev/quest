import { expect, test } from "vitest";

import { type Doc, check, handedBack, parse, parseWait, unblocked, waiting, withoutHandBack } from "../src/core";

const ROOT = "# Quests\n\n## Goal\n\nAll.\n\n## Required\n\n- [m0](/quest/m0/README.md)\n- [m1](/quest/m1/README.md)\n";

/** A tree of two milestones, each listing its quests. */
function tree(m0: Record<string, string>, m1: Record<string, string> = {}): Doc[] {
	const milestone = (name: string, quests: Record<string, string>) => [
		parse(
			`quest/${name}/README.md`,
			`# ${name}\n\n## Goal\n\nWork.\n` +
				(Object.keys(quests).length
					? `\n## Required\n\n${Object.keys(quests)
							.map((q) => `- [${q}](/quest/${name}/${q})`)
							.join("\n")}\n`
					: ""),
		),
		...Object.entries(quests).map(([q, body]) =>
			parse(`quest/${name}/${q}`, `# [S] ${q}\n\n## Goal\n\nWork.\n${body}`),
		),
	];
	return [parse("quest/README.md", ROOT), ...milestone("m0", m0), ...milestone("m1", m1)];
}

test("a wait opens with its party", () => {
	const doc = parse(
		"quest/m0/a.md",
		"# [S] A\n\n## Goal\n\nA.\n\n## Waiting\n\n- Maintainer: open the account,\n  then check `GET /server`.\n- moq-dev/moq: a release carries the fix.\n- No party is named here\n- This sentence runs on far too long before it reaches a colon: so it is prose\n",
	);
	const [account, release, none, prose] = doc.entries.map(parseWait);
	expect(account).toEqual({ line: 9, party: "Maintainer", text: "open the account, then check GET /server." });
	expect(release).toMatchObject({ party: "moq-dev/moq", text: "a release carries the fix." });
	expect(none).toBeNull();
	expect(prose).toBeNull();
});

test("check rejects a wait without a party and an empty section", () => {
	const docs = tree({ "a.md": "\n## Waiting\n\n- pick a name\n", "b.md": "\n## Waiting\n" });
	expect(check(docs, () => true).map((f) => `${f.path}:${f.line}: ${f.message}`)).toEqual([
		"quest/m0/a.md:9: '## Waiting' item must open with who acts, as 'Maintainer: ...' or '<party>: ...'",
		"quest/m0/b.md:7: '## Waiting' is empty; remove the heading with its last entry",
	]);
});

test("lists the maintainer's waits first, then by milestone and impact", () => {
	const docs = tree(
		{
			"upstream.md": "\n## Waiting\n\n- moq-dev/moq: a release.\n",
			"plain.md": "",
			"later.md": "\n## Required\n\n- [Upstream](/quest/m0/upstream.md)\n",
		},
		{ "decide.md": "\n## Waiting\n\n- Maintainer: pick a provider.\n- Hetzner: verify the account.\n" },
	);
	expect(waiting(docs)).toEqual([
		{
			path: "quest/m1/decide.md",
			dependents: 0,
			ready: true,
			waits: [
				{ line: 9, party: "Maintainer", text: "pick a provider." },
				{ line: 10, party: "Hetzner", text: "verify the account." },
			],
		},
		{
			path: "quest/m0/upstream.md",
			dependents: 1,
			ready: true,
			waits: [{ line: 9, party: "moq-dev/moq", text: "a release." }],
		},
	]);
});

test("ties keep the tree's priority order, as unblocked does", () => {
	// The CLI loads documents by path, so a.md comes first.
	const docs = tree({
		"z.md": "\n## Waiting\n\n- Maintainer: pick one.\n",
		"a.md": "\n## Waiting\n\n- Maintainer: pick another.\n",
	}).sort((x, y) => x.path.localeCompare(y.path));
	expect(unblocked(docs).map((quest) => quest.path)).toEqual(["quest/m0/z.md", "quest/m0/a.md"]);
	expect(waiting(docs).map((quest) => quest.path)).toEqual(["quest/m0/z.md", "quest/m0/a.md"]);
});

test("a draft hands back with Waiting, or the Decisions needed heading it replaced", () => {
	expect(handedBack("Work.\n\n## Waiting\n\n- Maintainer: pick one.\n")).toBe(true);
	expect(handedBack("Work.\r\n\r\n## Decisions needed\r\n\r\n1. Pick one.\r\n")).toBe(true);
	expect(handedBack("Work.\n\n### Waiting\n\nNot a hand-back.\n")).toBe(false);
	expect(handedBack("Waiting on CI.\n")).toBe(false);
});

test("a hand-back heading inside a fence, list, or quote is an example, not a hand-back", () => {
	expect(handedBack("Docs.\n\n````markdown\n## Waiting\n\n- Maintainer: pick.\n````\n")).toBe(false);
	expect(handedBack("Docs.\n\n~~~\n## Decisions needed\n~~~\n")).toBe(false);
	expect(handedBack("- ## Waiting\n\n> ## Waiting\n")).toBe(false);
});

test("withoutHandBack keeps fenced examples and drops fenced text inside a hand-back", () => {
	const example = "Docs.\n\n```markdown\n## Waiting\n\n- Maintainer: pick.\n```\n\n## Validation\n\nPasses.";
	expect(withoutHandBack(example)).toBe(example);
	expect(withoutHandBack("Work.\n\n## Waiting\n\n```\n## Not a heading\n```\n\n## Validation\n\nPasses.")).toBe(
		"Work.\n\n## Validation\n\nPasses.",
	);
});
