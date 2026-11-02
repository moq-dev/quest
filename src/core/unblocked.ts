// Rank ready work without mistaking the epic index for downstream work.

import { type Doc, children, entries, permanent, rooted } from "./doc";
import { ready } from "./ready";
import { ROOT, check, formatFinding } from "./rules";
import { type Wait, onMaintainer, waits } from "./waiting";

export interface RankedQuest {
	path: string;
	/** Distinct transitive dependents; other prerequisites may still remain. */
	dependents: number;
}

/**
 * How much finishing a quest matters: the milestone its subtree belongs to, and
 * its distinct transitive dependents. Validates the graph and document
 * structure; callers validate filesystem links.
 */
export interface Ranking {
	/** The root's subtree rank of `path`, lowest first; unindexed paths sort last. */
	priority(path: string): number;
	/** Distinct transitive dependents of `path`, excluding epic membership and milestones. */
	impact(path: string): number;
}

/** Rank `docs`' quests by milestone, then downstream impact. */
export function ranking(docs: Doc[]): Ranking {
	const findings = check(docs, () => true);
	if (findings.length > 0) throw new Error(findings.map(formatFinding).join("\n"));

	const byPath = new Map(docs.map((doc) => [doc.path, doc]));
	const reverse = new Map<string, { path: string; structural: boolean }[]>();
	for (const doc of docs) {
		const members = new Set(children(doc));
		for (const entry of entries(doc, "Required")) {
			const target = rooted(entry.target!)!;
			const dependents = reverse.get(target) ?? [];
			dependents.push({ path: doc.path, structural: members.has(target) });
			reverse.set(target, dependents);
		}
	}

	// Assign the root's subtrees their priority before scoring. In particular,
	// many later-milestone dependents cannot promote a later candidate.
	const priority = new Map<string, number>();
	const assign = (path: string, rank: number) => {
		if (priority.has(path)) return;
		priority.set(path, rank);
		const doc = byPath.get(path);
		if (doc) for (const child of children(doc)) assign(child, rank);
	};
	const root = byPath.get(ROOT);
	if (root) children(root).forEach(assign);

	const impact = (path: string): number => {
		const visited = new Set([path]);
		const dependents = new Set<string>();
		const pending = [path];
		for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
			for (const edge of reverse.get(next) ?? []) {
				if (!edge.structural && !permanent(edge.path) && edge.path !== path) dependents.add(edge.path);
				// Membership does not score, but traversing it lets a real
				// dependency on an epic reach that epic's remaining work.
				if (visited.has(edge.path)) continue;
				visited.add(edge.path);
				pending.push(edge.path);
			}
		}
		return dependents.size;
	};

	return { priority: (path) => priority.get(path) ?? Infinity, impact };
}

/**
 * Milestone order, descending downstream impact, then existing ready order.
 * Readiness and impact are local facts, independent of claims or outside conditions.
 */
export function unblocked(docs: Doc[]): RankedQuest[] {
	const rank = ranking(docs);
	return ready(docs)
		.map((path) => ({ path, dependents: rank.impact(path) }))
		.sort((a, b) => rank.priority(a.path) - rank.priority(b.path) || b.dependents - a.dependents);
}

/** A quest with a `## Waiting` section, as `quest waiting` lists it. */
export interface WaitingQuest {
	path: string;
	/** Distinct transitive dependents, as `quest unblocked` counts them. */
	dependents: number;
	/** No `Required` entry remains, so clearing its waits lets it start. */
	ready: boolean;
	waits: Wait[];
}

/**
 * Every quest with a `## Waiting` section: those waiting on the maintainer
 * first, then milestone order, descending downstream impact, ready before
 * blocked, then tree order. Validates the tree first, as `unblocked` does.
 */
export function waiting(docs: Doc[]): WaitingQuest[] {
	const rank = ranking(docs);
	const startable = new Set(ready(docs));
	const maintainer = (quest: WaitingQuest) => (quest.waits.some(onMaintainer) ? 0 : 1);
	return docs
		.map((doc) => ({ path: doc.path, waits: waits(doc) }))
		.filter((quest) => quest.waits.length > 0)
		.map((quest) => ({
			path: quest.path,
			dependents: rank.impact(quest.path),
			ready: startable.has(quest.path),
			waits: quest.waits,
		}))
		.sort(
			(a, b) =>
				maintainer(a) - maintainer(b) ||
				rank.priority(a.path) - rank.priority(b.path) ||
				b.dependents - a.dependents ||
				Number(b.ready) - Number(a.ready),
		);
}
