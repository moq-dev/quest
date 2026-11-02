// How a quest's PR and branch say whose move it is. A draft is its starter's
// claim until its body hands it back with a `## Waiting` section, and a branch
// whose work merged holds nothing (the guide's Execution section); the CLI and
// the Worker read both the same way.

// Web edits end lines in CRLF. `Decisions needed` is the heading `Waiting`
// replaced; drafts opened before it still hand back with it.
const HAND_BACK = /^#{2}[ \t]+(?:Waiting|Decisions needed)[ \t]*#*[ \t]*\r?$/im;

/** Whether a PR body hands its draft back to the maintainer; only the heading's presence matters. */
export function handedBack(body: string): boolean {
	return HAND_BACK.test(body);
}

/** A closed PR from a quest's branch: the commit it ended at, and whether it merged. */
export interface ClosedPull {
	head: string;
	merged: boolean;
}

/**
 * The PR that landed a quest branch at `tip`: one from it that merged with
 * `tip` as its head, so the branch holds no claim. One whose PR closed unmerged
 * still holds its quest, since that work may be wanted back, and so does one
 * with commits pushed after its merge. The CLI and the Worker share this rule.
 */
export function landed<P extends ClosedPull>(tip: string, pulls: Iterable<P>): P | undefined {
	for (const pull of pulls) if (pull.merged && pull.head === tip) return pull;
	return undefined;
}
