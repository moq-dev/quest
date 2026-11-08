import { expect, test } from "vitest";

import { EXHAUSTED, LIMIT, codexReset } from "../src/cli/limit";

test("usage limits and spent balances match, and other limits do not", () => {
	for (const message of [
		"You've hit your weekly limit · resets Nov 5, 3pm (America/Los_Angeles)",
		"You've hit your 5-hour limit · resets 3pm",
		"You've hit your limit",
		"You've reached your Fable limit.",
		"Claude AI usage limit reached|1900000000",
		"Opus weekly limit reached ∙ resets Nov 5",
		"You're out of extra usage",
		"You're out of usage credits. Switch to another model to continue.",
		"You've hit your usage limit. Try again at 3:15 PM.",
		"usage_limit_reached",
		"Quota exceeded. Check your plan and billing details.",
		"Credit balance is too low",
		"Your workspace is out of credits. Add credits to continue.",
		"You hit your spend cap set in your workspace. Increase your spend cap to continue.",
		"You've hit your team's shared budget. /model to switch models.",
		// A CLIProxyAPI pool, as Claude Code shows it and in the OpenAI-style formats.
		"API Error: Request rejected (429) · All credentials for model claude-opus-5-5 are cooling down (last error: rate_limit_error: This request would exceed your account's rate limit.)",
		'{"error":{"code":"model_cooldown","message":"All credentials for model gpt-6.1-sol are cooling down","reset_seconds":81}}',
	]) {
		expect(LIMIT.test(message), message).toBe(true);
	}
	for (const message of [
		"Context limit reached · /compact or /clear to continue",
		"Budget limit reached ($5.00 spent of the $5.00 budget); stopping background agents.",
		"Subagent nesting limit reached (depth 3 of 3).",
		"Rate limit reached for requests",
		"exceeded retry limit, last status: 429 Too Many Requests",
		"API Error: Server is temporarily limiting requests (not your usage limit)",
		"Claude is temporarily limiting requests to the usage page (not your usage limit). Try again in a moment.",
	]) {
		expect(LIMIT.test(message), message).toBe(false);
	}
	expect(EXHAUSTED.test("Quota exceeded. Check your plan and billing details.")).toBe(true);
	expect(EXHAUSTED.test("You've hit your usage limit.")).toBe(false);
});

test("Codex's reset is read in the local time zone, today's by time alone", () => {
	const now = new Date(2026, 10, 3, 9, 0);
	expect(codexReset("You've hit your usage limit. Try again at 3:15 PM.", now)).toBe(
		new Date(2026, 10, 3, 15, 15).getTime(),
	);
	expect(codexReset("You've hit your usage limit. Try again at 12:05 AM.", now)).toBe(
		new Date(2026, 10, 3, 0, 5).getTime(),
	);
	expect(codexReset("... or try again at Jan 2nd, 2027 12:30 PM.", now)).toBe(new Date(2027, 0, 2, 12, 30).getTime());
	expect(codexReset("You've hit your usage limit.", now)).toBeNull();
	expect(codexReset("Try again at Foo 2nd, 2027 12:30 PM.", now)).toBeNull();
});
