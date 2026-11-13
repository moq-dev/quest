// The CLI's side of the GitHub client: PR arguments, git remotes, and the token, which need a checkout or Node.
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { GitHubDependencies, PullRequest, Repository } from "../github/client";
import { git } from "./git";

/** A bad PR argument or option, reported as a usage error. */
export class GitHubInputError extends Error {}

/** Accept a GitHub PR URL, or a number in the origin repository. */
export function pullRequest(value: string, root: string): PullRequest {
	if (/^[1-9]\d*$/.test(value)) {
		const outside = `a bare PR number is read from origin in ${root}; pass the full GitHub PR URL, or run inside a checkout or name one with --root`;
		let origin: Remote | null;
		try {
			origin = readRemote(root, "origin");
		} catch {
			origin = null;
		}
		if (!origin) throw new GitHubInputError(`${root} is not a checkout with an origin remote: ${outside}`);
		const { repository } = remoteRepository(origin);
		if (!repository) throw new GitHubInputError(`origin does not name a github.com repository: ${outside}`);
		return { ...repository, number: Number(value) };
	}
	const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?(?:[?#].*)?$/.exec(value);
	if (!match) throw new GitHubInputError("expected a GitHub pull request URL or a PR number in origin");
	return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

/**
 * A git remote, read once per command so repeated lookups spawn no more git:
 * its URLs as configured, and the URLs git uses after `insteadOf` rewrites.
 */
export interface Remote {
	name: string;
	/** `remote.<name>.url`, and `.pushurl` or `null` when unset, as configured: the last value of each, as `git config --get` prints. */
	configured: { fetch: string; push: string | null };
	/** The URLs fetches and pushes use, as `git remote get-url [--push]` prints them. */
	used(): { fetch: string; push: string };
}

/**
 * Read `name` from the repository at `root` with one git process, or `null`
 * when it has no configured URL. Only when the configuration rewrites URLs do
 * the rewritten ones cost another, on first use.
 */
export function readRemote(root: string, name: string): Remote | null {
	const key = `remote.${name}.`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// Every value in order: the last is what `git config --get` prints, the first what git uses.
	const fetch: string[] = [];
	const push: string[] = [];
	let rewrites = false;
	// `-z` prints `key\nvalue\0` for each value.
	const listing = git(root, [
		"config",
		"-z",
		"--get-regexp",
		`^(${key}(url|pushurl)|url\\..*\\.(insteadof|pushinsteadof))$`,
	]);
	for (const entry of listing.split("\0")) {
		const at = entry.indexOf("\n");
		if (at < 0) continue;
		const [variable, value] = [entry.slice(0, at), entry.slice(at + 1)];
		if (variable.startsWith("url.")) rewrites = true;
		else if (variable.endsWith(".pushurl")) push.push(value);
		else fetch.push(value);
	}
	if (fetch.length === 0) return null;
	const configured = { fetch: fetch.at(-1)!, push: push.at(-1) ?? null };
	let used = rewrites ? null : { fetch: fetch[0], push: push[0] ?? fetch[0] };
	return {
		name,
		configured,
		used: () => (used ??= rewritten(root, name)),
	};
}

/** The URLs `git remote get-url [--push]` prints for `name`, from one `git remote -v`. */
function rewritten(root: string, name: string): { fetch: string; push: string } {
	const urls: { fetch?: string; push?: string } = {};
	// `<name>\t<url> (fetch|push)` for each URL of every remote, a partial clone's fetch followed by
	// ` [<filter>]`; get-url prints the first of each.
	for (const line of git(root, ["remote", "-v"]).split("\n")) {
		const match = /^([^\t]+)\t(.*) \((fetch|push)\)(?: \[[^\]]*\])?$/.exec(line);
		if (match !== null && match[1] === name) urls[match[3] as "fetch" | "push"] ??= match[2];
	}
	if (urls.fetch === undefined) throw new Error(`no ${name} remote`);
	return { fetch: urls.fetch, push: urls.push ?? urls.fetch };
}

/** Read `name` like `readRemote`, failing when there is no such remote. */
export function requireRemote(root: string, name: string): Remote {
	const remote = readRemote(root, name);
	if (remote === null) throw new Error(`no ${name} remote`);
	return remote;
}

/**
 * The URL `remote` fetches from, or pushes to with `push`, and the github.com
 * repository it names. The configured URL comes first, so a rewrite
 * (`insteadOf`) to another host still names GitHub; otherwise the rewritten one.
 */
export function remoteRepository(remote: Remote, push = false): { url: string; repository: Repository | null } {
	const configured = (push ? remote.configured.push : null) ?? remote.configured.fetch;
	const named = githubRepository(configured);
	if (named !== null) return { url: configured, repository: named };
	const url = push ? remote.used().push : remote.used().fetch;
	return { url, repository: githubRepository(url) };
}

/**
 * The github.com repository a remote URL names, or `null` for any other host:
 * HTTPS with or without credentials, `ssh://`, or the scp-like `user@github.com:` form.
 */
export function githubRepository(url: string): Repository | null {
	const match =
		/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|[^@/:]+@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
			url,
		);
	return match ? { owner: match[1], repo: match[2] } : null;
}

export function gitHubDependencies(warn: (message: string) => void): GitHubDependencies {
	let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
	if (!token) {
		try {
			token = execFileSync("gh", ["auth", "token", "--hostname", "github.com"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		} catch {
			throw new Error("set GH_TOKEN or GITHUB_TOKEN, or sign in with gh auth login");
		}
	}
	if (!token) throw new Error("GitHub authentication returned an empty token");
	return { fetch, now: Date.now, sleep, token, warn };
}
