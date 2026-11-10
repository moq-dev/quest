// Epic branches: each epic directly under a milestone has a branch, its
// README's quest branch, that its quests' PRs target and that lands on the
// default branch as one PR. A quest finished there is deleted on that branch
// alone until the epic lands, so readiness reads each quest's tree from the
// branch its PR targets.

import { questBranch } from "./doc";
import { type Source, remove } from "./edit";
import { comparePaths } from "./path";

/**
 * The README of the epic whose branch `path`'s PR targets: the epic directly
 * under its milestone, however deep `path` sits in it. `null` for a quest
 * directly under a milestone and for an epic's own README, which target the
 * default branch.
 */
export function epicOf(path: string): string | null {
	const parts = path.split("/");
	if (parts[0] !== "quest" || parts.length < 4) return null;
	const readme = `${parts.slice(0, 3).join("/")}/README.md`;
	return readme === path ? null : readme;
}

/** The branch `path`'s PR targets, or `null` for the default branch. */
export function epicBranch(path: string): string | null {
	const readme = epicOf(path);
	return readme === null ? null : questBranch(readme);
}

/** The epic README whose branch `branch` is, or `null` when it names no epic directly under a milestone. */
export function branchEpic(branch: string): string | null {
	const readme = `${branch}.md`;
	return /^quest\/[^/]+\/[^/]+\/README\.md$/.test(readme) ? readme : null;
}

/**
 * The quest tree an epic's branch holds once the default branch is next
 * merged into it, from the two sides' sources and their merge base's: each
 * document as the side that changed it left it, deleted when either side
 * deleted it, and the epic's version when both edited it. List entries
 * linking to a document dropped this way go too, as `quest rm` drops them.
 */
export function mergeSources(base: Source[], epic: Source[], main: Source[]): Source[] {
	const read = (sources: Source[]) => new Map(sources.map((source) => [source.path, source.text]));
	const [was, ours, theirs] = [read(base), read(epic), read(main)];
	const paths = new Set([...was.keys(), ...ours.keys(), ...theirs.keys()]);
	const kept = new Map<string, string>();
	for (const path of paths) {
		const [before, left, right] = [was.get(path), ours.get(path), theirs.get(path)];
		const text =
			left === before
				? right
				: right === before
					? left
					: left === undefined || right === undefined
						? undefined
						: left;
		if (text !== undefined) kept.set(path, text);
	}
	const sources = [...kept].map(([path, text]) => ({ path, text }));
	const edited = remove(sources, (path) => paths.has(path) && !kept.has(path));
	return sources
		.map((source) => ({ path: source.path, text: edited.get(source.path) ?? source.text }))
		.sort((a, b) => comparePaths(a.path, b.path));
}
