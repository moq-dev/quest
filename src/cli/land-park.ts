// Parking: a PR the fixer is working on stays queued but sits out batches.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { attempt } from "./land-fixer";
import type { Entry, Plan } from "./land";

/**
 * The PRs fixer jobs hold, each with every auto-merge `enabledAt` a job parked: an older job may
 * still hold a PR that a newer pick parked again. A PR is parked from the
 * moment `startFixer` records its job until the job's result for it is collected, so parking never
 * outlives its job: a collected `requeue` or `fixed` puts the PR back in batches, and only a handback
 * takes it out of the queue. Parking changes nothing on GitHub: the PR keeps its auto-merge, its
 * `quest:merge` label, and its place, and gets no ejection comment. A new maintainer pick (a new
 * `enabledAt`) is not parked, so it rejoins batches at once.
 */
export function parked(state: string): Map<number, Set<string>> {
	const held = new Map<number, Set<string>>();
	for (const name of readdirSync(state)) {
		if (!/^fix-job-.*\.json$/.test(name)) continue;
		let job: { numbers: number[]; plan: Plan };
		try {
			job = JSON.parse(readFileSync(join(state, name), "utf8")) as typeof job;
		} catch {
			continue; // Collection reports an unreadable job.
		}
		for (const number of job.numbers) {
			const entry = job.plan.queue.find((item) => item.number === number);
			if (entry) held.set(number, (held.get(number) ?? new Set()).add(entry.enabledAt));
		}
	}
	return held;
}

/** Whether a fixer job holds this queue entry. */
export function isParked(held: Map<number, Set<string>>, entry: Pick<Entry, "number" | "enabledAt">): boolean {
	return held.get(entry.number)?.has(entry.enabledAt) ?? false;
}

/**
 * The queue a batch may draw from: parked PRs left out, and each PR at the place of the maintainer
 * pick it descends from. Requeuing a fixed head enables auto-merge again, which GitHub dates anew;
 * the pick's attempt record keeps the original date, so the fix does not send the PR to the back.
 */
export function batchable(state: string, plan: Plan): Plan {
	const held = parked(state);
	const place = (entry: Entry) => {
		const record = attempt(state, entry.number);
		return record?.requeued === entry.enabledAt ? record.pick : entry.enabledAt;
	};
	const queue = plan.queue
		.filter((entry) => !isParked(held, entry))
		.map((entry) => ({ entry, place: place(entry) }))
		.sort((a, b) => a.place.localeCompare(b.place) || a.entry.number - b.entry.number)
		.map(({ entry }) => entry);
	return { ...plan, queue };
}
