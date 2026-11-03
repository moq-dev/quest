// GitHub-specific landing decisions shared by the CLI and the Worker.
// Keep these outside the tracker-independent quest core.

/** GitHub merges these states at once and refuses auto-merge because the PR is clean. */
export function immediateMerge(state: string, queue: boolean): boolean {
	return !queue && ["CLEAN", "HAS_HOOKS", "UNSTABLE"].includes(state);
}

/** The one refusal that warrants rereading an initially unknown merge state. */
export function cleanAutoMergeRefusal(message: unknown): boolean {
	return typeof message === "string" && /\bpull request is in clean status\b/i.test(message);
}

/** Merge states in which GitHub may still be running required checks, so only auto-merge can wait for them. */
const PENDING = ["BLOCKED", "UNKNOWN"];

/** Send one GraphQL mutation; it throws GitHub's refusal as an `Error` whose message carries GitHub's. */
export type Mutate = (query: string, variables: Record<string, string>) => Promise<unknown>;

/** How {@link queueHead} put a head in the queue: enqueued it, or armed auto-merge to enqueue it once its checks pass. */
export type Queued = "enqueued" | "armed";

/**
 * Put `head`, which must still be the head of pull request `id`, in its base's merge queue:
 * enqueue it, or, while GitHub may still be running its required checks (`mergeState` pending),
 * arm auto-merge bound to it, which enqueues it once they pass. Either joins the back of the queue.
 * GitHub refuses auto-merge for a PR it finished computing as ready, which is then enqueued.
 * Enqueueing directly matters: GitHub often leaves an armed PR that is already ready out of the
 * queue (https://github.com/orgs/community/discussions/209348). A refusal throws GitHub's error.
 * `method` is the auto-merge method GitHub requires, though the queue applies its own.
 */
export async function queueHead(
	mutate: Mutate,
	id: string,
	head: string,
	mergeState: string,
	method: string,
): Promise<Queued> {
	const enqueue = async (): Promise<Queued> => {
		await mutate(
			`mutation($id: ID!, $sha: GitObjectID!) {
				enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $sha }) { clientMutationId }
			}`,
			{ id, sha: head },
		);
		return "enqueued";
	};
	if (!PENDING.includes(mergeState)) return enqueue();
	try {
		await mutate(
			`mutation($id: ID!, $sha: GitObjectID!, $method: PullRequestMergeMethod!) {
				enablePullRequestAutoMerge(input: { pullRequestId: $id, expectedHeadOid: $sha, mergeMethod: $method }) { clientMutationId }
			}`,
			{ id, sha: head, method: method.toUpperCase() },
		);
		return "armed";
	} catch (error) {
		// An UNKNOWN state GitHub finished computing as ready: nothing is left to wait for.
		if (!cleanAutoMergeRefusal(error instanceof Error ? error.message : null)) throw error;
		return enqueue();
	}
}
