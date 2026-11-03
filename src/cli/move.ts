// `quest mv` and `quest rm`: git moves or deletes the files and stages the
// change, and the core edits the links in the documents that remain.
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";

import { check, formatFinding, isQuest, move, normalize, permanent, questBranch, relocate, remove } from "../core";
import { type ClaimDependencies, claims } from "./claims";
import { checkout, exists, sources, under } from "./tree";

/** What a command changed, and what it left for the caller to look at. */
export interface Report {
	/** `R from -> to`, `D path`, or `M path`, one per change. */
	changes: string[];
	/** Mentions left for a person to edit, as `path:line: message`. */
	warnings: string[];
	/** `quest check` on the result. */
	findings: string[];
}

/**
 * Move a quest, or an epic directory and everything under it, and rewrite
 * every root-absolute link to it. Refuses while a moved quest is claimed,
 * since its branch would no longer name it.
 */
export async function moveQuest(
	root: string,
	fromArg: string,
	toArg: string,
	deps: ClaimDependencies,
): Promise<Report> {
	workTree(root);
	const from = treePath(root, fromArg);
	const to = treePath(root, toArg);
	if (!exists(root, from)) throw new Error(`${fromArg} does not exist`);
	const directory = statSync(join(root, from)).isDirectory();
	if (from === "quest" || permanent(directory ? `${from}/README.md` : from)) {
		throw new Error(`${fromArg} is permanent; the root epic and milestones never move`);
	}
	if (!directory && !isQuest(from)) throw new Error(`${fromArg} is not a quest document`);
	if (!directory && !isQuest(to)) throw new Error(`${toArg} must name a Markdown quest document`);
	if (exists(root, to)) throw new Error(`${toArg} already exists`);
	if (relocate(to, from, from) !== null) throw new Error(`cannot move ${fromArg} inside itself`);

	const docs = sources(root);
	const moving = docs.filter((doc) => relocate(doc.path, from, to) !== null);
	if (moving.length === 0) throw new Error(`${fromArg} holds no quest documents`);
	const held = await claims(
		root,
		"origin",
		moving.map((doc) => questBranch(doc.path)),
		deps,
	);
	if (held.length > 0) {
		const list = held.map((claim) => (claim.url ? `${claim.branch} (${claim.url})` : claim.branch)).join(", ");
		throw new Error(
			`refusing to move claimed quests: ${list}; their branches would no longer name them, so move them once the work merges or the claim is released`,
		);
	}

	const edited = move(docs, from, to);
	mkdirSync(join(root, posix.dirname(to)), { recursive: true });
	git(root, "mv", "--", from, to);
	write(root, edited.texts);
	const warnings = edited.missed.map(
		(link) =>
			`${relocate(link.path, from, to) ?? link.path}:${link.line}: links ${link.target} in a form mv cannot rewrite; update it by hand`,
	);
	return {
		changes: [`R ${from} -> ${to}`, ...modified(edited.texts)],
		warnings: [...warnings, ...mentions(root, from)],
		findings: findings(root),
	};
}

/**
 * Delete a quest, or an epic with the quests under it, and drop every list
 * entry that links to what was deleted. The root and milestones are permanent.
 */
export function removeQuest(root: string, arg: string, recursive: boolean): Report {
	workTree(root);
	const target = treePath(root, arg);
	if (!exists(root, target)) throw new Error(`${arg} does not exist`);
	const directory = statSync(join(root, target)).isDirectory();
	if (target === "quest" || permanent(directory ? `${target}/README.md` : target)) {
		throw new Error(`${arg} is permanent; the root epic and milestones are never removed`);
	}
	if (!directory && !isQuest(target)) throw new Error(`${arg} is not a quest document`);

	// An epic is its directory, or its README while it still holds other quests.
	const epic = directory ? target : posix.basename(target) === "README.md" ? posix.dirname(target) : null;
	const docs = sources(root);
	const inside = epic === null ? [] : docs.filter((doc) => relocate(doc.path, epic, epic) !== null);
	const whole = epic !== null && (directory || inside.length > 1);
	const doomed = whole ? inside : docs.filter((doc) => doc.path === target);
	if (doomed.length === 0) throw new Error(`${arg} holds no quest documents`);
	if (whole && doomed.length > 1 && !recursive) {
		throw new Error(`${arg} is an epic holding ${doomed.length} quest documents; pass -r to remove them all`);
	}

	const gone = new Set(doomed.map((doc) => doc.path));
	const edited = remove(docs, (path) => gone.has(path));
	git(root, "rm", "-q", ...(whole ? ["-r"] : []), "--", whole ? epic! : target);
	write(root, edited);
	return {
		changes: [...doomed.map((doc) => `D ${doc.path}`), ...modified(edited)],
		warnings: mentions(root, whole ? epic! : target),
		findings: findings(root),
	};
}

/**
 * A quest path as the tree writes it (`/quest/m0/a.md`), as the shell
 * completes it (`quest/m0/a.md`), or as a filesystem path to it.
 */
function treePath(root: string, arg: string): string {
	const tree = normalize(arg.replace(/^\/(?=quest(\/|$))/, ""));
	const path =
		tree === "quest" || tree.startsWith("quest/")
			? tree
			: relative(resolve(root), resolve(arg)).split(sep).join("/");
	if (path !== "quest" && !path.startsWith("quest/")) throw new Error(`${arg} is not under ${under(root, "quest")}`);
	return path;
}

/** Fail outside a git work tree: these commands stage their change. */
function workTree(root: string) {
	try {
		git(root, "rev-parse", "--is-inside-work-tree");
	} catch {
		throw new Error(`${root} is not in a git work tree; quest mv and rm stage their change with git`);
	}
}

function git(root: string, ...args: string[]): string {
	try {
		return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr?.trim();
		throw new Error(stderr || (error as Error).message);
	}
}

/** Write and stage each edited document. */
function write(root: string, texts: Map<string, string>) {
	if (texts.size === 0) return;
	for (const [path, text] of texts) writeFileSync(join(root, path), text);
	git(root, "add", "--", ...texts.keys());
}

function modified(texts: Map<string, string>): string[] {
	return [...texts.keys()].sort().map((path) => `M ${path}`);
}

/**
 * Every line in a tracked or unignored untracked file that still names
 * `path`, or a path under it, which no
 * edit could safely change. A longer sibling name, such as `drain.md` or
 * `drain-2` for `drain`, is not a mention; a trailing full stop is.
 */
function mentions(root: string, path: string): string[] {
	const pattern = `${path.replace(/[.[\]()*+?{}|^$\\]/g, "\\$&")}\\.*([^A-Za-z0-9_.-]|$)`;
	let out: string;
	try {
		out = execFileSync(
			"git",
			["-C", root, "grep", "--untracked", "--exclude-standard", "-n", "-I", "-E", "-e", pattern],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
	} catch (error) {
		// git grep exits 1 when nothing matches.
		if ((error as { status?: number }).status === 1) return [];
		throw error;
	}
	return out
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => {
			const [file, number] = line.split(":", 2);
			return `${file}:${number}: mentions ${path}; update it by hand`;
		});
}

function findings(root: string): string[] {
	// A move or removal changes no submodule, so a skip `quest check` would note is not news here.
	const tree = checkout(root, () => {});
	return check(tree.docs, tree.exists).map(formatFinding);
}
