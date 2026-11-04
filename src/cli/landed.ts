// Whether a PR from a quest's branch leaves that quest accurate: it deletes
// the finished quest or rewrites it to what remains, so either way the diff
// from the base touches the quest's file. Reading the diff needs git, so it
// lives here rather than in the core.

import { spawnSync } from "node:child_process";

import { type Finding, branchQuest } from "../core";
import { discoveryEnv } from "./git";

/**
 * A finding when `branch` (default: the current branch) is a quest's branch
 * and the working tree neither deletes nor modifies that quest relative to its
 * merge base with `base`. Not a quest branch, or no such quest at the merge
 * base, is no finding.
 */
export function landed(root: string, base: string, branch?: string): Finding[] {
	const name = branch ?? currentBranch(root);
	const mergeBase = git(root, ["merge-base", base, "HEAD"]);
	if (mergeBase.status !== 0) {
		throw new Error(`no merge base between ${base} and HEAD: ${mergeBase.stderr.trim() || "unrelated histories"}`);
	}
	const commit = mergeBase.stdout.trim();
	const path = questAt(root, commit, name);
	if (path === null) return [];
	// The pathspec and `<rev>:./path` are relative to the root, which may sit
	// below the repository's top level.
	const diff = git(root, ["diff", "--quiet", "--no-ext-diff", commit, "--", `./${path}`]);
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

/** The quest file `branch` names, if it existed at `commit`. */
function questAt(root: string, commit: string, branch: string): string | null {
	if (!branch.startsWith("quest/") || branch.endsWith("/")) return null;
	const path = branchQuest(branch);
	return git(root, ["cat-file", "-e", `${commit}:./${path}`]).status === 0 ? path : null;
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
