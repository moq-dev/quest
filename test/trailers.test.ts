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
