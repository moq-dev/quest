import { expect, test } from "vitest";

import { withTrailers } from "../src/cli/trailers";

const by = { harness: "codex", model: "gpt-test", effort: "high" };
const trailers = "Agent-Harness: codex\nAgent-Model: gpt-test\nAgent-Effort: high\n";

test("joins an existing trailer block and replaces every repeat of its own keys", () => {
	expect(
		withTrailers(
			"fix: thing\n\nBody\n---\nmore\n\nagent-model: old\nCo-Authored-By: X <x@y>\nAgent-Model: stale\nAgent-Effort: low\n",
			by,
		),
	).toBe(`fix: thing\n\nBody\n---\nmore\n\nCo-Authored-By: X <x@y>\n${trailers}`);
});

test("starts a trailer block under a lone subject, and writes unknown for a value that cannot be one", () => {
	expect(withTrailers("Agent-Model: subject", by)).toBe(`Agent-Model: subject\n\n${trailers}`);
	expect(withTrailers("subject\n\nAgent-Harness: codex\n", { ...by, model: "two words\nAgent-Model: x" })).toBe(
		"subject\n\nAgent-Harness: codex\nAgent-Model: unknown\nAgent-Effort: high\n",
	);
});

test("finds the trailer block as Git does, leaving lookalike lines in the body alone", () => {
	expect(withTrailers("fix: x\r\n\r\nAgent-Model: old\r\n", by)).toBe(`fix: x\n\n${trailers}`);
	expect(withTrailers("fix: x\n\nAgent-Model: old\n\n# comment\n", by)).toContain("\n\n# comment\n");
	expect(withTrailers("fix: x\n\nAgent-Model: old\n\n# comment\n", by)).not.toContain("old");
	const body = "fix: x\n\nThe example configuration is:\nAgent-Model: old\nThis value identifies the model.";
	expect(withTrailers(body, by)).toBe(`${body}\n\n${trailers}`);
});
