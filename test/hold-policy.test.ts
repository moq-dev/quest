import { describe, expect, test } from "vitest";
import { ACTIVE_LABEL, HOLD_PREFIX, heldToken, isHoldLabel, latestHold } from "../src/core";

const added = { id: "first", label: ACTIVE_LABEL, time: 1 };

describe("shared hold policy", () => {
	test("recognizes all hold labels without treating ordinary labels as holds", () => {
		expect(HOLD_PREFIX).toBe("quest:");
		expect(ACTIVE_LABEL).toBe("quest:active");
		// Older quest versions' quest:iterate and quest:ready still hold a PR.
		for (const label of [ACTIVE_LABEL, "quest:kix", "quest:ready", "quest:iterate", "quest:custom"])
			expect(isHoldLabel(label)).toBe(true);
		// Their quest:merge only shadowed a queued landing.
		for (const label of ["quest", "bug", "other:quest:active", "quest:merge"])
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
