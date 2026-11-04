// Git run on an explicit path. Quest may itself run from a Git hook or `git submodule foreach`, whose
// repository-local variables would otherwise point every such call at the repository that started it.
import { execFileSync, spawnSync } from "node:child_process";

let located: string[] | undefined;
/**
 * `env` without the repository-local variables a Git hook or `git submodule foreach` exports, such as
 * GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE, which override discovery from a path. Git drops the same
 * ones when it enters another repository, and keeps `-c` config.
 */
export function discoveryEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	located ??= execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" })
		.split("\n")
		.filter((name) => name && name !== "GIT_CONFIG_PARAMETERS" && name !== "GIT_CONFIG_COUNT");
	const result = { ...env };
	for (const name of located) delete result[name];
	return result;
}

/** A Git command that exited unsuccessfully, with what it printed. */
export class GitError extends Error {
	constructor(
		command: string,
		readonly status: number | null,
		readonly stdout: string,
		readonly stderr: string,
	) {
		super(`git ${command} failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
	}
}

/**
 * Git run in the repository at `root`, without prompting, returning its output without trailing newlines.
 * A `config` lookup that matches nothing is empty rather than an error.
 */
export function git(root: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): string {
	const result = spawnSync("git", ["-C", root, ...args], {
		encoding: "utf8",
		env: { ...discoveryEnv(), GIT_TERMINAL_PROMPT: "0", ...env },
		input,
		maxBuffer: 1 << 30,
		stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
	});
	if (result.error) throw result.error;
	if (result.status === 0) return result.stdout.replace(/\n+$/, "");
	if (result.status === 1 && args[0] === "config") return "";
	throw new GitError(args[0], result.status, result.stdout, result.stderr);
}
