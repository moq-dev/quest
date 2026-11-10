import { describe, expect, test } from "vitest";
import { ACTIVE_LABEL, HOLD_PREFIX, heldToken, isHoldLabel, latestHold } from "../src/core";

const added = { id: "first", label: ACTIVE_LABEL, time: 1 };

describe("shared hold policy", () => {
	test("recognizes only the hold label, not other quest:* or ordinary labels", () => {
		expect(HOLD_PREFIX).toBe("quest:");
		expect(ACTIVE_LABEL).toBe("quest:active");
		expect(isHoldLabel(ACTIVE_LABEL)).toBe(true);
		// Labels older quest versions added, and quest:merge, hold nothing.
		for (const label of [
			"quest",
			"quest:kix",
			"bug",
			"other:quest:active",
			"quest:merge",
			"quest:iterate",
			"quest:ready",
			"quest:custom",
		])
			expect(isHoldLabel(label)).toBe(false);
	});

	test("only the latest addition owns a present label, preserving event metadata", () => {
		const latest = { id: "second", label: ACTIVE_LABEL, time: 2 };
		const state = { labels: [ACTIVE_LABEL], events: [added, { id: "landing", label: null }, latest] };
		expect(latestHold(state.events, ACTIVE_LABEL)).toBe(latest);
		expect(heldToken(state, ACTIVE_LABEL)).toBe("second");
		expect(heldToken({ ...state, labels: [] }, ACTIVE_LABEL)).toBeUndefined();
		expect(heldToken({ ...state, events: [] }, ACTIVE_LABEL)).toBeUndefined();
	});
});
