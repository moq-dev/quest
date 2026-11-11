// The quest tree each quest's PR builds on: the default branch's, or, for a
// quest in an epic with a branch, that branch's as it will be once the default
// branch is next merged into it. A quest finished on its epic's branch is
// still on the default branch until the epic lands, and one finished on the
// default branch reaches the epic's branch only at that merge, so neither tree
// alone answers.

import { type Source, branchEpic, epicOf, mergeSources, parse } from "../core";
import { GitError, git } from "./git";
import { type Note, type Snapshot, checkout, committedSources, sources } from "./tree";

/** The default branch's side: its tree, its sources, and the commit merge bases are found from. */
export interface Main {
	snapshot: Snapshot;
	sources: Source[];
	commit: string;
}

/** The trees quests are read from: the default branch's, and each epic branch's by epic README. */
export interface Views {
	main: Snapshot;
	epics: Map<string, Snapshot>;
}

/** The default branch's side at `commit`. */
export function mainAt(root: string, commit: string, note: Note): Main {
	const tree = committedSources(root, commit, note);
	const docs = tree.sources.map((source) => parse(source.path, source.text));
	return { snapshot: { docs, exists: tree.exists }, sources: tree.sources, commit };
}

/** The checkout as the default branch's side, with `HEAD` for merge bases. */
export function mainCheckout(root: string, note: Note): Main {
	return { snapshot: checkout(root, note), sources: sources(root), commit: "HEAD" };
}

/** The tree `path` is read from. */
export function viewOf(views: Views, path: string): Snapshot {
	return views.epics.get(epicOf(path) ?? path) ?? views.main;
}

/** The tree the epic branch at `tip`, a local commit, holds once `main` is next merged into it. */
export function epicView(root: string, main: Main, tip: string, note: Note): Snapshot {
	const base = git(root, ["merge-base", main.commit, tip]);
	const [was, epic] = [committedSources(root, base, note), committedSources(root, tip, note)];
	const merged = mergeSources(was.sources, epic.sources, main.sources);
	return {
		docs: merged.map((source) => parse(source.path, source.text)),
		// As mergeSources keeps documents: a path either side deleted stays deleted, one either side added exists.
		exists: (path) =>
			was.exists(path)
				? main.snapshot.exists(path) && epic.exists(path)
				: main.snapshot.exists(path) || epic.exists(path),
	};
}

/** The views of `main` and of each epic branch among `tips`, branch names to local commits. */
export function views(root: string, main: Main, tips: ReadonlyMap<string, string>, note: Note): Views {
	const epics = new Map<string, Snapshot>();
	for (const [branch, tip] of tips) {
		const readme = branchEpic(branch);
		if (readme !== null) epics.set(readme, epicView(root, main, tip, note));
	}
	return { main: main.snapshot, epics };
}

/**
 * The `quest/*` branches of `remote` as last fetched, by branch name, with
 * their tips. None outside a git repository or without the remote.
 */
export function tracked(root: string, remote: string): Map<string, string> {
	const prefix = `refs/remotes/${remote}/`;
	let listing: string;
	try {
		listing = git(root, ["for-each-ref", "--format=%(objectname) %(refname)", `${prefix}quest/`]);
	} catch (error) {
		if (error instanceof GitError) return new Map();
		throw error;
	}
	const tips = new Map<string, string>();
	for (const line of listing.split("\n")) {
		if (line === "") continue;
		const [sha, ref] = line.split(" ");
		tips.set(ref.slice(prefix.length), sha);
	}
	return tips;
}
