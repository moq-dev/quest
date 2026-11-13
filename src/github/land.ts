// The markers `quest land` leaves on GitHub, which `quest status` reads back.

/** The check a gated base requires. Nothing reports it on a PR head, so GitHub's auto-merge only waits. */
export const LAND_CHECK = "quest land";

/** The auto-merge commit body trailer that pins the head `quest merge --land` approved. */
const PIN = "Quest-Land-Head";

/** The auto-merge commit body that queues `sha`. */
export function pin(sha: string): string {
	return `${PIN}: ${sha}`;
}

/** The head an auto-merge commit body pins, if any. */
export function pinned(body: string): string | null {
	return new RegExp(`^${PIN}: ([0-9a-f]{40})$`, "m").exec(body)?.[1] ?? null;
}

/** Why the gate removed a PR from the queue; `quest status` prints it under `landing-stopped`. */
export type Reason =
	| "merge_conflict"
	| "failed_checks"
	| "changes_requested"
	| "unresolved_conversations"
	| "head_moved"
	| "not_pinned"
	| "tree_mismatch"
	| "merge_refused"
	| "fork_head"
	| "unanswered_signal";

/** The hidden line an ejection comment carries, which `quest status` reads. */
export const EJECTED = /^<!-- quest land: ([a-z_]+) -->$/m;
