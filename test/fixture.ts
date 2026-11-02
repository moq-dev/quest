// A minimal but complete quest tree on disk: root epic -> milestone ->
// epic -> two quests, one blocking the other.

import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
	appendFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, afterEach, expect } from "vitest";

import { blockers, check, formatFinding, lookup, ready, renderBlocker } from "../src/core";
import { type Output, main } from "../src/cli/main";
import { type Terminal } from "../src/cli/theme";
import { exists, load } from "../src/cli/tree";

export const ROOT_README = `# Quests

## Goal

The permanent root epic.

## Required

- [M0](/quest/m0/README.md)
`;

export const M0_README = `# M0

## Goal

A milestone.

## Required

- [Epic](/quest/m0/epic/README.md)
`;

export const EPIC_README = `# Epic

## Goal

An epic.

## Required

- [One](/quest/m0/epic/one.md)
- [Two](/quest/m0/epic/two.md)
`;

export const ONE = `# [S] One

## Goal

A quest.
`;

export const TWO = `# [S] Two

## Goal

Another quest.

## Required

- [One](/quest/m0/epic/one.md) - must finish first
`;

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh temporary directory, removed after the test. */
export function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "quest-test-"));
	dirs.push(dir);
	return dir;
}

const templates: string[] = [];
afterAll(() => {
	for (const dir of templates.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A repository, or any directory, that `build` makes once per test file in an
 * empty directory, then copied for each use into `dir` or a fresh temporary
 * directory. Every git process is slow to start on Windows, so tests copy
 * repositories rather than spawn git to make each one.
 */
export function template(build: (dir: string) => void): (dir?: string) => string {
	let built: string | undefined;
	return (dir = tempDir()) => {
		if (built === undefined) {
			const fresh = mkdtempSync(join(tmpdir(), "quest-template-"));
			templates.push(fresh);
			build(fresh);
			built = fresh;
		}
		cpSync(built, dir, { recursive: true });
		return dir;
	};
}

/**
 * Settings for every fixture repository: an identity, no signing, and no
 * automatic maintenance, which would spawn another git after each commit, fetch, or merge.
 */
export const GIT_SETTINGS: Record<string, string> = {
	"user.name": "Test",
	"user.email": "test@example.com",
	"commit.gpgsign": "false",
	"maintenance.auto": "false",
};

/**
 * Add `settings`, by `section[.subsection].name`, to the config of the
 * repository at `dir`, bare or not, without spawning git. Each adds a value,
 * so set only keys the config lacks.
 */
export function configure(dir: string, settings: Record<string, string>): void {
	// Subsections and quoted values escape `"` and `\`, as in a Windows path.
	const quote = (text: string) => `"${text.replace(/["\\]/g, "\\$&")}"`;
	const sections = Object.entries(settings).map(([key, value]) => {
		const first = key.indexOf(".");
		const last = key.lastIndexOf(".");
		const subsection = first === last ? "" : ` ${quote(key.slice(first + 1, last))}`;
		return `[${key.slice(0, first)}${subsection}]\n\t${key.slice(last + 1)} = ${quote(value)}\n`;
	});
	const git = join(dir, ".git");
	appendFileSync(existsSync(git) ? join(git, "config") : join(dir, "config"), sections.join(""));
}

/** Empty repositories on main, with `GIT_SETTINGS`. */
const repositories = {
	work: template((dir) => {
		execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
		configure(dir, GIT_SETTINGS);
	}),
	bare: template((dir) => {
		execFileSync("git", ["init", "-q", "--bare", "-b", "main", dir], { stdio: "ignore" });
		configure(dir, GIT_SETTINGS);
	}),
};

/**
 * Make `dir`, or a fresh temporary directory, a new repository on main with
 * `GIT_SETTINGS`, keeping any files already in it. Returns its path.
 */
export function initRepository(dir?: string, { bare = false } = {}): string {
	return bare ? repositories.bare(dir) : repositories.work(dir);
}

/** The baseline tree, committed on main. */
const committedBaseline = template((dir) => {
	Tree.baseline().copy(dir);
	initRepository(dir);
	execFileSync("git", ["-C", dir, "add", "-A"], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "commit", "-q", "-m", "baseline"], { stdio: "ignore" });
});

export class Tree {
	readonly path: string;

	constructor(path = tempDir()) {
		this.path = path;
	}

	/** The baseline tree, which passes. */
	static baseline(): Tree {
		return new Tree()
			.write("quest/README.md", ROOT_README)
			.write("quest/m0/README.md", M0_README)
			.write("quest/m0/epic/README.md", EPIC_README)
			.write("quest/m0/epic/one.md", ONE)
			.write("quest/m0/epic/two.md", TWO);
	}

	/** The baseline tree as a repository with everything committed on main, with `GIT_SETTINGS`, at `path`. */
	static committed(path?: string): Tree {
		return new Tree(committedBaseline(path));
	}

	/** Copy this tree's files into `dir`. */
	copy(dir: string): void {
		cpSync(this.path, dir, { recursive: true });
	}

	write(rel: string, body: string): this {
		const path = join(this.path, rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, body);
		return this;
	}

	append(rel: string, body: string): this {
		return this.write(rel, readFileSync(join(this.path, rel), "utf8") + body);
	}

	remove(rel: string): this {
		rmSync(join(this.path, rel), { recursive: true });
		return this;
	}

	read(rel: string): string {
		return readFileSync(join(this.path, rel), "utf8");
	}

	findings(): string[] {
		return check(load(this.path), (path) => exists(this.path, path)).map(formatFinding);
	}

	/** The rendered blocker chain: one line per blocker, nesting indented. */
	blockers(path: string): string[] {
		const docs = load(this.path);
		const doc = lookup(docs, path);
		if (doc === null) throw new Error(`${path} is not a quest`);
		return blockers(docs, doc).flatMap((blocker) => renderBlocker(blocker));
	}

	ready(): string[] {
		return ready(load(this.path));
	}

	/** Run the CLI against this tree. */
	run(...args: string[]): { code: number; stdout: string; stderr: string } {
		return run("--root", this.path, ...args);
	}

	/** Run the CLI against this tree with stdout on a terminal. */
	runOn(terminal: Terminal, ...args: string[]): { code: number; stdout: string; stderr: string } {
		return runOn(terminal, "--root", this.path, ...args);
	}

	accepts() {
		expect(this.findings()).toEqual([]);
	}

	rejects(expected: string) {
		const findings = this.findings();
		expect(
			findings.some((f) => f.includes(expected)),
			`expected a finding containing ${JSON.stringify(expected)}, got: ${JSON.stringify(findings, null, 2)}`,
		).toBe(true);
	}

	without(unexpected: string) {
		const findings = this.findings();
		expect(
			findings.some((f) => f.includes(unexpected)),
			`expected NO finding containing ${JSON.stringify(unexpected)}, got: ${JSON.stringify(findings, null, 2)}`,
		).toBe(false);
	}
}

/** Run the CLI in-process with stdout piped, capturing its output. */
export function run(...args: string[]): { code: number; stdout: string; stderr: string } {
	return runOn(undefined, ...args);
}

/** Run the CLI in-process with stdout on `terminal`, or piped when `undefined`. */
export function runOn(
	terminal: Terminal | undefined,
	...args: string[]
): { code: number; stdout: string; stderr: string } {
	let stdout = "";
	let stderr = "";
	const out: Output = {
		stdout: (text) => {
			stdout += text;
		},
		stderr: (text) => {
			stderr += text;
		},
		terminal,
	};
	const code = main(args, out);
	if (typeof code !== "number") throw new Error("use await main for asynchronous CLI commands");
	return { code, stdout, stderr };
}

/**
 * Run `command` as the foreground job of a new pseudo-terminal, through util-linux `script`,
 * and type `keys` once the terminal shows "ready". Resolves with everything the terminal showed.
 */
export async function onTerminal(
	command: string[],
	keys: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number | null; output: string }> {
	const quoted = command.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
	const child = spawn("script", ["--quiet", "--return", "--flush", "--command", quoted, "/dev/null"], {
		env: { ...env, SHELL: "/bin/sh" },
		stdio: ["pipe", "pipe", "inherit"],
	});
	let output = "";
	let typed = false;
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (data: string) => {
		output += data;
		if (typed || !output.includes("ready")) return;
		typed = true;
		child.stdin.write(keys);
	});
	const [code] = await once(child, "exit");
	return { code, output };
}
