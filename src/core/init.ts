// `quest init`'s file plan: which files installing Quest writes or removes in
// a repository, computed from what the repository holds without writing any.
// The CLI applies it to a checkout and the Worker publishes it as a setup
// pull request, so both install the same files.
//
// The plan touches only skill stubs (writing missing or outdated ones and
// removing those of retired skills), one reference line in the root agent
// instructions, one `.gitattributes` line, `quest/README.md` when missing, and
// the hook entries earlier versions wrote to `.claude/settings.json`, which it
// removes: Quest's worktree hooks are a user-level opt-in, since a
// repository's settings would force them on every contributor.

/** Installed skills carry this prefix so they don't collide with a repository's own. */
export const PREFIX = "quest-";

/**
 * Marks Quest's line in the root agent instructions, so a repository can
 * reword the rest of it without init adding another.
 */
export const REFERENCE_MARKER = "Quests: ";

/** Appended to the root agent instructions when Quest is installed. */
export const REFERENCE_LINE = "Quests: before any work, run `quest context` and follow it.";

/** Earlier releases' default reference lines, which init upgrades in place; a reworded line stays. */
const OLD_REFERENCE_LINES: readonly string[] = [
	"Quests: before starting work, run `quest guide` and follow it.",
	"Quests: before starting work, run `quest context` and `quest guide`, and follow both.",
];

/** The skill directories Claude Code and Codex read; new installs use real directories. */
export const SKILL_DIRS = [".claude/skills", ".agents/skills"] as const;

/** Routes quest files through the `quest` merge driver; uninstall removes lines starting with it. */
export const ATTRIBUTES_LINE = "quest/** merge=quest";

/** Claude Code's shared project settings, where earlier versions installed the worktree hooks. */
export const CLAUDE_SETTINGS = ".claude/settings.json";

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

/**
 * One file the plan sets to `content`, or, with null content, deletes along with its directory once
 * empty: a retired stub, or settings left empty once Quest's hooks are removed.
 */
export interface InitChange {
	path: string;
	content: string | null;
	/** The Quest hook entries removed from Claude Code's settings by this change. */
	hooks?: QuestHook[];
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
	const written = dirs.flatMap((skills) =>
		stubs.flatMap((skill): InitChange[] => {
			const dir = `${skills}/${skill.installed}`;
			const path = `${dir}/SKILL.md`;
			checkPath(repo, path, "file");
			if (repo.stat(path) === "file") {
				if (!isStub(repo, path, skill.installed)) refuse(path, "is not a Quest stub");
				// An older version's stub is rewritten in place, keeping its newlines; Quest writes no links, so it leaves linked ones.
				const content = repo.read(path);
				if (content.replaceAll("\r\n", "\n") === skill.stub) return [];
				if (repo.lstat(dir) !== "dir" || repo.lstat(path) !== "file") return [];
				return [{ path, content: skill.stub.replaceAll("\n", newline(content)) }];
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
	const settings = repo.stat(CLAUDE_SETTINGS) === "file" ? removeHooks(repo.read(CLAUDE_SETTINGS)) : undefined;

	const changes: InitChange[] = [...written, ...retired.map((dir) => ({ path: `${dir}/SKILL.md`, content: null }))];
	if (repo.lstat(readme) === null) changes.push({ path: readme, content: questReadme(options.goal) });
	if (settings !== undefined) changes.push({ path: CLAUDE_SETTINGS, ...settings });
	for (const [path, marker, line, old] of [
		[instructions, REFERENCE_MARKER, REFERENCE_LINE, OLD_REFERENCE_LINES],
		[".gitattributes", ATTRIBUTES_LINE, ATTRIBUTES_LINE, []],
	] as const) {
		const content = appendLine(repo.stat(path) === "file" ? repo.read(path) : "", marker, line, old);
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
 * line, or null when a line already starts with `marker`. A line matching one
 * of `old` exactly is replaced with `line` instead.
 */
function appendLine(content: string, marker: string, line: string, old: readonly string[]): string | null {
	const existing = lines(content);
	const outdated = existing.find((l) => old.includes(l));
	if (outdated !== undefined) return content.replace(outdated, line);
	if (existing.some((l) => l.startsWith(marker))) return null;
	const eol = newline(content);
	if (content !== "") {
		if (!content.endsWith("\n")) content += eol;
		content += eol;
	}
	return `${content}${line}${eol}`;
}

/** A hook entry that runs Quest: the event it handles and its command. */
export interface QuestHook {
	event: string;
	command: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The command of a hook handler that runs `quest worktree hook`, directly or through a wrapper that names
 * the `quest` executable, package, or flake attribute as a word, such as
 * `nix run "${CLAUDE_PROJECT_DIR}#quest" -- worktree hook`. Another tool's command that merely ends in
 * `worktree hook` is not Quest's.
 */
function questCommand(handler: unknown): string | undefined {
	if (!record(handler) || handler.type !== "command" || typeof handler.command !== "string") return undefined;
	const command = handler.command.trim();
	const runner = /^(.*?)(?:^|\s)worktree hook$/.exec(command)?.[1];
	return runner !== undefined && /(?:^|[\s/#"'])quest(?=$|[\s"'@])/.test(runner) ? command : undefined;
}

/**
 * Claude Code settings `text` without Quest's hook handlers, nor the groups, events, and hooks object they
 * leave empty, along with the handlers removed. Its content is null when nothing else remains, and the
 * result undefined when there is nothing to remove or the settings are malformed, which Claude Code
 * rejects whole, so their hooks never run.
 */
export function removeHooks(text: string): { content: string | null; hooks: QuestHook[] } | undefined {
	let settings: unknown;
	try {
		settings = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!record(settings) || !record(settings.hooks)) return undefined;
	const removed: QuestHook[] = [];
	const kept: [string, unknown][] = [];
	for (const [event, groups] of Object.entries(settings.hooks)) {
		if (!Array.isArray(groups) || !groups.every((group) => record(group) && Array.isArray(group.hooks ?? [])))
			return undefined;
		const before = removed.length;
		const remaining = (groups as { hooks?: unknown[] }[]).flatMap((group) => {
			const handlers = group.hooks ?? [];
			const others = handlers.filter((handler) => {
				const command = questCommand(handler);
				if (command !== undefined) removed.push({ event, command });
				return command === undefined;
			});
			if (others.length === handlers.length) return [group];
			return others.length ? [{ ...group, hooks: others }] : [];
		});
		if (removed.length === before) kept.push([event, groups]);
		else if (remaining.length) kept.push([event, remaining]);
	}
	if (!removed.length) return undefined;
	// Rebuilt rather than edited, so an event named `__proto__` stays an ordinary key.
	if (kept.length) settings.hooks = Object.fromEntries(kept);
	else delete settings.hooks;
	if (Object.keys(settings).length === 0) return { content: null, hooks: removed };
	const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
	const eol = newline(text);
	return { content: `${JSON.stringify(settings, null, indent).replaceAll("\n", eol)}${eol}`, hooks: removed };
}
