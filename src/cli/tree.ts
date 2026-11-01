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

/** Whether a repository-relative path exists under `root`. */
export function exists(root: string, path: string): boolean {
	return existsSync(join(root, path));
}

/** A quest tree as `quest check` reads it: its documents, and whether a repository-relative path exists. */
export interface Snapshot {
	docs: Doc[];
	exists(path: string): boolean;
}

/** The quest tree in the checkout at `root`. */
export function checkout(root: string): Snapshot {
	return { docs: load(root), exists: (path) => exists(root, path) };
}

/**
 * The quest tree at `commit`, read from git rather than the checkout, with
 * paths relative to `root` as on disk. A symbolic link is a path, not a quest.
 * With `submodules` false, as in a bare repository with no submodule checkouts,
 * every path inside a submodule exists rather than being read from it.
 */
export function snapshot(root: string, commit: string, submodules = true): Snapshot {
	const tree = committed(root, commit, submodules);
	const quests = tree.entries.filter(
		({ mode, type, path }) => type === "blob" && mode !== "120000" && path.startsWith("quest/") && isQuest(path),
	);
	if (quests.length === 0) throw new Error(`no quest documents found under ${under(root, "quest")} at ${commit}`);

	// One `cat-file --batch` reads every document: `<oid> blob <size>\n<content>\n` each, in input order.
	const batch = git(root, ["cat-file", "--batch"], `${quests.map((quest) => quest.oid).join("\n")}\n`);
	let offset = 0;
	const docs = quests.map(({ path }) => {
		const header = batch.indexOf(10, offset);
		const size = Number(batch.toString("utf8", offset, header).split(" ")[2]);
		const text = decode(batch.subarray(header + 1, header + 1 + size), path);
		offset = header + size + 2;
		return { path, text };
	});
	return {
		docs: docs.sort((a, b) => comparePaths(a.path, b.path)).map((source) => parse(source.path, source.text)),
		exists: tree.exists,
	};
}

interface Entry {
	mode: string;
	type: string;
	oid: string;
	path: string;
}

/** Committed paths, descending into a gitlink only when a link needs its contents. */
function committed(
	root: string,
	commit: string,
	submodules = true,
): { entries: Entry[]; exists(path: string): boolean } {
	const entries: Entry[] = [];
	const paths = new Set<string>();
	const modules = new Map<string, string>();
	const loaded = new Map<string, ReturnType<typeof committed>>();
	// `<mode> <type> <oid>\t<path>`; run in `root`, git lists only its subtree, relative to it.
	for (const entry of git(root, ["ls-tree", "-r", "-z", commit]).toString("utf8").split("\0")) {
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
	return {
		entries,
		exists(path) {
			if (paths.has(path)) return true;
			for (const [module, oid] of modules) {
				if (!path.startsWith(`${module}/`)) continue;
				if (!submodules) return true;
				let tree = loaded.get(module);
				if (!tree) {
					const dir = join(root, module);
					try {
						// Without its own gitdir, `git -C` would silently read the parent repository.
						if (!existsSync(join(dir, ".git"))) throw new Error("submodule is not initialized");
						tree = committed(dir, oid);
					} catch (error) {
						throw new Error(
							`cannot read submodule ${module} at ${oid}: ${(error as Error).message}; run git submodule update --init --recursive and ensure that commit is available`,
						);
					}
					loaded.set(module, tree);
				}
				return tree.exists(path.slice(module.length + 1));
			}
			return false;
		},
	};
}

function git(root: string, args: string[], input = ""): Buffer {
	try {
		return execFileSync("git", ["-C", root, ...args], { input, maxBuffer: 1 << 30, stdio: "pipe" });
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
