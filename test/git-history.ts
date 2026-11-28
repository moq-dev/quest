// A real repository's history, as the core's base-merge check reads it and as GitHub's REST API serves it.
import { type ChildProcessByStdio, execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach } from "vitest";

import type { History, TreeEntry } from "../src/core";
import { tempDir } from "./fixture";

const bin = fileURLToPath(new URL("../src/cli/bin.ts", import.meta.url));
const bunfig = fileURLToPath(new URL("../bunfig.toml", import.meta.url));

export function git(dir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Whether `ancestor` is reachable from `commit`. */
function reaches(dir: string, commit: string, ancestor: string): boolean {
	return spawnSync("git", ["-C", dir, "merge-base", "--is-ancestor", ancestor, commit]).status === 0;
}

/** A repository on `main`, its `quest` merge driver this checkout's `quest resolve`. */
export function repository(): string {
	const dir = tempDir();
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.name", "Quest test");
	git(dir, "config", "user.email", "test@example.invalid");
	git(dir, "config", "merge.quest.driver", `bun --config='${bunfig}' '${bin}' resolve %A %O %B`);
	// Git's defaults, which a person's own config may change for `git merge`, and GitHub's merges keep.
	git(dir, "config", "diff.algorithm", "histogram");
	git(dir, "config", "merge.conflictStyle", "merge");
	return dir;
}

/** Commit `files` on the current branch, deleting each null one; returns the commit. */
export function commit(dir: string, files: Record<string, string | Uint8Array | null>, message = "edit"): string {
	for (const [path, content] of Object.entries(files)) {
		const file = join(dir, path);
		if (content === null) rmSync(file);
		else {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, content);
		}
	}
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "--allow-empty", "-m", message);
	return git(dir, "rev-parse", "HEAD");
}

/** One `git cat-file --batch` answering reads of a repository's objects in order. */
class Objects {
	readonly #child: ChildProcessByStdio<Writable, Readable, null>;
	readonly #waiting: {
		oid: string;
		type: string;
		resolve: (object: { oid: string; body: Buffer }) => void;
		reject: (error: Error) => void;
	}[] = [];
	readonly #exited: Promise<void>;
	#buffer = Buffer.alloc(0);
	#failed: Error | undefined;

	constructor(dir: string) {
		this.#child = spawn("git", ["-C", dir, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "inherit"] });
		this.#child.stdout.on("data", (chunk: Buffer) => {
			this.#buffer = Buffer.concat([this.#buffer, chunk]);
			this.#drain();
		});
		this.#exited = new Promise((resolve) => {
			const fail = (error: Error) => {
				this.#failed ??= error;
				for (const read of this.#waiting.splice(0)) read.reject(this.#failed);
				resolve();
			};
			this.#child.on("error", fail);
			this.#child.stdin.on("error", fail);
			this.#child.on("close", (code) => fail(new Error(`git cat-file --batch exited with ${code}`)));
		});
	}

	/** Object `oid`'s full id and body; it must be a `type`. */
	read(oid: string, type: string): Promise<{ oid: string; body: Buffer }> {
		return new Promise((resolve, reject) => {
			if (this.#failed !== undefined) return reject(this.#failed);
			this.#waiting.push({ oid, type, resolve, reject });
			this.#child.stdin.write(`${oid}\n`);
		});
	}

	/** Ends the process and waits for it, so the test's CPU budget counts it. */
	close(): Promise<void> {
		this.#child.stdin.end();
		return this.#exited;
	}

	#drain() {
		while (this.#waiting.length > 0) {
			const eol = this.#buffer.indexOf(10);
			if (eol < 0) return;
			// `<oid> <type> <size>`, the body, and a newline; or `<name> missing` or `<name> ambiguous`.
			const header = this.#buffer.toString("latin1", 0, eol);
			const [id, type, size] = header.split(" ") as [string, string?, string?];
			const end = eol + 1 + Number(size);
			if (size !== undefined && this.#buffer.length < end + 1) return;
			const read = this.#waiting.shift()!;
			if (size === undefined || type !== read.type) {
				this.#buffer = this.#buffer.subarray(size === undefined ? eol + 1 : end + 1);
				read.reject(new Error(`${read.oid} is not a ${read.type}: ${header}`));
				continue;
			}
			read.resolve({ oid: id, body: this.#buffer.subarray(eol + 1, end) });
			this.#buffer = this.#buffer.subarray(end + 1);
		}
	}
}

const readers = new Map<string, Objects>();

// Registered after the fixture's and the budget's hooks, so it runs before them (Vitest runs after-hooks as a
// stack): each reader exits before its repository is removed and is reaped before the budget samples the CPU.
afterEach(async () => {
	const open = [...readers.values()];
	readers.clear();
	await Promise.all(open.map((reader) => reader.close()));
});

/** `dir`'s object reader, started once per test and closed when the test ends. */
function objects(dir: string): Objects {
	let reader = readers.get(dir);
	if (reader === undefined) {
		reader = new Objects(dir);
		readers.set(dir, reader);
	}
	return reader;
}

/** `dir`'s history, with `base` as the PR's base branch; its reads end with the test. */
export function gitHistory(dir: string, base = "main"): History {
	const reader = objects(dir);
	return {
		async commit(sha) {
			const body = (await reader.read(sha, "commit")).body.toString("utf8");
			const headers = body.slice(0, body.indexOf("\n\n")).split("\n");
			const field = (name: string) =>
				headers.filter((line) => line.startsWith(`${name} `)).map((line) => line.slice(name.length + 1));
			return { tree: field("tree")[0]!, parents: field("parent") };
		},
		async tree(oid) {
			// Each entry is `<mode> <name>\0` and a binary id as wide as the tree's own (SHA-1 or SHA-256); git
			// stores a directory's mode without its leading zero.
			const { oid: id, body } = await reader.read(oid, "tree");
			const width = id.length / 2;
			const entries = new Map<string, TreeEntry>();
			for (let at = 0; at < body.length;) {
				const space = body.indexOf(32, at);
				const nul = body.indexOf(0, space);
				const mode = body.toString("latin1", at, space).padStart(6, "0");
				const type = mode === "040000" ? "tree" : mode === "160000" ? "commit" : "blob";
				entries.set(body.toString("utf8", space + 1, nul), {
					mode,
					type,
					oid: body.toString("hex", nul + 1, nul + 1 + width),
				});
				at = nul + 1 + width;
			}
			return entries;
		},
		async blob(oid) {
			return new Uint8Array((await reader.read(oid, "blob")).body);
		},
		async mergeBase(a, b) {
			const bases = git(dir, "merge-base", "--all", a, b).split("\n").filter(Boolean);
			return bases.length === 1 ? bases[0]! : null;
		},
		async onBase(sha) {
			return reaches(dir, base, sha);
		},
	};
}

/**
 * The GitHub REST routes the base-merge check and the review readers call for `example/project`, answered from
 * `dir`: commits, trees, blobs, and comparisons, as JSON or as a diff. Undefined for any other request.
 */
export function gitRoutes(dir: string): (url: URL, init?: RequestInit) => Response | undefined {
	const prefix = "/repos/example/project";
	const resolve = (ref: string) => git(dir, "rev-parse", decodeURIComponent(ref));
	return (url, init) => {
		if (!url.pathname.startsWith(`${prefix}/`)) return undefined;
		const route = url.pathname.slice(prefix.length);
		const object = /^\/git\/(commits|trees|blobs)\/([0-9a-f]{40})$/.exec(route);
		if (object?.[1] === "commits") {
			const [, ...parents] = git(dir, "rev-list", "--parents", "-n", "1", object[2]!).split(" ");
			return Response.json({
				sha: object[2],
				tree: { sha: git(dir, "rev-parse", `${object[2]}^{tree}`) },
				parents: parents.map((sha) => ({ sha })),
			});
		}
		if (object?.[1] === "trees") {
			const tree = [
				...execFileSync("git", ["-C", dir, "ls-tree", "-z", object[2]!], { encoding: "utf8" }).split("\0"),
			]
				.filter(Boolean)
				.map((line) => {
					const [info, path] = line.split("\t") as [string, string];
					const [mode, type, sha] = info.split(" ");
					return { path, mode, type, sha };
				});
			return Response.json({ sha: object[2], tree, truncated: false });
		}
		if (object?.[1] === "blobs") {
			const bytes = execFileSync("git", ["-C", dir, "cat-file", "blob", object[2]!]);
			return Response.json({ sha: object[2], content: bytes.toString("base64"), encoding: "base64" });
		}
		const compare = /^\/compare\/(.+)\.\.\.([^.].*)$/.exec(route);
		if (!compare) return undefined;
		const [from, to] = [resolve(compare[1]!), resolve(compare[2]!)];
		if (new Headers(init?.headers).get("Accept") === "application/vnd.github.diff")
			return new Response(execFileSync("git", ["-C", dir, "diff", `${from}...${to}`], { encoding: "utf8" }));
		const status =
			from === to
				? "identical"
				: reaches(dir, from, to)
					? "behind"
					: reaches(dir, to, from)
						? "ahead"
						: "diverged";
		const count = (range: string) => Number(git(dir, "rev-list", "--count", range));
		return Response.json({
			status,
			// As git counts them, which GitHub's are.
			ahead_by: count(`${from}..${to}`),
			behind_by: count(`${to}..${from}`),
			base_commit: { sha: from },
			merge_base_commit: { sha: git(dir, "merge-base", from, to) },
			files: [],
		});
	};
}
