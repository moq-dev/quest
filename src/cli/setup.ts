// `quest init` and `quest uninstall`: install skill stubs and reverse it.
//
// Init applies the core's file plan (`planInit`) to the checkout, then
// registers the clone's merge driver. Uninstall never deletes the quest tree.

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	rmSync,
	rmdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
	ATTRIBUTES_LINE,
	type Checkout,
	type Kind,
	REFERENCE_MARKER,
	SKILL_DIRS,
	installedStubs,
	lines,
	newline,
	InitRefused,
	planInit,
} from "../core";
import { git } from "./git";
import { DRIVER, OLD_DRIVERS } from "./resolve";
import { SKILLS } from "./skills";

export { ATTRIBUTES_LINE, REFERENCE_LINE } from "../core";

/**
 * Install Quest stubs and markers under `root`. Returns the paths it changed, relative to `root`.
 * A conflict throws before anything is written, so a refused init leaves the repository as it was.
 */
export function init(root: string): string[] {
	const changes = planInit(checkout(root), SKILLS);
	for (const { path, content } of changes) {
		if (content === null) {
			rmSync(join(root, path));
			removeIfEmpty(dirname(join(root, path)));
		} else {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), content);
		}
	}
	register(root);
	return changes.map((change) => change.path);
}

/** The checkout under `root`, as the core's file plan reads it. */
function checkout(root: string): Checkout {
	return {
		lstat: (path) => kind(join(root, path)),
		stat: (path) => {
			try {
				const stat = statSync(join(root, path));
				return stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				return null;
			}
		},
		read: (path) => read(root, path),
		list: (path) => readdirSync(join(root, path)),
		real: (path) => realpathSync(join(root, path)),
	};
}

/**
 * Register the merge driver when `root`'s `.gitattributes` names it, so fresh
 * clones and worktrees get it from any command. Never fails.
 */
export function heal(root: string): void {
	let named = false;
	try {
		named = lines(read(root, ".gitattributes")).some((line) => /(^|\s)merge=quest(\s|$)/.test(line));
	} catch {
		// No attributes, so no driver to register.
	}
	if (named) register(root);
}

/**
 * Set `merge.quest.driver` in the clone's config when no config sets it, or
 * the one in effect is a driver an older quest registered, and only inside a
 * git work tree: git ignores a driver named only in `.gitattributes`. A custom
 * driver stays. A failed write is ignored, leaving the driver as it was.
 */
function register(root: string): void {
	try {
		const current = git(root, ["config", "--get", "merge.quest.driver"]);
		if (current !== "" && !OLD_DRIVERS.includes(current)) return;
		if (git(root, ["rev-parse", "--is-inside-work-tree"]) !== "true") return;
		git(root, ["config", "--local", "merge.quest.driver", DRIVER]);
	} catch {
		// Not a repository, or its config is not writable.
	}
}

/** Remove the merge driver from the clone's config, inside a git work tree. */
function unregister(root: string): void {
	try {
		if (git(root, ["rev-parse", "--is-inside-work-tree"]) !== "true") return;
		if (git(root, ["config", "--local", "--get", "merge.quest.driver"]) === "") return;
		git(root, ["config", "--local", "--remove-section", "merge.quest"]);
	} catch {
		// Not a repository, or its config is not writable.
	}
}

/** Remove Quest stubs and markers under `root`. Returns the paths it changed, relative to `root`. */
export function uninstall(root: string): string[] {
	const changes: string[] = [];
	for (const skills of SKILL_DIRS) {
		if (!isRealDir(join(root, skills))) continue;
		for (const dir of installedStubs(checkout(root), skills)) changes.push(removeStub(root, dir));
		removeIfEmpty(join(root, skills));
	}
	// Remove only the conventional link from an older Quest install whose target went away.
	for (const skills of SKILL_DIRS) {
		const link = join(root, skills);
		const other = SKILL_DIRS.find((dir) => dir !== skills)!;
		if (
			isSymlink(link) &&
			!existsSync(link) &&
			resolve(dirname(link), readlinkSync(link)) === resolve(root, other)
		) {
			rmSync(link);
			changes.push(skills);
		}
		const parent = dirname(link);
		if (isRealDir(parent)) removeIfEmpty(parent);
	}

	for (const path of ["AGENTS.md", "CLAUDE.md"]) {
		if (removeLine(root, path, REFERENCE_MARKER)) changes.push(path);
	}
	if (removeLine(root, ".gitattributes", ATTRIBUTES_LINE)) changes.push(".gitattributes");
	unregister(root);
	return changes;
}

/** What sits at `path` without following a symlink, or `null` for nothing. */
function kind(path: string): Kind | null {
	try {
		const stat = lstatSync(path);
		if (stat.isDirectory()) return "dir";
		return stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other";
	} catch {
		return null;
	}
}

function isSymlink(path: string): boolean {
	return kind(path) === "symlink";
}

function isRealDir(path: string): boolean {
	return kind(path) === "dir";
}

/** A regular file, following symlinks. */
function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function removeIfEmpty(dir: string) {
	if (readdirSync(dir).length === 0) rmdirSync(dir);
}

function read(root: string, path: string): string {
	return readFileSync(join(root, path), "utf8");
}

/** Delete the stub in skill directory `dir`, and the directory once empty. Returns the stub's path. */
function removeStub(root: string, dir: string): string {
	const path = `${dir}/SKILL.md`;
	rmSync(join(root, path));
	removeIfEmpty(join(root, dir));
	return path;
}

/**
 * Remove every line starting with `marker` and the blank lines it leaves at the
 * end, deleting the file if nothing else remains.
 */
function removeLine(root: string, path: string, marker: string): boolean {
	if (!isFile(join(root, path))) return false;
	const original = read(root, path);
	const eol = newline(original);
	const content = lines(original);
	if (!content.some((existing) => existing.startsWith(marker))) return false;
	const kept = content
		.filter((existing) => !existing.startsWith(marker))
		.join(eol)
		.trimEnd();
	if (kept === "") {
		rmSync(join(root, path));
	} else {
		writeFileSync(join(root, path), `${kept}${eol}`);
	}
	return true;
}

/**
 * What `quest init` would change in `root`'s skill stubs, one line each: a
 * missing, outdated, or retired stub, or the edited file it refuses to
 * rewrite. Reusing init's plan keeps this from drifting from what init writes.
 */
export function stubFindings(root: string): string[] {
	let changes: ReturnType<typeof planInit>;
	try {
		changes = planInit(checkout(root), SKILLS);
	} catch (error) {
		if (error instanceof InitRefused) return [error.message];
		throw error;
	}
	return changes
		.filter(({ path }) => SKILL_DIRS.some((dir) => path.startsWith(`${dir}/`)))
		.map(({ path, content }) => {
			const why =
				content === null
					? "is a retired skill's stub"
					: existsSync(join(root, path))
						? "is outdated"
						: "is missing";
			return `${path}: ${why}; run \`quest init\` and commit the result`;
		});
}
