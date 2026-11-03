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

/** GitHub answered a GraphQL operation with errors; `types` are their types, `undefined` for an untyped one. */
export class GitHubGraphQLError extends Error {
	constructor(
		readonly types: (string | undefined)[],
		messages: string[],
	) {
		super(`GitHub GraphQL error: ${messages.join("; ")}`);
	}
}

export type ObjectValue = Record<string, unknown>;

/** Retries of a 5xx or a dropped connection, waiting 1, 2, 4, then 8 seconds unless GitHub says how long. */
const TRANSIENT_RETRIES = 4;
/** How far GitHub's clock may run behind ours when looking for what a lost request created. */
const CLOCK_SKEW = 60_000;
/** Statuses whose response has no body. */
const NULL_BODY = [204, 205, 304];

/**
 * Whether a request may repeat after a 5xx or a dropped connection, after which GitHub may have
 * acted anyway: `true` when repeating leaves the same state, or a check, run before each repeat,
 * for the response of an earlier attempt that took effect (undefined if none did).
 */
export type Repeat = boolean | ((started: number) => Promise<Response | undefined>);

export interface RequestOptions {
	etag?: string;
	body?: unknown;
	method?: "POST" | "PUT" | "PATCH" | "DELETE";
	allow?: number[];
	/** Overrides how the request repeats; the default follows its method and endpoint. */
	repeat?: Repeat;
}

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

/** Run git in `root` for its output; a lookup that matches nothing, which exits 1, is empty. */
function git(root: string, args: string[]): string {
	try {
		return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		if (args[0] === "config" && (error as { status?: number }).status === 1) return "";
		throw error;
	}
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

/** Whether GitHub turned a request away for a rate limit, which any request may wait out and repeat. */
function limited(response: Response, body: string): boolean {
	return (
		response.status === 429 ||
		(response.status === 403 &&
			(response.headers.has("retry-after") ||
				response.headers.get("x-ratelimit-remaining") === "0" ||
				/rate limit/i.test(body)))
	);
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
	 * A 2xx or 304 response, its body already read; anything else fails, with GitHub's reason when
	 * it gives one, unless `allow` lists its status. Rate limits are waited out. A 5xx or a
	 * connection dropped before the body is in, after which GitHub may or may not have acted, is
	 * retried with bounded backoff as `repeat` allows, then fails with the last error. `body` makes
	 * it a POST unless `method` says otherwise.
	 */
	async request(path: string, options: RequestOptions = {}): Promise<Response> {
		// Follow only same-origin pagination links; never send a token to another host.
		const url = new URL(path, API);
		if (url.origin !== API || url.username || url.password) throw new Error("invalid GitHub pagination URL");
		const started = this.deps.now();
		const repeat = options.repeat ?? (await this.repeatable(url, options, started));
		let limits = 0;
		let failures = 0;
		for (;;) {
			const remaining = this.deadline - this.deps.now();
			if (remaining <= 0) throw new GitHubDeadline();
			let response: Response | undefined;
			let failure: unknown;
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
				failure = error;
			}
			let retry: number | undefined;
			if (response) {
				this.pollInterval = Math.max(this.pollInterval, seconds(response.headers.get("x-poll-interval")) ?? 0);
				// Read the body here, so a connection that drops mid-body is retried like one that drops before it.
				const read = await response.text().then(
					(text) => ({ text }),
					(error: unknown) => ({ error }),
				);
				// A rate limit is waited out even when the caller allows its status, such as a 403 refusal.
				if (
					response.ok ||
					response.status === 304 ||
					(options.allow?.includes(response.status) && !limited(response, "text" in read ? read.text : ""))
				) {
					const { status, statusText, headers } = response;
					if ("text" in read)
						return new Response(NULL_BODY.includes(status) ? null : read.text, {
							status,
							statusText,
							headers,
						});
					if (this.deps.now() >= this.deadline) throw new GitHubDeadline();
					failure = read.error;
				} else {
					// A refusal's status still says what to do when its body was cut off.
					const body = "text" in read ? read.text : "";
					if (limited(response, body)) {
						// GitHub turned the request away unprocessed, so any request repeats.
						await this.waitOut(
							response.headers,
							limits++,
							`GitHub HTTP ${response.status} for ${url.pathname}; rate limit persisted`,
						);
						continue;
					}
					const reason = explanation(body);
					if (response.status < 500)
						throw new Error(
							`GitHub HTTP ${response.status} for ${url.pathname}; ${reason ?? "check repository access and token permissions"}`,
						);
					failure = new Error(
						`GitHub HTTP ${response.status} for ${url.pathname}; ${reason ?? "GitHub server error"}`,
					);
					retry = seconds(response.headers.get("retry-after"));
				}
			}
			if (repeat === false || failures >= TRANSIENT_RETRIES) throw failure;
			const delay = retry ?? 1000 * 2 ** failures;
			failures++;
			this.deps.warn(`${message(failure)}; retrying in ${Math.ceil(delay / 1000)} seconds`);
			await this.pause(delay);
			if (typeof repeat === "function") {
				const landed = await repeat(started);
				if (landed) return landed;
			}
		}
	}

	/**
	 * Wait out a rate limit, the `limits`th in a row, as its headers say: Retry-After, else the
	 * primary limit's reset, else a minute doubling each time. Fails with `persisted` after six.
	 */
	private async waitOut(headers: Headers, limits: number, persisted: string): Promise<void> {
		if (limits >= 6) throw new Error(persisted);
		const retry = seconds(headers.get("retry-after"));
		const reset =
			headers.get("x-ratelimit-remaining") === "0" ? seconds(headers.get("x-ratelimit-reset")) : undefined;
		const delay = retry ?? (reset === undefined ? 60_000 * 2 ** limits : Math.max(1000, reset - this.deps.now()));
		this.deps.warn(`GitHub rate limited this request; waiting ${Math.ceil(delay / 1000)} seconds`);
		await this.pause(delay);
	}

	/**
	 * How a request may repeat after a 5xx or a dropped connection. A GET reads and a PUT, PATCH, or
	 * DELETE sets state, so each repeats; so does adding labels. A merge is confirmed first by its
	 * pinned head, and a POST that creates something by what it created: a comment by its body, among
	 * those not already there before it, a pull request by its branch. Any other POST never repeats.
	 */
	private async repeatable(url: URL, options: RequestOptions, started: number): Promise<Repeat> {
		const method = options.method ?? (options.body === undefined ? "GET" : "POST");
		const body = typeof options.body === "object" && options.body !== null ? (options.body as ObjectValue) : {};
		const merge = /^(\/repos\/[^/]+\/[^/]+\/pulls\/\d+)\/merge$/.exec(url.pathname);
		if (method === "PUT" && merge) {
			return async () => {
				const pull = object(await (await this.request(merge[1])).json());
				// Merged at another head is not this merge; repeating it gets GitHub's refusal for the caller.
				if (pull.merged !== true || typeof pull.merge_commit_sha !== "string") return;
				if (body.sha !== undefined && object(pull.head).sha !== body.sha) return;
				return Response.json({
					merged: true,
					sha: pull.merge_commit_sha,
					message: "Pull Request successfully merged",
				});
			};
		}
		if (method !== "POST") return true;
		const issue = /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/(labels|comments)$/.exec(url.pathname);
		if (issue?.[1] === "labels") return true;
		if (issue?.[1] === "comments" && typeof body.body === "string") {
			const since = new Date(started - CLOCK_SKEW).toISOString();
			const identical = async () =>
				(await this.all(`${url.pathname}?since=${since}&per_page=100`)).filter(
					(comment) => comment.body === body.body,
				);
			// An identical comment already there, such as one from a requeued PR's earlier ejection, is not this one.
			const earlier = new Set((await identical()).map((comment) => comment.id));
			return async () => {
				const found = (await identical()).find((comment) => !earlier.has(comment.id));
				return found && Response.json(found, { status: 201 });
			};
		}
		const pulls = /^\/repos\/([^/]+)\/[^/]+\/pulls$/.exec(url.pathname);
		if (pulls && typeof body.head === "string") {
			const head = body.head.includes(":") ? body.head : `${pulls[1]}:${body.head}`;
			return async (started) => {
				const open = await this.list(
					`${url.pathname}?state=open&head=${encodeURIComponent(head)}&per_page=100`,
				);
				const found = open.rows.find(
					(pull) =>
						typeof pull.created_at === "string" && Date.parse(pull.created_at) >= started - CLOCK_SKEW,
				);
				return found && Response.json(found, { status: 201 });
			};
		}
		return false;
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

	/**
	 * Run a GraphQL query and return its data, failing on any reported error. A query repeats after
	 * a 5xx or a dropped connection; a mutation only once its effect is confirmed missing, and one
	 * confirmed to have taken effect returns no data. GitHub can report a rate limit as a 200 whose
	 * errors say `RATE_LIMITED`; that is waited out like a REST one.
	 */
	async graphql(query: string, variables: ObjectValue): Promise<ObjectValue> {
		const repeat = this.mutationRepeat(query, variables);
		for (let limits = 0; ; limits++) {
			const response = await this.request("/graphql", { body: { query, variables }, repeat });
			const body = object(await response.json());
			if (body.errors === undefined) return object(body.data);
			const errors = array(body.errors);
			if (!errors.some((error) => error.type === "RATE_LIMITED"))
				throw new GitHubGraphQLError(
					errors.map((error) => (typeof error.type === "string" ? error.type : undefined)),
					errors.map((error) => String(error.message)),
				);
			// GitHub turned the operation away unprocessed, so any operation repeats.
			await this.waitOut(response.headers, limits, "GitHub GraphQL rate limit persisted");
		}
	}

	/**
	 * Repeat a query; confirm a pull request mutation `PULL_MUTATIONS` knows; never repeat another.
	 * One pinned to `expectedHeadOid` is confirmed only at that head; at any other, its repeat gets
	 * GitHub's refusal for the caller.
	 */
	private mutationRepeat(query: string, variables: ObjectValue): Repeat {
		if (!/^\s*mutation\b/.test(query)) return true;
		const call = /^\s*mutation\b[^{]*\{\s*(\w+)\s*\(\s*input:\s*\{\s*pullRequestId:\s*\$(\w+)\b/.exec(query);
		const effect = call && Object.hasOwn(PULL_MUTATIONS, call[1]) ? PULL_MUTATIONS[call[1]] : undefined;
		const id = call && variables[call[2]];
		if (!effect || typeof id !== "string") return false;
		const pinned = /\bexpectedHeadOid:\s*\$(\w+)\b/.exec(query);
		const head = pinned ? variables[pinned[1]] : undefined;
		const read = `query($id: ID!) { node(id: $id) { ... on PullRequest { headRefOid ${effect.fields} } } }`;
		return async () => {
			const pull = object((await this.graphql(read, { id })).node);
			const landed = (head === undefined || pull.headRefOid === head) && effect.landed(pull);
			return landed ? Response.json({ data: {} }) : undefined;
		};
	}
}

/**
 * Pull request mutations whose effect can be read back: the fields that show it, and whether
 * they do. Each takes its pull request as `pullRequestId`.
 */
const PULL_MUTATIONS: Record<string, { fields: string; landed(pull: ObjectValue): boolean }> = {
	mergePullRequest: { fields: "merged", landed: (pull) => pull.merged === true },
	enqueuePullRequest: {
		fields: "merged mergeQueueEntry { state }",
		landed: (pull) => pull.merged === true || pull.mergeQueueEntry != null,
	},
	enablePullRequestAutoMerge: {
		fields: "merged autoMergeRequest { enabledAt } mergeQueueEntry { state }",
		landed: (pull) => pull.merged === true || pull.autoMergeRequest != null || pull.mergeQueueEntry != null,
	},
	disablePullRequestAutoMerge: {
		fields: "autoMergeRequest { enabledAt }",
		landed: (pull) => pull.autoMergeRequest === null,
	},
	markPullRequestReadyForReview: { fields: "isDraft", landed: (pull) => pull.isDraft === false },
};

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

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function seconds(value: string | null): number | undefined {
	if (value === null || !/^\d+(?:\.\d+)?$/.test(value)) return undefined;
	const result = Number(value) * 1000;
	return Number.isFinite(result) ? result : undefined;
}
