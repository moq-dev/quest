// Whether a PR from a quest's branch leaves that quest accurate: it deletes
// the finished quest or rewrites it to what remains, so either way the diff
// from the base touches the quest's file. Reading the diff needs git, so it
// lives here rather than in the core.

import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Finding, branchQuest, check } from "../core";
import { discoveryEnv } from "./git";
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
	const head = options.head ?? "HEAD";
	const mergeBase = git(root, ["merge-base", base, head]);
	if (mergeBase.status !== 0) {
		throw new Error(
			`no merge base between ${base} and ${head}: ${mergeBase.stderr.trim() || "unrelated histories"}`,
		);
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
	/** The base branch's name, and the commit it points at. */
	base: string;
	baseSha: string;
	branch: string;
	sha: string;
	token: string;
}

/** Checks a head before `quest merge` queues it; resolves to its findings, empty when it may land. */
export type LandingCheck = (head: LandingHead) => Promise<Finding[]>;

/**
 * What `quest check --no-stubs --base <base> --branch <branch>` reports on `head.sha`, against a
 * freshly fetched base. The head is untrusted, so nothing from it runs or is checked out: the
 * check reads git objects. It fetches both commits by SHA into the repository of the checkout at
 * `root`, writing no ref, so Git sends only what that repository lacks and an interrupted run leaves
 * nothing behind. A checkout it cannot write, or a shallow one whose history could hide the merge
 * base, gives way to a temporary bare repository, as does no checkout.
 * A finding the base already has is not the head's, as the land daemon screens a head, and a
 * repository with no quests on either side does not use them.
 */
export function landingCheck(root: string): LandingCheck {
	return async (head) => {
		const local = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--is-shallow-repository"]);
		const [common, shallow] = local.stdout.trim().split("\n");
		const borrowed = local.status === 0 && shallow === "false" && writable(common);
		const dir = borrowed ? common : mkdtempSync(join(tmpdir(), "quest-merge-"));
		const { baseSha: base, sha: tip } = head;
		const run = (args: string[], env: Record<string, string> = {}) => {
			const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-C", dir, ...args], {
				encoding: "utf8",
				env: { ...discoveryEnv(), GIT_TERMINAL_PROMPT: "0", ...env },
				maxBuffer: 1 << 30,
			});
			if (result.error) throw result.error;
			if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
			return result.stdout.trim();
		};
		// Findings and errors name the scratch directory and the base's SHA, which the refusal need not show.
		const tidy = (finding: Finding): Finding => ({
			...finding,
			message: finding.message.replaceAll(`${dir}/`, "").replaceAll(base, `origin/${head.base}`),
		});
		try {
			if (!borrowed) run(["init", "--quiet", "--bare"]);
			// The token rides in the environment, after any configuration the user's environment already passes.
			const count = Number(process.env.GIT_CONFIG_COUNT ?? 0) || 0;
			const basic = Buffer.from(`x-access-token:${head.token}`).toString("base64");
			run(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", head.remote, base, tip], {
				GIT_CONFIG_COUNT: String(count + 2),
				// An empty value drops any header the checkout already sends, such as actions/checkout's, which GitHub would reject as a duplicate.
				[`GIT_CONFIG_KEY_${count}`]: "http.https://github.com/.extraheader",
				[`GIT_CONFIG_VALUE_${count}`]: "",
				[`GIT_CONFIG_KEY_${count + 1}`]: "http.https://github.com/.extraheader",
				[`GIT_CONFIG_VALUE_${count + 1}`]: `Authorization: basic ${basic}`,
			});
			const quests = (ref: string) => run(["ls-tree", "--name-only", ref, "quest"]) !== "";
			const based = quests(base);
			if (!based && !quests(tip)) return [];
			// A finding the base already has is not this PR's, such as one a `quest` older than the tree's
			// format reports; one more of the same in the head is.
			const known = based ? treeCheck(dir, base) : [];
			const findings = treeCheck(dir, tip).filter((finding) => {
				const index = known.findIndex((old) => old.path === finding.path && old.message === finding.message);
				if (index === -1) return true;
				known.splice(index, 1);
				return false;
			});
			let accurate: Finding[];
			try {
				accurate = landed(dir, base, { branch: head.branch, head: tip });
			} catch (error) {
				throw new Error(
					tidy({ path: "", line: null, message: String(error instanceof Error ? error.message : error) })
						.message,
				);
			}
			return [...findings, ...accurate].map(tidy);
		} finally {
			if (!borrowed) rmSync(dir, { recursive: true, force: true });
		}
	};
}

/** Whether this process may write the objects of the Git directory `dir`. */
function writable(dir: string): boolean {
	try {
		accessSync(join(dir, "objects"), constants.W_OK);
		return true;
	} catch {
		return false;
	}
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
