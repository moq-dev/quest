// The rules from `quest context` that a program can check, enforced on an
// agent's tool calls by `quest hook` instead of read as prose. Each check
// stays narrow enough to never block legitimate work: it judges only what the
// call itself shows, and lets through what it cannot tell apart.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { parse } from "./shell";

const EM_DASH = String.fromCharCode(0x2014);

/** The prefix with which an agent attests that the user asked, in their own words, for a force-push or rebase. */
export const USER_ASKED = "QUEST_USER_ASKED=1";

/** Each checked rule, as `quest hook` gives it when denying a call that breaks it. */
export const RULES = {
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
	/** Whether `path` is scratch under `/tmp`, written as is or through `$TMPDIR`, outside the checkout holding `cwd`. */
	scratch: (path: string) => boolean;
}

function check(cwd: string): Check {
	const root = checkoutRoot(cwd);
	return {
		found: new Set(),
		scratch: (path) => /^(\/tmp|\$TMPDIR|\$\{TMPDIR[^}]*\})(\/|$)/.test(path) && !`${path}/`.startsWith(`${root}/`),
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

/** `args` past its leading options, where `-n`, `-s`, `-k`, and `-u` take a value. */
function dropOptions(args: string[]): string[] {
	let i = 0;
	while (i < args.length && args[i]!.startsWith("-")) i += /^-[nsku]$/.test(args[i]!) ? 2 : 1;
	return args.slice(i);
}

/**
 * Check each simple command in a shell command line, following `sh -c` into
 * its script, which inherits the assignments in `inherited`. Bodies are read
 * only from the line itself, never from disk: a file may hold something else
 * by the time the line runs it.
 */
function shell(line: string, check: Check, inherited: ReadonlySet<string> = new Set()) {
	const { found, scratch } = check;
	for (const simple of parse(line)) {
		const env = new Set(inherited);
		const argv = unwrap(simple.argv, env);
		for (const { op, target } of simple.redirects)
			if ([">", ">>", ">|", "&>", "&>>"].includes(op) && scratch(target)) found.add("tmp");
		if (argv === null) continue;
		const [name, ...args] = argv;
		if (["bash", "sh", "zsh", "dash"].includes(name!)) {
			const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
			if (flag !== -1 && args[flag + 1] !== undefined) shell(args[flag + 1]!, check, env);
			continue;
		}
		const asked = env.has(USER_ASKED);
		// A here-document or here-string the shell expands is unknown here, as is any other stdin or file.
		const stdin = simple.stdinExpanded ? undefined : simple.stdin;
		const input = (file: string) => (file === "-" ? stdin : undefined);
		const literal = (value: string) => (simple.expanded?.some((word) => word.endsWith(value)) ? undefined : value);
		if (name === "tee") {
			if (args.some((arg) => !arg.startsWith("-") && scratch(arg))) found.add("tmp");
		} else if (name === "mkdir" || name === "touch") {
			if (args.some(scratch)) found.add("tmp");
		} else if (["cp", "mv", "ln", "rsync"].includes(name!)) {
			const last = args.filter((arg) => !arg.startsWith("-")).at(-1);
			if (last !== undefined && scratch(last)) found.add("tmp");
		} else if (name === "mktemp") mktemp(args, env, check);
		else if (name === "git") git(args, asked, input, check);
		else if (name === "gh") gh(args, input, literal, check);
	}
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
	if (sub === "push") push(args, asked, check);
	else if (sub === "rebase") {
		if (!asked && !args.some((arg) => ["--abort", "--quit", "--show-current-patch"].includes(arg)))
			check.found.add("rewrite");
	} else if (sub === "pull") {
		const rebase = args.some((arg) => /^(-r|--rebase(=(true|merges|interactive|i))?)$/.test(arg));
		if (rebase && !asked) check.found.add("rewrite");
	} else if (sub === "commit") {
		const message = values(args, ["-m", "--message"], { attached: ["-m"] }).join("\n");
		const files = values(args, ["-F", "--file"], { attached: ["-F"] }).map(input);
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
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--") positionals.push(...args.slice(i + 1));
		if (arg === "--") break;
		if (PUSH_VALUE_OPTIONS.has(arg)) i++;
		else if (arg.startsWith("-")) flags.push(arg);
		else positionals.push(arg);
	}
	const refspecs = positionals.slice(1);
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
 * Check a `gh` command that posts text. `input` gives a body file's text
 * (only `-`, stdin from the line, is known), and `literal` gives a word's
 * text, or `undefined` when the shell expands it; an unknown body passes.
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
			values(fields, names)
				.filter((value) => value.startsWith("body="))
				.map((value) => literal(value)?.slice("body=".length));
		body = [
			...field(["-f", "--raw-field"]),
			...field(["-F", "--field"]).map((value) => (value?.startsWith("@") ? file(value.slice(1)) : value)),
		];
		const method = values(fields, ["-X", "--method"]).at(-1)?.toUpperCase();
		authored = method !== "PATCH" && method !== "PUT";
	} else {
		const post = POSTS[group ?? ""]?.[command ?? ""];
		if (post === undefined) return;
		authored = post;
		body = [
			...values(rest, ["-b", "--body"]).map(literal),
			...values(rest, ["-F", "--body-file"]).map((path) => file(literal(path))),
		];
		titles = values(rest, ["-t", "--title"]).map(literal);
	}
	if (body.length === 0) return;
	// A body not on the line, such as a file, one piped in, or one the shell expands, is left to the prose.
	if (body.some((text) => text === undefined)) return;
	const text = body.join("\n");
	if (authored && adds("", [...titles.filter((title) => title !== undefined), text].join("\n")))
		check.found.add("emDash");
	if (authored && !/^\(written by .+\)\s*$/im.test(text)) check.found.add("footer");
}
