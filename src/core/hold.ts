// A hold is a label plus the event that most recently added it. Callers load
// labels and ordered events from their tracker and apply the resulting rule.
export const HOLD_PREFIX = "quest:";
/** The label a local session adds while its agent works on a PR. */
export const ACTIVE_LABEL = `${HOLD_PREFIX}active`;

/**
 * Compatibility with older quest versions, which repositories pin: delete once
 * they have upgraded. Their `quest:iterate` and `quest:ready` still hold a PR,
 * as every other `quest:*` label does, so nothing here names them. Their
 * `quest:merge` stayed on a queued PR after its session ended, and the pinned
 * auto-merge is the queue signal, so that label holds nothing.
 */
const LEGACY_IGNORED = `${HOLD_PREFIX}merge`;

export interface HoldEvent {
	id: string;
	/** The label added, or null for another timeline event, such as a landing starting. */
	label: string | null;
}
export interface HoldSnapshot {
	labels: readonly string[];
	/** Oldest first. */
	events: readonly HoldEvent[];
}

export function isHoldLabel(label: string): boolean {
	return label.startsWith(HOLD_PREFIX) && label !== LEGACY_IGNORED;
}

/** Preserve a caller's extra event fields, such as its timestamp. */
export function latestHold<T extends HoldEvent>(events: readonly T[], label: string): T | undefined {
	for (let index = events.length - 1; index >= 0; index--) if (events[index].label === label) return events[index];
	return undefined;
}

/** A present label is owned only by its most recent addition. */
export function heldToken(snapshot: HoldSnapshot, label: string): string | undefined {
	return snapshot.labels.includes(label) ? latestHold(snapshot.events, label)?.id : undefined;
}
