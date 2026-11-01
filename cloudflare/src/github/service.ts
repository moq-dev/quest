import { createHash, createPrivateKey, sign } from "node:crypto";
import {
	MERGE_LABEL,
	isHoldLabel,
	latestHold,
	heldToken,
	spentMergeHold,
	check,
	isQuest,
	parse,
	ready,
} from "quest/core";
import { cleanAutoMergeRefusal, immediateMerge } from "../../../src/github/merge";
import { osiApproved } from "../licenses";
import { unreviewed } from "./review";
import { positiveId } from "./webhook";
import {
	activityQuery,
	type ActivityPage,
	type ProjectState,
	type Pull,
	type Scan,
	reconcile,
	readState,
	staleEntities,
} from "./state";

export interface GitHubRepository {
	owner: string;
	name: string;
	id: number;
}
type Permission = "metadata" | "contents" | "issues" | "pull_requests" | "checks" | "statuses";
type Permissions = Partial<Record<Permission, "read" | "write">>;
/** What reading a project's observations needs. */
const observing: Permissions = {
	contents: "read",
	issues: "read",
	pull_requests: "read",
	checks: "read",
	statuses: "read",
};
// Longer than a Worker keeps background work after its response, so a read
// that died with its Worker frees the project for the next webhook.
const observeLease = 60_000;
interface Installation {
	id: number;
	app_id: number;
	suspended_at: string | null;
	permissions: Permissions;
}
interface Repository {
	id: number;
	name: string;
	owner: { login: string };
	archived: boolean;
	disabled: boolean;
	fork: boolean;
	parent?: { id: number };
	private: boolean;
	visibility: string;
	default_branch: string;
	license?: { spdx_id: string; name: string } | null;
	allow_squash_merge?: boolean;
	allow_merge_commit?: boolean;
	allow_rebase_merge?: boolean;
}
interface PullHead {
	number: number;
	node_id: string;
	html_url: string;
	state: string;
	draft: boolean;
	title: string;
	body: string | null;
	created_at: string;
	head: { ref: string; sha: string; repo: { id: number; name: string; owner: { login: string } } | null };
	base: { ref: string };
}
export class GitHubError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		/** GitHub's own words for a refusal, read only where a request asks for them. */
		readonly reason: string | null = null,
	) {
		super(message);
	}
}

/** Another read published, or a webhook invalidated, while this one read, so it must read again. */
export class ProjectChanged extends GitHubError {
	constructor() {
		super("Project changed during refresh; refresh again");
	}
}
/** A publication the bot cannot make, which needs a maintainer's decision rather than a retry. */
export class PublicationBlocked extends GitHubError {}
/** A job's branch is not where the job left it, which starting the job over can reset. */
export class BranchChanged extends PublicationBlocked {}
/** A maintainer check that was answered with a denial, rather than one that could not complete. */
export class NotMaintainer extends GitHubError {}

/** One file a publication sets or, with null content, deletes. */
/** One path's new content, or null to delete it, with its Git mode: a file, an executable, or a symlink. */
export type Change = { path: string; content: Uint8Array | null; mode: "100644" | "100755" | "120000" };
/** What a job may publish: its workflow, its target, and its one branch. */
export type Contribution = {
	workflow: "plan" | "start" | "iterate" | "merge" | "bootstrap";
	target: string;
	branch: string;
	pull: number | null;
	/** When the job was created, in milliseconds; an older closed pull request on its branch is not its own. */
	createdAt: number;
};
/** The one branch a job may write, on the repository the service resolved for it. */
export interface Branch {
	repository: GitHubRepository;
	/** The branch's commit, or null when it does not exist yet. */
	head(): Promise<string | null>;
	/**
	 * Create a commit of `changes` on `parent` without moving the branch. With
	 * `merge`, it is a merge commit of `parent` and `merge`, and `changes` are
	 * relative to `merge`'s files.
	 */
	commit(
		parent: string,
		changes: Change[],
		message: string,
		merge?: string,
		submodules?: { path: string; sha: string }[],
	): Promise<string>;
	/** Whether the branch this one merges into, upstream, already holds `commit`. */
	based(commit: string): Promise<boolean>;
	/** The tree ID of `commit`'s `.github/workflows`, or null when it has none. */
	workflows(commit: string): Promise<string | null>;
	/** Move the branch from `from` (null creates it) to `to`; false when it moved first. */
	move(from: string | null, to: string): Promise<boolean>;
	/** Point the branch at `to` wherever it is, creating it if it is gone, discarding its commits. */
	reset(to: string): Promise<void>;
}
export type ContributionState = "enabled" | "paused";
export type Enrollment = GitHubRepository & { state: ContributionState };
/** A running job attempt whose project was disconnected, which its runner must stop. */
export type Stopped = { actor: string; runner: string; job: string; attempt: number };
export type ProjectPreview = {
	repository: GitHubRepository;
	branch: string;
	commit: string;
	license: Repository["license"];
	licenseError: string | null;
	quests: { path: string; title: string }[];
	state: ContributionState | null;
};
type Tree = { truncated: boolean; tree: { path: string; type: string; mode: string; sha: string }[] };

interface GitHubEnvironment {
	DB: D1Database;
	GITHUB_APP_ID: string;
	GITHUB_APP_PRIVATE_KEY: string;
	GITHUB_FORK_OWNER: string;
}

function name(value: string) {
	return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(value);
}
function repositoryPath(repo: GitHubRepository) {
	if (!positiveId(repo.id) || !name(repo.owner) || !name(repo.name)) throw new GitHubError("Invalid repository");
	return `/repos/${repo.owner}/${repo.name}`;
}
function number(value: number) {
	if (!positiveId(value)) throw new GitHubError("Invalid issue or pull request number");
	return value;
}
function sha(value: string) {
	if (!/^[a-f0-9]{40}$/.test(value)) throw new GitHubError("An exact commit SHA is required");
	return value;
}
/** Whether Git accepts `name` as a branch, per `git check-ref-format`. */
export function refName(name: string) {
	return !/[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\/|(^|\/)\.|\.lock($|\/)|[/.]$|^\/|^@$/.test(name);
}
/** The `message` GitHub gives for a refused request, as one bounded line of display text. */
async function refusal(response: Response) {
	try {
		const { message } = (await response.json()) as { message?: unknown };
		if (typeof message === "string") return line(message) || null;
	} catch {}
	return null;
}
function pullNumber(target: string) {
	const match = target.match(/^pulls\/(\d{1,15})$/);
	if (!match) throw new GitHubError("Invalid pull request target");
	return number(Number(match[1]));
}

/** Server-only integration. Call with an authenticated local session's user ID
 * after the product has approved the particular operation. Never expose this
 * object, credentials, arbitrary API requests, or installation tokens to agents.
 */
export class GitHubService {
	#env: GitHubEnvironment;
	#fetch: typeof fetch;
	// Workers' fetch throws "Illegal invocation" when called as this.#fetch(), so wrap it.
	constructor(env: GitHubEnvironment, request: typeof fetch = (input, init) => fetch(input, init)) {
		this.#env = env;
		this.#fetch = request;
	}

	#jwt() {
		if (!/^\d+$/.test(this.#env.GITHUB_APP_ID) || !this.#env.GITHUB_APP_PRIVATE_KEY)
			throw new GitHubError("GitHub App not configured");
		const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
		const now = Math.floor(Date.now() / 1000);
		const body = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: this.#env.GITHUB_APP_ID, iat: now - 60, exp: now + 540 })}`;
		return `${body}.${sign("RSA-SHA256", Buffer.from(body), createPrivateKey(this.#env.GITHUB_APP_PRIVATE_KEY)).toString("base64url")}`;
	}

	/** `explain` keeps GitHub's one-line `message` from a refusal, for a maintainer to read. */
	async #api<T>(token: string, path: string, method = "GET", body?: unknown, explain = false): Promise<T> {
		const response = await this.#fetch(`https://api.github.com${path}`, {
			method,
			// Workers refuse `redirect: "error"`; a redirect is not ok, so it fails below.
			redirect: "manual",
			headers: {
				...(token ? { Authorization: `Bearer ${token}` } : {}),
				Accept: "application/vnd.github+json",
				"Content-Type": "application/json",
				"User-Agent": "Quest-GitHub-App",
				"X-GitHub-Api-Version": "2026-03-10",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		// Never include provider response bodies, request headers, or secrets in errors.
		if (!response.ok)
			throw new GitHubError(
				`GitHub request failed (${response.status})`,
				response.status,
				explain ? await refusal(response) : null,
			);
		return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
	}

	async #gate(id: number) {
		const state = await this.#env.DB.prepare("SELECT blocked FROM github_installations WHERE id=?")
			.bind(id)
			.first<{ blocked: number }>();
		if (state?.blocked) throw new GitHubError("GitHub installation revoked or suspended");
	}

	#repository(repo: GitHubRepository, current: Repository, allowUnavailable = false) {
		if (
			current.id !== repo.id ||
			current.owner.login.toLowerCase() !== repo.owner.toLowerCase() ||
			current.name.toLowerCase() !== repo.name.toLowerCase() ||
			(!allowUnavailable && (current.archived || current.disabled))
		)
			throw new GitHubError("Repository identity or availability changed");
	}

	async #license(current: Repository): Promise<string | null> {
		try {
			if (await osiApproved(current.license?.spdx_id, this.#fetch)) return null;
			return "GitHub must detect an OSI-approved license. Add or correct the repository license on GitHub, then review this project again.";
		} catch {
			return "License approval could not be verified. Contributions cannot be enabled while SPDX license data is unavailable.";
		}
	}

	async #withInstallation<T>(
		repo: Pick<GitHubRepository, "owner" | "name"> & { id?: number },
		permissions: Permissions,
		action: (token: string, installationId: number) => Promise<T>,
	) {
		if (!name(repo.owner) || !name(repo.name)) throw new GitHubError("Invalid repository");
		const path = `/repos/${repo.owner}/${repo.name}`;
		// Resolve the installation from the live repository; no browser-supplied
		// installation IDs and no cached permission grants.
		const installation = await this.#api<Installation>(this.#jwt(), `${path}/installation`);
		if (
			!positiveId(installation.id) ||
			String(installation.app_id) !== this.#env.GITHUB_APP_ID ||
			installation.suspended_at
		)
			throw new GitHubError("GitHub installation unavailable");
		await this.#gate(installation.id);
		const scope: Permissions = { metadata: "read", ...permissions };
		for (const [permission, level] of Object.entries(scope)) {
			const granted = installation.permissions[permission as Permission];
			if (!granted || (level === "write" && granted !== "write"))
				throw new GitHubError(`GitHub ${permission} permission required`);
		}
		const minted = await this.#api<{ token: string }>(
			this.#jwt(),
			`/app/installations/${installation.id}/access_tokens`,
			"POST",
			{
				...(repo.id === undefined ? { repositories: [repo.name] } : { repository_ids: [repo.id] }),
				permissions: scope,
			},
		);
		if (!minted.token) throw new GitHubError("Installation token unavailable");
		try {
			await this.#gate(installation.id);
			return await action(minted.token, installation.id);
		} finally {
			// Do not turn a completed mutation into a retryable error if cleanup
			// fails. GitHub also expires installation tokens after one hour.
			try {
				await this.#api(minted.token, "/installation/token", "DELETE");
			} catch {
				console.error({ event: "github_token_revocation_failed" });
			}
		}
	}

	async #withRepository<T>(
		repo: GitHubRepository,
		permissions: Permissions,
		action: (token: string, current: Repository, installationId: number) => Promise<T>,
		allowUnavailable = false,
	) {
		const path = repositoryPath(repo);
		return this.#withInstallation(repo, permissions, async (token, installation) => {
			const current = await this.#api<Repository>(token, path);
			this.#repository(repo, current, allowUnavailable);
			await this.#gate(installation);
			return action(token, current, installation);
		});
	}

	/**
	 * Verify current maintainer authority, and keep the user's inbox membership
	 * of an enrolled project in step with the answer. Membership lists the
	 * project; it never stands in for this check. A check that cannot complete,
	 * such as an outage or a rate limit, fails without changing membership.
	 */
	async #maintainer(token: string, repo: GitHubRepository, userId: string) {
		const db = this.#env.DB;
		try {
			await this.#authority(token, repo, userId);
		} catch (error) {
			if (error instanceof NotMaintainer)
				await db.batch([
					db
						.prepare("DELETE FROM github_project_members WHERE repository=? AND user=?")
						.bind(repo.id, userId),
					db.prepare("DELETE FROM inbox_items WHERE repository=? AND user=?").bind(repo.id, userId),
				]);
			throw error;
		}
		await db
			.prepare(
				"INSERT INTO github_project_members(repository,user) SELECT id,? FROM github_projects WHERE id=? ON CONFLICT DO NOTHING",
			)
			.bind(userId, repo.id)
			.run();
	}

	async #authority(token: string, repo: GitHubRepository, userId: string) {
		const account = await this.#env.DB.prepare(
			"SELECT accountId FROM account WHERE userId=? AND providerId='github' LIMIT 1",
		)
			.bind(userId)
			.first<{ accountId: string }>();
		if (!account || !/^\d+$/.test(account.accountId)) throw new NotMaintainer("Linked GitHub identity required");
		const user = await this.#api<{ id: number; login: string }>(token, `/user/${account.accountId}`);
		if (String(user.id) !== account.accountId || !name(user.login))
			throw new GitHubError("GitHub identity changed");
		// Every caller has already read the repository with this token, and the
		// user resolved above, so a 404 here means the user is no collaborator.
		const permission = await this.#api<{ permission: string; role_name: string; user: { id: number } }>(
			token,
			`${repositoryPath(repo)}/collaborators/${user.login}/permission`,
		).catch((error: unknown) => {
			if (error instanceof GitHubError && error.status === 404)
				throw new NotMaintainer("Current GitHub maintainer authority required");
			throw error;
		});
		// GitHub maps maintain to legacy permission=write. Do not accidentally
		// grant maintainer authority to ordinary writers or custom roles.
		if (
			String(permission.user.id) !== account.accountId ||
			(permission.permission !== "admin" && permission.role_name !== "maintain")
		)
			throw new NotMaintainer("Current GitHub maintainer authority required");
	}

	async #authorized<T>(
		repo: GitHubRepository,
		userId: string,
		permissions: Permissions,
		action: (token: string, current: Repository, installationId: number) => Promise<T>,
		allowUnavailable = false,
	) {
		return this.#withRepository(
			repo,
			permissions,
			async (token, current, installationId) => {
				await this.#maintainer(token, repo, userId);
				await this.#gate(installationId);
				return action(token, current, installationId);
			},
			allowUnavailable,
		);
	}

	/** The operator's registered App, rather than an assumed App name. */
	async installationURL() {
		const app = await this.#api<{ id: number; slug: string }>(this.#jwt(), "/app");
		if (String(app.id) !== this.#env.GITHUB_APP_ID || !/^[a-zA-Z0-9-]+$/.test(app.slug))
			throw new GitHubError("GitHub App unavailable");
		return `https://github.com/apps/${app.slug}/installations/new`;
	}

	/** Resolve public metadata through a repository-scoped App token. */
	async resolveRepository(owner: string, repository: string): Promise<GitHubRepository> {
		if (!name(owner) || !name(repository)) throw new GitHubError("Use an owner/repository name");
		return this.#withInstallation({ owner, name: repository }, {}, async (token) => {
			const found = await this.#api<Repository>(token, `/repos/${owner}/${repository}`);
			this.#public(found);
			const repo = { id: found.id, owner: found.owner.login, name: found.name };
			repositoryPath(repo);
			return repo;
		});
	}

	#public(current: Repository) {
		if (current.private !== false || current.visibility !== "public")
			throw new GitHubError("Select a public repository");
	}

	async #state(repo: GitHubRepository, installation: number) {
		const row = await this.#env.DB.prepare(
			"SELECT state FROM github_projects WHERE id=? AND owner=? COLLATE NOCASE AND name=? COLLATE NOCASE AND installation=?",
		)
			.bind(repo.id, repo.owner, repo.name, installation)
			.first<{ state: ContributionState }>();
		return row?.state ?? null;
	}

	/** The enrolled projects whose inbox the user belongs to. */
	async projects(userId: string): Promise<Enrollment[]> {
		// Membership is navigation only, never an authority grant.
		return (
			await this.#env.DB.prepare(
				"SELECT p.id,p.owner,p.name,p.state FROM github_projects p JOIN github_project_members m ON m.repository=p.id WHERE m.user=? ORDER BY p.owner,p.name",
			)
				.bind(userId)
				.all<Enrollment>()
		).results;
	}

	/** Whether a user currently maintains a project, as its inbox items require. */
	async maintains(repo: GitHubRepository, userId: string) {
		try {
			return await this.#authorized(repo, userId, {}, async () => true);
		} catch (error) {
			if (error instanceof GitHubError) return false;
			throw error;
		}
	}

	/** Let any current maintainer reach stop controls without a valid preview. */
	async enrolledProject(owner: string, repository: string, userId: string): Promise<Enrollment | null> {
		return this.#withInstallation({ owner, name: repository }, {}, async (token, installation) => {
			const current = await this.#api<Repository>(token, `/repos/${owner}/${repository}`);
			const repo = { id: current.id, owner: current.owner.login, name: current.name };
			repositoryPath(repo);
			const enrolled = await this.#env.DB.prepare("SELECT state FROM github_projects WHERE id=?")
				.bind(repo.id)
				.first<{ state: ContributionState }>();
			if (!enrolled) return null;
			await this.#maintainer(token, repo, userId);
			await this.#gate(installation);
			// Names are navigation metadata, not identity. A rename must not hide
			// an existing enrollment from a current maintainer's stop controls.
			await this.#env.DB.prepare("UPDATE github_projects SET owner=?,name=? WHERE id=?")
				.bind(repo.owner, repo.name, repo.id)
				.run();
			return { ...repo, state: enrolled.state };
		});
	}

	async #snapshot(token: string, repo: GitHubRepository, current: Repository) {
		this.#public(current);
		if (!current.default_branch) throw new GitHubError("Repository default branch unavailable");
		const path = repositoryPath(repo);
		const commit = await this.#api<{ sha: string; commit: { tree: { sha: string } } }>(
			token,
			`${path}/commits/${encodeURIComponent(current.default_branch)}`,
		);
		sha(commit.sha);
		const root = await this.#api<Tree>(token, `${path}/git/trees/${sha(commit.commit.tree.sha)}?recursive=1`);
		if (root.truncated) throw new GitHubError("Repository tree is incomplete");
		const quest = root.tree.find((entry) => entry.path === "quest" && entry.type === "tree");
		if (!quest) throw new GitHubError("Quest files are required. Follow the existing Quest setup guide first.");
		const entries = root.tree.filter(
			(entry) => entry.path.startsWith("quest/") && isQuest(entry.path) && entry.type === "blob",
		);
		if (!entries.length)
			throw new GitHubError("Quest files are required. Follow the existing Quest setup guide first.");
		// Read the pinned blobs together: a REST request per file can exhaust a
		// Worker's subrequest budget during enrollment even for a small quest tree.
		const fields = entries.map((entry, i) => {
			if (!["100644", "100755"].includes(entry.mode)) throw new GitHubError("Quest files must be regular files");
			return `q${i}: object(oid: "${sha(entry.sha)}") { ... on Blob { oid text isBinary isTruncated } }`;
		});
		const result = await this.#api<{
			data?: {
				repository: Record<
					string,
					{ oid: string; text: string | null; isBinary: boolean | null; isTruncated: boolean } | null
				> | null;
			};
			errors?: unknown[];
		}>(token, "/graphql", "POST", {
			query: `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join("\n")} } }`,
			variables: { owner: repo.owner, name: repo.name },
		});
		if (result.errors?.length || !result.data?.repository) throw new GitHubError("Quest content unavailable");
		const blobs = result.data.repository;
		const files: { path: string; content: string }[] = [];
		const documents = entries.map((entry, i) => {
			const blob = blobs[`q${i}`];
			if (
				!blob ||
				blob.oid !== entry.sha ||
				blob.isBinary !== false ||
				blob.isTruncated !== false ||
				typeof blob.text !== "string"
			)
				throw new GitHubError("Quest content unavailable");
			// GraphQL supplies decoded text. Verify the Git object hash so a lossy
			// UTF-8 conversion cannot silently change the snapshot being validated.
			const content = Buffer.from(blob.text, "utf8");
			const oid = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
			if (oid !== entry.sha) throw new GitHubError("Quest content unavailable");
			files.push({ path: entry.path, content: blob.text });
			return parse(entry.path, blob.text);
		});
		const paths = new Set(root.tree.map((entry) => entry.path));
		if (check(documents, (path) => paths.has(path)).length)
			throw new GitHubError("Fix the quest tree with quest check before enabling contributions");
		const available = new Set(ready(documents));
		return {
			commit: commit.sha,
			date: new Date().toISOString().slice(0, 10),
			documents: files,
			completed: [],
			ready: documents
				.filter((doc) => available.has(doc.path))
				.map((doc) => ({ path: doc.path, title: doc.title?.text ?? doc.path })),
		};
	}

	async #preview(
		token: string,
		repo: GitHubRepository,
		current: Repository,
		installation: number,
	): Promise<ProjectPreview> {
		const snapshot = await this.#snapshot(token, repo, current);
		return {
			repository: repo,
			branch: current.default_branch,
			commit: snapshot.commit,
			license: current.license,
			licenseError: await this.#license(current),
			quests: snapshot.ready,
			state: await this.#state(repo, installation),
		};
	}

	async #observations(repo: GitHubRepository, installation: number) {
		const result = await readState(this.#env.DB, repo);
		const state = await this.#state(repo, installation);
		await this.#gate(installation);
		if (state === null) throw new GitHubError("Project enrollment changed");
		if (result && state !== "enabled") result.project.available = [];
		return result;
	}

	/** Observations only. Neither a refresh nor an arriving entity launches work. */
	projectState(repo: GitHubRepository, userId: string, refresh = false): Promise<ProjectState | null> {
		return this.#authorized(repo, userId, refresh ? observing : {}, async (token, current, installation) => {
			this.#public(current);
			if ((await this.#state(repo, installation)) === null)
				throw new GitHubError("Project is not enrolled for this installation");
			// A lost maintainer role during the read must not publish fresh observations.
			if (refresh)
				await this.#read(token, repo, current, installation, () => this.#maintainer(token, repo, userId), true);
			return this.#observations(repo, installation);
		});
	}

	/**
	 * Read one page of a project's observations from GitHub and publish them,
	 * unless `recheck` fails or the repository, installation, or enrollment
	 * changed during the read.
	 */
	async #read(
		token: string,
		repo: GitHubRepository,
		current: Repository,
		installation: number,
		recheck: () => Promise<void>,
		full = false,
	) {
		await this.#env.DB.prepare("INSERT OR IGNORE INTO github_project_state(repository,epoch) VALUES(?,?)")
			.bind(repo.id, crypto.randomUUID())
			.run();
		const row = await this.#env.DB.prepare(
			"SELECT revision,scan,invalidated,epoch FROM github_project_state WHERE repository=?",
		)
			.bind(repo.id)
			.first<{ revision: number; scan: string | null; invalidated: number; epoch: string }>();
		const previous: Scan | null = row?.scan ? JSON.parse(row.scan) : null;
		// History resumes through any webhook; only occupancy, which is
		// small, restarts to observe a possibly opened, closed, or claimed quest.
		const scan: Scan = {
			history:
				previous?.history.since && !previous.history.complete && (!full || previous.history.full)
					? previous.history
					: {
							id: crypto.randomUUID(),
							issues: null,
							pulls: null,
							complete: false,
							since: full
								? { issues: null, pulls: null }
								: (previous?.history.watermark ?? { issues: null, pulls: null }),
							watermark: full
								? { issues: null, pulls: null }
								: (previous?.history.watermark ?? { issues: null, pulls: null }),
							full,
						},
			occupancy:
				previous && !previous.occupancy.complete && row!.invalidated !== 1
					? previous.occupancy
					: { open: null, refs: null, pulls: [], claims: [], complete: false },
		};
		// What webhooks named is read by number, so it is current after one read
		// however far the history pass is from it.
		const stale = await staleEntities(this.#env.DB, repo.id);
		const snapshot = await this.#snapshot(token, repo, current);
		const response = await this.#api<{
			data?: { repository: ActivityPage | null };
			errors?: { path?: unknown[] }[];
		}>(token, "/graphql", "POST", {
			query: activityQuery(scan, stale),
			variables: {
				owner: repo.owner,
				name: repo.name,
				issues: scan.history.issues || null,
				pulls: scan.history.pulls || null,
				open: scan.occupancy.open || null,
				refs: scan.occupancy.refs || null,
			},
		});
		// An entity read by number may be gone, such as a deleted issue (GitHub
		// reports NOT_FOUND at its alias). Any other error is a partial result.
		// Accepting any error at the alias keeps one unreadable entity from
		// blocking every later read.
		const partial = response.errors?.some(
			(error) =>
				error.path?.length !== 2 || error.path[0] !== "repository" || !/^s\d+$/.test(String(error.path[1])),
		);
		if (partial || !response.data?.repository) throw new GitHubError("Project activity unavailable");
		await this.#draftBodies(token, repo, scan, response.data.repository, stale);
		// A rename, transfer, visibility change, or revocation during the read
		// must not publish fresh observations.
		const latest = await this.#api<Repository>(token, repositoryPath(repo));
		this.#repository(repo, latest);
		this.#public(latest);
		if (latest.default_branch !== current.default_branch)
			throw new GitHubError("Default branch changed; refresh again");
		await recheck();
		await this.#gate(installation);
		if ((await this.#state(repo, installation)) === null) throw new GitHubError("Project enrollment changed");
		await reconcile(this.#env.DB, repo, snapshot, scan, response.data.repository, stale, row!.revision, row!.epoch);
	}

	async #draftBodies(
		token: string,
		repo: GitHubRepository,
		scan: Scan,
		page: ActivityPage,
		stale: Awaited<ReturnType<typeof staleEntities>>,
	) {
		// Bodies are needed only to classify open drafts. Metadata pages never request them.
		// Read those drafts in one batch, then require the same identity/version before publishing.
		const drafts = new Map<number, (Pull & { body?: string })[]>();
		const rows = [
			...(scan.history.pulls !== false
				? (page.pullRequests?.nodes ?? []).filter(
						(item) =>
							!scan.history.since?.pulls ||
							Date.parse(item.updatedAt) >= Date.parse(scan.history.since.pulls),
					)
				: []),
			...(scan.occupancy.open !== false ? (page.open?.nodes ?? []) : []),
			...stale.map((_, i) => page[`s${i}`]),
		];
		for (const item of rows) {
			if (!item || !("isDraft" in item) || !item.isDraft || item.state !== "OPEN") continue;
			const draft = item as Pull & { body?: string };
			if (!positiveId(draft.number)) throw new GitHubError("Invalid draft observation");
			drafts.set(draft.number, [...(drafts.get(draft.number) ?? []), draft]);
		}
		if (drafts.size) {
			const numbers = [...drafts.keys()];
			const result = await this.#api<{
				data?: {
					repository?: Record<
						string,
						| (Pick<Pull, "databaseId" | "updatedAt" | "headRefOid" | "state" | "isDraft"> & {
								body: string;
						  })
						| null
					>;
				};
				errors?: unknown[];
			}>(token, "/graphql", "POST", {
				query: `query($owner: String!, $name: String!) { repository(owner:$owner,name:$name) { ${numbers.map((number, i) => `b${i}:pullRequest(number:${number}) { databaseId:fullDatabaseId updatedAt headRefOid state isDraft body }`).join("\n")} } }`,
				variables: { owner: repo.owner, name: repo.name },
			});
			if (result.errors?.length || !result.data?.repository) throw new GitHubError("Draft bodies unavailable");
			for (const [i, number] of numbers.entries()) {
				const body = result.data.repository[`b${i}`];
				for (const item of drafts.get(number)!) {
					if (
						!body ||
						typeof body.body !== "string" ||
						body.databaseId !== item.databaseId ||
						body.updatedAt !== item.updatedAt ||
						body.headRefOid !== item.headRefOid ||
						body.state !== "OPEN" ||
						!body.isDraft
					)
						throw new ProjectChanged();
					item.body = body.body;
				}
			}
		}
	}

	/**
	 * Reread an enabled project after a webhook asked for it, with the App's
	 * own token. One read runs at a time: it answers every request made before
	 * it started, and requests made during it get one more read, so a burst of
	 * deliveries costs one or two reads rather than one each. This publishes
	 * observations only. It checks no maintainer, so it neither grants nor
	 * caches authority; every page and action still rechecks whoever acts. A
	 * read that another read or a webhook overtook reads again. A failure is
	 * recorded for the inbox and not retried: only a request made during the
	 * failed read gets another round. Each invocation reads at most three
	 * rounds to stay within one Worker invocation's subrequest budget; a
	 * request left after them waits for the next webhook or a refresh.
	 */
	async observe(id: number) {
		const db = this.#env.DB;
		for (let round = 0; round < 3; round++) {
			const now = Date.now();
			const lease = now + observeLease;
			const claimed = await db
				.prepare(
					`UPDATE github_project_state SET requested=0,lease=? WHERE repository=? AND requested=1 AND (lease IS NULL OR lease<?)
 AND EXISTS(SELECT 1 FROM github_projects WHERE id=? AND state='enabled')`,
				)
				.bind(lease, id, now, id)
				.run();
			if (claimed.meta.changes !== 1) return;
			let failure: string | null = null;
			let overtaken = false;
			try {
				const repo = await db
					.prepare("SELECT id,owner,name FROM github_projects WHERE id=?")
					.bind(id)
					.first<GitHubRepository>();
				if (repo)
					await this.#withRepository(repo, observing, async (token, current, installation) => {
						this.#public(current);
						if ((await this.#state(repo, installation)) !== "enabled")
							throw new GitHubError("Project enrollment changed");
						await this.#read(token, repo, current, installation, async () => {});
					});
			} catch (error) {
				// A manual refresh that started before the webhook, or a webhook's
				// revision bump, can publish first and leave this read's entities stale.
				if (error instanceof ProjectChanged) overtaken = true;
				else {
					// Provider errors carry no response bodies or secrets; anything else is a bug.
					failure = error instanceof GitHubError ? error.message : "Unexpected error";
					if (!(error instanceof GitHubError))
						console.error({ event: "github_observe_failed", name: (error as Error)?.name });
				}
			}
			// An overtaken read, or more named entities than one read covers, asks for another round.
			const more = overtaken || (!failure && (await staleEntities(db, id)).length > 0);
			await db
				.prepare(
					"UPDATE github_project_state SET lease=NULL,failure=COALESCE(?,failure),requested=MAX(requested,?) WHERE repository=? AND lease=?",
				)
				.bind(failure, more ? 1 : 0, id, lease)
				.run();
		}
	}

	/**
	 * What a new job may start from: `resolve` picks it from current
	 * observations, then this checks that its issue or pull request is still
	 * open at the observed head, and whether its revision has a flake for the
	 * runner's devShell.
	 */
	jobSource<T extends { target: string; revision: string; trusted: boolean }>(
		repo: GitHubRepository,
		userId: string,
		resolve: (state: ProjectState) => T,
	) {
		const permissions = { contents: "read", issues: "read", pull_requests: "read" } as const;
		return this.#authorized(repo, userId, permissions, async (token, current, installation) => {
			this.#public(current);
			const enrolled = await this.#state(repo, installation);
			if (enrolled === null) throw new GitHubError("Project is not enrolled for this installation");
			const state = await this.#observations(repo, installation);
			// Pending availability means a webhook or an unfinished pass left open PRs and claims unread.
			if (!state || state.project.available === null)
				throw new GitHubError("Refresh project activity before starting work");
			// Check the revision the job will run, such as a pull request's head.
			const job = resolve(state);
			// Only history rereads an issue or PR, so its activity row can still say
			// open after it closed; read the target itself before binding a job to it.
			const [, kind, target] = job.target.match(/^(issues|pulls)\/(\d+)$/) ?? [];
			if (kind) {
				const live = await this.#api<{ state: string; head?: { sha: string } }>(
					token,
					`${repositoryPath(repo)}/${kind}/${number(Number(target))}`,
				);
				if (live.state !== "open" || (kind === "pulls" && live.head?.sha !== job.revision))
					throw new GitHubError("This changed on GitHub since it was read; refresh and review it again");
			}
			if (kind === "pulls") job.trusted = await this.#pullTrust(token, repo, Number(target), job.revision);
			let flake = true;
			try {
				await this.#api(token, `${repositoryPath(repo)}/contents/flake.nix?ref=${sha(job.revision)}`);
			} catch (error) {
				if (!(error instanceof GitHubError) || error.status !== 404) throw error;
				flake = false;
			}
			return { job, enabled: enrolled === "enabled", flake };
		});
	}

	/** Recheck a queued PR head against current signatures and repository roles. */
	jobTrust(repo: GitHubRepository, target: string, revision: string) {
		return this.#withRepository(repo, { contents: "read", pull_requests: "read" }, async (token, current) => {
			this.#public(current);
			return this.#pullTrust(token, repo, pullNumber(target), revision);
		});
	}

	async #pullTrust(token: string, repo: GitHubRepository, pull: number, revision: string) {
		type Signer = { databaseId: number; login: string };
		type Commit = { oid: string; signature: { isValid: boolean; signer: Signer | null } | null };
		type Comparison = {
			baseTarget: { oid: string };
			headTarget: { oid: string };
			commits: {
				totalCount: number;
				nodes: Commit[];
				pageInfo: { hasNextPage: boolean; endCursor: string | null };
			};
		};
		type Page = {
			pullRequest: { state: string; headRefOid: string } | null;
			defaultBranchRef: { name: string; target: { oid: string } | null; compare: Comparison | null } | null;
		};
		// A PR's base is contributor-controlled. Compare the exact head against the
		// repository's trusted default branch so retargeting cannot hide ancestors.
		const query = `query($owner:String!,$name:String!,$number:Int!,$revision:String!,$after:String) {
 repository(owner:$owner,name:$name) {
 pullRequest(number:$number) { state headRefOid }
 defaultBranchRef { name target { oid } compare(headRef:$revision) {
 baseTarget { oid } headTarget { oid }
 commits(first:100,after:$after) {
 totalCount nodes { oid signature { isValid signer { databaseId login } } }
 pageInfo { hasNextPage endCursor }
 } } } } }`;
		let after: string | null = null;
		let base: string | undefined;
		let branch: string | undefined;
		let count: number | undefined;
		const cursors = new Set<string>();
		const commits = new Set<string>();
		const maintainers = new Map<number, boolean>();
		do {
			const response: { data?: { repository?: Page }; errors?: unknown[] } = await this.#api(
				token,
				"/graphql",
				"POST",
				{
					query,
					variables: { owner: repo.owner, name: repo.name, number: pull, revision: sha(revision), after },
				},
			);
			if (response.errors?.length) throw new GitHubError("Could not verify pull request commits");
			const repository: Page | undefined = response.data?.repository;
			const live = repository?.pullRequest;
			const anchor = repository?.defaultBranchRef;
			const comparison = anchor?.compare;
			if (!live || live.state !== "OPEN" || live.headRefOid !== revision || !anchor?.target || !comparison)
				return false;
			base ??= sha(anchor.target.oid);
			branch ??= anchor.name;
			const page = comparison.commits;
			count ??= page.totalCount;
			if (
				base !== anchor.target.oid ||
				branch !== anchor.name ||
				count !== page.totalCount ||
				comparison.baseTarget.oid !== base ||
				comparison.headTarget.oid !== revision
			)
				return false;
			for (const commit of page.nodes) {
				if (commits.has(commit.oid)) throw new GitHubError("Repeated pull request commit");
				commits.add(sha(commit.oid));
				// Only a valid signature counts, never author email. kix's own commits
				// are signed as the App, which is no maintainer, so they stay untrusted.
				const signer = commit.signature?.isValid && commit.signature.signer;
				if (!signer || !positiveId(signer.databaseId) || !name(signer.login)) return false;
				if (!maintainers.has(signer.databaseId)) {
					const permission = await this.#api<{ user: { id: number }; permission: string; role_name: string }>(
						token,
						`${repositoryPath(repo)}/collaborators/${signer.login}/permission`,
					).catch((error: unknown) => {
						if (error instanceof GitHubError && error.status === 404) return null;
						throw error;
					});
					maintainers.set(
						signer.databaseId,
						!!permission &&
							permission.user.id === signer.databaseId &&
							(permission.permission === "admin" || permission.role_name === "maintain"),
					);
				}
				if (!maintainers.get(signer.databaseId)) return false;
			}
			if (!page.pageInfo.hasNextPage) break;
			after = page.pageInfo.endCursor;
			if (!after || cursors.has(after)) throw new GitHubError("Missing or repeated pull request commit cursor");
			cursors.add(after);
		} while (true);
		return commits.size === count && (count === 0 || commits.has(revision));
	}

	previewProject(repo: GitHubRepository, userId: string) {
		return this.#authorized(repo, userId, { contents: "read" }, (token, current, installation) =>
			this.#preview(token, repo, current, installation),
		);
	}

	/** Change a project's contribution state, returning the running job attempts a disconnect removed. */
	setContributions(repo: GitHubRepository, userId: string, state: ContributionState | "disconnected") {
		if (!["enabled", "paused", "disconnected"].includes(state)) throw new GitHubError("Invalid contribution state");
		return this.#authorized(
			repo,
			userId,
			state === "enabled" ? { contents: "read" } : {},
			async (token, current, installation) => {
				if (state === "enabled") {
					const preview = await this.#preview(token, repo, current, installation);
					if (preview.licenseError) throw new GitHubError(preview.licenseError);
					// The repository or license can change during content reads. Check
					// current eligibility again, rather than persisting the preview's grant.
					const latest = await this.#api<Repository>(token, repositoryPath(repo));
					this.#repository(repo, latest);
					this.#public(latest);
					if (
						latest.default_branch !== current.default_branch ||
						latest.license?.spdx_id !== current.license?.spdx_id
					)
						throw new GitHubError("Repository eligibility changed; review this project again");
					const licenseError = await this.#license(latest);
					if (licenseError) throw new GitHubError(licenseError);
					await this.#maintainer(token, repo, userId);
				}
				// Recheck the local revocation gate after potentially long content reads.
				await this.#gate(installation);
				if (state === "disconnected") {
					// Jobs go with the project, so read the running attempts in the same transaction,
					// and queue the deletion of any output objects, which R2 cannot do in it.
					const [running] = await this.#env.DB.batch<Stopped>([
						this.#env.DB.prepare(
							"SELECT actor,runner,id AS job,attempt FROM jobs WHERE repository=? AND state='running'",
						).bind(repo.id),
						this.#env.DB.prepare(
							"INSERT OR IGNORE INTO output_cleanup(job,at) SELECT DISTINCT a.job,? FROM job_output_attempts a JOIN jobs j ON j.id=a.job WHERE j.repository=?",
						).bind(Date.now(), repo.id),
						this.#env.DB.prepare("DELETE FROM github_projects WHERE id=?").bind(repo.id),
					]);
					return running!.results;
				}
				if (state === "paused") {
					await this.#env.DB.prepare("UPDATE github_projects SET state='paused',updatedAt=? WHERE id=?")
						.bind(Date.now(), repo.id)
						.run();
				} else {
					await this.#env.DB.batch([
						this.#env.DB.prepare(
							"DELETE FROM github_project_state WHERE repository=? AND EXISTS(SELECT 1 FROM github_projects WHERE id=? AND installation<>?)",
						).bind(repo.id, repo.id, installation),
						this.#env.DB.prepare(
							"DELETE FROM github_project_activity WHERE repository=? AND EXISTS(SELECT 1 FROM github_projects WHERE id=? AND installation<>?)",
						).bind(repo.id, repo.id, installation),
						this.#env.DB.prepare(
							`INSERT INTO github_projects(id,owner,name,installation,state,enrolledBy,updatedAt) VALUES(?,?,?,?,'enabled',?,?)
					ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,name=excluded.name,installation=excluded.installation,state=excluded.state,updatedAt=excluded.updatedAt`,
						).bind(repo.id, repo.owner, repo.name, installation, userId, Date.now()),
						// The project did not exist when the check above ran.
						this.#env.DB.prepare(
							"INSERT INTO github_project_members(repository,user) VALUES(?,?) ON CONFLICT DO NOTHING",
						).bind(repo.id, userId),
					]);
				}
				return [];
			},
			state !== "enabled",
		);
	}

	// Reads also require authority: installations may contain private repositories.
	readQuest(repo: GitHubRepository, userId: string, path: string, commit: string) {
		if (
			!/^quest\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.md$/.test(path) ||
			path.split("/").some((p) => p === "." || p === "..")
		)
			throw new GitHubError("Invalid quest path");
		return this.#authorized(repo, userId, { contents: "read" }, (token) =>
			this.#api(token, `${repositoryPath(repo)}/contents/${path}?ref=${sha(commit)}`),
		);
	}
	readIssue(repo: GitHubRepository, userId: string, issue: number) {
		return this.#authorized(repo, userId, { issues: "read" }, (token) =>
			this.#api(token, `${repositoryPath(repo)}/issues/${number(issue)}`),
		);
	}
	readPullRequest(repo: GitHubRepository, userId: string, pull: number) {
		return this.#authorized(repo, userId, { pull_requests: "read" }, (token) =>
			this.#api(token, `${repositoryPath(repo)}/pulls/${number(pull)}`),
		);
	}
	readChecks(repo: GitHubRepository, userId: string, commit: string, page = 1) {
		if (!positiveId(page)) throw new GitHubError("Invalid checks page");
		return this.#authorized(repo, userId, { checks: "read", statuses: "read" }, async (token) => ({
			checks: await this.#api(
				token,
				`${repositoryPath(repo)}/commits/${sha(commit)}/check-runs?per_page=100&page=${page}`,
			),
			status: await this.#api(
				token,
				`${repositoryPath(repo)}/commits/${sha(commit)}/status?per_page=100&page=${page}`,
			),
		}));
	}
	/**
	 * What a job's agent reads about its issue or pull request, which its
	 * checkout does not hold: an issue's text and comments, or a pull request's
	 * text, comments, reviews, unresolved review threads, and checks at its head.
	 * Everything in it is untrusted GitHub content.
	 */
	readTarget(repo: GitHubRepository, userId: string, target: string) {
		const [, kind, value] = target.match(/^(issues|pulls)\/(\d{1,15})$/) ?? [];
		if (!kind) throw new GitHubError("Only issue and pull request jobs have a target to read");
		const permissions: Permissions =
			kind === "issues" ? { issues: "read" } : { pull_requests: "read", checks: "read", statuses: "read" };
		const pageInfo = "pageInfo { hasNextPage endCursor }";
		const commentFields = "nodes { author { login } body createdAt }";
		const comments = `comments(first: 100, after: $after) { ${commentFields} ${pageInfo} }`;
		const reviews = `reviews(first: 50, after: $after) { nodes { author { login } state body submittedAt } ${pageInfo} }`;
		const threads = `reviewThreads(first: 100, after: $after) { nodes { id isResolved isOutdated path line comments(first: 50) { ${commentFields} ${pageInfo} } } ${pageInfo} }`;
		const contexts = (after: boolean) =>
			`contexts(first: 100${after ? ", after: $after" : ""}) { nodes { __typename ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state description targetUrl } } ${pageInfo} }`;
		const query =
			kind === "issues"
				? `issue(number: $number) { number title state body author { login } ${comments} }`
				: `pullRequest(number: $number) { number title state body isDraft author { login } baseRefName headRefName headRefOid ${comments} ${reviews} ${threads}
 commits(last: 1) { nodes { commit { oid statusCheckRollup { state ${contexts(false)} } } } } }`;
		type Connection<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
		type Comment = { author: { login: string } | null; body: string; createdAt?: string; submittedAt?: string };
		type Review = Comment & { state: string };
		type Thread = {
			id: string;
			isResolved: boolean;
			isOutdated: boolean;
			path: string;
			line: number | null;
			comments: Connection<Comment>;
		};
		type Check = {
			__typename: string;
			name?: string;
			status?: string;
			conclusion?: string | null;
			detailsUrl?: string | null;
			context?: string;
			state?: string;
			description?: string | null;
			targetUrl?: string | null;
		};
		type Rollup = { state: string; contexts: Connection<Check> };
		type Item = {
			number: number;
			title: string;
			state: string;
			body: string;
			isDraft?: boolean;
			author: { login: string } | null;
			baseRefName?: string;
			headRefName?: string;
			headRefOid?: string;
			comments: Connection<Comment>;
			reviews?: Connection<Review>;
			reviewThreads?: Connection<Thread>;
			commits?: { nodes: { commit: { oid: string; statusCheckRollup: Rollup | null } }[] };
		};
		return this.#authorized(repo, userId, permissions, async (token) => {
			const request = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
				const result = await this.#api<{ data?: T; errors?: unknown[] }>(token, "/graphql", "POST", {
					query,
					variables,
				});
				if (result.errors?.length || !result.data)
					throw new GitHubError("This issue or pull request is unavailable");
				return result.data;
			};
			const read = async (fields: string, after: string | null = null) => {
				const result = await request<{ repository: { issue?: Item | null; pullRequest?: Item | null } | null }>(
					`query($owner: String!, $name: String!, $number: Int!, $after: String) { repository(owner: $owner, name: $name) { ${fields} } }`,
					{ owner: repo.owner, name: repo.name, number: number(Number(value)), after },
				);
				const item = result.repository?.[kind === "pulls" ? "pullRequest" : "issue"];
				if (!item) throw new GitHubError("This issue or pull request is unavailable");
				return item;
			};
			// Each connection owns its cursor history, including nested comments and fixed-head checks.
			const collect = async <T>(
				first: Connection<T> | undefined,
				next: (after: string) => Promise<Connection<T> | undefined>,
				name: string,
			): Promise<T[]> => {
				const all: T[] = [];
				const seen = new Set<string>();
				let page = first;
				for (;;) {
					if (!page) throw new GitHubError(`This target's ${name} are unavailable`);
					all.push(...page.nodes);
					if (!page.pageInfo.hasNextPage) return all;
					const cursor = page.pageInfo.endCursor;
					if (!cursor || seen.has(cursor)) throw new GitHubError(`This target's ${name} are unavailable`);
					seen.add(cursor);
					page = await next(cursor);
				}
			};
			const item = await read(query);
			const comment = (c: Comment) => ({
				author: c.author?.login ?? null,
				body: c.body,
				at: c.createdAt ?? c.submittedAt ?? null,
			});
			const discussion = await collect(
				item.comments,
				async (after) =>
					(
						await read(
							`${kind === "pulls" ? "pullRequest" : "issue"}(number: $number) { ${comments} }`,
							after,
						)
					).comments,
				"comments",
			);
			const common = {
				number: item.number,
				title: item.title,
				state: item.state,
				author: item.author?.login ?? null,
				body: item.body,
				comments: discussion.map(comment),
			};
			if (kind === "issues") return { kind: "issue" as const, ...common };
			const allReviews = await collect(
				item.reviews,
				async (after) => (await read(`pullRequest(number: $number) { ${reviews} }`, after)).reviews,
				"reviews",
			);
			const allThreads = await collect(
				item.reviewThreads,
				async (after) => (await read(`pullRequest(number: $number) { ${threads} }`, after)).reviewThreads,
				"review threads",
			);
			const unresolved = [];
			for (const thread of allThreads.filter((t) => !t.isResolved)) {
				const replies = await collect(
					thread.comments,
					async (after) => {
						const data = await request<{ node: { comments: Connection<Comment> } | null }>(
							`query($id: ID!, $after: String) { node(id: $id) { ... on PullRequestReviewThread { comments(first: 50, after: $after) { ${commentFields} ${pageInfo} } } } }`,
							{ id: thread.id, after },
						);
						return data.node?.comments;
					},
					"review thread comments",
				);
				unresolved.push({
					path: thread.path,
					line: thread.line,
					outdated: thread.isOutdated,
					comments: replies.map(comment),
				});
			}
			const head = item.commits?.nodes.at(-1)?.commit;
			const allChecks = head?.statusCheckRollup
				? await collect(
						head.statusCheckRollup.contexts,
						async (after) => {
							const data = await request<{
								repository: { object: { statusCheckRollup: Rollup | null } | null } | null;
							}>(
								`query($owner: String!, $name: String!, $oid: GitObjectID!, $after: String) { repository(owner: $owner, name: $name) { object(oid: $oid) { ... on Commit { statusCheckRollup { ${contexts(true)} } } } } }`,
								{ owner: repo.owner, name: repo.name, oid: head.oid, after },
							);
							return data.repository?.object?.statusCheckRollup?.contexts;
						},
						"check contexts",
					)
				: [];
			return {
				kind: "pull" as const,
				...common,
				draft: item.isDraft ?? false,
				base: item.baseRefName ?? null,
				head: { ref: item.headRefName ?? null, oid: item.headRefOid ?? null },
				reviews: allReviews.map((r) => ({ ...comment(r), state: r.state })),
				// Resolved threads need nothing more; outdated ones may still need an answer.
				threads: unresolved,
				checks: {
					commit: head?.oid ?? null,
					state: head?.statusCheckRollup?.state ?? null,
					runs: allChecks.map((c) =>
						c.__typename === "CheckRun"
							? { name: c.name!, state: c.conclusion ?? c.status ?? null, url: c.detailsUrl ?? null }
							: {
									name: c.context!,
									state: c.state ?? null,
									url: c.targetUrl ?? null,
									description: c.description ?? null,
								},
					),
				},
			};
		});
	}

	comment(repo: GitHubRepository, userId: string, issue: number, approvedBody: string) {
		if (!approvedBody.trim()) throw new GitHubError("Approved comment required");
		return this.#authorized(repo, userId, { issues: "write" }, (token) =>
			this.#api(token, `${repositoryPath(repo)}/issues/${number(issue)}/comments`, "POST", {
				body: approvedBody,
			}),
		);
	}

	/**
	 * Hand `action` the one branch a job may write: its branch on the service
	 * fork, or an iterated pull request's head when the bot can update it.
	 * Rechecks the requester's current authority and the project's enrollment.
	 */
	contribute<T>(
		upstream: GitHubRepository,
		userId: string,
		job: Contribution,
		action: (branch: Branch) => Promise<T>,
	) {
		const pulled = job.workflow === "iterate" || job.workflow === "merge";
		return this.#authorized(
			upstream,
			userId,
			pulled ? { contents: "read", pull_requests: "read" } : {},
			async (token, current, installation) => {
				this.#public(current);
				if ((await this.#state(upstream, installation)) === null)
					throw new GitHubError("Project is not enrolled for this installation");
				// A merge commit may only bring in what the pull request's upstream base already holds.
				const based = (base: string) => async (commit: string) => {
					try {
						const ref = base.split("/").map(encodeURIComponent).join("/");
						const { status } = await this.#api<{ status: string }>(
							token,
							`${repositoryPath(upstream)}/compare/${sha(commit)}...${ref}`,
						);
						return status === "identical" || status === "ahead";
					} catch (error) {
						if (error instanceof GitHubError && error.status === 404) return false;
						throw error;
					}
				};
				// A job's own branch starts from the default branch's current commit, so it merges nothing in.
				if (!pulled)
					return this.#fork(upstream, upstream.name, { contents: "write" }, (forkToken, fork) =>
						action(this.#branch(forkToken, fork, job.branch, async () => false)),
					);
				const pull = await this.#api<PullHead>(
					token,
					`${repositoryPath(upstream)}/pulls/${pullNumber(job.target)}`,
				);
				if (pull.state !== "open" || pull.head.ref !== job.branch)
					throw new GitHubError("The pull request was closed or its head branch changed");
				const head = pull.head.repo;
				const base = based(pull.base.ref);
				if (head?.id === upstream.id)
					return this.#withRepository(upstream, { contents: "write" }, async (writeToken, latest) =>
						action(this.#branch(writeToken, latest, job.branch, base)),
					);
				if (head && this.#forkOwner(head.owner.login))
					return this.#fork(upstream, head.name, { contents: "write" }, (forkToken, fork) => {
						if (fork.id !== head.id) throw new GitHubError("Repository identity or availability changed");
						return action(this.#branch(forkToken, fork, job.branch, base));
					});
				throw new PublicationBlocked(
					"The pull request's head is in a contributor's fork, which the bot cannot update. Ask its author to apply the changes, or close it and start new work.",
				);
			},
		);
	}

	#forkOwner(owner: string) {
		return !!this.#env.GITHUB_FORK_OWNER && owner.toLowerCase() === this.#env.GITHUB_FORK_OWNER.toLowerCase();
	}

	/** The operator-provisioned fork of `upstream` in the service namespace, verified by parent ID. */
	async #fork<T>(
		upstream: GitHubRepository,
		repository: string,
		permissions: Permissions,
		action: (token: string, fork: Repository) => Promise<T>,
	) {
		const owner = this.#env.GITHUB_FORK_OWNER;
		if (!owner || !name(owner)) throw new GitHubError("Configured service fork namespace required");
		const missing = new GitHubError(`Provision the service fork ${owner}/${repository} of this upstream first`);
		// Only a missing installation or repository means the fork is unprovisioned.
		let found = false;
		try {
			return await this.#withInstallation({ owner, name: repository }, permissions, async (token) => {
				const fork = await this.#api<Repository>(token, `/repos/${owner}/${repository}`);
				if (
					!fork.fork ||
					fork.parent?.id !== upstream.id ||
					!this.#forkOwner(fork.owner.login) ||
					fork.archived ||
					fork.disabled
				)
					throw missing;
				found = true;
				return action(token, fork);
			});
		} catch (error) {
			throw !found && error instanceof GitHubError && error.status === 404 ? missing : error;
		}
	}

	#branch(token: string, repo: Repository, branch: string, based: Branch["based"]): Branch {
		if (!refName(branch) || branch === repo.default_branch)
			throw new PublicationBlocked("Jobs never write a repository's default branch");
		const path = `/repos/${repo.owner.login}/${repo.name}`;
		const ref = branch.split("/").map(encodeURIComponent).join("/");
		const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
		return {
			repository: { owner: repo.owner.login, name: repo.name, id: repo.id },
			head: async () => {
				try {
					const found = await this.#api<{ object: { sha: string; type: string } }>(
						token,
						`${path}/git/ref/heads/${ref}`,
					);
					if (found.object.type !== "commit") throw new GitHubError("Branch must point at a commit");
					return sha(found.object.sha);
				} catch (error) {
					if (error instanceof GitHubError && error.status === 404) return null;
					throw error;
				}
			},
			based,
			workflows: async (commit) => {
				try {
					const entries = await this.#api<unknown>(token, `${path}/contents/.github?ref=${sha(commit)}`);
					if (!Array.isArray(entries)) return null;
					const found = (entries as { name?: unknown; type?: unknown; sha?: unknown }[]).find(
						(entry) => entry.name === "workflows" && entry.type === "dir",
					);
					return typeof found?.sha === "string" ? sha(found.sha) : null;
				} catch (error) {
					if (error instanceof GitHubError && error.status === 404) return null;
					throw error;
				}
			},
			commit: async (parent, changes, message, merge, submodules = []) => {
				const base = await this.#api<{ tree: { sha: string } }>(
					token,
					`${path}/git/commits/${sha(merge ?? parent)}`,
				);
				const tree = [];
				if (submodules.length) {
					const source = await this.#api<{ tree: { sha: string } }>(
						token,
						`${path}/git/commits/${sha(parent)}`,
					);
					const existing = await this.#api<Tree>(
						token,
						`${path}/git/trees/${sha(source.tree.sha)}?recursive=1`,
					);
					if (existing.truncated)
						throw new PublicationBlocked("The head's submodule tree is incomplete; no merge was published");
					for (const pointer of submodules) {
						const entry = existing.tree.find((entry) => entry.path === pointer.path);
						if (entry?.mode !== "160000" || entry.type !== "commit" || entry.sha !== pointer.sha)
							throw new PublicationBlocked(
								`A merge can only retain the head's existing submodule pointer: ${pointer.path}`,
							);
						tree.push({ path: pointer.path, mode: "160000", type: "commit", sha: sha(entry.sha) });
					}
				}
				for (const change of changes) {
					const mode = change.mode;
					if (change.content === null) {
						tree.push({ path: change.path, mode, type: "blob", sha: null });
						continue;
					}
					// Text goes inline in the tree request; other bytes need their own blob.
					let content: string | null = null;
					try {
						content = text.decode(change.content);
					} catch {}
					if (content !== null && !content.includes("\0")) {
						tree.push({ path: change.path, mode, type: "blob", content });
						continue;
					}
					const blob = await this.#api<{ sha: string }>(token, `${path}/git/blobs`, "POST", {
						content: Buffer.from(change.content).toString("base64"),
						encoding: "base64",
					});
					tree.push({ path: change.path, mode, type: "blob", sha: sha(blob.sha) });
				}
				const created = await this.#api<{ sha: string }>(token, `${path}/git/trees`, "POST", {
					base_tree: sha(base.tree.sha),
					tree,
				});
				// No author or committer: GitHub attributes and signs the commit as the App.
				const commit = await this.#api<{ sha: string }>(token, `${path}/git/commits`, "POST", {
					message,
					tree: sha(created.sha),
					parents: merge ? [parent, sha(merge)] : [parent],
				});
				return sha(commit.sha);
			},
			move: async (from, to) => {
				try {
					if (from === null)
						await this.#api(token, `${path}/git/refs`, "POST", {
							ref: `refs/heads/${branch}`,
							sha: sha(to),
						});
					// Fast-forward only, so an update built on a stale head cannot overwrite newer work.
					else
						await this.#api(token, `${path}/git/refs/heads/${ref}`, "PATCH", {
							sha: sha(to),
							force: false,
						});
					return true;
				} catch (error) {
					if (error instanceof GitHubError && (error.status === 409 || error.status === 422)) return false;
					throw error;
				}
			},
			reset: async (to) => {
				try {
					await this.#api(token, `${path}/git/refs/heads/${ref}`, "PATCH", { sha: sha(to), force: true });
				} catch (error) {
					// GitHub refuses to update a reference that does not exist.
					if (!(error instanceof GitHubError) || error.status !== 422) throw error;
					await this.#api(token, `${path}/git/refs`, "POST", { ref: `refs/heads/${branch}`, sha: sha(to) });
				}
			},
		};
	}

	/**
	 * Open the job's pull request from its service fork branch, or update the
	 * one it already opened. A closed pull request is not replaced.
	 */
	deliver(
		upstream: GitHubRepository,
		userId: string,
		job: Contribution,
		input: { title: string; body: string; draft: boolean },
	) {
		if (job.workflow === "iterate" || job.workflow === "merge")
			throw new GitHubError("Work on a pull request updates its head and opens no pull request");
		return this.#authorized(upstream, userId, { pull_requests: "write" }, async (token, current, installation) => {
			this.#public(current);
			if ((await this.#state(upstream, installation)) !== "enabled")
				throw new GitHubError("Contributions are paused");
			const fork = await this.#fork(upstream, upstream.name, {}, async (_token, fork) => fork);
			const pulls = `${repositoryPath(upstream)}/pulls`;
			const label = `${fork.owner.login}:${job.branch}`;
			// An unrecorded earlier delivery may have opened one. The branch is
			// where the job left it, so its only open pull request is the job's,
			// even one a failed job this retry continues opened. Otherwise one
			// opened since the job is, which the maintainer may since have closed.
			// GitHub reports whole seconds, so compare against the second the job was created in.
			const since = Math.floor(job.createdAt / 1000) * 1000;
			const opened = async () => {
				const found = await this.#api<PullHead[]>(
					token,
					`${pulls}?state=all&per_page=100&head=${encodeURIComponent(label)}`,
				);
				const open = found.filter((pull) => pull.state === "open");
				return (
					(open.length === 1 ? open[0] : found.find((pull) => Date.parse(pull.created_at) >= since)) ?? null
				);
			};
			let pull = job.pull ? await this.#api<PullHead>(token, `${pulls}/${number(job.pull)}`) : await opened();
			if (pull && (pull.head.repo?.id !== fork.id || pull.head.ref !== job.branch))
				throw new GitHubError("The job's pull request no longer comes from its branch");
			if (pull && pull.state !== "open")
				throw new GitHubError("The job's pull request was closed; reopen it on GitHub to deliver again");
			if (!pull) {
				try {
					pull = await this.#api<PullHead>(token, pulls, "POST", {
						head: label,
						// GitHub requires the head repository for cross-organization pull requests.
						head_repo: fork.name,
						base: current.default_branch,
						title: input.title,
						body: input.body,
						draft: input.draft,
						// Installation tokens cannot span both owners, so the upstream
						// token cannot grant maintainers edits on the fork branch.
						maintainer_can_modify: false,
					});
				} catch (error) {
					// A concurrent delivery may have opened it first.
					if (!(error instanceof GitHubError) || error.status !== 422) throw error;
					pull = await opened();
					if (pull?.state !== "open") throw error;
				}
			}
			if (pull.title !== input.title || pull.body !== input.body)
				pull = await this.#api<PullHead>(token, `${pulls}/${number(pull.number)}`, "PATCH", {
					title: input.title,
					body: input.body,
				});
			// Finished work leaves draft; a maintainer's own choice to mark it ready is never reverted.
			if (pull.draft && !input.draft) {
				const result = await this.#api<{ errors?: unknown[] }>(token, "/graphql", "POST", {
					query: "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { clientMutationId } }",
					variables: { id: pull.node_id },
				});
				if (result.errors?.length) throw new GitHubError("Could not mark the pull request ready for review");
				pull = { ...pull, draft: false };
			}
			return { number: number(pull.number), url: pull.html_url, draft: pull.draft };
		});
	}

	/** Why kix may not land `head` yet, or null when a review counts on it; see `unreviewed`. */
	#unreviewed(token: string, repo: GitHubRepository, current: Repository, pull: number, head: string) {
		const path = repositoryPath(repo);
		return unreviewed(
			{
				get: (tail) => this.#api(token, `${path}${tail}`),
				graphql: (query, variables) => this.#api(token, "/graphql", "POST", { query, variables }),
			},
			{
				owner: repo.owner,
				name: repo.name,
				pull: number(pull),
				head: sha(head),
				branch: current.default_branch,
				app: Number(this.#env.GITHUB_APP_ID),
			},
		);
	}

	/**
	 * Merge exactly `expectedHead` with the first method the repository
	 * allows: squash, then a merge commit, then rebase, once a review counts on
	 * it. GitHub enforces branch rules, reviews, and checks; a refusal says why
	 * and is never retried.
	 */
	mergePullRequest(repo: GitHubRepository, userId: string, pull: number, expectedHead: string) {
		const permissions: Permissions = { contents: "write", pull_requests: "write", checks: "read" };
		return this.#authorized(repo, userId, permissions, async (token, current) => {
			const method = mergeMethod(current);
			const waiting = await this.#unreviewed(token, repo, current, pull, expectedHead);
			if (waiting) throw new GitHubError(waiting);
			let merged: { sha: string };
			try {
				merged = await this.#api<{ sha: string }>(
					token,
					`${repositoryPath(repo)}/pulls/${number(pull)}/merge`,
					"PUT",
					{ sha: sha(expectedHead), merge_method: method },
					true,
				);
			} catch (error) {
				if (!(error instanceof GitHubError)) throw error;
				if (error.status === 409)
					throw new GitHubError("The pull request's head moved since you looked; review it again", 409);
				if (error.reason && [403, 405, 422].includes(error.status!))
					throw new GitHubError(`GitHub refused the merge: ${error.reason}`, error.status);
				throw error;
			}
			await this.#invalidate(repo);
			return { sha: merged.sha };
		});
	}

	/** As a webhook would, mark observations stale so the inbox stops offering a pull request that merged or is landing. */
	async #invalidate(repo: GitHubRepository) {
		await this.#env.DB.prepare(
			"UPDATE github_project_state SET invalidated=1,revision=revision+1 WHERE repository=?",
		)
			.bind(repo.id)
			.run();
	}

	/** A pull request's hold labels and the timeline events that add a label or start a landing, as `quest merge` reads them. */
	async #holds(token: string, repo: GitHubRepository, pull: number): Promise<Holds> {
		const result = await this.#api<{
			data?: { repository: { pullRequest: HoldRow | null } | null };
			errors?: unknown[];
		}>(token, "/graphql", "POST", {
			query: HOLDS,
			variables: { owner: repo.owner, name: repo.name, number: number(pull) },
		});
		const row = result.data?.repository?.pullRequest;
		if (result.errors?.length || !row) throw new GitHubError("This pull request is unavailable");
		return {
			id: row.id,
			state: row.state,
			base: row.baseRefName,
			head: row.headRefOid,
			mergeState: row.mergeStateStatus,
			queue: row.isMergeQueueEnabled === true,
			landing: row.autoMergeRequest !== null || row.mergeQueueEntry !== null,
			labels: row.labels.nodes.map((label) => label.name).filter(isHoldLabel),
			events: row.timelineItems.nodes.map((event) => ({
				id: event.id,
				label: event.__typename === "LabeledEvent" ? (event.label?.name ?? "") : null,
			})),
		};
	}

	/** Remove `quest:merge` from a pull request; one already gone is fine. */
	async #unhold(token: string, repo: GitHubRepository, pull: number) {
		try {
			await this.#api(
				token,
				`${repositoryPath(repo)}/issues/${number(pull)}/labels/${encodeURIComponent(MERGE_LABEL)}`,
				"DELETE",
			);
		} catch (error) {
			if (!(error instanceof GitHubError) || error.status !== 404) throw error;
		}
	}

	/**
	 * Hold an open pull request for a merge job with the `quest:merge` label,
	 * the contract `quest merge --help` states for local sessions too. Refused
	 * while another session holds a `quest:*` label; a `quest:merge` whose
	 * landing ended unmerged is spent and removed first. When two sessions
	 * label it at once, the first label added keeps it. Returns the hold's
	 * token: the timeline event that added the label.
	 */
	holdPullRequest(repo: GitHubRepository, userId: string, pull: number) {
		return this.#authorized(repo, userId, { issues: "write", pull_requests: "read" }, async (token) => {
			let holds = await this.#holds(token, repo, pull);
			if (holds.state !== "OPEN") throw new GitHubError("The pull request is no longer open");
			if (spentMergeHold(holds)) {
				await this.#unhold(token, repo, pull);
				holds = { ...holds, labels: holds.labels.filter((name) => name !== MERGE_LABEL) };
			}
			const other = holds.labels[0];
			if (other) throw new GitHubError(heldBy(other));
			await this.#api(token, `${repositoryPath(repo)}/issues/${number(pull)}/labels`, "POST", {
				labels: [MERGE_LABEL],
			});
			holds = await this.#holds(token, repo, pull);
			const ours = latestHold(holds.events, MERGE_LABEL);
			if (!ours) throw new GitHubError("GitHub does not show the quest:merge label kix added");
			const rival = holds.labels.find((name) => {
				if (name === MERGE_LABEL) return false;
				const event = latestHold(holds.events, name);
				return !event || holds.events.indexOf(event) < holds.events.indexOf(ours);
			});
			if (rival) {
				await this.#unhold(token, repo, pull);
				throw new GitHubError(heldBy(rival));
			}
			return ours.id;
		});
	}

	/**
	 * Release a merge job's `quest:merge` hold unless its pull request is
	 * queued or auto-merging. The App acts on its own label here, with no
	 * maintainer request behind it. Returns whether the hold is over: released
	 * now, already removed or replaced, or its pull request no longer open.
	 */
	releasePullRequest(repo: GitHubRepository, pull: number, hold: string) {
		return this.#withRepository(repo, { issues: "write", pull_requests: "read" }, async (token) => {
			const holds = await this.#holds(token, repo, pull);
			if (holds.state !== "OPEN" || heldToken(holds, MERGE_LABEL) !== hold) return true;
			if (holds.landing) return false;
			await this.#unhold(token, repo, pull);
			return true;
		});
	}

	/** Whether `branch` requires the `quest land` check, read from branch protection and rulesets. */
	async #gated(token: string, repo: GitHubRepository, branch: string): Promise<boolean> {
		const path = repositoryPath(repo);
		const ref = encodeURIComponent(branch);
		type Contexts = { context: string }[];
		const { protection } = await this.#api<{
			protection?: {
				required_status_checks?: { enforcement_level?: string; contexts?: string[]; checks?: Contexts };
			};
		}>(token, `${path}/branches/${ref}`);
		const legacy = protection?.required_status_checks;
		const contexts =
			legacy && legacy.enforcement_level !== "off"
				? (legacy.checks?.map((check) => check.context) ?? legacy.contexts ?? [])
				: [];
		const rules = await this.#api<{ type: string; parameters?: { required_status_checks?: Contexts } }[]>(
			token,
			`${path}/rules/branches/${ref}?per_page=100`,
		);
		const ruled = rules.flatMap((rule) =>
			rule.type === "required_status_checks" ? (rule.parameters?.required_status_checks ?? []) : [],
		);
		return [...contexts, ...ruled.map((check) => check.context)].includes(LAND_CHECK);
	}

	/**
	 * Land a merge job's pull request at exactly `head`, while the job still
	 * holds it: enable auto-merge bound to that head, which enters the merge
	 * queue when the base has one, or merge at once when GitHub would refuse
	 * auto-merge because nothing is left to wait for. `method` is the one the
	 * repository's instructions name, or else the first the repository allows.
	 * A base that requires the `quest land` check queues it for that gate
	 * instead, as `quest merge --land` does: squash auto-merge whose commit body
	 * pins the head. Either way, only once a review counts on the head.
	 */
	landPullRequest(
		repo: GitHubRepository,
		userId: string,
		pull: number,
		input: { head: string; hold: string | null; method: MergeMethod | null },
	) {
		return this.#authorized(
			repo,
			userId,
			{ contents: "write", pull_requests: "write", checks: "read" },
			async (token, current, installation) => {
				// Landing is a contribution like opening a pull request, so a paused project lands nothing.
				if ((await this.#state(repo, installation)) !== "enabled")
					throw new GitHubError("Contributions are paused");
				const check = (holds: Holds) => {
					if (holds.state !== "OPEN") throw new PublicationBlocked("The pull request is no longer open.");
					if (!input.hold || heldToken(holds, MERGE_LABEL) !== input.hold)
						throw new PublicationBlocked(
							"This job's quest:merge label was removed or replaced, so it no longer holds the pull request.",
						);
					if (holds.head !== sha(input.head))
						throw new PublicationBlocked("The pull request's head moved outside this job.");
				};
				const holds = await this.#holds(token, repo, pull);
				check(holds);
				// The maintainer's pick of merge never stands in for a review of what the job published since.
				const waiting = await this.#unreviewed(token, repo, current, pull, input.head);
				if (waiting) throw new PublicationBlocked(waiting);
				const gated = await this.#gated(token, repo, holds.base);
				let mutation: "mergePullRequest" | "enablePullRequestAutoMerge" =
					!gated && immediateMerge(holds.mergeState, holds.queue)
						? "mergePullRequest"
						: "enablePullRequestAutoMerge";
				const submit = async () => {
					const result = await this.#api<{ errors?: { message?: unknown }[] }>(token, "/graphql", "POST", {
						query: `mutation($id: ID!, $sha: GitObjectID!, $method: PullRequestMergeMethod!, $body: String) { ${mutation}(input: { pullRequestId: $id, expectedHeadOid: $sha, mergeMethod: $method, commitBody: $body }) { clientMutationId } }`,
						variables: {
							id: holds.id,
							sha: input.head,
							method: gated ? "SQUASH" : (input.method ?? mergeMethod(current)).toUpperCase(),
							body: gated ? `${LAND_PIN}: ${input.head}` : null,
						},
					});
					if (result.errors?.length) {
						const reason = result.errors[0]?.message;
						throw new PublicationBlocked(
							`GitHub refused to land the pull request${typeof reason === "string" && line(reason) ? `: ${line(reason)}` : "."}`,
						);
					}
				};
				try {
					await submit();
				} catch (error) {
					if (
						mutation !== "enablePullRequestAutoMerge" ||
						gated ||
						holds.queue ||
						!cleanAutoMergeRefusal(error instanceof Error ? error.message : null)
					)
						throw error;
					// The refusal can race GitHub computing UNKNOWN. Reread once, keeping the original head pinned.
					const fresh = await this.#holds(token, repo, pull);
					check(fresh);
					if (!immediateMerge(fresh.mergeState, fresh.queue) || (await this.#gated(token, repo, fresh.base)))
						throw error;
					mutation = "mergePullRequest";
					await submit();
				}
				await this.#invalidate(repo);
				return { merged: mutation === "mergePullRequest" };
			},
		);
	}
}

export type MergeMethod = "merge" | "squash" | "rebase";

/** The first merge method the repository allows: squash, then a merge commit, then rebase. */
function mergeMethod(current: Repository): MergeMethod {
	if (current.allow_squash_merge) return "squash";
	if (current.allow_merge_commit) return "merge";
	if (current.allow_rebase_merge) return "rebase";
	throw new GitHubError("The repository allows no merge method");
}

/** The check a base gated by `quest land` requires, and the commit body trailer that queues a head for it; see `quest land --help`. */
const LAND_CHECK = "quest land";
const LAND_PIN = "Quest-Land-Head";
const HOLDS = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) {
 id state baseRefName headRefOid mergeStateStatus isMergeQueueEnabled autoMergeRequest { enabledAt } mergeQueueEntry { state }
 labels(first: 100) { nodes { name } }
 timelineItems(last: 100, itemTypes: [LABELED_EVENT, AUTO_MERGE_ENABLED_EVENT, ADDED_TO_MERGE_QUEUE_EVENT]) { nodes { __typename
  ... on LabeledEvent { id label { name } } ... on AutoMergeEnabledEvent { id } ... on AddedToMergeQueueEvent { id } } } } } }`;
type HoldRow = {
	id: string;
	state: string;
	baseRefName: string;
	headRefOid: string;
	mergeStateStatus: string;
	isMergeQueueEnabled: boolean | null;
	autoMergeRequest: unknown;
	mergeQueueEntry: unknown;
	labels: { nodes: { name: string }[] };
	timelineItems: { nodes: { __typename: string; id: string; label?: { name: string } | null }[] };
};
type Holds = {
	id: string;
	state: string;
	base: string;
	head: string;
	mergeState: string;
	queue: boolean;
	/** Auto-merge is enabled or the pull request is in the merge queue. */
	landing: boolean;
	/** Its `quest:*` labels. */
	labels: string[];
	/** Oldest first; `label` is null for a landing that started. */
	events: { id: string; label: string | null }[];
};

function heldBy(label: string) {
	return `Another session holds this pull request with ${label}; pick it again once it is released`;
}

/** Untrusted GitHub text as one bounded line. */
function line(text: string) {
	return text
		.replace(/[\x00-\x1f\x7f]+/g, " ")
		.trim()
		.slice(0, 300);
}
