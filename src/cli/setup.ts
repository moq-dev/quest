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
	CLAUDE_SETTINGS,
	type Checkout,
	HOOK_EVENTS,
	type Kind,
	REFERENCE_MARKER,
	SKILL_DIRS,
	installedStubs,
	isQuestHook,
	lines,
	newline,
	parseSettings,
	planInit,
	renderSettings,
} from "../core";
import { gitOutput } from "./claims";
import { DRIVER } from "./resolve";
import { SKILLS } from "./skills";

export { ATTRIBUTES_LINE, HOOK_COMMAND, REFERENCE_LINE } from "../core";

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
 * Set `merge.quest.driver` in the clone's config when no config sets it, and
 * only inside a git work tree: git ignores a driver named only in
 * `.gitattributes`. A failed write is ignored, leaving git's own merge.
 */
function register(root: string): void {
	try {
		if (gitOutput(root, ["config", "--get", "merge.quest.driver"]) !== "") return;
		if (gitOutput(root, ["rev-parse", "--is-inside-work-tree"]) !== "true") return;
		gitOutput(root, ["config", "--local", "merge.quest.driver", DRIVER]);
	} catch {
		// Not a repository, or its config is not writable.
	}
}

/** Remove the merge driver from the clone's config, inside a git work tree. */
function unregister(root: string): void {
	try {
		if (gitOutput(root, ["rev-parse", "--is-inside-work-tree"]) !== "true") return;
		if (gitOutput(root, ["config", "--local", "--get", "merge.quest.driver"]) === "") return;
		gitOutput(root, ["config", "--local", "--remove-section", "merge.quest"]);
	} catch {
		// Not a repository, or its config is not writable.
	}
}

/** Remove Quest stubs and markers under `root`. Returns the paths it changed, relative to `root`. */
export function uninstall(root: string): string[] {
	const changes: string[] = [];
	if (uninstallHooks(root)) changes.push(CLAUDE_SETTINGS);
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
 * Remove exactly Quest's hook handlers, then the groups, events, and hooks object they leave empty,
 * deleting the file when nothing else remains. A file that is missing or malformed is left alone.
 */
function uninstallHooks(root: string): boolean {
	let parsed;
	try {
		parsed = isFile(join(root, CLAUDE_SETTINGS)) ? parseSettings(read(root, CLAUDE_SETTINGS)) : undefined;
	} catch {
		return false;
	}
	if (!parsed?.settings.hooks) return false;
	const { settings, indent, eol } = parsed;
	const hooks = settings.hooks!;
	let changed = false;
	for (const event of HOOK_EVENTS) {
		const groups = hooks[event];
		if (!groups) continue;
		const kept = groups.flatMap((group) => {
			const handlers = group.hooks ?? [];
			const others = handlers.filter((handler) => !isQuestHook(handler));
			if (others.length === handlers.length) return [group];
			changed = true;
			return others.length ? [{ ...group, hooks: others }] : [];
		});
		if (kept.length) hooks[event] = kept;
		else delete hooks[event];
	}
	if (!changed) return false;
	if (Object.keys(hooks).length === 0) delete settings.hooks;
	if (Object.keys(settings).length === 0) rmSync(join(root, CLAUDE_SETTINGS));
	else writeFileSync(join(root, CLAUDE_SETTINGS), renderSettings(settings, indent, eol));
	return true;
}
