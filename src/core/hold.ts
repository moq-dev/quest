// A hold is a label plus the event that most recently added it. Callers load
// labels and ordered events from their tracker and apply the resulting rule.
export const HOLD_PREFIX = "quest:";
/** The label a local session adds while its agent works on a PR. */
export const ACTIVE_LABEL = `${HOLD_PREFIX}active`;

/**
 * The label a merge job holds its pull request with, from the pick until the
 * job ends without landing or a landing it started ends unmerged. It is kix's
 * own, apart from local sessions' `quest:active`, since it stays on while the
 * job's landing is queued; local sessions respect it.
 */
export const KIX_LABEL = `${HOLD_PREFIX}kix`;

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
	return label === ACTIVE_LABEL || label === KIX_LABEL;
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
