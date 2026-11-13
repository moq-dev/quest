// The host daemon's shared plumbing: App tokens, state, locks, and the retry loop.
import { spawn } from "node:child_process";
import { createPrivateKey, createSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { GitHub, type GitHubDependencies, type Repository, object, string } from "./github";
import { git } from "./land";

/** Mint a short-lived token for this repository, never the installation's other repositories. */
export async function installationToken(
	repository: Repository,
	options: { appId: string },
	permissions: Record<string, "read" | "write">,
	deps: Pick<GitHubDependencies, "fetch" | "now">,
): Promise<string> {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const now = Math.floor(deps.now() / 1000);
	const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: options.appId })}`;
	const signature = createSign("RSA-SHA256").update(payload).sign(readFileSync(keyPath())).toString("base64url");
	const request = async (path: string, body?: unknown) => {
		const response = await deps.fetch(`https://api.github.com${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				Authorization: `Bearer ${payload}.${signature}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "quest",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!response.ok) throw new Error(`GitHub App request failed: HTTP ${response.status}`);
		return object(await response.json());
	};
	const installation = await request(`/repos/${repository.owner}/${repository.repo}/installation`);
	return string(
		(
			await request(`/app/installations/${Number(installation.id)}/access_tokens`, {
				repositories: [repository.repo],
				permissions,
			})
		).token,
	);
}

/** Replace `path` atomically, readable only by the daemon's user. */
export function save(path: string, value: unknown): void {
	writeFileSync(`${path}.new`, JSON.stringify(value), { mode: 0o600 });
	renameSync(`${path}.new`, path);
}

/** A fresh bare repository with no config, objects, or alternates inherited from the user's checkout. */
export function privateRepository(state: string): string {
	const path = join(state, "repository.git");
	if (!existsSync(path)) {
		mkdirSync(path, { mode: 0o700 });
		git(path, ["init", "--bare", "--quiet"]);
		git(path, ["config", "user.name", "moq-bot"]);
		git(path, ["config", "user.email", "moq-bot@users.noreply.github.com"]);
	}
	return path;
}

/** The App key's path, never in argv, where any process could read it from /proc. */
export function keyPath(): string {
	const path =
		process.env.QUEST_LAND_KEY ||
		(process.env.CREDENTIALS_DIRECTORY ? join(process.env.CREDENTIALS_DIRECTORY, "github-app-key") : undefined);
	if (!path) throw new Error("set QUEST_LAND_KEY or provide the github-app-key systemd credential");
	return path;
}

/** A base branch as one path component: `/` and `@` escaped, so no two bases share a file name. */
const baseKey = (base: string) => encodeURIComponent(base);

/**
 * systemd's StateDirectory, or the XDG state home, outside any checkout a sandbox might mount, one per
 * repository and base. No repository name contains `@`, so no two pairs share a directory.
 */
export function defaultState(repository: Repository, base: string): string {
	const home =
		process.env.STATE_DIRECTORY ??
		join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "quest-land");
	return join(home, `${repository.owner}-${repository.repo}@${baseKey(base)}`);
}

/** The repository's default branch, which a daemon started without `--base` lands onto. */
export async function defaultBranch(github: GitHub, repository: Repository): Promise<string> {
	const data = await github.graphql(
		"query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { defaultBranchRef { name } } }",
		{ owner: repository.owner, name: repository.repo },
	);
	return string(object(object(data.repository).defaultBranchRef).name);
}

/** Refresh before expiry and retry a revoked token once; callers never retain an expired token. */
export function apiDependencies(
	mint: () => Promise<string>,
	base: Omit<GitHubDependencies, "token">,
): GitHubDependencies {
	let cached: { token: string; until: number } | undefined;
	return {
		...base,
		token: "quest-api",
		fetch: (async (input, init) => {
			// A merge's fresh, PR-scoped token must not be replaced by the cached queue token.
			const authorization = new Headers(init?.headers).get("Authorization");
			if (authorization && authorization !== "Bearer quest-api") return base.fetch(input, init);
			const request = async () => {
				if (!cached || base.now() >= cached.until)
					cached = { token: await mint(), until: base.now() + 50 * 60_000 };
				const headers = new Headers(init?.headers);
				headers.set("Authorization", `Bearer ${cached.token}`);
				return base.fetch(input, { ...init, headers });
			};
			let response = await request();
			if (response.status === 401) {
				cached = undefined;
				response = await request();
			}
			return response;
		}) as typeof fetch,
	};
}

/** GitHub refuses comments over 65,536 characters. Escaping grows a character at most 5x (`&amp;`). */
export const EXCERPT = 12_000;

/** The end of a log, escaped for `<pre>` and bounded so the comment always posts. */
export function excerpt(tail: string, limit = EXCERPT): string {
	const cut = tail.length > limit ? `…${tail.slice(-limit)}` : tail;
	return cut.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

/** An OS lock disappears even after SIGKILL. Its holder exits when our pipe closes. */
export async function lockCheckout(path: string): Promise<() => void> {
	const child = spawn("flock", ["--nonblock", path, "sh", "-c", "printf locked; cat >/dev/null"], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	await new Promise<void>((done, reject) => {
		child.stdout.once("data", () => done());
		child.once("error", reject);
		child.once("exit", () => reject(new Error("another quest land daemon holds this checkout (or flock failed)")));
	});
	return () => child.stdin.end();
}

/** Every linked worktree resolves to the same lock per base in the common git directory. */
export function lockRepository(root: string, base: string): Promise<() => void> {
	return lockCheckout(
		join(
			git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
			`quest-land-${baseKey(base)}.lock`,
		),
	);
}

/**
 * Prepare a daemon for `repository`: check the App key, resolve its base in `options` once, from
 * `--base` or `defaultBase`, for the daemon's life, resolve and create its state directory, and hold
 * one lock per checkout's repository and base and one per state directory, whichever two daemons
 * would share, so two watchers never run beside each other on one base while
 * daemons on different bases do. Returns the unlock.
 */
export async function startDaemon(
	root: string,
	repository: Repository,
	options: { state: string; base?: string },
	defaultBase: () => Promise<string>,
): Promise<() => void> {
	// These are startup configuration failures; transient network failures in the loop are recoverable.
	createPrivateKey(readFileSync(keyPath()));
	const base = (options.base ||= await defaultBase());
	options.state = resolve(root, options.state || defaultState(repository, base));
	mkdirSync(options.state, { recursive: true, mode: 0o700 });
	const unlockRepository = await lockRepository(root, base);
	const unlockState = await lockCheckout(join(options.state, "lock")).catch((error: unknown) => {
		unlockRepository();
		throw error;
	});
	return () => {
		unlockState();
		unlockRepository();
	};
}

/** Retry a failed pass independently of the lifetime of the daemon. */
export async function daemonLoop(
	iteration: () => Promise<boolean>,
	deps: Pick<GitHubDependencies, "sleep" | "warn">,
	stopped = () => false,
): Promise<void> {
	let backoff = 1000;
	while (!stopped()) {
		let delay = 0;
		try {
			const active = await iteration();
			backoff = 1000;
			if (!active) delay = 60_000;
		} catch (error) {
			deps.warn(
				`quest land: ${error instanceof Error ? error.message : String(error)}; retrying in ${backoff / 1000}s`,
			);
			delay = backoff;
			backoff = Math.min(backoff * 2, 60_000);
		}
		if (delay) await deps.sleep(delay);
	}
}
