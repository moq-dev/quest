// The board's reading of a project: milestones, epics, and quests, each with its
// status and progress. Readiness comes from the shared core; coordinator jobs
// also claim quests before their branches appear in forge observations.

import {
	type Doc,
	ROOT,
	blockers,
	branchQuest,
	children,
	comparePaths,
	isEpic,
	parse,
	permanent,
	questBranch,
	ready,
} from "quest/core";
import type { Size } from "../layout";
import type { Change, Completed, Project } from "./project";

/**
 * A quest's most advanced state, per design/theme.md: Ready to turn in, then
 * Available or Requires.
 */
export type Status =
	| { kind: "turn-in"; change: Change }
	| { kind: "available" }
	| { kind: "pending" }
	/** Claimed by a quest branch, or by the draft PR its starter still holds. */
	| { kind: "accepted"; change?: Change; job?: string }
	| { kind: "blocked"; requires: Ref[] };

/** A link to another quest, or a blocker's own words when it names none. */
export type Ref = { title: string; href: string | null };

export type Quest = {
	path: string;
	href: string;
	title: string;
	size: Size | null;
	status: Status;
};

/** Finished work out of all work, by count and weighted by difficulty. */
export type Progress = { done: number; total: number; weight: number; totalWeight: number };

/** A milestone or epic: a directory of quests, listed in path order. */
export type Group = {
	path: string;
	href: string;
	title: string;
	progress: Progress;
	items: Item[];
};

export type Item = { kind: "quest"; quest: Quest } | { kind: "epic"; epic: Group };

export type Milestone = Group & { number: string; summary: string };

export type Finished = Completed & { href: string | null; name: string; size: Size | null; milestone: string | null };

export type Board = {
	project: Project;
	summary: string;
	milestones: Milestone[];
	counts: Record<Status["kind"], number>;
	finished: Finished[];
	docs: Map<string, Doc>;
	quests: Map<string, Quest>;
};

// Story points: the size ladder grows faster than linearly.
const WEIGHTS: Record<Size, number> = { XS: 1, S: 2, M: 3, L: 5, XL: 8 };

/** A `[S] Title` heading split into its size and its name. */
export function title(text: string): { size: Size | null; name: string } {
	const match = /^\[(XS|S|M|L|XL)\]\s+(.*)$/.exec(text);
	return match ? { size: match[1] as Size, name: match[2] } : { size: null, name: text };
}

export function boardHref(project: Project): string {
	return project.href ?? `/repos/${project.name}`;
}

/** A quest's page: its branch name, so an epic's ends in `/README`. The root's is the board. */
export function questHref(project: Project, path: string): string {
	if (path === ROOT) return boardHref(project);
	return `${boardHref(project)}/${encodePath(questBranch(path))}`;
}

/**
 * A file on the project's forge, or `null` when the project has no web address.
 * Paths are literal filenames; pass a `#fragment` separately so a filename's
 * `#` is encoded and the fragment remains a fragment.
 */
export function blobHref(project: Project, path: string, fragment = ""): string | null {
	return project.web ? `${project.web}/blob/${project.commit}/${encodePath(path)}${fragment}` : null;
}

export function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

/** A milestone's section on its board page: its directory name, such as `m0`. */
export function milestoneAnchor(milestone: Milestone): string {
	return milestone.path.split("/")[1] ?? "unsorted";
}

/** The document a page path names, as its branch does: `quest/m0/board` or `quest/m0/epic/README`. */
export function findDoc(board: Board, page: string): Doc | null {
	return board.docs.get(branchQuest(page)) ?? null;
}

/** The first paragraph of a section, as plain words. */
export function lead(content: string, section: string): string {
	const body = content.split(new RegExp(`^## ${section}$`, "m"))[1]?.split(/^## /m)[0] ?? "";
	const paragraph = body.trim().split(/\n\s*\n/)[0] ?? "";
	return paragraph
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[`*_]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function readBoard(project: Project, jobs: ReadonlyMap<string, string> = new Map()): Board {
	const sorted = [...project.documents].sort((a, b) => comparePaths(a.path, b.path));
	const parsed = sorted.map(({ path, content }) => parse(path, content));
	const docs = new Map(parsed.map((doc) => [doc.path, doc]));
	const contents = new Map(sorted.map(({ path, content }) => [path, content]));
	const open = new Set(ready(parsed));
	// Observations narrow the tree's ready quests; until they are complete, an
	// unseen change or claim may already occupy one.
	const free = project.available === undefined ? open : new Set(project.available ?? []);
	const changes = new Map(project.changes.map((change) => [change.quest, change]));

	const name = (path: string) => {
		const doc = docs.get(path);
		return doc?.title ? title(doc.title.text).name : path;
	};

	const status = (doc: Doc): Status => {
		const job = jobs.get(doc.path);
		if (job) return { kind: "accepted", job };
		const change = changes.get(doc.path);
		if (change) return change.owned ? { kind: "accepted", change } : { kind: "turn-in", change };
		if (project.claims?.includes(doc.path)) return { kind: "accepted" };
		if (free.has(doc.path)) return { kind: "available" };
		if (open.has(doc.path)) return { kind: "pending" };
		const requires = blockers(parsed, doc).map((blocker) =>
			blocker.path === null
				? { title: blocker.text, href: null }
				: { title: name(blocker.path), href: questHref(project, blocker.path) },
		);
		return { kind: "blocked", requires };
	};

	const quest = (doc: Doc): Quest => {
		const parsed = title(doc.title?.text ?? doc.path);
		return {
			path: doc.path,
			href: questHref(project, doc.path),
			title: parsed.name,
			size: parsed.size,
			status: status(doc),
		};
	};

	const dir = (path: string) => path.replace(/\/README\.md$/, "");
	const finishedUnder = (path: string) => project.completed.filter((c) => c.path.startsWith(`${dir(path)}/`));

	const progress = (path: string): Progress => {
		const under = (p: string) => p.startsWith(`${dir(path)}/`);
		const remaining = parsed.filter((doc) => under(doc.path) && !isEpic(parsed, doc));
		const done = finishedUnder(path);
		const weigh = (titles: string[]) => titles.reduce((sum, text) => sum + WEIGHTS[title(text).size ?? "XS"], 0);
		const weight = weigh(done.map((c) => c.title));
		return {
			done: done.length,
			total: done.length + remaining.length,
			weight,
			totalWeight: weight + weigh(remaining.map((doc) => doc.title?.text ?? "")),
		};
	};

	// A group's items are its children: the quests in its directory, in path order.
	const seen = new Set<string>([ROOT]);
	const group = (doc: Doc): Group => {
		seen.add(doc.path);
		const items = children(parsed, doc).flatMap((path): Item[] => {
			if (seen.has(path)) return [];
			seen.add(path);
			const child = docs.get(path)!;
			return isEpic(parsed, child)
				? [{ kind: "epic", epic: group(child) }]
				: [{ kind: "quest", quest: quest(child) }];
		});
		return {
			path: doc.path,
			href: questHref(project, doc.path),
			title: name(doc.path),
			progress: progress(doc.path),
			items,
		};
	};

	const milestones = parsed
		.filter((doc) => doc.path !== ROOT && permanent(doc.path))
		.map((doc): Milestone => {
			const segment = doc.path.split("/")[1];
			return {
				...group(doc),
				number: /^[a-z](\d+)$/.exec(segment)?.[1] ?? segment,
				summary: lead(contents.get(doc.path) ?? "", "Goal"),
			};
		});

	// Quests outside every milestone still show, in a group of their own.
	const rest = parsed.filter((doc) => !seen.has(doc.path) && !isEpic(parsed, doc)).map(quest);
	if (rest.length > 0) {
		milestones.push({
			path: "quest",
			href: questHref(project, ROOT),
			title: "Unsorted",
			number: "",
			summary: "Quests outside every milestone.",
			progress: { done: 0, total: rest.length, weight: 0, totalWeight: 0 },
			items: rest.map((quest) => ({ kind: "quest", quest })),
		});
	}

	const all = milestones.flatMap((milestone) => flatten(milestone.items));
	const counts = { "turn-in": 0, available: 0, pending: 0, blocked: 0, accepted: 0 };
	for (const q of all) counts[q.status.kind]++;

	const milestoneOf = (path: string) => milestones.find((c) => c.number !== "" && path.startsWith(`${dir(c.path)}/`));
	const finished = project.completed.map((c): Finished => {
		const parsed = title(c.title);
		const milestone = milestoneOf(c.path);
		return {
			...c,
			name: parsed.name,
			size: parsed.size,
			milestone: milestone ? `Milestone ${milestone.number}` : null,
			href: project.web ? `${project.web}/commit/${c.commit}` : null,
		};
	});

	return {
		project,
		summary: lead(contents.get(ROOT) ?? "", "Goal"),
		milestones,
		counts,
		finished,
		docs,
		quests: new Map(all.map((q) => [q.path, q])),
	};
}

/** Only the quests with this status, dropping epics left empty. */
export function only(items: Item[], kind: Status["kind"]): Item[] {
	return items.flatMap((item): Item[] => {
		if (item.kind === "quest") return item.quest.status.kind === kind ? [item] : [];
		const kept = only(item.epic.items, kind);
		return kept.length > 0 ? [{ kind: "epic", epic: { ...item.epic, items: kept } }] : [];
	});
}

export function flatten(items: Item[]): Quest[] {
	return items.flatMap((item) => (item.kind === "quest" ? [item.quest] : flatten(item.epic.items)));
}

/** The groups that hold a document, outermost first: its milestone, then any epics. */
export function trail(board: Board, path: string): Group[] {
	const found: Group[] = [];
	const visit = (group: Group): boolean =>
		group.items.some((item) => {
			if (item.kind === "quest") return item.quest.path === path;
			if (item.epic.path === path) return true;
			if (!visit(item.epic)) return false;
			found.unshift(item.epic);
			return true;
		});
	const milestone = board.milestones.find((milestone) => milestone.path !== path && visit(milestone));
	return milestone ? [milestone, ...found] : [];
}

/** The group a document heads, if it is a milestone or an epic. */
export function findGroup(board: Board, path: string): Group | null {
	const search = (groups: Group[]): Group | null => {
		for (const group of groups) {
			if (group.path === path) return group;
			const epics = group.items.flatMap((item) => (item.kind === "epic" ? [item.epic] : []));
			const found = search(epics);
			if (found) return found;
		}
		return null;
	};
	return search(board.milestones);
}
