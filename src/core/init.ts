// `quest init`'s file plan: which files installing Quest writes or removes in
// a repository, computed from what the repository holds without writing any.
// The CLI applies it to a checkout and the Worker publishes it as a setup
// pull request, so both install the same files.
//
// The plan touches only skill stubs (writing missing ones and removing those
// of retired skills), one reference line in the root agent instructions, one
// `.gitattributes` line, `quest/README.md` when missing, and Quest's hook
// entries in `.claude/settings.json`.

/** Installed skills carry this prefix so they don't collide with a repository's own. */
export const PREFIX = "quest-";

/**
 * Marks Quest's line in the root agent instructions, so a repository can
 * reword the rest of it without init adding another.
 */
export const REFERENCE_MARKER = "Quests: ";

/** Appended to the root agent instructions when Quest is installed. */
export const REFERENCE_LINE = "Quests: before starting work, run `quest guide` and follow it.";

/** The skill directories Claude Code and Codex read; new installs use real directories. */
export const SKILL_DIRS = [".claude/skills", ".agents/skills"] as const;

/** Routes quest files through the `quest` merge driver; uninstall removes lines starting with it. */
export const ATTRIBUTES_LINE = "quest/** merge=quest";

/** Claude Code's shared project settings, where init installs the worktree lifecycle hooks. */
export const CLAUDE_SETTINGS = ".claude/settings.json";

/** The one command each installed hook entry runs; the logic lives in the binary, so upgrades never rewrite it. */
export const HOOK_COMMAND = "quest worktree hook";

/** The Claude Code events `quest worktree hook` handles, in the order `quest init` installs them. */
export const HOOK_EVENTS = ["WorktreeCreate", "WorktreeRemove", "SubagentStart", "SubagentStop"] as const;

/** Events whose single hook decides the outcome, so another hook for them conflicts with Quest's. */
const EXCLUSIVE_EVENTS = new Set<string>(["WorktreeCreate", "WorktreeRemove"]);

/** The quest tree's root, with the project's goal or a placeholder for it. */
export function questReadme(goal?: string): string {
	return `# Quests\n\n## Goal\n\n${goal?.trim() || "What this project is working toward."}\n`;
}

/** What sits at a path: a directory, a regular file, a symbolic link, or anything else. */
export type Kind = "dir" | "file" | "symlink" | "other";

/**
 * A repository's files as the plan reads them. Paths are relative to the
 * repository root and joined with `/`. Reads may throw an `InitRefused`
 * naming a path the caller cannot inspect.
 */
export interface Checkout {
	/** What sits at `path` without following a final symlink, or null when nothing does. */
	lstat(path: string): Kind | null;
	/** What `path` resolves to, following symlinks, or null when it, or a link's target, is missing. */
	stat(path: string): Exclude<Kind, "symlink"> | null;
	/** The text of the file at `path`, following symlinks. */
	read(path: string): string;
	/** The entry names in the directory at `path`. */
	list(path: string): string[];
	/** Where `path` resolves to, so two names for one directory compare equal; a missing path is itself. */
	real(path: string): string;
}

/** One skill as a repository installs it: its directory name and its `SKILL.md`. */
export interface Stub {
	installed: string;
	stub: string;
}

/** One file the plan sets to `content`, or, with null content, a retired stub it deletes along with its directory once empty. */
export interface InitChange {
	path: string;
	content: string | null;
}

/** Init cannot install because of what sits at `path`; the repository needs a person's judgement. */
export class InitRefused extends Error {
	constructor(
		readonly path: string,
		message: string,
	) {
		super(message);
		this.name = "InitRefused";
	}
}

function refuse(path: string, why: string): never {
	throw new InitRefused(path, `${path} ${why}; remove or rename it before running \`quest init\``);
}

/**
 * The changes installing Quest makes in `repo`, in order, with `stubs` as the
 * skills to install and `goal` as a new `quest/README.md`'s Goal. Every
 * conflict throws an `InitRefused` before any change is returned, so a
 * refused init leaves the repository as it was. An empty plan means Quest is
 * already installed.
 */
export function planInit(repo: Checkout, stubs: readonly Stub[], options: { goal?: string } = {}): InitChange[] {
	const dirs = skillDirs(repo);
	const missing = dirs.flatMap((skills) =>
		stubs.flatMap((skill): InitChange[] => {
			const dir = `${skills}/${skill.installed}`;
			const path = `${dir}/SKILL.md`;
			checkPath(repo, path, "file");
			if (repo.stat(path) === "file") {
				// An older version's stub stays as it is; only a missing one is written.
				if (isStub(repo, path, skill.installed)) return [];
				refuse(path, "is not a Quest stub");
			} else if (repo.lstat(dir) !== null) {
				throw new InitRefused(
					dir,
					`${dir} exists without SKILL.md; remove or rename it before running \`quest init\``,
				);
			}
			return [{ path, content: skill.stub }];
		}),
	);
	const current = new Set(stubs.map((skill) => skill.installed));
	const retired = dirs.flatMap((skills) =>
		installedStubs(repo, skills).filter((dir) => !current.has(dir.slice(dir.lastIndexOf("/") + 1))),
	);
	const readme = "quest/README.md";
	checkPath(repo, readme, "file");
	const instructions = ["AGENTS.md", "CLAUDE.md"].find((name) => repo.stat(name) === "file") ?? "AGENTS.md";
	checkPath(repo, instructions, "file");
	checkPath(repo, ".gitattributes", "file");
	checkPath(repo, CLAUDE_SETTINGS, "file");
	const settings = installHooks(repo);

	const changes: InitChange[] = [...missing, ...retired.map((dir) => ({ path: `${dir}/SKILL.md`, content: null }))];
	if (repo.lstat(readme) === null) changes.push({ path: readme, content: questReadme(options.goal) });
	if (settings !== undefined) changes.push({ path: CLAUDE_SETTINGS, content: settings });
	for (const [path, marker, line] of [
		[instructions, REFERENCE_MARKER, REFERENCE_LINE],
		[".gitattributes", ATTRIBUTES_LINE, ATTRIBUTES_LINE],
	]) {
		const content = appendLine(repo.stat(path) === "file" ? repo.read(path) : "", marker, line);
		if (content !== null) changes.push({ path, content });
	}
	return changes;
}

/** Check an install destination and its parents before any writes, following valid symlinks. */
function checkPath(repo: Checkout, path: string, expected: "dir" | "file"): void {
	const slash = path.lastIndexOf("/");
	if (slash > 0) checkPath(repo, path.slice(0, slash), "dir");
	const found = repo.stat(path);
	if (found === null ? repo.lstat(path) === null : found === expected) return;
	refuse(path, `is not a ${expected === "dir" ? "directory" : "file"}`);
}

/** Validate both destinations before writing; existing links to one tree are installed once. */
function skillDirs(repo: Checkout): string[] {
	const seen = new Set<string>();
	return SKILL_DIRS.filter((dir) => {
		checkPath(repo, dir, "dir");
		const destination = repo.stat(dir) === null ? dir : repo.real(dir);
		if (seen.has(destination)) return false;
		seen.add(destination);
		return true;
	});
}

/**
 * Any version's stub: frontmatter naming the skill, then the pointer to
 * `quest skill`. Descriptions and the setup link change between versions, so
 * only this shape identifies a file Quest wrote. Skill frontmatter has only
 * ever held `name` and `description`, so any other field marks an edited stub.
 */
const STUB =
	/^---\nname: (\S+)\n(?:(?:name|description): .*\n)*---\n\nRun `quest skill (\S+)` and follow its output\.\nIf `quest` is not installed, follow \S+ first\.\n$/;

/**
 * Whether `path` holds a Quest stub of any version for the skill installed as
 * `installed`. Git may check out unchanged stubs with CRLF in an adopting repository.
 */
function isStub(repo: Checkout, path: string, installed: string): boolean {
	const match = STUB.exec(repo.read(path).replaceAll("\r\n", "\n"));
	return match?.[1] === installed && `${PREFIX}${match[2]}` === installed;
}

/**
 * The skill directories under `skills` that hold a Quest stub of any version,
 * including skills this version no longer ships. Quest writes neither links
 * nor other files there, so it skips symlinks.
 */
export function installedStubs(repo: Checkout, skills: string): string[] {
	if (repo.lstat(skills) === null) return [];
	return repo
		.list(skills)
		.filter((name) => name.startsWith(PREFIX))
		.map((name) => `${skills}/${name}`)
		.filter(
			(dir) =>
				repo.lstat(dir) === "dir" &&
				repo.lstat(`${dir}/SKILL.md`) === "file" &&
				isStub(repo, `${dir}/SKILL.md`, dir.slice(dir.lastIndexOf("/") + 1)),
		)
		.sort();
}

/** The line ending a file already uses. */
export function newline(content: string): string {
	return content.includes("\r\n") ? "\r\n" : "\n";
}

/** Lines without their terminators, as Markdown editors on any platform wrote them. */
export function lines(content: string): string[] {
	const out = content.split(/\r?\n/);
	if (out[out.length - 1] === "") out.pop();
	return out;
}

/**
 * `content` with `line` appended, separated from existing content by a blank
 * line, or null when a line already starts with `marker`.
 */
function appendLine(content: string, marker: string, line: string): string | null {
	if (lines(content).some((existing) => existing.startsWith(marker))) return null;
	const eol = newline(content);
	if (content !== "") {
		if (!content.endsWith("\n")) content += eol;
		content += eol;
	}
	return `${content}${line}${eol}`;
}

/** A settings object as Claude Code reads it: hook groups per event, each with handlers. */
export type Settings = { hooks?: Record<string, { hooks?: unknown[] }[]> } & Record<string, unknown>;

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export function isQuestHook(handler: unknown): boolean {
	return record(handler) && handler.type === "command" && handler.command === HOOK_COMMAND;
}

/**
 * Claude Code's settings file parsed and checked for the shape init edits,
 * with its formatting. Throws an `InitRefused` naming the file when it is not.
 */
export function parseSettings(text: string): { settings: Settings; indent: string; eol: string } {
	const invalid = (why: string) =>
		new InitRefused(
			CLAUDE_SETTINGS,
			`${CLAUDE_SETTINGS} ${why}; fix it before running \`quest init\` or \`quest uninstall\``,
		);
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

/** The settings file's text, in the formatting `parseSettings` read. */
export function renderSettings(settings: Settings, indent: string, eol: string): string {
	return `${JSON.stringify(settings, null, indent).replaceAll("\n", eol)}${eol}`;
}

/**
 * The settings file with one Quest hook group added for each event that lacks one, or undefined when
 * nothing changes. Another hook for an event whose single hook decides the outcome is a conflict.
 */
function installHooks(repo: Checkout): string | undefined {
	const { settings, indent, eol } =
		repo.stat(CLAUDE_SETTINGS) === "file"
			? parseSettings(repo.read(CLAUDE_SETTINGS))
			: { settings: {} as Settings, indent: "  ", eol: "\n" };
	const hooks = (settings.hooks ??= {});
	let changed = false;
	for (const event of HOOK_EVENTS) {
		const groups = (hooks[event] ??= []);
		const handlers = groups.flatMap((group) => group.hooks ?? []);
		if (EXCLUSIVE_EVENTS.has(event) && handlers.some((handler) => !isQuestHook(handler)))
			throw new InitRefused(
				CLAUDE_SETTINGS,
				`${CLAUDE_SETTINGS} already has a ${event} hook, and only one can manage Claude's worktrees; ` +
					"remove it before running `quest init`",
			);
		if (handlers.some(isQuestHook)) continue;
		groups.push({ hooks: [{ type: "command", command: HOOK_COMMAND }] });
		changed = true;
	}
	return changed ? renderSettings(settings, indent, eol) : undefined;
}
