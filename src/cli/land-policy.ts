// How big the next batch is: sized from the measured per-PR failure rate of recent checks.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** How the next batch is chosen: its base end of the queue, and at most how many PRs it checks. */
export interface BatchPolicy {
	order: "oldest" | "newest";
	size: number;
}

/** One checked batch: how many PRs it held and whether its check passed. */
export interface CheckedBatch {
	size: number;
	passed: boolean;
}

const POLICY = "batch-policy.json";

/**
 * How many checked batches the failure rate is measured over: about six hours of checks. A
 * simulation at moq's measured rate lands within 2% of the best fixed size per check with this
 * window, and a shorter one follows a changed rate sooner but lands less.
 */
export const HISTORY = 30;

/** The next batch's policy and the batches it was sized from; a missing or unreadable record starts oldest-first at full size. */
export function readPolicy(state: string): BatchPolicy & { history: CheckedBatch[] } {
	try {
		const data = JSON.parse(readFileSync(join(state, POLICY), "utf8")) as {
			order?: unknown;
			size?: unknown;
			history?: unknown;
		};
		const order = data.order === "newest" ? "newest" : "oldest";
		// An unbounded size is saved as null, since JSON has no infinity.
		const size = typeof data.size === "number" && data.size >= 1 ? Math.floor(data.size) : Number.POSITIVE_INFINITY;
		const history = Array.isArray(data.history)
			? data.history.filter(
					(item): item is CheckedBatch =>
						typeof item === "object" &&
						item !== null &&
						Number.isSafeInteger(item.size) &&
						item.size >= 1 &&
						typeof item.passed === "boolean",
				)
			: [];
		return { order, size, history: history.slice(-HISTORY) };
	} catch {
		return { order: "oldest", size: Number.POSITIVE_INFINITY, history: [] };
	}
}

/** After a checked batch of `size` PRs: flip the order and size the next batch from the recent failure rate. */
export function recordBatch(state: string, previous: BatchPolicy & { history: CheckedBatch[] }, batch: CheckedBatch) {
	const history = [...previous.history, batch].slice(-HISTORY);
	const policy = {
		order: previous.order === "oldest" ? "newest" : "oldest",
		size: batchSize(failureRate(history)),
		history,
	};
	const path = join(state, POLICY);
	writeFileSync(`${path}.new`, JSON.stringify(policy), { mode: 0o600 });
	renameSync(`${path}.new`, path);
}

/**
 * The per-PR failure rate that best explains `history`, assuming each PR breaks a batch
 * independently with the same probability p: a batch of n passes with probability (1 - p)^n.
 * The log-likelihood is concave in p, so bisecting its derivative finds the maximum.
 */
export function failureRate(history: CheckedBatch[]): number {
	if (!history.some((batch) => !batch.passed)) return 0;
	if (!history.some((batch) => batch.passed)) return 1;
	const slope = (p: number) => {
		const q = 1 - p;
		let total = 0;
		for (const { size, passed } of history)
			total += passed ? -size / q : (size * q ** (size - 1)) / (1 - q ** size);
		return total;
	};
	let low = 0;
	let high = 1;
	for (let i = 0; i < 60; i++) {
		const mid = (low + high) / 2;
		if (slope(mid) > 0) low = mid;
		else high = mid;
	}
	return (low + high) / 2;
}

/**
 * The batch size that lands the most PRs per check at failure rate `p`: n(1 - p)^n, which peaks
 * at n = -1 / ln(1 - p). A failed batch lands nothing but costs only its check, since the fixer
 * blames its culprits and the rest rejoin later batches.
 */
export function batchSize(p: number): number {
	if (p <= 0) return Number.POSITIVE_INFINITY;
	if (p >= 1) return 1;
	const peak = -1 / Math.log(1 - p);
	const landed = (n: number) => n * (1 - p) ** n;
	const low = Math.max(1, Math.floor(peak));
	return landed(low + 1) > landed(low) ? low + 1 : low;
}
