// Whether a PR from a quest's branch leaves that quest accurate: it deletes
// the finished quest or rewrites it to what remains, so either way the diff
// from the base touches the quest's file. Reading the diff needs git, so it
// lives here rather than in the core.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Finding, branchQuest, check } from "../core";
import { discoveryEnv } from "./git";
import { gitEnvironment } from "./land";
import { snapshot } from "./tree";

/**
 * A finding when `branch` (default: the current branch) is a quest's branch
 * and `head` (default: the working tree) neither deletes nor modifies that
 * quest relative to its merge base with `base`. Not a quest branch, or no such
 * quest at the merge base, is no finding. With `head`, `root` is the
 * repository's top level, as in a bare repository.
 */
export function landed(root: string, base: string, options: { branch?: string; head?: string } = {}): Finding[] {
	const name = options.branch ?? currentBranch(root);
	const mergeBase = git(root, ["merge-base", base, options.head ?? "HEAD"]);
	if (mergeBase.status !== 0) {
		throw new Error(`no merge base between ${base} and HEAD: ${mergeBase.stderr.trim() || "unrelated histories"}`);
	}
	const commit = mergeBase.stdout.trim();
	// Without a head, the pathspec and `<rev>:./path` are relative to the root,
	// which may sit below the repository's top level; a bare repository has no
	// work tree to be relative to.
	const relative = options.head === undefined ? "./" : "";
	const path = questAt(root, commit, name, relative);
	if (path === null) return [];
	const heads = options.head === undefined ? [] : [options.head];
	const diff = git(root, ["diff", "--quiet", "--no-ext-diff", commit, ...heads, "--", `${relative}${path}`]);
	if (diff.status === 1) return [];
	if (diff.status !== 0) throw new Error(`git diff ${commit} -- ${path}: ${diff.stderr.trim()}`);
	return [
		{
			path,
			line: null,
			message:
				`branch ${name} neither deletes nor edits its quest since ${base}; a PR that finishes a quest deletes ` +
				"it and every link to it, and one that leaves work rewrites it to what remains (`quest guide`, Execution)",
		},
	];
}

/** The PR head `quest merge` is about to land, and where to fetch it and its base. */
export interface LandingHead {
	/** The base repository's Git URL, which serves the head's commits even from a fork. */
	remote: string;
	base: string;
	branch: string;
	sha: string;
	token: string;
}

/** Checks a head before `quest merge` queues it; resolves to its findings, empty when it may land. */
export type LandingCheck = (head: LandingHead) => Promise<Finding[]>;

/**
 * What `quest check --no-stubs --base <base> --branch <branch>` reports on `head.sha`, against a
 * freshly fetched base. The head is untrusted, so nothing from it runs or is checked out: the
 * check reads git objects in a temporary bare repository that borrows the objects of the
 * checkout at `root`, if any, and fetches only what it lacks. A base without quests is a
 * repository that does not use them, so it has no findings, and a finding the base already
 * has is not the head's, as the land daemon screens a head.
 */
export function landingCheck(root: string): LandingCheck {
	return async (head) => {
		const dir = mkdtempSync(join(tmpdir(), "quest-merge-"));
		try {
			const run = (args: string[], env: Record<string, string> = {}) => {
				const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-C", dir, ...args], {
					encoding: "utf8",
					env: { ...gitEnvironment(), ...env },
					maxBuffer: 1 << 30,
				});
				if (result.error) throw result.error;
				if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
				return result.stdout.trim();
			};
			run(["init", "--quiet", "--bare"]);
			const local = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
			if (local.status === 0)
				writeFileSync(join(dir, "objects/info/alternates"), `${local.stdout.trim()}/objects\n`);
			// The token rides in the environment, never in arguments other processes can read.
			const basic = Buffer.from(`x-access-token:${head.token}`).toString("base64");
			run(
				[
					"fetch",
					"--quiet",
					"--no-tags",
					head.remote,
					`+refs/heads/${head.base}:refs/remotes/origin/${head.base}`,
					`+${head.sha}:refs/quest/head`,
				],
				{
					GIT_CONFIG_COUNT: "1",
					GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
					GIT_CONFIG_VALUE_0: `Authorization: basic ${basic}`,
				},
			);
			if (run(["ls-tree", "--name-only", `origin/${head.base}`, "quest"]) === "") return [];
			const known = treeCheck(dir, `origin/${head.base}`);
			// A finding the base already has is not this PR's, such as one a `quest` older than the tree's format reports.
			const findings = treeCheck(dir, "refs/quest/head").filter(
				(finding) => !known.some((old) => old.path === finding.path && old.message === finding.message),
			);
			return [
				...findings,
				...landed(dir, `origin/${head.base}`, { branch: head.branch, head: "refs/quest/head" }),
			];
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

/** `quest check`'s findings on `commit`; a tree it cannot read, such as one with no quests left, is one. */
function treeCheck(dir: string, commit: string): Finding[] {
	try {
		const tree = snapshot(dir, commit, null);
		return check(tree.docs, tree.exists);
	} catch (error) {
		return [{ path: "quest", line: null, message: error instanceof Error ? error.message : String(error) }];
	}
}

/** The quest file `branch` names, if it existed at `commit`. */
function questAt(root: string, commit: string, branch: string, relative: string): string | null {
	if (!branch.startsWith("quest/") || branch.endsWith("/")) return null;
	const path = branchQuest(branch);
	return git(root, ["cat-file", "-e", `${commit}:${relative}${path}`]).status === 0 ? path : null;
}

function currentBranch(root: string): string {
	const head = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (head.status !== 0) throw new Error("HEAD is not on a branch; pass --branch with the PR's head branch");
	return head.stdout.trim();
}

function git(root: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync("git", ["-C", root, ...args], {
		encoding: "utf8",
		env: discoveryEnv(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) throw new Error(`running git: ${result.error.message}`);
	return result;
}
