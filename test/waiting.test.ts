import { expect, test } from "vitest";

import {
	type Doc,
	check,
	handBackWaits,
	handedBack,
	parse,
	parseWait,
	unblocked,
	waiting,
	withoutHandBack,
} from "../src/core";

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
			pr: null,
			dependents: 0,
			ready: true,
			waits: [
				{ line: 9, party: "Maintainer", text: "pick a provider." },
				{ line: 10, party: "Hetzner", text: "verify the account." },
			],
		},
		{
			path: "quest/m0/upstream.md",
			pr: null,
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

test("a draft's hand-back items are the maintainer's unless a Waiting item names its party, after any task checkbox", () => {
	expect(
		handBackWaits(
			"Work.\n\n## Waiting\n\n- Codex: out of quota until 15:00 UTC.\n- pick a name,\n  either one.\n" +
				"- [ ] Maintainer: approve the account.\n* [x] moq-dev/moq: a release.\n\n" +
				"## Validation\n\n- Passes.\n\n## Decisions needed\n\n1. Naming: foo or bar?\n",
		),
	).toEqual([
		{ line: 5, party: "Codex", text: "out of quota until 15:00 UTC." },
		{ line: 6, party: "Maintainer", text: "pick a name, either one." },
		{ line: 8, party: "Maintainer", text: "approve the account." },
		{ line: 9, party: "moq-dev/moq", text: "a release." },
		{ line: 17, party: "Maintainer", text: "Naming: foo or bar?" },
	]);
});

test("a draft's hand-back item keeps nested headings and the body's reference definitions, and drops raw HTML", () => {
	expect(
		handBackWaits(
			"[m]: https://example.com\n\n## Waiting\n\n- Maintainer: choose a provider.\n\n  ## Options\n\n  Hetzner or OVH.\n" +
				"- [Maintainer][m]: approve the **account**.\n- <strong>Codex</strong>: out of <!-- c -->quota.\n" +
				'- <span title="a > b">Maintainer</span>: approve.\n',
		),
	).toEqual([
		{ line: 5, party: "Maintainer", text: "choose a provider. Options Hetzner or OVH." },
		{ line: 10, party: "Maintainer", text: "approve the account." },
		{ line: 11, party: "Codex", text: "out of quota." },
		{ line: 12, party: "Maintainer", text: "approve." },
	]);
});

test("a draft's hand-back without items is one maintainer item holding its prose", () => {
	expect(handBackWaits("Work.\r\n\r\nWaiting\r\n-------\r\n\r\nPick a name\r\nfor it.\r\n")).toEqual([
		{ line: 3, party: "Maintainer", text: "Pick a name for it." },
	]);
	expect(handBackWaits("## Waiting\n\n<details>\n<summary>Why</summary>\nPick one.\n</details>\n")).toEqual([
		{ line: 1, party: "Maintainer", text: "the draft hands back without saying what it waits on" },
	]);
	expect(handBackWaits("## Waiting\n\n<details>\n<summary>Why</summary>\n</details>\n\nThen merge.\n")).toEqual([
		{ line: 1, party: "Maintainer", text: "Then merge." },
	]);
	expect(handBackWaits("## Waiting\n")).toEqual([
		{ line: 1, party: "Maintainer", text: "the draft hands back without saying what it waits on" },
	]);
	expect(handBackWaits("Work.\n\n```\n## Waiting\n\n- Maintainer: pick.\n```\n")).toEqual([]);
});

test("drafts rank as the quest they carry, after quests on a tie, and last when they carry none", () => {
	const docs = tree(
		{ "a.md": "\n## Waiting\n\n- Maintainer: pick one.\n", "b.md": "" },
		{ "c.md": "\n## Required\n\n- [B](/quest/m0/b.md)\n" },
	);
	const draft = (url: string, branch: string, body: string) => ({ url, branch, body });
	const found = waiting(docs, [
		draft("https://example.com/pull/1", "quest-plan/x", "## Waiting\n\n- Maintainer: plan it.\n"),
		draft("https://example.com/pull/2", "quest/m0/b", "## Waiting\n\n- Maintainer: pick b.\n"),
		draft("https://example.com/pull/3", "quest/m0/a", "## Waiting\n\n- moq-dev/moq: a release.\n"),
		draft("https://example.com/pull/4", "quest/m0/a", "Ready soon.\n"),
		draft("https://example.com/pull/5", "quest/m9/gone", "## Decisions needed\n\n- Keep it?\n"),
	]);
	expect(found.map((quest) => [quest.pr ?? quest.path, quest.path, quest.dependents, quest.ready])).toEqual([
		["https://example.com/pull/2", "quest/m0/b.md", 1, true],
		["quest/m0/a.md", "quest/m0/a.md", 0, true],
		["https://example.com/pull/1", null, 0, true],
		["https://example.com/pull/5", null, 0, true],
		["https://example.com/pull/3", "quest/m0/a.md", 0, true],
	]);
});
