// Loading the quest tree for the core to read: from a checkout on disk, or
// from a commit, such as the upstream default branch's tip.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { type Doc, type Source, comparePaths, isQuest, parse } from "../core";

/**
 * `<root>/<path>` as a user would name it in an error: `./quest`, not the
 * normalized `quest`.
 */
export function under(root: string, path: string): string {
	return `${root.replace(/\/+$/, "")}/${path}`;
}

/** Every quest document under `<root>/quest`, sorted, repository-relative. */
export function collect(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		// Dirent types do not follow symlinks, so a symlinked AGENTS.md is a file
		// here and a directory symlink can never make this recurse forever.
		for (const entry of readdirSync(under(root, dir), { withFileTypes: true })) {
			const path = `${dir}/${entry.name}`;
			if (entry.isDirectory()) {
				walk(path);
			} else if (isQuest(path)) {
				out.push(path);
			}
		}
	};
	try {
		walk("quest");
	} catch (error) {
		throw new Error(`scanning ${under(root, "quest")}: ${(error as Error).message}`);
	}
	return out.sort(comparePaths);
}

/** Every quest document's source text, in tree order. */
export function sources(root: string): Source[] {
	const paths = collect(root);
	if (paths.length === 0) throw new Error(`no quest documents found under ${under(root, "quest")}`);
	return paths.map((path) => ({ path, text: read(root, path) }));
}

/** Every quest document, parsed, in tree order. */
export function load(root: string): Doc[] {
	return sources(root).map((source) => parse(source.path, source.text));
}

/** Whether a repository-relative path exists under `root`, on disk alone. */
export function exists(root: string, path: string): boolean {
	return existsSync(join(root, path));
}

/** A quest tree as `quest check` reads it: its documents, and whether a repository-relative path exists. */
export interface Snapshot {
	docs: Doc[];
	exists(path: string): boolean;
}

/**
 * Called once per submodule whose links are skipped, rather than reported broken,
 * because no local git directory holds the commit its gitlink pins.
 */
export type Note = (message: string) => void;

/**
 * The quest tree in the checkout at `root`. A path inside a submodule that is
 * not checked out, as in a fresh worktree, resolves at the submodule's pinned
 * commit instead of its empty directory.
 */
export function checkout(root: string, note: Note): Snapshot {
	return { docs: load(root), exists: onDisk(root, note) };
}

/**
 * The quest tree at `commit`, read from git rather than the checkout, with
 * paths relative to `root` as on disk. A symbolic link is a path, not a quest.
 * A path inside a submodule resolves at the commit its gitlink pins; with
 * `note` null, as in a bare repository with no submodule checkouts, every such
 * path exists instead.
 */
export function snapshot(root: string, commit: string, note: Note | null): Snapshot {
	const tree = committedSources(root, commit, note);
	return { docs: tree.sources.map((source) => parse(source.path, source.text)), exists: tree.exists };
}

/** A quest document as committed: its source text and its file mode. */
export interface CommittedSource extends Source {
	mode: string;
}

/**
 * Every quest document's source at `commit`, a commit or a tree, in tree order, read from git
 * objects alone, as `snapshot` reads them, and whether a repository-relative path exists there.
 */
export function committedSources(
	root: string,
	commit: string,
	note: Note | null,
): { sources: CommittedSource[]; exists(path: string): boolean } {
	const repo = { dir: root };
	const tree = committed(repo, commit, note, "");
	const quests = tree.entries.filter(
		({ mode, type, path }) => type === "blob" && mode !== "120000" && path.startsWith("quest/") && isQuest(path),
	);
	if (quests.length === 0) throw new Error(`no quest documents found under ${under(root, "quest")} at ${commit}`);

	// One `cat-file --batch` reads every document: `<oid> blob <size>\n<content>\n` each, in input order.
	const batch = git(repo, ["cat-file", "--batch"], `${quests.map((quest) => quest.oid).join("\n")}\n`);
	let offset = 0;
	const sources = quests.map(({ path, mode }) => {
		const header = batch.indexOf(10, offset);
		const size = Number(batch.toString("utf8", offset, header).split(" ")[2]);
		const text = decode(batch.subarray(header + 1, header + 1 + size), path);
		offset = header + size + 2;
		return { path, mode, text };
	});
	return { sources: sources.sort((a, b) => comparePaths(a.path, b.path)), exists: tree.exists };
}

/** A repository to read: a work tree, or a submodule's git directory without one. */
type Repo = { dir: string } | { gitdir: string };

interface Entry {
	mode: string;
	type: string;
	oid: string;
	path: string;
}

interface Tree {
	entries: Entry[];
	exists(path: string): boolean;
}

/**
 * Whether a path exists in the checkout at `root`: on disk, or, inside a
 * submodule that is not checked out, at the commit its gitlink pins.
 */
function onDisk(root: string, note: Note): (path: string) => boolean {
	const repo = { dir: root };
	let names: Map<string, string> | undefined;
	// Git runs in `root`, so it names the file relative to that.
	const modules = () =>
		(names ??= exists(root, ".gitmodules") ? gitmodules(repo, ["-f", ".gitmodules"]) : new Map<string, string>());
	const resolve = pins(repo, modules, note, "");
	return (path) => {
		if (exists(root, path)) return true;
		for (const module of modules().keys()) {
			if (path === module) return gitlink(root, module) !== null;
			if (!path.startsWith(`${module}/`)) continue;
			// A checked-out submodule's files are on disk like any other.
			if (existsSync(join(root, module, ".git"))) return false;
			const oid = gitlink(root, module);
			return oid !== null && resolve(module, oid, path.slice(module.length + 1));
		}
		return false;
	};
}

/** The commit the index pins the submodule at `module` to, or null when that path is no gitlink. */
function gitlink(root: string, module: string): string | null {
	// `<mode> <oid> <stage>\t<path>`, listing the files under `module` instead when it is a directory.
	for (const entry of git({ dir: root }, ["ls-files", "-s", "-z", "--", `:(literal)${module}`])
		.toString("utf8")
		.split("\0")) {
		const tab = entry.indexOf("\t");
		const [mode, oid] = entry.slice(0, tab).split(" ");
		if (mode === "160000" && entry.slice(tab + 1) === module) return oid;
	}
	return null;
}

/** Committed paths, descending into a gitlink only when a link needs its contents. */
function committed(repo: Repo, commit: string, note: Note | null, prefix: string): Tree {
	const entries: Entry[] = [];
	const paths = new Set<string>();
	const modules = new Map<string, string>();
	// `<mode> <type> <oid>\t<path>`; run in a work tree, git lists only its subtree, relative to it.
	const full = "gitdir" in repo ? ["--full-tree"] : [];
	for (const entry of git(repo, ["ls-tree", ...full, "-r", "-z", commit])
		.toString("utf8")
		.split("\0")) {
		if (entry === "") continue;
		const tab = entry.indexOf("\t");
		const [mode, type, oid] = entry.slice(0, tab).split(" ");
		const path = entry.slice(tab + 1);
		entries.push({ mode, type, oid, path });
		paths.add(path);
		for (let dir = path; dir.includes("/");) {
			dir = dir.slice(0, dir.lastIndexOf("/"));
			paths.add(dir);
		}
		if (type === "commit") modules.set(path, oid);
	}
	let names: Map<string, string> | undefined;
	const resolve =
		note && pins(repo, () => (names ??= gitmodules(repo, ["--blob", `${commit}:.gitmodules`])), note, prefix);
	return {
		entries,
		exists(path) {
			if (paths.has(path)) return true;
			for (const [module, oid] of modules) {
				if (!path.startsWith(`${module}/`)) continue;
				return !resolve || resolve(module, oid, path.slice(module.length + 1));
			}
			return false;
		},
	};
}

/**
 * Whether a path inside the submodule at `module` exists at `oid`, the commit
 * its gitlink pins, reading each submodule's tree once. A submodule whose
 * commit no local git directory holds is noted and its paths all exist, since
 * a missing checkout says nothing about whether a link is broken.
 */
function pins(
	repo: Repo,
	names: () => Map<string, string>,
	note: Note,
	prefix: string,
): (module: string, oid: string, path: string) => boolean {
	const loaded = new Map<string, Tree | null>();
	return (module, oid, path) => {
		let tree = loaded.get(module);
		if (tree === undefined) {
			tree = pinned(repo, module, names().get(module) ?? module, oid, note, `${prefix}${module}/`);
			if (tree === null) {
				note(
					`skipped links into submodule ${prefix}${module}: no local git directory holds its pinned commit ${oid}; run git submodule update --init --recursive to check them`,
				);
			}
			loaded.set(module, tree);
		}
		return tree === null || tree.exists(path);
	};
}

/**
 * The tree of the submodule `name` at `module` at commit `oid`, read from the
 * first local git directory that holds that commit: the submodule's own
 * checkout, where `git submodule` keeps it for this work tree, then where it
 * keeps it for the main work tree, which a fresh linked worktree has not
 * initialized but shares objects with. Null when none holds it.
 */
function pinned(repo: Repo, module: string, name: string, oid: string, note: Note, prefix: string): Tree | null {
	const candidates: Repo[] = [];
	// Without its own gitdir, `git -C` would silently read the parent repository.
	if ("dir" in repo && existsSync(join(repo.dir, module, ".git"))) candidates.push({ dir: join(repo.dir, module) });
	// Git refuses a name that would climb out of its modules directory, so never follow one.
	if (!name.split(/[/\\]/).includes("..")) {
		candidates.push(...modulesDirs(repo, name));
	}
	for (const candidate of candidates) {
		try {
			return committed(candidate, oid, note, prefix);
		} catch {
			// That git directory lacks the commit; try the next.
		}
	}
	return null;
}

/** Where `git submodule` keeps the submodule `name`'s git directory for this work tree, then for the main one. */
function modulesDirs(repo: Repo, name: string): Repo[] {
	const dirs: Repo[] = [];
	try {
		const [own, common] = git(repo, [
			"rev-parse",
			"--path-format=absolute",
			"--git-path",
			`modules/${name}`,
			"--git-common-dir",
		])
			.toString("utf8")
			.trim()
			.split("\n");
		for (const gitdir of new Set([own, join(common, "modules", name)])) {
			if (existsSync(gitdir)) dirs.push({ gitdir });
		}
	} catch {
		// Not a repository git can locate a submodule directory for; only a checkout can hold it.
	}
	return dirs;
}

/** Each submodule's name by its path, from the `.gitmodules` file `git config` reads with `source`. */
function gitmodules(repo: Repo, source: string[]): Map<string, string> {
	let out: string;
	try {
		out = git(repo, ["config", "-z", ...source, "--get-regexp", "^submodule\\..*\\.path$"]).toString("utf8");
	} catch {
		// No `.gitmodules`, or no submodule in it: every name is its path.
		return new Map();
	}
	const names = new Map<string, string>();
	// `submodule.<name>.path\n<path>\0` each.
	for (const entry of out.split("\0")) {
		const newline = entry.indexOf("\n");
		if (newline < 0) continue;
		names.set(entry.slice(newline + 1), entry.slice("submodule.".length, newline - ".path".length));
	}
	return names;
}

function git(repo: Repo, args: string[], input = ""): Buffer {
	const where = "dir" in repo ? ["-C", repo.dir] : [`--git-dir=${repo.gitdir}`];
	try {
		return execFileSync("git", [...where, ...args], { input, maxBuffer: 1 << 30, stdio: "pipe" });
	} catch (error) {
		const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
		throw new Error(`git ${args[0]} failed${stderr ? `: ${stderr}` : ""}`);
	}
}

// Fatal, so a file that is not UTF-8 is an error rather than silently mangled
// text; ignoreBOM keeps a byte-order mark in the text, as the parser expects.
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function read(root: string, path: string): string {
	try {
		return UTF8.decode(readFileSync(join(root, path)));
	} catch (error) {
		throw new Error(`reading ${path}: ${(error as Error).message}`);
	}
}

function decode(bytes: Uint8Array, path: string): string {
	try {
		return UTF8.decode(bytes);
	} catch (error) {
		throw new Error(`reading ${path}: ${(error as Error).message}`);
	}
}
