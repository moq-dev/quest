// How a head's `statusCheckRollup` contexts are judged, shared by the CLI and the Worker.
// GitHub lists every check run on a head, including those a newer run of the same check replaced,
// and its rollup `state` counts them all; mergeability counts only each check's latest run.

/** A `statusCheckRollup` context: a `CheckRun` or a `StatusContext`, as GraphQL returns it. */
export type RollupContext = { [field: string]: unknown };

/** Completed check-run conclusions that do not fail; anything else completed fails. */
const PASSING = ["SUCCESS", "NEUTRAL", "SKIPPED"];

/** The GitHub App behind a check run; a commit status has none. */
export function appOf(context: RollupContext): number | null {
	if (context.__typename !== "CheckRun") return null;
	const app = (context.checkSuite as { app?: { databaseId?: unknown } | null } | null | undefined)?.app;
	return app?.databaseId == null ? null : Number(app.databaseId);
}

/**
 * Each check's latest report on the head, in rollup order. A check run is keyed by its app and name,
 * as a required check is, and the latest is the one created last: the highest `databaseId`. A commit
 * status is keyed by its context, and the latest is the newest `createdAt`, or on a tie the one listed
 * later. A check run and a status with the same name stay apart, since GitHub requires both.
 * Queries must ask for a check run's `databaseId name checkSuite { app { databaseId } }` and a
 * status's `context createdAt`.
 */
export function latestContexts<T extends RollupContext>(contexts: T[]): T[] {
	const key = (context: T) =>
		context.__typename === "CheckRun"
			? JSON.stringify(["run", appOf(context), context.name])
			: JSON.stringify(["status", context.context]);
	const newer = (context: T, seen: T) =>
		context.__typename === "CheckRun"
			? Number(context.databaseId) > Number(seen.databaseId)
			: String(context.createdAt ?? "") >= String(seen.createdAt ?? "");
	const latest = new Map<string, T>();
	for (const context of contexts) {
		const seen = latest.get(key(context));
		if (seen === undefined || newer(context, seen)) latest.set(key(context), context);
	}
	return contexts.filter((context) => latest.get(key(context)) === context);
}

/** Whether a context passed, failed, or is still pending. Neutral and skipped check runs pass. */
export function contextOutcome(context: RollupContext): "passed" | "failing" | "pending" {
	if (context.__typename === "CheckRun") {
		if (context.status !== "COMPLETED") return "pending";
		return PASSING.includes(String(context.conclusion).toUpperCase()) ? "passed" : "failing";
	}
	const state = String(context.state).toUpperCase();
	if (state === "PENDING" || state === "EXPECTED") return "pending";
	return state === "SUCCESS" ? "passed" : "failing";
}

/** The head's check state from its latest contexts: any failing fails, else any pending is pending. */
export function checksState(contexts: RollupContext[]): "SUCCESS" | "FAILURE" | "PENDING" {
	const outcomes = latestContexts(contexts).map(contextOutcome);
	if (outcomes.includes("failing")) return "FAILURE";
	return outcomes.includes("pending") ? "PENDING" : "SUCCESS";
}
