// `quest init` and `quest uninstall`: install skill stubs and reverse it.
//
// Init touches only stubs, one reference line, one `.gitattributes` line, an
// empty `quest/README.md` when missing, Quest's hook entries in
// `.claude/settings.json`, and the clone's merge driver config. Uninstall never
// deletes the quest tree.

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

import { gitOutput } from "./claims";
import { DRIVER } from "./resolve";
import { SKILLS } from "./skills";
import { HOOK_EVENTS } from "./worktree-hook";

/**
 * Marks Quest's line in the root agent instructions, so a repository can
 * reword the rest of it without init adding another.
 */
const REFERENCE_MARKER = "Quests: ";

/** Appended to the root agent instructions when Quest is installed. */
export const REFERENCE_LINE = "Quests: before starting work, run `quest guide` and follow it.";

/** The skill directories Claude Code and Codex read; new installs use real directories. */
const SKILL_DIRS = [".claude/skills", ".agents/skills"] as const;

/** Routes quest files through the `quest` merge driver; uninstall removes lines starting with it. */
export const ATTRIBUTES_LINE = "quest/** merge=quest";

/** Claude Code's shared project settings, where init installs the worktree lifecycle hooks. */
const CLAUDE_SETTINGS = ".claude/settings.json";

/** The one command each installed hook entry runs; the logic lives in the binary, so upgrades never rewrite it. */
export const HOOK_COMMAND = "quest worktree hook";

/** Events whose single hook decides the outcome, so another hook for them conflicts with Quest's. */
const EXCLUSIVE_EVENTS = new Set(["WorktreeCreate", "WorktreeRemove"]);

const QUEST_ROOT_README = "# Quests\n\n## Goal\n\nWhat this project is working toward.\n";

/**
 * Install Quest stubs and markers under `root`. Returns the paths it changed, relative to `root`.
 * A conflict throws before anything is written, so a refused init leaves the repository as it was.
 */
export function init(root: string): string[] {
	const dirs = skillDirs(root);
	const missing = dirs.flatMap((skills) =>
		SKILLS.flatMap((skill) => {
			const dir = `${skills}/${skill.installed}`;
			const path = `${dir}/SKILL.md`;
			checkPath(root, path, "file");
			if (isFile(join(root, path))) {
				if (isStub(root, path, skill.stub)) return [];
				throw new Error(`${path} is not a Quest stub; remove or rename it before running \`quest init\``);
			} else if (existsSync(join(root, dir))) {
				throw new Error(`${dir} exists without SKILL.md; remove or rename it before running \`quest init\``);
			}
			return [{ path, stub: skill.stub }];
		}),
	);
	const readme = "quest/README.md";
	checkPath(root, readme, "file");
	const instructions = ["AGENTS.md", "CLAUDE.md"].find((name) => isFile(join(root, name))) ?? "AGENTS.md";
	checkPath(root, instructions, "file");
	checkPath(root, ".gitattributes", "file");
	checkPath(root, CLAUDE_SETTINGS, "file");
	const settings = installHooks(root);

	const changes: string[] = [];
	for (const { path, stub } of missing) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), stub);
		changes.push(path);
	}

	if (!existsSync(join(root, readme))) {
		mkdirSync(join(root, "quest"), { recursive: true });
		writeFileSync(join(root, readme), QUEST_ROOT_README);
		changes.push(readme);
	}

	if (settings !== undefined) {
		mkdirSync(join(root, ".claude"), { recursive: true });
		writeFileSync(join(root, CLAUDE_SETTINGS), settings);
		changes.push(CLAUDE_SETTINGS);
	}
	if (appendLine(root, instructions, REFERENCE_MARKER, REFERENCE_LINE)) changes.push(instructions);
	if (appendLine(root, ".gitattributes", ATTRIBUTES_LINE, ATTRIBUTES_LINE)) changes.push(".gitattributes");
	register(root);
	return changes;
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

/** Check an install destination and its parents before any writes, following valid symlinks. */
function checkPath(root: string, path: string, expected: "directory" | "file"): void {
	const parent = dirname(path);
	if (parent !== ".") checkPath(root, parent, "directory");
	const absolute = join(root, path);
	let stat;
	try {
		stat = statSync(absolute);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		if (kind(absolute) === null) return;
	}
	if (expected === "directory" ? stat?.isDirectory() : stat?.isFile()) return;
	throw new Error(`${path} is not a ${expected}; remove or rename it before running \`quest init\``);
}

/** Remove Quest stubs and markers under `root`. Returns the paths it changed, relative to `root`. */
export function uninstall(root: string): string[] {
	const changes: string[] = [];
	if (uninstallHooks(root)) changes.push(CLAUDE_SETTINGS);
	for (const skills of SKILL_DIRS) {
		if (!isRealDir(join(root, skills))) continue;
		for (const skill of SKILLS) {
			const dir = `${skills}/${skill.installed}`;
			const path = `${dir}/SKILL.md`;
			if (!isFile(join(root, path)) || !isStub(root, path, skill.stub)) continue;
			rmSync(join(root, path));
			changes.push(path);
			removeIfEmpty(join(root, dir));
		}
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

/** Validate both destinations before writing; existing links to one tree are installed once. */
function skillDirs(root: string): string[] {
	const seen = new Set<string>();
	return SKILL_DIRS.filter((dir) => {
		checkPath(root, dir, "directory");
		const path = join(root, dir);
		const destination = existsSync(path) ? realpathSync(path) : resolve(path);
		if (seen.has(destination)) return false;
		seen.add(destination);
		return true;
	});
}

/** What sits at `path` without following a symlink, or `null` for nothing. */
function kind(path: string): "dir" | "symlink" | "other" | null {
	try {
		const stat = lstatSync(path);
		return stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "symlink" : "other";
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

// Git may check out unchanged stubs with CRLF in an adopting repository.
function isStub(root: string, path: string, stub: string): boolean {
	return read(root, path).replaceAll("\r\n", "\n") === stub;
}

function newline(content: string): string {
	return content.includes("\r\n") ? "\r\n" : "\n";
}

/** Lines without their terminators, as Markdown editors on any platform wrote them. */
function lines(content: string): string[] {
	const out = content.split(/\r?\n/);
	if (out[out.length - 1] === "") out.pop();
	return out;
}

/**
 * Append `line` unless a line already starts with `marker`, creating the file
 * if missing, separated from existing content by a blank line.
 */
function appendLine(root: string, path: string, marker: string, line: string): boolean {
	let content = isFile(join(root, path)) ? read(root, path) : "";
	if (lines(content).some((existing) => existing.startsWith(marker))) return false;
	const eol = newline(content);
	if (content !== "") {
		if (!content.endsWith("\n")) content += eol;
		content += eol;
	}
	writeFileSync(join(root, path), `${content}${line}${eol}`);
	return true;
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

/** A settings object as Claude Code reads it: hook groups per event, each with handlers. */
type Settings = { hooks?: Record<string, { hooks?: unknown[] }[]> } & Record<string, unknown>;

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function isQuestHook(handler: unknown): boolean {
	return record(handler) && handler.type === "command" && handler.command === HOOK_COMMAND;
}

/** The settings file parsed and checked for the shape init edits, with its formatting. */
function readSettings(root: string): { settings: Settings; indent: string; eol: string } | undefined {
	if (!isFile(join(root, CLAUDE_SETTINGS))) return undefined;
	const text = read(root, CLAUDE_SETTINGS);
	const invalid = (why: string) =>
		new Error(`${CLAUDE_SETTINGS} ${why}; fix it before running \`quest init\` or \`quest uninstall\``);
	let settings: unknown;
	try {
		settings = JSON.parse(text);
	} catch {
		throw invalid("is not valid JSON");
	}
	if (!record(settings)) throw invalid("is not a JSON object");
	if (settings.hooks !== undefined) {
		if (!record(settings.hooks)) throw invalid("has hooks that are not an object");
		for (const [event, groups] of Object.entries(settings.hooks))
			if (!Array.isArray(groups) || !groups.every((group) => record(group) && Array.isArray(group.hooks ?? [])))
				throw invalid(`has ${event} hooks that are not a list of hook groups`);
	}
	return { settings: settings as Settings, indent: /\n([ \t]+)"/.exec(text)?.[1] ?? "  ", eol: newline(text) };
}

function writeSettings(settings: Settings, indent: string, eol: string): string {
	return `${JSON.stringify(settings, null, indent).replaceAll("\n", eol)}${eol}`;
}

/**
 * The settings file with one Quest hook group added for each event that lacks one, or undefined when
 * nothing changes. Another hook for an event whose single hook decides the outcome is a conflict.
 */
function installHooks(root: string): string | undefined {
	const { settings, indent, eol } = readSettings(root) ?? { settings: {}, indent: "  ", eol: "\n" };
	const hooks = (settings.hooks ??= {});
	let changed = false;
	for (const event of HOOK_EVENTS) {
		const groups = (hooks[event] ??= []);
		const handlers = groups.flatMap((group) => group.hooks ?? []);
		if (EXCLUSIVE_EVENTS.has(event) && handlers.some((handler) => !isQuestHook(handler)))
			throw new Error(
				`${CLAUDE_SETTINGS} already has a ${event} hook, and only one can manage Claude's worktrees; ` +
					"remove it before running `quest init`",
			);
		if (handlers.some(isQuestHook)) continue;
		groups.push({ hooks: [{ type: "command", command: HOOK_COMMAND }] });
		changed = true;
	}
	return changed ? writeSettings(settings, indent, eol) : undefined;
}

/**
 * Remove exactly Quest's hook handlers, then the groups, events, and hooks object they leave empty,
 * deleting the file when nothing else remains. A file that is missing or malformed is left alone.
 */
function uninstallHooks(root: string): boolean {
	let parsed;
	try {
		parsed = readSettings(root);
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
	else writeFileSync(join(root, CLAUDE_SETTINGS), writeSettings(settings, indent, eol));
	return true;
}
