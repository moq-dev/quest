import { lstatSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** How long a finished log stays, so a person can still read what a recent comment cites. */
export const LOG_RETENTION = 7 * 24 * 3_600_000;

/**
 * Every log the watcher writes to its state directory's top level, by whole name, and those the
 * retired `quest land serve` left there (`base-`, `check-`, `batch-`, `fix-job-` and `fix-base-`),
 * so they still expire.
 */
const LOG =
	/^(?:base-\d+-[0-9a-f]+|check-\d+-\d+|batch-\d+-\d+|removal-\d+-[0-9TZ]+|conflict-\d+-[0-9a-f]+|fixer-input-\d+-[0-9a-z]+|(?:fix-job|fix-base|watch-job)-[^/]+\.json)\.log$/;
/** The watcher's job records a later pass reads a log from; each also owns `<record>.log`. */
const JOB = /^watch-job-[^/]+\.json$/;
const REMOVAL = /^removal-(\d+)\.json$/;

/** The logs a record in `state` still reads: a job's, or a removal's waiting for a fixer slot. */
function inUse(state: string, names: string[]): Set<string> {
	const used = new Set<string>();
	const cite = (path: unknown) => {
		if (typeof path === "string" && path && resolve(state, dirname(path)) === resolve(state))
			used.add(basename(path));
	};
	const read = (name: string) => JSON.parse(readFileSync(join(state, name), "utf8")) as Record<string, unknown>;
	for (const name of names) {
		if (JOB.test(name)) {
			used.add(`${name}.log`);
			cite(read(name).log);
		} else {
			const removal = REMOVAL.exec(name);
			if (!removal) continue;
			const record = read(name);
			if (!record.failure || record.taken !== undefined) continue;
			cite(record.log);
			if (typeof record.unmerged === "string")
				used.add(`conflict-${removal[1]}-${record.unmerged.slice(0, 12)}.log`);
		}
	}
	return used;
}

/**
 * Delete the land daemons' logs in `state` that no record reads and that were last written over
 * `LOG_RETENTION` before `now`. Returns the names deleted. Failing to prune, such as on an unreadable record, warns and deletes
 * nothing, so it never blocks the queue.
 */
export function pruneLogs(state: string, now: number, warn: (message: string) => void): string[] {
	try {
		return prune(state, now);
	} catch (error) {
		warn(`quest land: pruning logs failed: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}

function prune(state: string, now: number): string[] {
	const names = readdirSync(state);
	const used = inUse(state, names);
	const pruned: string[] = [];
	for (const name of names) {
		if (!LOG.test(name) || used.has(name)) continue;
		const stat = lstatSync(join(state, name));
		if (!stat.isFile() || now - stat.mtimeMs < LOG_RETENTION) continue;
		unlinkSync(join(state, name));
		pruned.push(name);
	}
	return pruned;
}
