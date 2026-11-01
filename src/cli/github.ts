// The GitHub client shared by the commands that talk to GitHub, outside the repository-independent core.
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const API = "https://api.github.com";
const MAX_SLEEP = 2_147_483_647;

/** A repository on github.com. */
export interface Repository {
	owner: string;
	repo: string;
}

export interface PullRequest extends Repository {
	number: number;
}

export interface GitHubDependencies {
	fetch: typeof fetch;
	now(): number;
	sleep(milliseconds: number): Promise<unknown>;
	token: string;
	warn(message: string): void;
}

/** A bad PR argument or option, reported as a usage error. */
export class GitHubInputError extends Error {}

/** A request or pause reached the client's deadline; the caller decides what that means. */
export class GitHubDeadline extends Error {
	constructor() {
		super("deadline reached");
	}
}

export type ObjectValue = Record<string, unknown>;

/** Accept a GitHub PR URL, or a number in the origin repository. */
export function pullRequest(value: string, root: string): PullRequest {
	if (/^[1-9]\d*$/.test(value)) {
		const outside = `a bare PR number is read from origin in ${root}; pass the full GitHub PR URL, or run inside a checkout or name one with --root`;
		let repository: Repository | null;
		try {
			repository = remoteRepository(root, "origin").repository;
		} catch {
			throw new GitHubInputError(`${root} is not a checkout with an origin remote: ${outside}`);
		}
		if (!repository) throw new GitHubInputError(`origin does not name a github.com repository: ${outside}`);
		return { ...repository, number: Number(value) };
	}
	const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?(?:[?#].*)?$/.exec(value);
	if (!match) throw new GitHubInputError("expected a GitHub pull request URL or a PR number in origin");
	return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

/** The URL a git remote fetches from. */
export function remoteUrl(root: string, remote: string): string {
	return execFileSync("git", ["-C", root, "remote", "get-url", remote], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

/**
 * The URL `remote` fetches from, or pushes to with `push`, and the github.com
 * repository it names. The configured URL comes first, so a rewrite
 * (`insteadOf`) to another host still names GitHub; otherwise the rewritten one.
 */
export function remoteRepository(
	root: string,
	remote: string,
	push = false,
): { url: string; repository: Repository | null } {
	const git = (args: string[]) => {
		try {
			return execFileSync("git", ["-C", root, ...args], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		} catch {
			// An unset config key exits 1.
			return "";
		}
	};
	const configured =
		(push ? git(["config", "--get", `remote.${remote}.pushurl`]) : "") ||
		git(["config", "--get", `remote.${remote}.url`]);
	const named = githubRepository(configured);
	if (named !== null) return { url: configured, repository: named };
	const url = push ? git(["remote", "get-url", "--push", remote]) : remoteUrl(root, remote);
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

/** Authenticated REST and GraphQL requests that wait out rate limits, bounded by an optional deadline. */
export class GitHub {
	/** The longest X-Poll-Interval GitHub asked for since the caller last set this, in milliseconds. */
	pollInterval = 0;

	constructor(
		private readonly deps: GitHubDependencies,
		private readonly deadline = Infinity,
	) {}

	/** Sleep, cut short by the deadline. */
	async pause(milliseconds: number): Promise<void> {
		const remaining = this.deadline - this.deps.now();
		if (remaining <= 0) throw new GitHubDeadline();
		await this.deps.sleep(Math.min(milliseconds, remaining, MAX_SLEEP));
		if (this.deps.now() >= this.deadline) throw new GitHubDeadline();
	}

	/**
	 * A 2xx or 304 response; anything else fails after rate-limit retries, with
	 * GitHub's reason when it gives one, unless `allow` lists its status. `body` makes it a POST
	 * unless `method` says otherwise.
	 */
	async request(
		path: string,
		options: { etag?: string; body?: unknown; method?: "POST" | "PUT" | "PATCH" | "DELETE"; allow?: number[] } = {},
	): Promise<Response> {
		// Follow only same-origin pagination links; never send a token to another host.
		const url = new URL(path, API);
		if (url.origin !== API || url.username || url.password) throw new Error("invalid GitHub pagination URL");
		let attempts = 0;
		for (;;) {
			const remaining = this.deadline - this.deps.now();
			if (remaining <= 0) throw new GitHubDeadline();
			let response: Response;
			try {
				response = await this.deps.fetch(url, {
					...(options.body === undefined
						? options.method && { method: options.method }
						: { method: options.method ?? "POST", body: JSON.stringify(options.body) }),
					headers: {
						Accept: "application/vnd.github+json",
						Authorization: `Bearer ${this.deps.token}`,
						"X-GitHub-Api-Version": "2022-11-28",
						"User-Agent": "quest",
						...(options.etag ? { "If-None-Match": options.etag } : {}),
					},
					...(Number.isFinite(remaining) ? { signal: AbortSignal.timeout(Math.ceil(remaining)) } : {}),
				});
			} catch (error) {
				if (this.deps.now() >= this.deadline) throw new GitHubDeadline();
				throw error;
			}
			this.pollInterval = Math.max(this.pollInterval, seconds(response.headers.get("x-poll-interval")) ?? 0);
			if (response.ok || response.status === 304 || options.allow?.includes(response.status)) return response;
			const body = await response.text();
			const limited =
				response.status === 429 ||
				(response.status === 403 &&
					(response.headers.has("retry-after") ||
						response.headers.get("x-ratelimit-remaining") === "0" ||
						/rate limit/i.test(body)));
			if (!limited || attempts >= 6)
				throw new Error(
					`GitHub HTTP ${response.status} for ${url.pathname}; ${limited ? "rate limit persisted" : (explanation(body) ?? "check repository access and token permissions")}`,
				);
			const retry = seconds(response.headers.get("retry-after"));
			const reset =
				response.headers.get("x-ratelimit-remaining") === "0"
					? seconds(response.headers.get("x-ratelimit-reset"))
					: undefined;
			const delay =
				retry ?? (reset === undefined ? 60_000 * 2 ** attempts : Math.max(1000, reset - this.deps.now()));
			attempts++;
			this.deps.warn(`GitHub rate limited this request; waiting ${Math.ceil(delay / 1000)} seconds`);
			await this.pause(delay);
		}
	}

	/** One page of a REST listing, and its response for the next link. */
	async list(path: string): Promise<{ rows: ObjectValue[]; response: Response }> {
		const response = await this.request(path);
		if (response.status !== 200) throw new Error("unexpected GitHub 304 without a cached response");
		return { rows: array(await response.json()), response };
	}

	/** Every page of a REST listing. */
	async all(path: string): Promise<ObjectValue[]> {
		const rows: ObjectValue[] = [];
		for (let next: string | undefined = path; next;) {
			const page = await this.list(next);
			rows.push(...page.rows);
			next = link(page.response, "next");
		}
		return rows;
	}

	/** Run a GraphQL query and return its data, failing on any reported error. */
	async graphql(query: string, variables: ObjectValue): Promise<ObjectValue> {
		const response = await this.request("/graphql", { body: { query, variables } });
		const body = object(await response.json());
		if (body.errors !== undefined)
			throw new Error(
				`GitHub GraphQL error: ${array(body.errors)
					.map((error) => String(error.message))
					.join("; ")}`,
			);
		return object(body.data);
	}
}

/** A check a base branch requires. */
export interface RequiredCheck {
	name: string;
	/** The GitHub App whose check run alone satisfies it, or null for any source. */
	app: number | null;
}

/** What a base branch requires, read from branch protection and rulesets. */
export interface Requirements {
	checks: RequiredCheck[];
	/** Workflow files that must pass as a whole, so each of their jobs is required. */
	workflows: string[];
	/** Every rule the branch's active rulesets apply: `type`, `parameters`, and the ruleset's source. */
	rules: ObjectValue[];
	/** Whether classic branch protection may be on; its settings beyond required checks need admin rights to read. */
	classic: boolean;
}

/** What `branch` of `repository` requires, read with read access from branch protection and rulesets. */
export async function requirements(github: GitHub, repository: Repository, branch: string): Promise<Requirements> {
	const base = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
	const ref = encodeURIComponent(branch);
	const protection = object(object(await (await github.request(`${base}/branches/${ref}`)).json()).protection ?? {});
	const legacy = object(protection.required_status_checks ?? {});
	const source = (app: unknown) => (typeof app === "number" && app > 0 ? app : null);
	// Classic protection may list only `contexts`, without the newer `checks`.
	const classic: RequiredCheck[] =
		legacy.enforcement_level === "off"
			? []
			: legacy.checks === undefined
				? (Array.isArray(legacy.contexts) ? legacy.contexts : []).map((name) => ({
						name: string(name),
						app: null,
					}))
				: array(legacy.checks).map((row) => ({ name: string(row.context), app: source(row.app_id) }));
	const rules = await github.all(`${base}/rules/branches/${ref}?per_page=100`);
	const checks = [
		...classic,
		...rules
			.filter((rule) => rule.type === "required_status_checks")
			.flatMap((rule) => array(object(rule.parameters).required_status_checks))
			.map((row) => ({ name: string(row.context), app: source(row.integration_id) })),
	];
	return {
		checks: checks.filter(
			(check, index) =>
				checks.findIndex((other) => other.name === check.name && other.app === check.app) === index,
		),
		workflows: rules
			.filter((rule) => rule.type === "workflows")
			.flatMap((rule) => array(object(rule.parameters).workflows))
			.map((row) => string(row.path)),
		rules,
		// Unknown counts as on, so a reader that needs the settings reads them rather than assume none.
		classic: protection.enabled !== false,
	};
}

/**
 * Whether a merged PR in `repository` had exactly `commit` as its head, as when it was squash-merged;
 * false for a commit GitHub does not have.
 */
export async function mergedHead(github: GitHub, repository: Repository, commit: string): Promise<boolean> {
	const data = await github.graphql(
		"query($owner: String!, $name: String!, $oid: GitObjectID!) { repository(owner: $owner, name: $name) { " +
			"object(oid: $oid) { ... on Commit { associatedPullRequests(first: 100) { nodes { merged headRefOid } } } } } }",
		{ owner: repository.owner, name: repository.repo, oid: commit },
	);
	const found = object(data.repository).object;
	const pulls = found === null || found === undefined ? undefined : object(found).associatedPullRequests;
	if (pulls === null || pulls === undefined) return false; // Unknown, or not a commit.
	return array(object(pulls).nodes).some((pull) => pull.merged === true && pull.headRefOid === commit);
}

/** A login, a committer name without spaces, or `-` for a deleted account. */
export function actor(value: unknown): string {
	if (value === null || value === undefined) return "-";
	const record = object(value);
	return typeof record.login === "string"
		? record.login
		: typeof record.name === "string"
			? record.name.replace(/\s/g, "_")
			: "-";
}

export function object(value: unknown): ObjectValue {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("invalid GitHub response: expected an object");
	return value as ObjectValue;
}

export function array(value: unknown): ObjectValue[] {
	if (!Array.isArray(value)) throw new Error("invalid GitHub response: expected an array");
	return value.map(object);
}

export function string(value: unknown): string {
	if (typeof value !== "string" || !value) throw new Error("invalid GitHub response: expected a nonempty string");
	return value;
}

export function link(response: Response, relation: string): string | undefined {
	return response.headers
		.get("link")
		?.split(",")
		.map((entry) => /<([^>]+)>;\s*rel="([^"]+)"/.exec(entry.trim()))
		.find((match) => match?.[2] === relation)?.[1];
}

/** GitHub's reason in an error body, such as why it refused to create a pull request. */
function explanation(body: string): string | undefined {
	try {
		const parsed = object(JSON.parse(body));
		const errors = Array.isArray(parsed.errors) ? (parsed.errors as unknown[]) : [];
		const parts = [parsed.message, ...errors.map((error) => (error as ObjectValue | null)?.message)];
		return parts.filter((part): part is string => typeof part === "string" && part !== "").join(": ") || undefined;
	} catch {
		return undefined;
	}
}

function seconds(value: string | null): number | undefined {
	if (value === null || !/^\d+(?:\.\d+)?$/.test(value)) return undefined;
	const result = Number(value) * 1000;
	return Number.isFinite(result) ? result : undefined;
}
