// Pre-checks: while a batch's check runs, the next queued PRs run the repository's quick command,
// each squashed alone onto the base, so a PR broken against the base is parked before it batches.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Entry, type Plan, mergeWorktree, screener } from "./land";

/** How many queued PRs a batch's check pre-checks at most, one at a time, in the order the next batch draws them. */
export const PRECHECK_AHEAD = 4;

/** A queued PR's pre-check: one per (head, base), at the pick it ran for. */
export interface Precheck {
	head: string;
	enabledAt: string;
	base: string;
	/** Its squash alone onto `base`, which the quick command checked and a fixer starts from. */
	commit: string;
	/** The quick command's exit code. */
	code: number;
	log: string;
	/** A failure already handed to the fixer, or ejected without one, which is never acted on twice. */
	reported?: boolean;
}

const PATH = "precheck.json";

export function readPrechecks(state: string): Record<number, Precheck> {
	const path = join(state, PATH);
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<number, Precheck>) : {};
}

function savePrechecks(state: string, records: Record<number, Precheck>): void {
	const path = join(state, PATH);
	writeFileSync(`${path}.new`, JSON.stringify(records), { mode: 0o600 });
	renameSync(`${path}.new`, path);
}

/** Record one pre-check, forgetting PRs no longer queued: a PR queued again is pre-checked again. */
export function recordPrecheck(state: string, plan: Plan, number: number, record: Precheck): void {
	const queued = new Set([...plan.queue, ...(plan.waiting ?? [])].map((entry) => entry.number));
	const records = Object.fromEntries(
		Object.entries(readPrechecks(state)).filter(([key]) => queued.has(Number(key))),
	) as Record<number, Precheck>;
	records[number] = record;
	savePrechecks(state, records);
}

/**
 * The queued PRs whose pre-check failed and has not been acted on, at the head and pick it ran for.
 * Each is marked reported as it is returned, so a crash before the fixer starts loses the
 * pre-check rather than parking the PR twice; it then fails in a batch as it would without one.
 */
export function takeFailures(state: string, plan: Plan): { entry: Entry; record: Precheck }[] {
	const records = readPrechecks(state);
	const failed = plan.queue.flatMap((entry) => {
		const record = records[entry.number];
		return record &&
			record.code !== 0 &&
			!record.reported &&
			record.head === entry.head &&
			record.enabledAt === entry.enabledAt
			? [{ entry, record }]
			: [];
	});
	if (failed.length === 0) return [];
	for (const { entry } of failed) records[entry.number] = { ...records[entry.number], reported: true };
	savePrechecks(state, records);
	return failed;
}

/**
 * The PRs to pre-check, in `order`, leaving out those already batched or screened out this round.
 * A PR is pre-checked once per head; a moved base pre-checks it again only when it is next in line,
 * so each landing does not pre-check the whole queue again.
 */
export function candidates(state: string, plan: Plan, order: "oldest" | "newest", skip: Set<number>): Entry[] {
	const records = readPrechecks(state);
	const ordered = (order === "newest" ? [...plan.queue].reverse() : plan.queue).filter(
		(entry) => !skip.has(entry.number),
	);
	return ordered
		.filter((entry, index) => {
			const record = records[entry.number];
			if (!record || record.head !== entry.head) return true;
			return index === 0 && record.base !== plan.base.sha;
		})
		.slice(0, PRECHECK_AHEAD);
}

/**
 * Squash each candidate alone onto the base. One that conflicts with the base, or fails
 * `quest check` there, is left for the batch that reaches it, which already parks it.
 */
export function squashAlone(root: string, plan: Plan, entries: Entry[]): { entry: Entry; commit: string }[] {
	if (entries.length === 0) return [];
	return mergeWorktree(root, plan.base.sha, (dir, driver) => {
		const screening = screener(dir, driver, plan);
		return entries.flatMap((entry) => {
			const alone = screening.alone(entry);
			return alone === null || alone.findings.length > 0 ? [] : [{ entry, commit: alone.commit }];
		});
	});
}

/**
 * Pre-check `squashed` one at a time with `run`, recording each result, until done or `signal`
 * aborts. A pre-check cut short by the abort is not recorded, so it runs again on a later batch.
 */
export async function precheck(
	state: string,
	plan: Plan,
	squashed: { entry: Entry; commit: string }[],
	run: (commit: string, log: string, signal: AbortSignal) => Promise<number>,
	signal: AbortSignal,
): Promise<void> {
	for (const { entry, commit } of squashed) {
		if (signal.aborted) return;
		const log = join(state, `precheck-${Date.now()}-${entry.number}.log`);
		const code = await run(commit, log, signal);
		if (signal.aborted) return;
		recordPrecheck(state, plan, entry.number, {
			head: entry.head,
			enabledAt: entry.enabledAt,
			base: plan.base.sha,
			commit,
			code,
			log,
		});
	}
}
