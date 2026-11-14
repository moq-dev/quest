import { expect, test } from "vitest";

import { ALWAYS_HIGH, matches, parseRiskFile, patternError, recordedRisk, riskier } from "../src/core";

test("a pattern is a path from the root whose * stays in a segment and whose ** spans segments", () => {
	const cases: [string, string, boolean][] = [
		// A plain path matches itself and everything under it, with or without a trailing slash.
		["src/billing", "src/billing", true],
		["src/billing", "src/billing/charge.ts", true],
		["src/billing/", "src/billing/charge.ts", true],
		["src/billing", "src/billing-old/charge.ts", false],
		["src/billing", "lib/src/billing/charge.ts", false],
		// `*` and `?` stay within one segment, from the root.
		["*.md", "RISK.md", true],
		["*.md", "docs/guide.md", false],
		["src/*/wire.ts", "src/moq/wire.ts", true],
		["src/*/wire.ts", "src/moq/lite/wire.ts", false],
		["v?.proto", "v2.proto", true],
		["v?.proto", "v10.proto", false],
		// `**` is any number of segments, none included.
		["**/*.proto", "wire.proto", true],
		["**/*.proto", "a/b/wire.proto", true],
		["src/**/wire.ts", "src/wire.ts", true],
		["src/**/wire.ts", "src/a/b/wire.ts", true],
		["src/**", "src", true],
		["src/**", "src/a/b", true],
		["**", "anything/at/all", true],
		// Regular expression characters are literal.
		["a.b+c", "a.b+c", true],
		["a.b+c", "aXbbc", false],
	];
	for (const [pattern, path, expected] of cases) {
		expect(patternError(pattern), pattern).toBeNull();
		expect(matches(pattern, path), `${pattern} ${path}`).toBe(expected);
	}
	for (const [pattern, why] of [
		["", "empty"],
		["/etc", "starts with /"],
		["src//x", "empty, `.`, or `..` segment"],
		["../x", "`..` segment"],
		["src/**x", "whole segment"],
		["{a,b}", "do not support"],
		["src/[ab]", "do not support"],
		["has space", "do not support"],
	] as const)
		expect(patternError(pattern), pattern).toContain(why);
});

test("the built-in high paths hold the risk file and every workflow", () => {
	const held = (path: string) => ALWAYS_HIGH.some((rule) => matches(rule.pattern, path));
	expect(held("RISK.md")).toBe(true);
	expect(held(".github/workflows/ci.yml")).toBe(true);
	expect(held(".github/actions/setup/action.yml")).toBe(true);
	expect(held(".github/dependabot.yml")).toBe(false);
	expect(held("docs/RISK.md")).toBe(false);
});

test("a risk file's ## High list is each backticked pattern and its reason; the rest is prose", () => {
	const text = [
		"# Risk",
		"",
		"Customers run the relay; the CLI is for contributors.",
		"",
		"## High",
		"",
		"The paths below always need a person.",
		"",
		"- `src/billing/` - charges customers,",
		"  and refunds are manual",
		"* `**/*.proto` - peers on older releases read the wire format",
		"",
		"## Customer-facing",
		"",
		"- `not/a/rule` - prose under another heading is never a rule",
	].join("\r\n");
	expect(parseRiskFile(text)).toEqual({
		high: [
			{ pattern: "src/billing/", reason: "charges customers, and refunds are manual" },
			{ pattern: "**/*.proto", reason: "peers on older releases read the wire format" },
		],
		problems: [],
	});
	expect(parseRiskFile("# Risk\n\nNothing is always high here.\n")).toEqual({ high: [], problems: [] });

	const broken = parseRiskFile(
		[
			"## High",
			"",
			"- `/etc` - absolute",
			"- `src/` without a dash",
			"- src/ - not backticked",
			"- `deploy/` - nested",
			"  - `deploy/prod` - inside",
			"",
			"## High",
		].join("\n"),
	);
	expect(broken.high).toEqual([]);
	expect(broken.problems).toEqual([
		"RISK.md has 2 ## High sections; merge them into one",
		"RISK.md:3: `/etc` is no pattern: it starts with /, but a pattern is a path from the repository root",
		"RISK.md:4: a `## High` item is a backticked pattern, ` - `, and why its change is high",
		"RISK.md:5: a `## High` item is a backticked pattern, ` - `, and why its change is high",
		"RISK.md:6: a `## High` item is a backticked pattern, ` - `, and why its change is high",
	]);
});

test("the review record's risk reads back, and a record without one names none", () => {
	const record = (lines: string[]) =>
		["Summary.", "", "## Review", "", "Rewritten by `quest review` after each round.", "", ...lines].join("\r\n");
	const head = "a".repeat(40);
	expect(
		recordedRisk(
			record([
				`- Head: ${head}`,
				"- Base: origin/main at bbbbbbbbbbbb",
				"- Risk: high, ``` ``ships`` to peers ```",
				"- Classified: low by Codex, gpt-6.1-sol, low effort, session `thread-9`",
			]),
		),
	).toEqual({
		tier: "high",
		reason: "``ships`` to peers",
		classified: "low",
		by: "model",
		session: "thread-9",
		head,
	});
	expect(
		recordedRisk(
			record([
				"- Head: aaaaaaaaaaaa, named in full once no reviewer reports a finding",
				"- Risk: high, `it changes RISK.md, which is always high: it sets the tier of every later change`",
				"- Classified: high by the always-high paths",
			]),
		),
	).toMatchObject({ classified: "high", by: "paths", session: null, head: "aaaaaaaaaaaa" });
	expect(
		recordedRisk(record([`- Head: ${head}`, "- Risk: medium, `no file`", "- Classified: medium by default"])),
	).toMatchObject({ by: "default" });
	expect(recordedRisk(record([`- Head: ${head}`]))).toBeNull();
	expect(recordedRisk("Summary.\n\n## Models\n\n- Size: S\n")).toBeNull();
	// A risk line `quest review` did not write fails loud.
	expect(() =>
		recordedRisk(record([`- Head: ${head}`, "- Risk: severe, `x`", "- Classified: low by default"])),
	).toThrow("risk is malformed");
	expect(() => recordedRisk(record([`- Head: ${head}`, "- Risk: low, `x`"]))).toThrow("risk is malformed");
});

test("tiers order from low to high", () => {
	expect(riskier("high", "medium")).toBe(true);
	expect(riskier("medium", "medium")).toBe(false);
	expect(riskier("low", "medium")).toBe(false);
});
