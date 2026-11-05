// Rank ready work without mistaking the epic index for downstream work.

import { handBackWaits } from "./claim";
import { type Doc, branchQuest, children, entries, permanent, rooted } from "./doc";
import { ready, treeOrder } from "./ready";
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

/** An open draft PR, as `quest waiting` reads its hand-back. */
export interface Draft {
	url: string;
	/** Its head branch, which names the quest it carries when it is a claim. */
	branch: string;
	body: string;
}

/** A quest with a `## Waiting` section, or a draft PR handed back, as `quest waiting` lists it. */
export interface WaitingQuest {
	/** The quest, or the one the draft carries; `null` for a draft that carries none. */
	path: string | null;
	/** The draft's URL, or `null` for a quest's own section. */
	pr: string | null;
	/** Distinct transitive dependents, as `quest unblocked` counts them. */
	dependents: number;
	/** No `Required` entry remains, so clearing its waits lets the work go on. */
	ready: boolean;
	waits: Wait[];
}

/**
 * Every quest with a `## Waiting` section and every draft in `drafts` handed
 * back with one: those waiting on the maintainer first, then milestone order,
 * descending downstream impact, ready before blocked, then tree order, with
 * drafts after quests in the order given. A draft ranks as the quest its branch
 * carries, or last when it carries none. Validates the tree first, as
 * `unblocked` does.
 */
export function waiting(docs: Doc[], drafts: Draft[] = []): WaitingQuest[] {
	const rank = ranking(docs);
	const startable = new Set(ready(docs));
	const maintainer = (quest: WaitingQuest) => (quest.waits.some(onMaintainer) ? 0 : 1);
	const priority = (quest: WaitingQuest) => (quest.path === null ? Infinity : rank.priority(quest.path));
	const byPath = new Map(docs.map((doc) => [doc.path, doc]));
	const entry = (path: string | null, pr: string | null, found: Wait[]): WaitingQuest => ({
		path,
		pr,
		dependents: path === null ? 0 : rank.impact(path),
		ready: path === null || startable.has(path),
		waits: found,
	});
	const quests = treeOrder(docs).map((path) => entry(path, null, waits(byPath.get(path)!)));
	const pulls = drafts.map((draft) => {
		const quest = branchQuest(draft.branch);
		return entry(byPath.has(quest) ? quest : null, draft.url, handBackWaits(draft.body));
	});
	// The sort is stable, so ties keep tree order, as they do in `unblocked`.
	return [...quests, ...pulls]
		.filter((quest) => quest.waits.length > 0)
		.sort(
			(a, b) =>
				maintainer(a) - maintainer(b) ||
				priority(a) - priority(b) ||
				b.dependents - a.dependents ||
				Number(b.ready) - Number(a.ready),
		);
}
