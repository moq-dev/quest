import { describe, expect, test } from "vitest";
import { ACTIVE_LABEL, HOLD_PREFIX, KIX_LABEL, heldToken, isHoldLabel, latestHold } from "../src/core";

const added = { id: "first", label: ACTIVE_LABEL, time: 1 };

describe("shared hold policy", () => {
	test("recognizes only the hold labels, not other quest:* or ordinary labels", () => {
		expect(HOLD_PREFIX).toBe("quest:");
		expect(ACTIVE_LABEL).toBe("quest:active");
		expect(KIX_LABEL).toBe("quest:kix");
		for (const label of [ACTIVE_LABEL, KIX_LABEL]) expect(isHoldLabel(label)).toBe(true);
		// Labels older quest versions added, and quest:merge, hold nothing.
		for (const label of [
			"quest",
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
