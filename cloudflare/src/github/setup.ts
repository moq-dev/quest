// The setup pull request: what `quest init` writes, planned by the core from
// a repository's default branch on GitHub and published by the App, for a
// maintainer enrolling a repository that has no Quest files yet.
import { type Checkout, type InitChange, InitRefused, type Kind, SKILL_DIRS, type Stub } from "quest/core";
import stubs from "../../build/stubs.json";

/** The branch the App publishes the setup on, outside the quest claim namespace. */
export const SETUP_BRANCH = "kix/setup";

/** The skill stubs this deployment's `quest` installs. */
export const STUBS: readonly Stub[] = stubs;

/** The longest goal the enrollment form accepts. */
export const GOAL_LIMIT = 2000;

export type TreeEntry = { path: string; type: string; mode: string; sha: string };

/** Whether the plan may read the file at `path`, so the service fetches it with the tree. */
export function planned(path: string): boolean {
	if (["AGENTS.md", "CLAUDE.md", ".gitattributes", ".claude/settings.json"].includes(path)) return true;
	return SKILL_DIRS.some((dir) => {
		const rest = path.startsWith(`${dir}/`) ? path.slice(dir.length + 1).split("/") : [];
		return rest.length === 2 && rest[0]!.startsWith("quest-") && rest[1] === "SKILL.md";
	});
}

/**
 * A default branch's tree as the core's file plan reads it, with the text of
 * the `planned` files in `files`. Git trees store a symlink's target as data,
 * so the plan refuses to follow one rather than guess where it leads.
 */
export function treeCheckout(entries: TreeEntry[], files: Map<string, string>): Checkout {
	const byPath = new Map(entries.map((entry) => [entry.path, entry]));
	const lstat = (path: string): Kind | null => {
		const entry = byPath.get(path);
		if (!entry) return null;
		if (entry.mode === "120000") return "symlink";
		return entry.type === "tree" ? "dir" : entry.type === "blob" ? "file" : "other";
	};
	const stat = (path: string) => {
		const parts = path.split("/");
		for (let i = 1; i <= parts.length; i++) {
			const prefix = parts.slice(0, i).join("/");
			if (lstat(prefix) === "symlink")
				throw new InitRefused(
					prefix,
					`${prefix} is a symbolic link, which the App cannot follow; run \`quest init\` in a clone instead`,
				);
		}
		return lstat(path) as Exclude<Kind, "symlink"> | null;
	};
	return {
		lstat,
		stat,
		read: (path) => {
			stat(path);
			const text = files.get(path);
			if (text === undefined)
				throw new InitRefused(path, `${path} could not be read as text; run \`quest init\` in a clone instead`);
			return text;
		},
		list: (path) =>
			entries
				.filter(
					(entry) => entry.path.startsWith(`${path}/`) && !entry.path.slice(path.length + 1).includes("/"),
				)
				.map((entry) => entry.path.slice(path.length + 1)),
		real: (path) => path,
	};
}

/**
 * The maintainer's answer to what the project is working toward, as
 * `quest/README.md`'s Goal: trimmed, with Unix newlines, and with any line that
 * would make a heading escaped, so it stays inside the Goal section.
 */
export function setupGoal(text: string): string {
	return (
		text
			.replaceAll("\r\n", "\n")
			.trim()
			.split("\n")
			// An ATX heading opens with `#`; a line of only `=` or `-` underlines the one above as a setext heading.
			.map((line) => line.replace(/^(\s{0,3})(#|(?:=+|-+)\s*$)/, "$1\\$2"))
			.join("\n")
	);
}

/** What each planned change is for, in the pull request body. */
function purpose(change: InitChange): string {
	const path = change.path;
	if (change.content === null) return "removes the stub of a skill Quest no longer ships";
	if (path.endsWith("/SKILL.md")) return "a skill stub";
	if (path === "quest/README.md") return "the quest tree's root, with the project's goal";
	if (path === ".gitattributes") return "routes `quest/**` through the `quest` merge driver";
	if (path === ".claude/settings.json") return "Claude Code's worktree hooks, which run `quest worktree hook`";
	return "points agents at `quest guide`";
}

/** The setup pull request's title and body for `changes`. */
export function setupPull(changes: InitChange[], options: { flake: boolean }) {
	const stubs = changes.filter((change) => change.content !== null && change.path.endsWith("/SKILL.md"));
	const others = changes.filter((change) => !stubs.includes(change));
	const lines = [
		"This sets up [Quest](https://github.com/moq-dev/quest) here with what `quest init` writes, so kix.quest can work on this repository's quests.",
		"",
		...(stubs.length
			? [
					`- ${stubs.length} skill stubs under ${[...new Set(stubs.map((change) => `\`${change.path.split("/").slice(0, 2).join("/")}/\``))].join(" and ")}: each asks the agent to run \`quest skill <name>\``,
				]
			: []),
		...others.map((change) => `- \`${change.path}\`: ${purpose(change)}`),
		"",
		"Merging it enables contributions on kix.quest. Closing it leaves the project setting up, where you can open it again or disconnect.",
		"",
		"## Left out",
		"",
		"These need judgement about this repository, so this pull request leaves them to you or a local agent following [SETUP.md](https://github.com/moq-dev/quest/blob/main/SETUP.md):",
		"",
		"- Pinning `quest` in the repository's tool manager, so local agents run the version these stubs expect. kix's runners bring their own `quest`, so its jobs don't need it.",
		"- Adapting existing agent instructions to Quest beyond the one line added. kix's jobs don't need that either.",
		...(options.flake
			? []
			: [
					"- A Nix dev shell. kix's jobs run in one, and this repository has no `flake.nix`, so after this merges kix offers a bootstrap job that adds one.",
				]),
		"",
	];
	return { title: "Set up Quest", body: lines.join("\n") };
}
