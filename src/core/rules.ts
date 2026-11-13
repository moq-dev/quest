// The rules, and the findings they produce.
//
// The contract is the guide (`quest guide`). Every rule here is one that has
// already been broken by hand, and the expensive failure is a rule that stops
// firing: a validator that quietly enforces nothing looks exactly like a clean
// tree.
//
// The whole tree is validated on every run, never just the changed files: the
// link graph and the epic directories are global, so completing one quest
// breaks files the diff never mentions. That is not hypothetical - it is how a
// link to a completed quest survived a rebase that produced no conflict at
// all.

import {
	type Doc,
	type Entry,
	children,
	entries,
	has,
	holds,
	HOST,
	HOSTS,
	hostOf,
	SCHEDULED,
	dateOf,
	isEpic,
	owner,
	permanent,
	questBranch,
	gates,
	resolve,
	rooted,
	size,
	withoutFragment,
} from "./doc";
import { comparePaths, join } from "./path";
import { MAINTAINER, WAITING, parseWait } from "./waiting";

/**
 * The `## ` headings a quest document may use. Readiness greps `## Required`
 * literally, so a typo turns a blocked quest ready and fails nowhere else: the
 * closed vocabulary is what catches it.
 */
export const HEADINGS = ["Goal", "Plan", "Hosts", "Waiting", "Scheduled", "Required", "Closes", "Related"];

/**
 * Sections whose whole content is a list. A heading left standing after its
 * last entry was removed is a bug: an empty `Required` blocks its quest
 * forever.
 */
export const LIST_SECTIONS = ["Hosts", "Waiting", "Scheduled", "Required", "Closes", "Related"];

/** The permanent root epic; the one document nothing has to list. */
export const ROOT = "quest/README.md";

/** One violation, addressed like a compiler diagnostic: `path:line: message`. */
export interface Finding {
	/** Repository-relative document the violation is in. */
	path: string;
	/** 1-based line, when the violation has one; `null` for whole-file findings. */
	line: number | null;
	/** What is wrong, and often why the rule exists. */
	message: string;
}

/** `path:line: message`, or `path: message` for a whole-file finding. */
export function formatFinding(finding: Finding): string {
	return finding.line === null
		? `${finding.path}: ${finding.message}`
		: `${finding.path}:${finding.line}: ${finding.message}`;
}

function compareFindings(a: Finding, b: Finding): number {
	return (
		comparePaths(a.path, b.path) ||
		(a.line ?? 0) - (b.line ?? 0) ||
		(a.message < b.message ? -1 : a.message > b.message ? 1 : 0)
	);
}

/**
 * Validate a whole tree. `docs` is every quest document, and `exists` reports
 * whether a repository-relative path (a file or a directory) exists, which is
 * how links outside the tree resolve. Returns every finding, sorted.
 */
export function check(docs: Doc[], exists: (path: string) => boolean): Finding[] {
	const found: Finding[] = [];
	const known = new Set(docs.map((d) => d.path));

	for (const doc of docs) {
		headings(found, docs, doc);
		links(found, exists, known, doc);
	}

	collisions(found, known, docs);
	membership(found, known, docs);
	milestones(found, docs);
	inversions(found, docs);
	cycles(found, docs);

	return found.sort(compareFindings);
}

/**
 * A quest's branch cannot be a prefix of another's: git stores refs as files
 * and directories, so `quest/m0/foo` cannot exist beside `quest/m0/foo/bar`.
 * A quest `X.md` therefore collides with every document under `X/`. That
 * includes a directory named `README` under an epic, whose children's branches
 * nest under the epic's `.../README` branch.
 */
function collisions(found: Finding[], known: Set<string>, docs: Doc[]) {
	const paths = [...known].sort(comparePaths);
	for (const doc of docs) {
		const dir = `${questBranch(doc.path)}/`;
		const readme = `${dir}README.md`;
		const nested = known.has(readme) ? readme : paths.find((path) => path.startsWith(dir));
		if (nested === undefined) continue;
		found.push({
			path: doc.path,
			line: null,
			message: `quest path collides with ${nested}; rename one of these documents`,
		});
	}
}

function headings(found: Finding[], docs: Doc[], doc: Doc) {
	if (!isEpic(docs, doc)) {
		if (size(doc) === null)
			found.push({ path: doc.path, line: null, message: "quest title must be '# [XS|S|M|L|XL] Title'" });
	}

	if (!has(doc, "Goal")) found.push({ path: doc.path, line: null, message: "missing '## Goal'" });

	for (const heading of doc.headings) {
		// A setext underline and a decorated ``## `Required` `` both render as the
		// same heading, and this validator would treat the quest as blocked.
		// Readiness greps `^## Required$` literally and would call it READY.
		if (HEADINGS.includes(heading.text) && !heading.literal) {
			found.push({
				path: doc.path,
				line: heading.line,
				message: `'${heading.text}' must be written literally as '## ${heading.text}'; readiness greps that form and would not see this one`,
			});
		}
		if (!HEADINGS.includes(heading.text)) {
			found.push({
				path: doc.path,
				line: heading.line,
				message: `unknown '## ${heading.text}' (allowed: ${HEADINGS.join(", ")})`,
			});
		}
	}

	// A section name at any other level is invisible to readiness and to `quest
	// waiting`, so a `### Waiting` would drop its items out of the list silently.
	for (const heading of doc.offLevel) {
		if (HEADINGS.includes(heading.text)) {
			found.push({
				path: doc.path,
				line: heading.line,
				message: `'${"#".repeat(heading.depth)} ${heading.text}' must be '## ${heading.text}': readiness and quest waiting read only '## ' sections`,
			});
		}
	}

	for (const heading of doc.headings) {
		if (LIST_SECTIONS.includes(heading.text) && entries(doc, heading.text).length === 0) {
			const why =
				heading.text === "Required"
					? "; an empty one blocks the quest forever, so remove the heading with its last entry"
					: "; remove the heading with its last entry";
			found.push({ path: doc.path, line: heading.line, message: `'## ${heading.text}' is empty${why}` });
		}
	}

	// A dispatcher routes on these values, so a typo would strand the quest on no host.
	for (const entry of entries(doc, HOSTS)) {
		if (hostOf(entry) === null) {
			found.push({
				path: doc.path,
				line: entry.line,
				message: `'## ${HOSTS}' item must open with one of ${HOST.join(", ")}, optionally followed by ' - why'`,
			});
		}
	}

	// Readiness compares the date as text, so anything but a real `YYYY-MM-DD`
	// would block the quest forever. A second date only says the same thing worse.
	entries(doc, SCHEDULED).forEach((entry, index) => {
		const message =
			dateOf(entry) === null
				? `'## ${SCHEDULED}' item must be a date, as 'YYYY-MM-DD' optionally followed by ' - why'`
				: index > 0
					? `'## ${SCHEDULED}' holds one date; keep the one the work waits for`
					: null;
		if (message !== null) found.push({ path: doc.path, line: entry.line, message });
	});

	// `quest waiting` sorts on who acts, so an item that does not name its
	// party would hide a decision the maintainer owes.
	for (const entry of entries(doc, WAITING)) {
		if (parseWait(entry) === null) {
			found.push({
				path: doc.path,
				line: entry.line,
				message: `'## ${WAITING}' item must open with who acts, as '${MAINTAINER}: ...' or '<party>: ...'`,
			});
		}
	}
}

function links(found: Finding[], exists: (path: string) => boolean, known: Set<string>, doc: Doc) {
	for (const link of doc.links) {
		if (link.target.includes("://") || link.target.startsWith("mailto:")) continue;
		const target = withoutFragment(link.target);
		if (target === "") continue;

		// A normalized path that still opens with `..` points above the
		// repository root. Testing whether it exists would follow it into
		// whatever sits beside the checkout, so the repo's own directory name (or
		// a sibling worktree) could make a broken link pass.
		const path = resolve(doc.path, target);
		if (path === null || !exists(path)) {
			found.push({ path: doc.path, line: link.line, message: `link does not resolve: ${link.target}` });
			continue;
		}

		// Quests and epics reference each other with root-absolute links. A
		// relative one still renders, so nothing else would notice - but it is
		// invisible to the dependency graph below, which only speaks /quest/...
		if (known.has(path) && !link.target.startsWith("/")) {
			found.push({
				path: doc.path,
				line: link.line,
				message: `link to a quest must be root-absolute: ${link.target} (write /${path})`,
			});
		}

		// A `Required` entry opens with its quest link. moq-dev/moq.pro#1170
		// shipped a customer-gate sentence mentioning an epic mid-line, which
		// reads as context but IS a blocker, and so silently required all of m2.
		if (link.section === "Required" && known.has(path) && link.position !== "entry") {
			found.push({
				path: doc.path,
				line: link.line,
				message: `Required links ${link.target} mid-sentence; that reads as prose but IS a blocker - open the bullet with the link, or drop the link`,
			});
		}
	}
}

/**
 * Every document sits in an epic: its directory has a README, and so does
 * each directory above it up to the root, so the tree reaches it. Every
 * `Required` entry is a quest, required once, and an epic requires nothing it
 * holds, since it already waits for everything in its directory.
 *
 * A condition outside the repository (a release, a customer, a person) is a
 * quest of its own rather than a plain-text bullet: a blocked quest drops out
 * of every ready listing, so the condition would be forgotten, while its own
 * quest keeps surfacing as ready until someone clears it.
 */
function membership(found: Finding[], known: Set<string>, docs: Doc[]) {
	for (const doc of docs) {
		const epic = join(owner(doc.path), "README.md");
		// The root epic is permanent and has nothing above it.
		if (doc.path !== ROOT && !known.has(epic)) {
			found.push({
				path: doc.path,
				line: null,
				message: `sits in ${owner(doc.path)}, which has no README.md; every directory under quest/ is an epic, so add its README or move the quest`,
			});
		}

		const seen = new Set<string>();
		for (const entry of entries(doc, "Required")) {
			const target = entry.target === null ? null : rooted(entry.target);
			if (target === null || !known.has(target)) {
				found.push({
					path: doc.path,
					line: entry.line,
					message: `requires ${entry.target ?? entry.text}, which is not a quest document; make an outside condition its own quest`,
				});
				continue;
			}
			if (seen.has(target)) {
				found.push({ path: doc.path, line: entry.line, message: `requires ${entry.target} twice` });
			}
			seen.add(target);
			if (holds(doc.path, target)) {
				found.push({
					path: doc.path,
					line: entry.line,
					message: `requires ${entry.target}, which this epic holds; an epic waits for everything in its directory, so remove the entry (quest check --fix does)`,
				});
			}
		}
	}
}

/**
 * A link to a finished milestone is removed. Milestones are permanent, so
 * unlike a finished quest, which is deleted, the link would keep resolving and
 * block its quest forever. A milestone is finished once its directory holds no
 * other quest and its README has no `## Required`. Its `## Scheduled` date
 * does not count: a date holds back only the quests under it, which an empty
 * milestone has none of, and reading it here would make `quest check` change
 * verdict on that day with no commit.
 *
 * Readiness stays a grep for the heading; this rule is what keeps that answer
 * true once the milestone empties. A root entry naming a milestone is the
 * membership rule's finding, not this one's.
 */
function milestones(found: Finding[], docs: Doc[]) {
	const finished = finishedMilestone(docs);
	for (const doc of docs) {
		for (const entry of entries(doc, "Required")) {
			if (!finished(doc, entry)) continue;
			found.push({
				path: doc.path,
				line: entry.line,
				message: `requires ${entry.target}, a finished milestone; remove the link, and the '## Required' heading with its last entry`,
			});
		}
	}
}

/**
 * Whether `entry`, in `doc`, is a `Required` link to a milestone of `docs`
 * that is finished. Shared with `quest rm`, which drops these links.
 */
export function finishedMilestone(docs: Doc[]): (doc: Doc, entry: Entry) => boolean {
	const byPath = new Map(docs.map((d) => [d.path, d]));
	return (doc, entry) => {
		if (doc.path === ROOT || entry.section !== "Required" || entry.target === null) return false;
		const target = rooted(entry.target);
		if (target === null || target === ROOT || !permanent(target)) return false;
		const milestone = byPath.get(target);
		return milestone !== undefined && !has(milestone, "Required") && !docs.some((d) => holds(target, d.path));
	};
}

/**
 * The milestone README of the root child directory holding `path`, or `null`
 * for the root README and files directly under the root.
 */
function milestoneOf(path: string): string | null {
	const parts = path.split("/");
	return parts.length >= 3 ? `${parts[0]}/${parts[1]}/README.md` : null;
}

/**
 * A `Required` link must not point to a later milestone. `quest unblocked`
 * ranks a blocker by its own milestone, so an inverted link stalls the earlier
 * quest behind all of the later milestone's work. Which side moves is the
 * maintainer's priority call, so there is no fix. A milestone README cannot
 * move, since milestones are permanent.
 */
function inversions(found: Finding[], docs: Doc[]) {
	for (const doc of docs) {
		const from = milestoneOf(doc.path);
		if (from === null) continue;
		for (const entry of entries(doc, "Required")) {
			if (entry.target === null) continue;
			const target = rooted(entry.target);
			if (target === null) continue;
			const to = milestoneOf(target);
			if (to === null || comparePaths(to, from) <= 0) continue;
			const [early, late] = [from.split("/")[1], to.split("/")[1]];
			const name = (path: string) => path.replace(/\/README\.md$/, "");
			const moves = [
				permanent(target) ? null : `move ${name(target)} to ${early}`,
				permanent(doc.path) ? null : `move ${name(doc.path)} to ${late}`,
			].filter((move) => move !== null);
			const fix =
				moves.length > 0 ? `${moves.join(" or ")} with \`quest mv\`, or remove the link` : "remove the link";
			found.push({
				path: doc.path,
				line: entry.line,
				message: `in milestone ${early}, requires ${target} in later milestone ${late}; ${fix}`,
			});
		}
	}
}

/**
 * `Required` must be acyclic. A cycle is a set of quests none of which can ever
 * start, and walking the links to rule one out is exactly the manual step an
 * author would otherwise take before adding a blocker. An epic waits for its
 * children, so a quest requiring the epic that holds it is a cycle too. An
 * epic's `Required` gates everything under it, so a blocker that waits on a
 * quest under the epic requiring it is one as well.
 */
function cycles(found: Finding[], docs: Doc[]) {
	const blockers = new Map(docs.map((doc) => [doc.path, [...gates(docs, doc), ...children(docs, doc)]]));

	const state = new Map<string, "open" | "done">();
	const walk = (node: string, stack: string[]) => {
		const seen = state.get(node);
		if (seen === "done") return;
		if (seen === "open") {
			const from = Math.max(0, stack.indexOf(node));
			found.push({
				path: node,
				line: null,
				message: `Required cycle: ${[...stack.slice(from), node].join(" -> ")}`,
			});
			return;
		}
		state.set(node, "open");
		stack.push(node);
		for (const next of blockers.get(node) ?? []) walk(next, stack);
		stack.pop();
		state.set(node, "done");
	};

	for (const doc of docs) walk(doc.path, []);
}
