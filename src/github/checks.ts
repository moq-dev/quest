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

/** A GitHub Actions workflow run on a head, as `GET /actions/runs` lists it. */
export interface WorkflowRun {
	id: number;
	workflow_id: number;
	check_suite_id: number;
	/** When its latest attempt started, so a rerun is newer than runs that started before it. */
	run_started_at: string;
	[field: string]: unknown;
}

/** Whether `run` started after `other`: by its latest attempt's start, then by ID on a tie. */
export function newerRun(run: WorkflowRun, other: WorkflowRun): boolean {
	const started = Date.parse(run.run_started_at) - Date.parse(other.run_started_at);
	if (Number.isNaN(started)) throw new Error(`workflow run ${run.id} or ${other.id} has no valid start time`);
	return started === 0 ? run.id > other.id : started > 0;
}

/** Whether a newer run of `run`'s workflow exists among `runs`, from any event. */
export function replacedRun(run: WorkflowRun, runs: WorkflowRun[]): boolean {
	return runs.some((other) => other.workflow_id === run.workflow_id && newerRun(other, run));
}

/** Whether a context is a check run that reported cancelled, the only result a replaced run's check drops. */
export function cancelled(context: RollupContext): boolean {
	return context.__typename === "CheckRun" && String(context.conclusion).toUpperCase() === "CANCELLED";
}

/**
 * Each check's latest report that still counts: a check that reported cancelled drops once a newer run of
 * its workflow exists on the head, leaving the check unreported rather than reviving an older report, as when `cancel-in-progress` cancels a run for a newer one, which may
 * never report the cancelled run's names, such as a matrix job's unexpanded name. Any other result keeps
 * counting, as does a cancelled run nothing replaced. A rerun reports anew in its run's check suite, so
 * the rollup holds only its latest attempt. Queries must also ask for a check run's `conclusion` and
 * `checkSuite { databaseId }`; `runs` are the head's workflow runs, needed only when a latest context is
 * {@link cancelled}.
 */
export function currentContexts<T extends RollupContext>(contexts: T[], runs: WorkflowRun[]): T[] {
	const replaced = new Set(runs.filter((run) => replacedRun(run, runs)).map((run) => run.check_suite_id));
	const suite = (context: T) =>
		Number((context.checkSuite as { databaseId?: unknown } | null | undefined)?.databaseId);
	return latestContexts(contexts).filter((context) => !(cancelled(context) && replaced.has(suite(context))));
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

/** The state of a head's current contexts, from {@link currentContexts}: any failing fails, else any pending is pending. */
export function checksState(current: RollupContext[]): "SUCCESS" | "FAILURE" | "PENDING" {
	const outcomes = current.map(contextOutcome);
	if (outcomes.includes("failing")) return "FAILURE";
	return outcomes.includes("pending") ? "PENDING" : "SUCCESS";
}
