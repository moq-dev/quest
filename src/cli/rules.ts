// The rules from `quest context` that a program can check, enforced on an
// agent's tool calls and turn ends by `quest hook` instead of read as prose.
// Each check stays narrow enough to never block legitimate work: it judges
// only what the call or stop itself shows, and lets through what it cannot
// tell apart.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { REFERENCE_MARKER, lines } from "../core";
import { parse, type Simple } from "./shell";

const EM_DASH = String.fromCharCode(0x2014);

/** The prefix with which an agent attests that the user asked, in their own words, for a force-push or rebase. */
export const USER_ASKED = "QUEST_USER_ASKED=1";

/** Each checked rule, as `quest hook` gives it when denying a call that breaks it. */
export const RULES = {
	busyWait:
		"Never busy-loop or spin while waiting, such as a `read` fed `/dev/zero` or `yes` into a loop or `/dev/null`: block on the harness's own wait for the task, `quest wait` for a PR, or the command itself.",
	emDash: "No em dashes in what you write: use a comma, colon, parentheses, or separate sentences. Text quoted from someone else keeps its em dashes on a `>` quote line.",
	footer: "End every GitHub post you author with a `(Written by <model> with <effort>)` line, naming the running model and its reasoning effort, or `(Written by <model>)` when the harness doesn't report the effort; never guess it.",
	refspec:
		"Push with an explicit refspec, `git push <remote> refs/heads/<branch>:refs/heads/<branch>`: a bare branch name can push to the base instead, as under `push.default=upstream` when the branch tracks it.",
	rewrite:
		"Never rebase or force-push, even a branch only you hold; merge the base instead, when the branch conflicts with it or a landing step refuses the head.",
	tmp: "Put scratch files, such as PR bodies, logs, patches, helper scripts, and temporary clones, in the checkout's `.tmp/`, never `/tmp`, so they disappear with the worktree.",
} as const;

/**
 * The checked rules as a section of `quest context`, for an agent no hook
 * checks them for, such as one whose user never ran `quest setup`. The hook
 * leaves it out of the context it adds.
 */
export const CHECKED_CONTEXT = `## Checked\n\n${Object.values(RULES)
	.map((rule) => `- ${rule}`)
	.join("\n")}\n`;

/**
 * Whether the checkout holding `cwd` points its agents at `quest context`:
 * its root `AGENTS.md` or `CLAUDE.md` has a line starting with Quest's
 * reference marker. Found without running git, since every session waits on it.
 */
export function usesQuest(cwd: string): boolean {
	return questRoot(cwd) !== null;
}

/** The root of the checkout holding `cwd` when it uses Quest, as `usesQuest` decides, or null. */
export function questRoot(cwd: string): string | null {
	for (let dir = cwd; ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) {
			const uses = ["AGENTS.md", "CLAUDE.md"].some((name) => {
				try {
					return lines(readFileSync(join(dir, name), "utf8")).some((line) =>
						line.startsWith(REFERENCE_MARKER),
					);
				} catch {
					return false;
				}
			});
			return uses ? dir : null;
		}
		if (dirname(dir) === dir) return null;
	}
}

/** The fields of a Claude Code `Stop` or `SubagentStop` hook's JSON input that `runningGates` reads. */
export interface StopInput {
	hook_event_name: string;
	cwd: string;
	/** Stop: the session's transcript. */
	transcript_path?: string;
	/** SubagentStop: the subagent's own transcript; empty where Claude Code keeps none. */
	agent_transcript_path?: string;
	/** The session's background work still in flight, its subagents' included. */
	background_tasks?: { id: string; type: string; command?: string }[];
}

/** A shell command line that runs `quest gate`, directly or through `bun run quest` and the like. */
const GATE = /(^|[^\w-])quest\s+gate(\s|$)/;

/**
 * The `quest gate` commands still running in the background that the agent
 * ending its turn started, in a repository that uses Quest. Claude Code lists
 * the whole session's background work, subagents' included, so a command
 * counts as this agent's when its transcript holds the ID Claude Code gave the
 * command on backgrounding it (`ID: <id>`); without a transcript, every one
 * counts. Claude Code stops a subagent's background commands when it ends, so
 * ending on one loses its result, and it lists a command only while it runs,
 * so a refusal lasts no longer than the gate. Input without the list, from a
 * Claude Code older than it, has none.
 */
export function runningGates(input: StopInput): string[] {
	const gates = (input.background_tasks ?? []).filter(
		(task) => task.type === "shell" && typeof task.command === "string" && GATE.test(task.command),
	);
	if (gates.length === 0 || !usesQuest(input.cwd)) return [];
	const path = input.hook_event_name === "SubagentStop" ? input.agent_transcript_path : input.transcript_path;
	let transcript: string | undefined;
	try {
		transcript = path ? readFileSync(path, "utf8") : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return gates
		.filter((task) => transcript === undefined || transcript.includes(`ID: ${task.id}`))
		.map((task) => task.command!);
}

/** What a denial adds to `rewrite`: the way through for a rebase or force-push the user asked for. */
const ASKED = ` If the user asked for this in their own words, prefix the command with \`${USER_ASKED}\`.`;

/** A tool call as Claude Code and Codex hand it to a `PreToolUse` hook. */
export interface ToolCall {
	tool: string;
	input: Record<string, unknown>;
	cwd: string;
}

/** The rules `call` breaks, each said once, in the order of `RULES`. */
export function broken(call: ToolCall): string[] {
	const state = check(call.cwd);
	const { found, scratch } = state;
	const text = (key: string) => (typeof call.input[key] === "string" ? (call.input[key] as string) : undefined);
	const path = text("file_path");
	switch (call.tool) {
		case "Bash": {
			const command = text("command");
			if (command !== undefined) shell(command, state);
			break;
		}
		case "Write":
			if (path !== undefined && scratch(path)) found.add("tmp");
			if (path !== undefined && adds(read(call.cwd, path) ?? "", text("content") ?? "")) found.add("emDash");
			break;
		case "Edit":
		case "MultiEdit": {
			if (path !== undefined && scratch(path)) found.add("tmp");
			const edits = Array.isArray(call.input.edits)
				? (call.input.edits as Record<string, unknown>[])
				: [call.input];
			for (const edit of edits)
				if (adds(String(edit.old_string ?? ""), String(edit.new_string ?? ""))) found.add("emDash");
			break;
		}
		case "apply_patch": {
			const patch = text("command");
			if (patch !== undefined) applyPatch(patch, state);
			break;
		}
	}
	return (Object.keys(RULES) as Rule[])
		.filter((key) => found.has(key))
		.map((key) => (key === "rewrite" ? RULES[key] + ASKED : RULES[key]));
}

/** Em dashes outside `>` quote lines. */
function dashes(text: string): number {
	let count = 0;
	for (const line of text.split("\n")) if (!/^\s*>/.test(line)) count += line.split(EM_DASH).length - 1;
	return count;
}

/** Whether replacing `before` with `after` writes em dashes of its own, rather than keeping ones already there. */
function adds(before: string, after: string): boolean {
	return dashes(after) > dashes(before);
}

type Rule = keyof typeof RULES;

/** One call's check: the rules found broken so far. */
interface Check {
	found: Set<Rule>;
	cwd: string;
	/**
	 * Whether `path` is scratch under `/tmp` outside the checkout holding `cwd`.
	 * A `$TMPDIR` path is unknown, since `TMPDIR` may name the checkout itself.
	 */
	scratch: (path: string) => boolean;
}

function check(cwd: string): Check {
	const root = checkoutRoot(cwd);
	return {
		found: new Set(),
		cwd,
		scratch: (path) => /^\/tmp(\/|$)/.test(path) && !`${path}/`.startsWith(`${root}/`),
	};
}

/** The checkout holding `cwd`, found without running git, or `cwd` outside any. */
function checkoutRoot(cwd: string): string {
	for (let dir = cwd; ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) return dir;
		if (dirname(dir) === dir) return cwd;
	}
}

function read(cwd: string, path: string): string | undefined {
	try {
		return readFileSync(resolve(cwd, path), "utf8");
	} catch {
		return undefined;
	}
}

/** The most a body file may hold to be read: far more than GitHub takes in a post. */
const BODY_LIMIT = 1 << 20;

/**
 * A body file's text, or `undefined` for one that is missing, too large, or
 * not a regular file: a device or pipe may never end, and reading one takes
 * what the command would have read.
 */
function body(cwd: string, path: string): string | undefined {
	try {
		const file = resolve(cwd, path);
		const stat = statSync(file);
		return stat.isFile() && stat.size <= BODY_LIMIT ? readFileSync(file, "utf8") : undefined;
	} catch {
		return undefined;
	}
}

/** The paths that name a command's own stdin. */
const STDIN = new Set(["-", "/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"]);

/** Codex's `apply_patch` envelope: its file headers and its `+`/`-` lines. */
function applyPatch(patch: string, check: Check) {
	let added = "";
	let removed = "";
	for (const line of patch.split("\n")) {
		const header = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
		if (header) {
			if (check.scratch(header[1]!.trim())) check.found.add("tmp");
		} else if (line.startsWith("+")) added += `${line.slice(1)}\n`;
		else if (line.startsWith("-")) removed += `${line.slice(1)}\n`;
	}
	if (adds(removed, added)) check.found.add("emDash");
}

/**
 * The command `argv` runs once wrappers such as `env`, `timeout`, `direnv
 * exec`, `nix develop --command`, and `quest gate` are peeled off, with the
 * variable assignments in front of it added to `env`; `null` for none.
 */
function unwrap(argv: string[], env: Set<string>): string[] | null {
	let rest = argv;
	for (;;) {
		while (rest.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]!)) env.add(rest.shift()!);
		const [name, ...args] = rest;
		if (name === undefined) return null;
		if (["command", "exec", "nohup", "time", "builtin", "env", "nice"].includes(name)) rest = dropOptions(args);
		else if (name === "timeout") rest = dropOptions(args).slice(1);
		else if (name === "direnv" && args[0] === "exec") rest = args.slice(2);
		else if (name === "quest" && args[0] === "gate") rest = args.slice(1);
		else if (name === "nix" && ["develop", "shell"].includes(args[0] ?? "")) {
			const at = args.findIndex((arg) => arg === "--command" || arg === "-c");
			if (at === -1) return rest;
			rest = args.slice(at + 1);
		} else return rest;
	}
}

/** `args` past its leading options, where `-n`, `-s`, `-k`, `-u`, and `-C` take a value. */
function dropOptions(args: string[]): string[] {
	let i = 0;
	while (i < args.length && args[i]!.startsWith("-")) i += /^-[nskuC]$/.test(args[i]!) ? 2 : 1;
	return args.slice(i);
}

/**
 * Check each simple command in a shell command line, following `sh -c` into
 * its script, which inherits the assignments in `inherited`. A body file is
 * read from disk only for a command that is `alone` on its line: after
 * another command, it may hold something else by the time the line posts it.
 * `consumer` is the command a pipe feeds the line's output to, when the line
 * is an `sh -c` script whose own command is piped.
 */
function shell(
	line: string,
	check: Check,
	inherited: ReadonlySet<string> = new Set(),
	alone = true,
	consumer?: string[],
) {
	const { found, scratch } = check;
	const commands = parse(line);
	alone &&= commands.length === 1 && !commands[0]!.runs;
	// A `read` fed `/dev/zero` never blocks, or returns at once, so waiting on it spins a core. The
	// redirect counts on the `read`, on the loop or group around one before it, on the
	// subshell holding one, or on an `exec` before one.
	const readsIn = (from: number, to: number) =>
		commands.slice(from, to).some(({ argv }) => commandName(argv) === "read");
	const feedsRead = ({ argv, group }: Simple, at: number) => {
		if (group !== undefined) return readsIn(...group);
		if (commandName(argv) === "read") return true;
		if (["done", "}"].includes(argv[0]!)) return readsIn(0, at);
		if (argv[0] === "exec") return readsIn(at + 1, commands.length);
		return commandName(argv) === undefined && readsIn(0, commands.length);
	};
	// The subshells around command `at`, whose redirections after `)` apply to it too.
	const around = (at: number) =>
		commands.filter(({ group }) => group !== undefined && group[0] <= at && at < group[1]);
	// The command a pipe from command `at` feeds: the next one past the subshells it is in.
	const into = (at: number) => {
		const groups = around(at);
		return commands.slice(at + 1).find((next) => !groups.includes(next))?.argv ?? [];
	};
	const busy = commands.some((simple, at) => {
		const words = commandWords(simple.argv);
		if (words?.[0] !== "yes" || ["--help", "--version"].includes(words[1]!)) return false;
		const reader = simple.piped ? into(at) : consumer;
		return (
			reader === undefined ||
			[simple, ...around(at)].some(({ redirects }) =>
				redirects.some(
					({ op, fd }) =>
						["&>", "&>>"].includes(op) ||
						([">", ">|", ">>"].includes(op) && (fd === undefined || fd === 1)),
				),
			) ||
			spins(reader)
		);
	});
	if (busy) found.add("busyWait");
	for (const [at, simple] of commands.entries()) {
		const env = new Set(inherited);
		const words = [...simple.argv];
		const argv = unwrap(simple.argv, env);
		for (const { op, target } of simple.redirects)
			if ([">", ">>", ">|", "&>", "&>>"].includes(op) && scratch(target)) found.add("tmp");
			else if (["<", "<>"].includes(op) && target === "/dev/zero" && feedsRead(simple, at)) found.add("busyWait");
		if (argv === null) continue;
		const [name, ...args] = argv;
		// A wrapper such as `env --chdir` moves where the command reads a relative path from.
		const moved = words.slice(0, words.length - argv.length).some((word) => /^(-C|--chdir)/.test(word));
		if (["bash", "sh", "zsh", "dash"].includes(name!)) {
			const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
			if (flag !== -1 && args[flag + 1] !== undefined)
				shell(args[flag + 1]!, check, env, alone && !moved, simple.piped ? into(at) : consumer);
			continue;
		}
		const asked = env.has(USER_ASKED);
		const from = (path: string, expanded = false) =>
			alone && !expanded && !path.startsWith("~") && (isAbsolute(path) || !moved)
				? body(check.cwd, path)
				: undefined;
		// Unknown: a here-document or here-string the shell expands, one beside a `<`, since the later wins, and a pipe.
		const fed = simple.redirects.filter(({ op, fd }) => op === "<" && !fd).at(-1);
		const here = simple.stdinExpanded ? undefined : simple.stdin;
		// Read only once a checked command asks, so no other command's input is opened.
		const stdin = () =>
			fed === undefined ? here : simple.stdin === undefined ? from(fed.target, fed.expanded) : undefined;
		const input = (file: string) =>
			STDIN.has(file) ? stdin() : /^\/(dev|proc)\//.test(file) ? undefined : from(file);
		const literal = (value: string) => (simple.expanded?.some((word) => word.endsWith(value)) ? undefined : value);
		if (name === "tee") {
			if (args.some((arg) => !arg.startsWith("-") && scratch(arg))) found.add("tmp");
		} else if (name === "mkdir") {
			if (positionals(args, new Set(["-m", "--mode"])).some(scratch)) found.add("tmp");
		} else if (name === "mktemp") mktemp(args, env, check);
		else if (name === "git") git(args, asked, input, check);
		else if (name === "gh") gh(args, input, literal, check);
	}
}

/** The shell keywords that may precede a command in the same simple command, as `parse` leaves them. */
const KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "{", "!", "time"]);

/** The words `argv` runs, past leading keywords, assignments, and wrappers such as `command`, or null when none run. */
function commandWords(argv: readonly string[]): string[] | null {
	let at = 0;
	while (at < argv.length && KEYWORDS.has(argv[at]!)) at++;
	return unwrap(argv.slice(at), new Set());
}

/** The command `argv` runs, as `commandWords` finds it. */
function commandName(argv: readonly string[]): string | undefined {
	return commandWords(argv)?.[0];
}

/** Whether a command fed `yes` spins on it: a loop, a group, or a `read`. */
function spins(argv: readonly string[]): boolean {
	const first = argv[0];
	return (
		first === undefined ||
		["while", "until", "for", "select", "{", "do"].includes(first) ||
		commandName(argv) === "read" ||
		commandName(argv) === undefined
	);
}

/**
 * `mktemp` creates under `$TMPDIR`, which is `/tmp` unless an assignment in
 * `env` sets it, unless given a directory or a template outside it.
 */
function mktemp(args: string[], env: ReadonlySet<string>, check: Check) {
	let dir: string | undefined;
	let tmpdir = false;
	let template: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		// These create nothing.
		if (["--help", "--version", "--dry-run"].includes(arg) || /^-[a-z]*u[a-z]*$/.test(arg)) return;
		if (arg === "-p") dir = args[++i];
		else if (arg.startsWith("--tmpdir=")) dir = arg.slice("--tmpdir=".length);
		else if (arg === "--tmpdir" || /^-[a-z]*t[a-z]*$/.test(arg)) tmpdir = true;
		else if (!arg.startsWith("-")) template = arg;
	}
	const assigned = [...env]
		.filter((assignment) => assignment.startsWith("TMPDIR="))
		.at(-1)
		?.slice("TMPDIR=".length);
	if (dir === undefined && (template === undefined || tmpdir)) dir = assigned || "/tmp";
	if (check.scratch(dir ?? template!)) check.found.add("tmp");
}

/** Options of `git` itself that take the next word. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

function git(argv: string[], asked: boolean, input: (file: string) => string | undefined, check: Check) {
	let i = 0;
	while (i < argv.length && argv[i]!.startsWith("-")) i += GIT_VALUE_OPTIONS.has(argv[i]!) ? 2 : 1;
	const [sub, ...args] = argv.slice(i);
	// `-C` moves where git reads a relative message file from.
	const moved = argv.slice(0, i).some((arg) => arg.startsWith("-C"));
	// A help flag anywhere passes, even as an option's value: a missed nudge is cheaper than per-subcommand grammars.
	if (argv.some((arg) => arg === "--help" || arg === "-h")) return;
	if (sub === "push") push(args, asked, check);
	else if (sub === "rebase") {
		if (!asked && !args.some((arg) => ["--abort", "--quit", "--show-current-patch"].includes(arg)))
			check.found.add("rewrite");
	} else if (sub === "pull") {
		const rebase = args.some((arg) => /^(-r|--rebase(=(true|merges|interactive|i))?)$/.test(arg));
		if (rebase && !asked) check.found.add("rewrite");
	} else if (sub === "commit") {
		const message = values(args, ["-m", "--message"], { attached: ["-m"] }).join("\n");
		const files = values(args, ["-F", "--file"], { attached: ["-F"] }).map((file) =>
			moved && file !== "-" && !isAbsolute(file) ? undefined : input(file),
		);
		if (adds("", [message, ...files].join("\n"))) check.found.add("emDash");
	} else if (sub === "clone") {
		// `git clone [options] <repository> [<directory>]` writes only the directory and a separate git directory.
		const written = [positionals(args, CLONE_VALUE_OPTIONS)[1], ...values(args, ["--separate-git-dir"])];
		if (written.some((path) => path !== undefined && check.scratch(path))) check.found.add("tmp");
	} else if (sub === "worktree" && args[0] === "add") {
		// `git worktree add [options] <path> [<commit-ish>]`.
		const path = positionals(args.slice(1), new Set(["-b", "-B", "--reason"]))[0];
		if (path !== undefined && check.scratch(path)) check.found.add("tmp");
	}
}

/** `git clone` options that take the next word. */
const CLONE_VALUE_OPTIONS = new Set([
	"-b",
	"--branch",
	"-o",
	"--origin",
	"-c",
	"--config",
	"-u",
	"--upload-pack",
	"-j",
	"--jobs",
	"--depth",
	"--reference",
	"--reference-if-able",
	"--template",
	"--separate-git-dir",
	"--filter",
	"--shallow-since",
	"--shallow-exclude",
	"--server-option",
	"--bundle-uri",
	"--ref-format",
]);

/** The words in `args` that are not options, nor the values of the options in `valued`. */
function positionals(args: string[], valued: ReadonlySet<string>): string[] {
	const found: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--") return [...found, ...args.slice(i + 1)];
		if (valued.has(args[i]!)) i++;
		else if (!args[i]!.startsWith("-")) found.push(args[i]!);
	}
	return found;
}

/** `git push` options that take the next word. */
const PUSH_VALUE_OPTIONS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

function push(args: string[], asked: boolean, check: Check) {
	const positionals: string[] = [];
	const flags: string[] = [];
	let repo = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--") positionals.push(...args.slice(i + 1));
		if (arg === "--") break;
		if (arg === "--repo" || arg.startsWith("--repo=")) repo = true;
		if (PUSH_VALUE_OPTIONS.has(arg)) i++;
		else if (arg.startsWith("-")) flags.push(arg);
		else positionals.push(arg);
	}
	// `--repo` names the remote, so every positional is a refspec.
	const refspecs = repo ? positionals : positionals.slice(1);
	const forced =
		refspecs.some((spec) => spec.startsWith("+")) ||
		flags.some((flag) => /^(--force|--force-with-lease(=.*)?|--mirror|-[a-zA-Z]*f[a-zA-Z]*)$/.test(flag));
	if (forced && !asked) check.found.add("rewrite");
	const deleting = flags.some((flag) => flag === "--delete" || /^-[a-zA-Z]*d[a-zA-Z]*$/.test(flag));
	const whole = flags.some((flag) => ["--all", "--branches", "--mirror"].includes(flag));
	// `--tags` pushes every tag beside any refspecs given, which still need a `:`.
	const tagsOnly = flags.includes("--tags") && refspecs.length === 0;
	if (whole || deleting || tagsOnly) return;
	if (refspecs.length === 0 || refspecs.some((spec) => !spec.includes(":"))) check.found.add("refspec");
}

/**
 * The values `args` gives the options in `names`, as `--name value`,
 * `--name=value`, or, for the short options in `attached`, `-nvalue`.
 */
function values(args: string[], names: string[], { attached = [] as string[] } = {}): string[] {
	const found: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		const long = names.find((name) => name.startsWith("--") && arg.startsWith(`${name}=`));
		if (names.includes(arg) && i + 1 < args.length) found.push(args[++i]!);
		else if (long !== undefined) found.push(arg.slice(long.length + 1));
		else {
			const short = attached.find((name) => arg.startsWith(name) && arg.length > name.length);
			if (short !== undefined) found.push(arg.slice(short.length));
		}
	}
	return found;
}

/** `gh` subcommands that post text, by group and command, and whether each authors a new post. */
const POSTS: Record<string, Record<string, boolean>> = {
	pr: { create: true, comment: true, review: true, edit: false },
	issue: { create: true, comment: true, edit: false },
};

/**
 * Check a `gh` command that posts text. `input` gives a body file's text,
 * `-` being stdin, and `literal` gives a word's text; each is `undefined`
 * when the line does not settle it, and an unknown body passes.
 */
function gh(
	args: string[],
	input: (file: string) => string | undefined,
	literal: (word: string) => string | undefined,
	check: Check,
) {
	const [group, command, ...rest] = args;
	const file = (path: string | undefined) => (path === undefined ? undefined : input(path));
	let body: (string | undefined)[];
	let titles: (string | undefined)[] = [];
	let authored: boolean;
	if (group === "api") {
		const fields = [command ?? "", ...rest];
		const field = (names: string[]) =>
			values(fields, names, { attached: [names[0]!] })
				.filter((value) => value.startsWith("body="))
				.map((value) => literal(value)?.slice("body=".length));
		body = [
			...field(["-f", "--raw-field"]),
			...field(["-F", "--field"]).map((value) => (value?.startsWith("@") ? file(value.slice(1)) : value)),
		];
		const method = values(fields, ["-X", "--method"], { attached: ["-X"] })
			.at(-1)
			?.toUpperCase();
		authored = method !== "PATCH" && method !== "PUT";
	} else {
		const post = POSTS[group ?? ""]?.[command ?? ""];
		if (post === undefined) return;
		// `--edit-last` edits the last comment, even with `--create-if-none`, which only sometimes creates one.
		authored = post && !rest.includes("--edit-last");
		body = [
			...values(rest, ["-b", "--body"], { attached: ["-b"] }).map(literal),
			...values(rest, ["-F", "--body-file"], { attached: ["-F"] }).map((path) => file(literal(path))),
		];
		titles = values(rest, ["-t", "--title"], { attached: ["-t"] }).map(literal);
	}
	if (body.length === 0) return;
	// An unknown body, such as one piped in, one the shell expands, or a file read after another command, passes.
	if (body.some((text) => text === undefined)) return;
	const text = body.join("\n");
	if (authored && adds("", [...titles.filter((title) => title !== undefined), text].join("\n")))
		check.found.add("emDash");
	if (authored && !/(^|\n)\(written by [^\n]+\)\s*$/i.test(text)) check.found.add("footer");
}
