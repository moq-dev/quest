// The pick `quest merge --land` records on a merge-queue base: a PR comment naming the head
// the maintainer picked. GitHub keeps no trace of a pick it refused to enqueue, and drops the
// queue entry and auto-merge when its queue removes a PR, so the queue watcher reads the pick here.
// Anyone can comment, so a reader honors only a pick by an author who can write to the repository.
import { repositoryPath } from "./claims";
import type { GitHub, PullRequest } from "./github";

const MARKER = /^<!-- quest pick: ([0-9a-f]{40}) -->$/m;

/** The comment that picks `sha` to land through the merge queue. */
export function pickComment(sha: string): string {
	const head = sha.toLowerCase();
	return (
		`Picked \`${head}\` to land through the merge queue. If the queue drops it or GitHub refuses to ` +
		"enqueue it, the queue watcher fixes it and enqueues it again, where one runs for this repository; " +
		`a push by anyone else, or a person removing it from the queue, ends the pick.\n\n<!-- quest pick: ${head} -->`
	);
}

/** The head a pick comment's body names, if it is one. */
export function pickedHead(body: string): string | null {
	return MARKER.exec(body)?.[1] ?? null;
}

/** Record the pick of `sha` on `pr`. Each pick is its own comment, so a pick after a handback starts anew. */
export async function recordPick(github: GitHub, pr: PullRequest, sha: string): Promise<void> {
	await github.request(`${repositoryPath(pr)}/issues/${pr.number}/comments`, { body: { body: pickComment(sha) } });
}
