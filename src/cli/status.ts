// `quest status`: a pull request's state as stable plain lines.
import type { Check, Status } from "../github/status";

/** Stable plain lines: a record type, then space-separated fields, with any free text last. */
export function statusLines(status: Status): string[] {
	const dash = (value: string | number | null) => (value === null ? "-" : String(value));
	const check = (kind: string, c: Check) =>
		`check ${kind} ${c.required ? "required" : "optional"} ${c.result} ${dash(c.url)} ${c.name}`;
	return [
		`url ${status.url}`,
		`state ${status.state}`,
		`draft ${status.draft}`,
		`head ${status.head}`,
		`mergeable ${status.mergeable}`,
		`merge-state ${status.mergeState}`,
		`review-decision ${dash(status.reviewDecision)}`,
		status.reviewRecord === null
			? "review-record -"
			: `review-record ${status.reviewRecord.state} ${status.reviewRecord.head}`,
		status.autoMerge === null
			? "auto-merge -"
			: `auto-merge ${status.autoMerge.method} ${status.autoMerge.enabledBy} ${status.autoMerge.enabledAt} ${dash(status.autoMerge.head)}`,
		status.mergeQueue === null
			? "merge-queue -"
			: `merge-queue ${status.mergeQueue.state} ${status.mergeQueue.position} ${status.mergeQueue.enqueuedAt}`,
		status.landingStopped === null
			? "landing-stopped -"
			: `landing-stopped ${status.landingStopped.reason} ${status.landingStopped.actor} ${status.landingStopped.at}`,
		`checks ${dash(status.checks.state)} passed=${status.checks.passed} failing=${status.checks.failing.length} pending=${status.checks.pending.length}`,
		...status.checks.failing.map((c) => check("failing", c)),
		...status.checks.pending.map((c) => check("pending", c)),
		...status.reviews.map(
			(r) => `review ${r.current ? "current" : "stale"} ${r.state} ${r.reviewer} ${r.submittedAt} ${r.url}`,
		),
		...status.checkpoints.map((c) => `checkpoint ${c.reviewer} round ${c.round} ${c.url}`),
		...status.reactions.map((r) => `reacted:${r.content} ${r.actor} ${r.createdAt} ${r.url}`),
		...status.threads.map(
			(t) =>
				`thread ${t.id} ${t.outdated ? "outdated" : "current"} ${t.lastAuthor} ${t.url} ${t.path}:${dash(t.line)}`,
		),
		...(status.holds.length
			? status.holds.map(
					(hold) =>
						`hold ${hold.label} ${dash(hold.token)} ${dash(hold.takenAt)} ${dash(hold.eventUrl)} ${hold.age ?? "unknown age"}`,
				)
			: ["hold -"]),
		...(status.starterHold
			? [
					`starter-hold ${status.starterHold.lastActive} ${status.starterHold.url} last active ${status.starterHold.age}`,
				]
			: []),
	];
}
