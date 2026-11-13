// A fake of the GitHub endpoints the land tests call, answering from an
// in-memory world. It never holds or forwards real credentials, and it refuses
// anything it does not model. Like GitHub, it scopes each installation token
// to the repositories and permissions it was minted for.
import { createHash } from "node:crypto";

export type User = { id: number; login: string; name: string; email: string };
/** A comment or review thread reply; a null author is a deleted account. */
export type Comment = { author: string | null; body: string; at: string };
export type Issue = {
	number: number;
	title: string;
	author: string;
	body?: string;
	comments?: Comment[];
	closed?: boolean;
	/** When GitHub last saw activity on it; a fixed past date when absent. */
	updatedAt?: string;
};
export type Thread = { path: string; line: number | null; resolved?: boolean; outdated?: boolean; comments: Comment[] };
export type Pull = Issue & {
	/** The PR base; retargeting changes its commit list, never the trusted default branch. */
	base?: string;
	/** Head branch; `quest/<path>` associates the pull request with that quest. */
	branch: string;
	checks: "SUCCESS" | "FAILURE" | "PENDING" | null;
	/** The check runs behind `checks`, oldest first. */
	/** `commit` is the one a run reports on; the head by default. */
	runs?: {
		name: string;
		conclusion: string;
		url: string;
		app?: number;
		context?: boolean;
		commit?: string;
		/** The check suite of the workflow run that reported it. */
		suite?: number;
	}[];
	review: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
	/** Oldest first; `commit` is the one a review was submitted on, the head by default. */
	reviews?: { state: string; author: string; body?: string; commit?: string }[];
	threads?: Thread[];
	draft?: boolean;
	/** Opened from this contributor's own fork, which the bot cannot update. */
	contributor?: string;
	/** The head's repository was deleted, so GitHub shows none. */
	headDeleted?: boolean;
	/** A `## Waiting` section in it hands a draft back to the maintainer. */
	body?: string;
	/** Who last edited the body; never edited when absent. */
	editor?: string;
	/** Closed by merging it; set with `closed`. */
	merged?: boolean;
	/** Optional squash result supplied by fixtures that model real git merges. */
	squash?: string;
	/** The commit a REST merge made. */
	mergeCommit?: string;
	/** REST mergeability can lag the base; fixtures can also model policy refusals. */
	mergeable?: boolean | null;
	mergeableState?: string;
	mergeRefusals?: { status: 405 | 409; message: string }[];
	/** The commit it ended at, when its branch has moved on since it closed; defaults to the branch's tip. */
	head?: string;
	/** GitHub's mergeStateStatus; only CLEAN merges. Defaults to BLOCKED, or DRAFT for a draft. */
	merge?: "CLEAN" | "BLOCKED" | "DIRTY" | "UNSTABLE" | "UNKNOWN";
	/** When it was opened, in milliseconds; defaults to the world's fixed update time. */
	createdAt?: number;
	labels?: string[];
	/** Timeline events that added a label, or with a null label enabled auto-merge, oldest first. */
	timeline?: { id: string; label: string | null }[];
	/** Auto-merge is enabled, so it lands once its requirements pass. */
	landing?: boolean;
	/** It is in its base's merge queue; only a base with `queue` takes it. */
	queued?: boolean;
	/** Its merge queue entry's state, `QUEUED` by default, and its merge group's check runs, while `queued`. */
	group?: { state: string; runs: NonNullable<Pull["runs"]> };
	/** The enabled auto-merge's time and commit body; `quest land` reads its queue from them. */
	autoMerge?: { enabledAt: string; commitBody: string };
	/** A fork's head branch accepts pushes from the upstream's maintainers. */
	maintainerCanModify?: boolean;
};
export type Commit = {
	parents: string[];
	tree: string;
	message: string;
	/** The account GitHub attributes the commit to; the App's bot for commits written through the API. */
	committer?: string;
	/** GitHub's authenticated signature result, independent of author identity. */
	signature?: { isValid: boolean; signer: { databaseId: number; login: string } | null } | null;
};
/** A tree written through the API: its base tree and the entries changed on it. */
export type Tree = { base: string; entries: unknown[] };
export type Repo = {
	id: number;
	owner: string;
	name: string;
	/** Logins with the maintain role; everyone else can only read. */
	maintainers: string[];
	/** Logins that can write without maintaining, whose approvals count as GitHub's writers' do. */
	writers?: string[];
	/**
	 * Roles by login, ahead of `maintainers` and `writers`, such as admin, triage, or a custom role.
	 * Null is someone without access, whose permission GitHub answers 404 for.
	 */
	roles?: Record<string, string | null>;
	/** Defaults to main. */
	defaultBranch?: string;
	private?: boolean;
	archived?: boolean;
	/** The SPDX ID of the license GitHub detects; MIT by default, none when null. */
	license?: string | null;
	/** The merge methods the repository allows; all of them by default. */
	mergeMethods?: ("merge" | "squash" | "rebase")[];
	/** The default branch's files. */
	files: { path: string; content: string }[];
	issues: Issue[];
	pulls: Pull[];
	/**
	 * Upstream branches and their commits. A pull request's branch that is not
	 * listed is at a commit derived from its number; a `quest/*` branch with no
	 * open pull request is a claim, unless it is still at a merged one's head.
	 * Listing the default branch moves it on from the commit of `files`.
	 */
	branches: Record<string, string>;
	/**
	 * Commits beyond the default branch's, including contributor-fork heads.
	 * The fake adds the default branch's commit and every branch tip it does not find here, as children of the default branch.
	 */
	commits: Record<string, Commit>;
	/** Trees written through the API. */
	trees: Record<string, Tree>;
	/** Check names the default branch's rulesets require. */
	required?: string[];
	/** The default branch has a merge queue, which takes a pull request only through `enqueuePullRequest` or auto-merge. */
	queue?: boolean;
	/** The default branch's other ruleset rules, as `GET /rules/branches/<default>` lists them. */
	rules?: Record<string, unknown>[];
	/** The default branch's classic protection, as `GET /branches/<default>/protection` returns it; none when absent. */
	protection?: Record<string, any>;
	/** Check runs the App wrote through `POST /check-runs`, oldest first; `status` is set while one is unfinished. */
	checkRuns?: {
		name: string;
		head_sha: string;
		conclusion?: string;
		status?: string;
		details_url?: string;
		app: number;
		output: Record<string, unknown>;
	}[];
	/** The check runs reported on commits that are no pull request's head, such as a queue build's. */
	commitRuns?: Record<string, NonNullable<Pull["runs"]>>;
	/** GitHub Actions workflow runs, as `GET /actions/runs` lists them, with their jobs and each job's log. */
	actionRuns?: {
		id: number;
		workflow_id?: number;
		check_suite_id?: number;
		run_started_at?: string;
		name: string;
		head_branch: string;
		head_sha: string;
		status: string;
		conclusion: string | null;
		html_url: string;
		jobs: {
			id: number;
			name: string;
			status: string;
			conclusion: string | null;
			html_url: string;
			steps?: { name: string; conclusion: string | null }[];
			log?: string;
		}[];
	}[];
	/** Rulesets by ID, as `GET /rulesets/<id>` shows them to the App. */
	rulesets?: Record<number, { current_user_can_bypass: "always" | "pull_requests_only" | "never" }>;
};
export type World = {
	app: { id: number; slug: string };
	/** The installation on the repositories' owner. */
	installation: number;
	/** The repositories' owner's GitHub ID, which the local server admits to enroll. */
	owner: number;
	users: User[];
	repos: Repo[];
};

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");
/** The Git object ID of a file's content. */
export const blob = (content: string | Uint8Array) => {
	const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
	return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
};
/** The default branch's first commit, whose tree is `files`. Objects derive from the ID, which a rename keeps. */
export const commitOf = (repo: Repo) => sha1(`commit ${repo.id}`);
const treeOf = (repo: Repo) => sha1(`tree ${repo.id}`);
const defaultOf = (repo: Repo) => repo.defaultBranch ?? "main";
const methodsOf = (repo: Repo) => repo.mergeMethods ?? ["merge", "squash", "rebase"];
/** The default branch's commit. */
const tipOf = (repo: Repo) => repo.branches[defaultOf(repo)] ?? commitOf(repo);
/** A login's role: its listed one, else maintain or write as `maintainers` and `writers` say, else read. */
const roleOf = (repo: Repo, login: string) =>
	repo.roles && login in repo.roles
		? repo.roles[login]!
		: repo.maintainers.includes(login)
			? "maintain"
			: repo.writers?.includes(login)
				? "write"
				: "read";
/** A pull request's head commit: the one it ended at, or its branch's tip where the world lists one. */
export const headOf = (repo: Repo, pull: Pull) =>
	pull.head ?? (pull.contributor ? {} : repo.branches)[pull.branch] ?? sha1(`head ${repo.id}#${pull.number}`);
// GitHub's database IDs differ from numbers; derive stable ones per repository.
export const databaseId = (repo: Repo, number: number) => String(repo.id * 1000 + number);
const updatedAt = "2026-10-20T12:00:00Z";
const nodeId = (repo: Repo, pull: Pull) => `PR_${databaseId(repo, pull.number)}`;
// The open pull requests whose branch is on the upstream itself.
const upstreamPulls = (repo: Repo) => repo.pulls.filter((pull) => !pull.closed && !pull.contributor);

const mergeState = (pull: Pull) => pull.merge ?? (pull.draft ? "DRAFT" : "BLOCKED");

const actor = (login: string) => ({ __typename: login.endsWith("[bot]") ? "Bot" : "User", login });

const page = <T>(nodes: T[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });

/** The repository holding a pull request's head branch, as `owner/name`. */
const holderOf = (repo: Repo, pull: Pull) => `${pull.contributor ?? repo.owner}/${repo.name}`;

/** A pull request as `quest land` reads its queue: auto-merge, head, reviews, and checks. */
function queueTarget(repo: Repo, pull: Pull) {
	return {
		id: nodeId(repo, pull),
		number: pull.number,
		url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
		title: pull.title,
		isDraft: !!pull.draft,
		headRefName: pull.branch,
		headRefOid: headOf(repo, pull),
		maintainerCanModify: !!pull.maintainerCanModify,
		reviewDecision: pull.review,
		headRepository: { nameWithOwner: holderOf(repo, pull) },
		autoMergeRequest: pull.landing
			? { enabledAt: pull.autoMerge?.enabledAt ?? updatedAt, commitBody: pull.autoMerge?.commitBody ?? "" }
			: null,
		commits: {
			nodes: [
				{
					commit: {
						oid: headOf(repo, pull),
						statusCheckRollup: pull.checks && { contexts: contextPage(pull, null) },
					},
				},
			],
		},
	};
}

/** The fake's GitHub Actions app, which reports a run unless it names another. */
export const ACTIONS_APP = 15368;

/** One page of a head's check runs and commit statuses, as `statusCheckRollup.contexts` pages them. */
function contextPage(pull: Pick<Pull, "runs">, after: unknown) {
	const start = typeof after === "string" ? Number(after) : 0;
	const all = (pull.runs ?? []).map((run, index) =>
		run.context
			? { __typename: "StatusContext", context: run.name, state: run.conclusion, targetUrl: run.url }
			: {
					__typename: "CheckRun",
					// GitHub numbers runs as they are created.
					databaseId: index + 1,
					name: run.name,
					status: "COMPLETED",
					conclusion: run.conclusion,
					detailsUrl: run.url,
					checkSuite: { databaseId: run.suite ?? null, app: { databaseId: run.app ?? ACTIONS_APP } },
				},
	);
	const end = start + 100;
	return {
		nodes: all.slice(start, end),
		pageInfo: { hasNextPage: end < all.length, endCursor: end < all.length ? String(end) : null },
	};
}

function graphql(repo: Repo, query: string, variables: Record<string, unknown>) {
	if (query.includes("object(oid: $oid)")) {
		const runs = repo.commitRuns?.[variables.oid as string];
		if (runs)
			return {
				data: {
					repository: { object: { statusCheckRollup: { contexts: contextPage({ runs }, variables.after) } } },
				},
			};
		const pull = repo.pulls.find(
			(p) => headOf(repo, p) === variables.oid || p.autoMerge?.commitBody === `Quest-Land-Head: ${variables.oid}`,
		);
		return {
			data: {
				repository: {
					object: pull
						? { statusCheckRollup: pull.checks && { contexts: contextPage(pull, variables.after) } }
						: null,
				},
			},
		};
	}
	if (query.includes("queue:pullRequests(")) {
		const queued = repo.pulls.filter((pull) => !pull.closed && variables.base === defaultOf(repo));
		return {
			data: {
				repository: {
					ref:
						variables.qualified === `refs/heads/${defaultOf(repo)}`
							? { target: { oid: tipOf(repo) } }
							: null,
					queue: page(queued.map((pull) => queueTarget(repo, pull))),
				},
			},
		};
	}
	// Anything else reads as a repository with none of the fields asked for.
	return { data: { repository: {} } };
}

function tree(repo: Repo) {
	const dirs = new Set<string>();
	for (const file of repo.files) {
		const parts = file.path.split("/");
		for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
	}
	return {
		sha: treeOf(repo),
		truncated: false,
		tree: [
			...[...dirs].map((path) => ({ path, type: "tree", mode: "040000", sha: sha1(`dir ${path}`) })),
			...repo.files.map((file) => ({ path: file.path, type: "blob", mode: "100644", sha: blob(file.content) })),
		],
	};
}

/** Give the default branch's commit, and every branch tip the world names without one, a commit. */
function connect(repo: Repo) {
	const main = commitOf(repo);
	repo.commits[main] ??= { parents: [], tree: treeOf(repo), message: "Initial commit" };
	const tips = [...Object.values(repo.branches), ...repo.pulls.map((pull) => headOf(repo, pull))];
	for (const tip of tips) repo.commits[tip] ??= { parents: [main], tree: treeOf(repo), message: "Work" };
}

/** A tree's files and their blob IDs: `files` for the first commit's, then each written tree's changes. */
function filesOf(repo: Repo, sha: string): Record<string, string> {
	if (sha === treeOf(repo)) return Object.fromEntries(repo.files.map((f) => [f.path, blob(f.content)]));
	const written = repo.trees[sha];
	if (!written) return {};
	const files = filesOf(repo, written.base);
	for (const entry of written.entries as { path: string; sha?: string | null; content?: string }[])
		if (entry.sha === null) delete files[entry.path];
		else files[entry.path] = entry.sha ?? blob(entry.content ?? "");
	return files;
}

type Permission =
	| "metadata"
	| "contents"
	| "issues"
	| "pull_requests"
	| "checks"
	| "statuses"
	| "administration"
	| "secrets"
	| "actions"
	| "environments";
/** What an installation token may do: the repositories (`owner/name`) and permissions it was minted for. */
type Grant = { repositories: Set<string>; permissions: Partial<Record<Permission, string>> };

/**
 * Answer one outbound request to GitHub's API from the world's repositories,
 * scoping each read and write to the repositories and permissions of the
 * installation token it carries.
 */
export function fakeGitHub(world: World) {
	for (const repo of world.repos) connect(repo);
	const grants = new Map<string, Grant>();
	let minted = 0;
	let events = 0;
	const nextEvent = () => ++events;
	const json = (body: unknown, status = 200) => Response.json(body, { status });
	const notFound = () => json({ message: "Not Found" }, 404);
	const missing = (method: string, url: string) => {
		console.warn(`fake GitHub: no model for ${method} ${url}`);
		return json({ message: "Not modeled by the fake GitHub" }, 501);
	};
	// A contributor's fork is readable as a PR head, but has no App installation.
	const headRepo = (repo: Repo, pull: Pull) =>
		pull.contributor
			? { id: repo.id * 10 + 1, name: repo.name, owner: { login: pull.contributor } }
			: { id: repo.id, name: repo.name, owner: { login: repo.owner } };
	const restPull = (repo: Repo, pull: Pull) => ({
		number: pull.number,
		node_id: nodeId(repo, pull),
		html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
		state: pull.closed ? "closed" : "open",
		merged: pull.merged ?? false,
		merge_commit_sha: pull.mergeCommit ?? null,
		mergeable: pull.mergeable !== undefined ? pull.mergeable : pull.merge !== "DIRTY",
		mergeable_state: pull.mergeableState ?? (pull.merge === "DIRTY" ? "dirty" : "clean"),
		title: pull.title,
		body: pull.body ?? "",
		labels: (pull.labels ?? []).map((name) => ({ name })),
		draft: !!pull.draft,
		user: { login: pull.author },
		created_at: new Date(pull.createdAt ?? Date.parse(updatedAt)).toISOString(),
		base: { ref: pull.base ?? defaultOf(repo) },
		head: { ref: pull.branch, sha: headOf(repo, pull), repo: headRepo(repo, pull) },
	});

	const restRepo = (repo: Repo) => ({
		id: repo.id,
		name: repo.name,
		owner: { login: repo.owner, id: world.owner },
		private: !!repo.private,
		visibility: repo.private ? "private" : "public",
		default_branch: defaultOf(repo),
		archived: !!repo.archived,
		disabled: false,
		license: repo.license === null ? null : { spdx_id: repo.license ?? "MIT" },
		allow_squash_merge: methodsOf(repo).includes("squash"),
		allow_merge_commit: methodsOf(repo).includes("merge"),
		allow_rebase_merge: methodsOf(repo).includes("rebase"),
		allow_auto_merge: true,
	});

	/** The repositories an installation token may name, by `owner/name`. */
	function grant(installation: number, input: { repository_ids?: number[]; repositories?: string[] }) {
		if (installation !== world.installation) return null;
		const names = (input.repositories ?? []).map((name) => {
			const repo = world.repos.find((r) => r.name === name);
			return repo && `${repo.owner}/${repo.name}`;
		});
		const ids = (input.repository_ids ?? []).map((id) => {
			const repo = world.repos.find((r) => r.id === id);
			return repo && `${repo.owner}/${repo.name}`;
		});
		const all = [...names, ...ids];
		return all.length && all.every(Boolean) ? new Set(all as string[]) : null;
	}

	return async function (this: unknown, input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
		// Called like fetch, with the runtime's checks: workerd's fetch throws when
		// called as another object's method, and building the Request validates
		// RequestInit as the real fetch does, refusing `redirect: "error"`.
		if (this !== undefined && this !== globalThis)
			throw new TypeError("Illegal invocation: fetch called as a method");
		const request = new Request(input, init);
		const url = new URL(request.url);
		const method = request.method;
		const path = url.pathname;
		if (url.origin !== "https://api.github.com") return missing(method, request.url);
		const text = await request.text();
		const body = text ? (JSON.parse(text) as Record<string, any>) : {};

		const token = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
		// The App authenticates as itself with a JWT, and as an installation with a token minted from it.
		const app = token.split(".").length === 3;
		const unauthorized = () => json({ message: "Bad credentials" }, 401);
		if (path === "/app") return app ? json({ id: world.app.id, slug: world.app.slug }) : unauthorized();
		const mint = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
		if (mint && method === "POST") {
			if (!app) return unauthorized();
			const repositories = grant(Number(mint[1]), body);
			if (!repositories) return json({ message: "Repository not in this installation" }, 422);
			const minted_token = `fake-installation-token-${++minted}`;
			grants.set(minted_token, { repositories, permissions: body.permissions ?? {} });
			return json({ token: minted_token, permissions: body.permissions }, 201);
		}
		const scope = grants.get(token);
		if (path === "/installation/token" && method === "DELETE") {
			if (!scope) return unauthorized();
			grants.delete(token);
			return new Response(null, { status: 204 });
		}
		const match = path.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
		const fullName = match && `${match[1]}/${match[2]}`;
		const tail = match?.[3] ?? "";
		const repo = match && world.repos.find((r) => r.owner === match[1] && r.name === match[2]);
		if (match && tail === "/installation") {
			if (!app) return unauthorized();
			if (!repo) return notFound();
			const permissions = {
				...Object.fromEntries(
					["metadata", "contents", "issues", "pull_requests", "checks", "statuses"].map((p) => [p, "write"]),
				),
				...Object.fromEntries(["administration", "secrets", "actions", "environments"].map((p) => [p, "read"])),
			};
			return json({ id: world.installation, app_id: world.app.id, suspended_at: null, permissions });
		}
		if (!scope) return unauthorized();
		// An installation token reaches only its repositories, and writes only what it was granted.
		const writes = (permission: Permission) => scope.permissions[permission] === "write";
		const forbidden = () => json({ message: "Resource not accessible by integration" }, 403);

		const user = path.match(/^\/user\/(\d+)$/);
		if (user) {
			const found = world.users.find((u) => String(u.id) === user[1]);
			return found ? json({ id: found.id, login: found.login }) : notFound();
		}
		if (path === "/graphql") {
			const { query, variables } = body as { query: string; variables: Record<string, any> };
			if (query.includes("viewer { login }"))
				return json({ data: { viewer: { login: `${world.app.slug}[bot]` } } });
			if (query.includes("markPullRequestReadyForReview")) {
				for (const repo of world.repos)
					for (const pull of repo.pulls)
						if (nodeId(repo, pull) === variables.id) {
							if (!scope.repositories.has(`${repo.owner}/${repo.name}`) || !writes("pull_requests"))
								return json({ errors: [{ type: "FORBIDDEN" }] });
							pull.draft = false;
							return json({ data: { markPullRequestReadyForReview: { clientMutationId: null } } });
						}
				return json({ errors: [{ type: "NOT_FOUND" }] });
			}
			// A pull request by node ID, or turning its auto-merge off.
			if (query.includes("node(id:") || query.includes("disablePullRequestAutoMerge(")) {
				for (const repo of world.repos)
					for (const pull of repo.pulls)
						if (nodeId(repo, pull) === variables.id) {
							if (!scope.repositories.has(`${repo.owner}/${repo.name}`))
								return json({ errors: [{ type: "NOT_FOUND" }] });
							if (query.includes("node(id:"))
								return json({
									data: {
										node: {
											state: pull.merged ? "MERGED" : pull.closed ? "CLOSED" : "OPEN",
											baseRefName: pull.base ?? defaultOf(repo),
											headRefOid: headOf(repo, pull),
											mergeStateStatus: mergeState(pull),
											mergeQueueEntry: pull.queued ? { enqueuedAt: updatedAt } : null,
											labels: { nodes: (pull.labels ?? []).map((name) => ({ name })) },
											headRepository: pull.headDeleted
												? null
												: { nameWithOwner: holderOf(repo, pull) },
											autoMergeRequest: pull.landing
												? { enabledAt: pull.autoMerge?.enabledAt ?? updatedAt }
												: null,
											reviewThreads: page(
												(pull.threads ?? []).map((thread) => ({
													isResolved: !!thread.resolved,
												})),
											),
										},
									},
								});
							if (!writes("pull_requests")) return json({ errors: [{ type: "FORBIDDEN" }] });
							// GitHub refuses a merged or closed PR's, though it still reports its auto-merge request.
							if (pull.merged || pull.closed)
								return json({
									errors: [{ message: "Can't disable auto-merge for this pull request." }],
								});
							if (!pull.landing)
								return json({
									errors: [{ message: "Auto-merge is not enabled for this pull request" }],
								});
							pull.landing = false;
							delete pull.autoMerge;
							return json({ data: { disablePullRequestAutoMerge: { clientMutationId: null } } });
						}
				return json({ errors: [{ type: "NOT_FOUND" }] });
			}
			const landing = query.match(/\b(enablePullRequestAutoMerge|mergePullRequest|enqueuePullRequest)\(/)?.[1];
			if (landing) {
				for (const repo of world.repos)
					for (const pull of repo.pulls)
						if (nodeId(repo, pull) === variables.id) {
							if (
								!scope.repositories.has(`${repo.owner}/${repo.name}`) ||
								!writes("contents") ||
								!writes("pull_requests")
							)
								return json({ errors: [{ type: "FORBIDDEN" }] });
							if (pull.closed) return json({ errors: [{ message: "Pull request is closed" }] });
							if (variables.sha !== headOf(repo, pull))
								return json({ errors: [{ message: "Head sha didn't match expected head" }] });
							const ready = ["CLEAN", "HAS_HOOKS", "UNSTABLE"].includes(mergeState(pull));
							if (landing === "enqueuePullRequest") {
								if (!repo.queue)
									return json({
										errors: [{ message: "Merge queue is not enabled for this branch" }],
									});
								if (pull.queued)
									return json({
										errors: [{ message: "Pull request is already in the merge queue" }],
									});
								if (!ready) return json({ errors: [{ message: "Pull request is not mergeable" }] });
								pull.queued = true;
							} else if (landing === "mergePullRequest") {
								if (!ready) return json({ errors: [{ message: "Pull Request is not mergeable" }] });
								pull.closed = pull.merged = true;
							} else {
								// A merge queue takes a ready pull request only through enqueueing it.
								if (repo.queue && ready)
									return json({ errors: [{ message: "Pull request is in clean status" }] });
								pull.landing = true;
								pull.autoMerge = {
									enabledAt: new Date().toISOString(),
									commitBody: typeof variables.body === "string" ? variables.body : "",
								};
								pull.timeline = [...(pull.timeline ?? []), { id: `AME_${nextEvent()}`, label: null }];
							}
							return json({ data: { [landing]: { clientMutationId: null } } });
						}
				return json({ errors: [{ type: "NOT_FOUND" }] });
			}
			const repo = world.repos.find((r) => r.owner === variables.owner && r.name === variables.name);
			if (!repo || !scope.repositories.has(`${repo.owner}/${repo.name}`))
				return json({ errors: [{ type: "NOT_FOUND", message: "Not Found" }] });
			return json(graphql(repo, query, variables));
		}
		if (!repo || !scope.repositories.has(fullName!)) return notFound();

		if (tail === "") return json(restRepo(repo));
		const permission = tail.match(/^\/collaborators\/([^/]+)\/permission$/);
		if (permission) {
			const found = world.users.find((u) => u.login === permission[1]);
			const role = found && roleOf(repo, found.login);
			if (!found || !role) return notFound();
			// The legacy permission is the base role's; a custom role's is read here.
			const legacy = role === "admin" ? "admin" : ["maintain", "write"].includes(role) ? "write" : "read";
			return json({ user: { id: found.id }, permission: legacy, role_name: role });
		}
		const listed = tail.match(/^\/commits\/([0-9a-f]{40})$/)?.[1];
		if (listed && method === "GET") {
			const found = repo.commits[listed];
			if (!found) return notFound();
			return json({
				sha: listed,
				committer: found.committer ? { login: found.committer, type: actor(found.committer).__typename } : null,
			});
		}
		const trunk = `/${encodeURIComponent(defaultOf(repo))}`;
		if (tail === `/commits${trunk}`)
			return json({ sha: tipOf(repo), commit: { tree: { sha: repo.commits[tipOf(repo)]!.tree } } });
		// Read access sees whether classic protection is on and its required checks; the rest needs administration.
		if (tail === `/branches${trunk}` && method === "GET") {
			const checks = repo.protection?.required_status_checks;
			return json({
				name: defaultOf(repo),
				protection: repo.protection
					? {
							enabled: true,
							required_status_checks: {
								enforcement_level: checks ? "non_admins" : "off",
								contexts: checks?.contexts ?? [],
								checks: checks?.checks ?? [],
							},
						}
					: { enabled: false },
			});
		}
		if (tail === `/branches${trunk}/protection` && method === "GET") {
			if (!scope.permissions.administration) return forbidden();
			return repo.protection ? json(repo.protection) : json({ message: "Branch not protected" }, 404);
		}
		// The setup page's CI check finds read-only pull-request CI: a read-only
		// default token, no secrets, and no environments.
		if (tail === "/actions/permissions/workflow" && method === "GET")
			return scope.permissions.administration
				? json({ default_workflow_permissions: "read", can_approve_pull_request_reviews: false })
				: forbidden();
		if ((tail === "/actions/secrets" || tail === "/actions/organization-secrets") && method === "GET")
			return scope.permissions.secrets ? json({ total_count: 0, secrets: [] }) : forbidden();
		if (tail === "/environments" && method === "GET")
			return scope.permissions.actions ? json({ total_count: 0, environments: [] }) : forbidden();
		const ruleset = tail.match(/^\/rulesets\/(\d+)$/);
		if (ruleset && method === "GET") {
			const found = repo.rulesets?.[Number(ruleset[1])];
			return found ? json({ id: Number(ruleset[1]), ...found }) : notFound();
		}
		const statuses = ["queued", "in_progress", "completed"];
		if (tail === "/check-runs" && method === "POST") {
			if (!writes("checks")) return forbidden();
			const known =
				typeof body.head_sha === "string" &&
				(repo.commits[body.head_sha] || repo.pulls.some((pull) => headOf(repo, pull) === body.head_sha));
			if (!statuses.includes(body.status) || (body.status === "completed") !== !!body.conclusion || !known)
				return json({ message: "Validation Failed" }, 422);
			(repo.checkRuns ??= []).push({
				name: body.name,
				head_sha: body.head_sha,
				conclusion: body.conclusion,
				status: body.status === "completed" ? undefined : body.status,
				details_url: body.details_url,
				app: world.app.id,
				output: body.output,
			});
			return json({ id: repo.checkRuns.length, name: body.name, head_sha: body.head_sha }, 201);
		}
		const checkRun = tail.match(/^\/check-runs\/(\d+)$/);
		if (checkRun && method === "PATCH") {
			if (!writes("checks")) return forbidden();
			const run = repo.checkRuns?.[Number(checkRun[1]) - 1];
			if (!run) return notFound();
			if (!statuses.includes(body.status) || (body.status === "completed") !== !!body.conclusion)
				return json({ message: "Validation Failed" }, 422);
			Object.assign(run, {
				conclusion: body.conclusion,
				status: body.status === "completed" ? undefined : body.status,
				details_url: body.details_url ?? run.details_url,
				output: body.output,
			});
			return json({ id: Number(checkRun[1]), name: run.name, head_sha: run.head_sha });
		}
		if (tail === "/actions/runs" && method === "GET") {
			if (!scope.permissions.actions) return forbidden();
			const sha = url.searchParams.get("head_sha");
			const branch = url.searchParams.get("branch");
			const workflow_runs = (repo.actionRuns ?? [])
				.filter((run) => (!sha || run.head_sha === sha) && (!branch || run.head_branch === branch))
				.map(({ jobs: _, ...run }) => run);
			return json({ total_count: workflow_runs.length, workflow_runs });
		}
		const actionRun = tail.match(/^\/actions\/runs\/(\d+)\/(jobs|cancel)$/);
		if (actionRun) {
			const run = repo.actionRuns?.find((item) => item.id === Number(actionRun[1]));
			if (!run) return notFound();
			if (actionRun[2] === "jobs" && method === "GET")
				return scope.permissions.actions
					? json({ total_count: run.jobs.length, jobs: run.jobs.map(({ log: _, ...job }) => job) })
					: forbidden();
			if (actionRun[2] === "cancel" && method === "POST") {
				if (!writes("actions")) return forbidden();
				if (run.status === "completed")
					return json({ message: "Cannot cancel a workflow run that is completed." }, 409);
				run.status = "completed";
				run.conclusion = "cancelled";
				return json({}, 202);
			}
		}
		const jobLog = tail.match(/^\/actions\/jobs\/(\d+)\/logs$/);
		if (jobLog && method === "GET") {
			if (!scope.permissions.actions) return forbidden();
			const job = (repo.actionRuns ?? [])
				.flatMap((run) => run.jobs)
				.find((item) => item.id === Number(jobLog[1]));
			return job?.log === undefined ? notFound() : new Response(job.log);
		}
		const runs = tail.match(/^\/commits\/([0-9a-f]{40})\/check-runs$/);
		if (runs && method === "GET") {
			if (!scope.permissions.checks) return forbidden();
			const name = url.searchParams.get("check_name");
			const app = url.searchParams.get("app_id");
			const found = repo.pulls.flatMap((pull) =>
				(pull.runs ?? [])
					.filter((run) => !run.context && (run.commit ?? headOf(repo, pull)) === runs[1])
					.map((run) => ({
						name: run.name,
						head_sha: runs[1],
						status: "completed",
						conclusion: run.conclusion.toLowerCase(),
						app: { id: run.app ?? ACTIONS_APP },
					})),
			);
			// The App's own runs, newest first as `filter=latest` keeps one per name.
			const written = (repo.checkRuns ?? [])
				.filter((run) => run.head_sha === runs[1])
				.reverse()
				.filter((run, i, all) => all.findIndex((other) => other.name === run.name) === i)
				.map((run) => ({ ...run, status: run.status ?? "completed", app: { id: run.app } }));
			const check_runs = [...written, ...found].filter(
				(run) => (!name || run.name === name) && (!app || String(run.app.id) === app),
			);
			return json({ total_count: check_runs.length, check_runs });
		}
		if (tail === `/rules/branches${trunk}` && method === "GET") {
			const contexts = (repo.required ?? []).map((context) => ({ context }));
			return json([
				...(contexts.length
					? [{ type: "required_status_checks", parameters: { required_status_checks: contexts } }]
					: []),
				...(repo.rules ?? []),
			]);
		}
		if (tail.startsWith(`/git/trees/${treeOf(repo)}`) && method === "GET") return json(tree(repo));
		// Upstream branches: those the world lists, and those of its pull requests that are not on a fork.
		const branches = {
			get: (name: string) => {
				const pull = upstreamPulls(repo).find((p) => p.branch === name);
				return repo.branches[name] ?? (pull ? headOf(repo, pull) : null);
			},
			set: (name: string, sha: string) => (repo.branches[name] = sha),
			delete: (name: string) => delete repo.branches[name],
		};
		const git = gitData(repo, branches, tail, method, body, writes);
		if (git) return git;
		if (tail === "/pulls" && method === "GET") {
			const head = url.searchParams.get("head");
			const state = url.searchParams.get("state") ?? "open";
			const found = repo.pulls.filter((pull) => {
				const owner = headRepo(repo, pull).owner.login;
				return (
					(state === "all" || state === (pull.closed ? "closed" : "open")) &&
					`${owner}:${pull.branch}` === head
				);
			});
			// Newest first, as GitHub lists them.
			return json(found.reverse().map((pull) => restPull(repo, pull)));
		}
		if (tail === "/issues" && method === "POST") {
			if (!writes("issues")) return forbidden();
			const issue: Issue = {
				number: Math.max(0, ...repo.issues.map((i) => i.number), ...repo.pulls.map((p) => p.number)) + 1,
				title: String(body.title),
				author: `${world.app.slug}[bot]`,
				body: typeof body.body === "string" ? body.body : undefined,
			};
			repo.issues.push(issue);
			return json({ number: issue.number, title: issue.title, state: "open" }, 201);
		}
		if (tail === "/pulls" && method === "POST") {
			if (!writes("pull_requests")) return forbidden();
			const [prefix, qualified] = String(body.head).split(":");
			const owner = qualified === undefined ? repo.owner : prefix;
			const branch = qualified ?? prefix;
			if (owner !== repo.owner || !branch || body.base !== defaultOf(repo) || !branches.get(branch))
				return json({ message: "Validation Failed: head is invalid" }, 422);
			if (repo.pulls.some((pull) => !pull.closed && !pull.contributor && pull.branch === branch))
				return json({ message: `A pull request already exists for ${body.head}.` }, 422);
			const pull: Pull = {
				number: Math.max(0, ...repo.issues.map((i) => i.number), ...repo.pulls.map((p) => p.number)) + 1,
				title: body.title,
				author: `${world.app.slug}[bot]`,
				body: body.body,
				branch,
				draft: !!body.draft,
				checks: null,
				review: null,
				createdAt: Date.now(),
			};
			repo.pulls.push(pull);
			return json(restPull(repo, pull), 201);
		}
		const item = tail.match(/^\/(issues|pulls)\/(\d+)$/);
		if (item) {
			const list: Issue[] = item[1] === "pulls" ? repo.pulls : repo.issues;
			const found = list.find((i) => String(i.number) === item[2]);
			if (!found) return notFound();
			if (item[1] === "issues") {
				if (method === "PATCH") {
					if (!writes("issues")) return forbidden();
					if (body.state === "closed") found.closed = true;
				}
				return json({ number: found.number, title: found.title, state: found.closed ? "closed" : "open" });
			}
			const pull = found as Pull;
			if (method === "PATCH") {
				if (!writes("pull_requests")) return forbidden();
				if (typeof body.title === "string") pull.title = body.title;
				if (typeof body.body === "string") pull.body = body.body;
				if (body.state === "closed") {
					pull.closed = true;
					pull.landing = pull.queued = false;
					pull.autoMerge = undefined;
				}
			}
			return json(restPull(repo, pull));
		}
		// The files a pull request changes against its base's tip, one page of up to 100.
		const changed = tail.match(/^\/pulls\/(\d+)\/files$/);
		if (changed && method === "GET") {
			const pull = repo.pulls.find((p) => String(p.number) === changed[1]);
			if (!pull) return notFound();
			const tree = (sha: string | undefined) => (sha ? filesOf(repo, repo.commits[sha]?.tree ?? "") : {});
			const before = tree(repo.branches[pull.base ?? defaultOf(repo)]);
			const after = tree(headOf(repo, pull));
			const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])]
				.filter((path) => before[path] !== after[path])
				.sort();
			const at = Number(url.searchParams.get("page") ?? 1);
			const size = Number(url.searchParams.get("per_page") ?? 30);
			return json(paths.slice((at - 1) * size, at * size).map((filename) => ({ filename })));
		}
		const merge = tail.match(/^\/pulls\/(\d+)\/merge$/);
		if (merge && method === "PUT") {
			if (!writes("contents")) return forbidden();
			const pull = repo.pulls.find((p) => String(p.number) === merge[1]);
			if (!pull) return notFound();
			if (pull.closed) return json({ message: "Pull Request is not open" }, 405);
			const refused = pull.mergeRefusals?.shift();
			if (refused) return json({ message: refused.message }, refused.status);
			if (body.sha !== headOf(repo, pull)) return json({ message: "Head branch was modified" }, 409);
			const methods = { merge: "Merge commits", squash: "Squash merges", rebase: "Rebase merges" } as const;
			const merging = (body.merge_method ?? "merge") as keyof typeof methods;
			if (!methodsOf(repo).includes(merging))
				return json({ message: `${methods[merging]} are not allowed on this repository.` }, 405);
			if (pull.merge !== "CLEAN") return json({ message: "Pull Request is not mergeable" }, 405);
			pull.closed = true;
			pull.merged = true;
			pull.landing = pull.queued = false;
			pull.autoMerge = undefined;
			if (pull.squash) repo.branches[pull.base ?? defaultOf(repo)] = pull.squash;
			pull.mergeCommit = pull.squash ?? commitOf(repo);
			return json({
				sha: pull.mergeCommit,
				merged: true,
				message: "Pull Request successfully merged",
			});
		}
		// Every issue and pull request comment, oldest first, updated at or after `since`.
		if (tail === "/issues/comments" && method === "GET") {
			if (!scope.permissions.issues && !scope.permissions.pull_requests) return forbidden();
			const since = Date.parse(url.searchParams.get("since") ?? "1970-01-01T00:00:00Z");
			const page = Number(url.searchParams.get("page") ?? 1);
			const size = Number(url.searchParams.get("per_page") ?? 30);
			const all = [...repo.pulls, ...repo.issues]
				.flatMap((item) =>
					(item.comments ?? []).map((c, i) => ({
						id: item.number * 1000 + i,
						html_url: `https://github.com/${fullName}/pull/${item.number}#issuecomment-${item.number * 1000 + i}`,
						issue_url: `https://api.github.com/repos/${fullName}/issues/${item.number}`,
						body: c.body,
						created_at: c.at,
						updated_at: c.at,
						user: c.author && { login: c.author, type: c.author.endsWith("[bot]") ? "Bot" : "User" },
						author_association:
							c.author && ["admin", "maintain", "write"].includes(roleOf(repo, c.author) ?? "")
								? "COLLABORATOR"
								: "NONE",
					})),
				)
				.filter((c) => Date.parse(c.created_at) >= since)
				.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
			return json(all.slice((page - 1) * size, page * size));
		}
		const comment = tail.match(/^\/issues\/(\d+)\/comments$/);
		if (comment && method === "GET") {
			const item = [...repo.pulls, ...repo.issues].find((i) => String(i.number) === comment[1]);
			if (!item) return notFound();
			const bot = `${world.app.slug}[bot]`;
			const page = Number(url.searchParams.get("page") ?? 1);
			const size = Number(url.searchParams.get("per_page") ?? 30);
			return json(
				(item.comments ?? [])
					.map((c, i) => ({
						id: item.number * 1000 + i,
						body: c.body,
						user: { login: c.author },
						performed_via_github_app: c.author === bot ? { id: world.app.id } : null,
					}))
					.slice((page - 1) * size, page * size),
			);
		}
		const edited = tail.match(/^\/issues\/comments\/(\d+)$/);
		if (edited && method === "PATCH") {
			if (!writes("issues") && !writes("pull_requests")) return forbidden();
			const id = Number(edited[1]);
			const item = [...repo.pulls, ...repo.issues].find((i) => i.number === Math.floor(id / 1000));
			const found = item?.comments?.[id % 1000];
			if (!found || found.author !== `${world.app.slug}[bot]`) return notFound();
			found.body = String(body.body);
			return json({ id, body: found.body });
		}
		if (comment && method === "POST") {
			if (!writes("issues") && !writes("pull_requests")) return forbidden();
			const item = [...repo.pulls, ...repo.issues].find((i) => String(i.number) === comment[1]);
			if (!item) return notFound();
			const added: Comment = {
				author: `${world.app.slug}[bot]`,
				body: String(body.body),
				at: new Date().toISOString(),
			};
			item.comments = [...(item.comments ?? []), added];
			return json({ body: added.body, user: { login: added.author } }, 201);
		}
		const labels = tail.match(/^\/issues\/(\d+)\/labels(?:\/([^/]+))?$/);
		if (labels && (method === "POST" || method === "DELETE")) {
			if (!writes("issues")) return forbidden();
			const pull = repo.pulls.find((p) => String(p.number) === labels[1]);
			if (!pull) return notFound();
			const current = pull.labels ?? [];
			if (method === "POST" && !labels[2]) {
				for (const name of body.labels as string[]) {
					if (!current.includes(name)) current.push(name);
					pull.timeline = [...(pull.timeline ?? []), { id: `LE_${nextEvent()}`, label: name }];
				}
				pull.labels = current;
				return json(current.map((name) => ({ name })));
			}
			const name = labels[2] && decodeURIComponent(labels[2]);
			if (method !== "DELETE" || !name) return missing(method, request.url);
			if (!current.includes(name)) return json({ message: "Label does not exist" }, 404);
			pull.labels = current.filter((label) => label !== name);
			return json(pull.labels.map((label) => ({ name: label })));
		}
		const compare = tail.match(/^\/compare\/([0-9a-f]{40})\.\.\.([^/]+)$/);
		if (compare && method === "GET") {
			const from = compare[1]!;
			const base = compare[2] === encodeURIComponent(defaultOf(repo)) ? tipOf(repo) : compare[2]!;
			if (!repo.commits[from] || !repo.commits[base]) return notFound();
			const ancestors = (tip: string, seen = new Set<string>()): Set<string> => {
				if (seen.has(tip)) return seen;
				seen.add(tip);
				for (const parent of repo.commits[tip]?.parents ?? []) ancestors(parent, seen);
				return seen;
			};
			const reaches = (sha: string, target: string) => ancestors(sha).has(target);
			const status =
				from === base
					? "identical"
					: reaches(base, from)
						? "ahead"
						: reaches(from, base)
							? "behind"
							: "diverged";
			// The nearest common ancestor: one no other common ancestor descends from.
			const common = [...ancestors(from)].filter((sha) => ancestors(base).has(sha));
			const nearest = common.find((sha) => !common.some((other) => other !== sha && reaches(other, sha)));
			return json({ status, merge_base_commit: nearest ? { sha: nearest } : null });
		}
		if (tail === "/contents/.github" && method === "GET") {
			const tree = repo.commits[url.searchParams.get("ref") ?? ""]?.tree;
			const files = Object.entries(tree ? filesOf(repo, tree) : {})
				.filter(([path]) => path.startsWith(".github/workflows/"))
				.sort();
			if (!files.length) return notFound();
			const sha = sha1(`workflows ${JSON.stringify(files)}`);
			return json([{ name: "workflows", path: ".github/workflows", type: "dir", sha }]);
		}
		// A file at a commit or branch, the default branch's by default.
		if (tail.startsWith("/contents/")) {
			const path = decodeURIComponent(tail.slice("/contents/".length));
			const ref = url.searchParams.get("ref") ?? defaultOf(repo);
			const tree = repo.commits[repo.commits[ref] ? ref : (branches.get(ref) ?? "")]?.tree;
			if (!tree) return json({ message: `No commit found for the ref ${ref}` }, 404);
			return path in filesOf(repo, tree) ? json({ type: "file", path }) : notFound();
		}
		return missing(method, request.url);
	};

	/**
	 * Git's database API on one repository's `branches` and object store:
	 * commits and trees build on known ones, and a branch update fast-forwards unless forced. Null when `tail` is not a Git request.
	 */
	function gitData(
		network: Repo,
		branches: {
			get(name: string): string | null;
			set(name: string, sha: string): void;
			delete(name: string): void;
		},
		tail: string,
		method: string,
		body: Record<string, any>,
		writes: (permission: Permission) => boolean,
	) {
		if (!tail.startsWith("/git/")) return null;
		if (method !== "GET" && !writes("contents"))
			return json({ message: "Resource not accessible by integration" }, 403);
		const invalid = (message: string) => json({ message }, 422);
		const knownTree = (sha: unknown) =>
			typeof sha === "string" &&
			(sha === treeOf(network) ||
				!!network.trees[sha] ||
				Object.values(network.commits).some((c) => c.tree === sha));
		const ref = tail.match(/^\/git\/refs?\/heads\/(.+)$/)?.[1];
		const branch = ref && decodeURIComponent(ref);
		if (branch && method === "GET") {
			const sha = branches.get(branch);
			return sha ? json({ ref: `refs/heads/${branch}`, object: { type: "commit", sha } }) : notFound();
		}
		if (branch && method === "PATCH") {
			const current = branches.get(branch);
			if (!current) return invalid("Reference does not exist");
			if (!network.commits[body.sha]) return invalid("Object does not exist");
			const ancestor = (sha: string): boolean =>
				sha === current || (network.commits[sha]?.parents ?? []).some(ancestor);
			if (!body.force && !ancestor(body.sha)) return invalid("Update is not a fast forward");
			branches.set(branch, body.sha);
			return json({ ref: `refs/heads/${branch}`, object: { type: "commit", sha: body.sha } });
		}
		if (branch && method === "DELETE") {
			if (!branches.get(branch)) return invalid("Reference does not exist");
			branches.delete(branch);
			return new Response(null, { status: 204 });
		}
		if (tail === "/git/refs" && method === "POST") {
			const name = typeof body.ref === "string" && body.ref.startsWith("refs/heads/") && body.ref.slice(11);
			if (!name) return invalid("Reference name must start with refs/heads/");
			if (branches.get(name)) return invalid("Reference already exists");
			if (!network.commits[body.sha]) return invalid("Object does not exist");
			branches.set(name, body.sha);
			return json({ ref: body.ref, object: { type: "commit", sha: body.sha } }, 201);
		}
		const commit = tail.match(/^\/git\/commits\/([0-9a-f]{40})$/)?.[1];
		if (commit && method === "GET") {
			const found = network.commits[commit];
			if (!found) return notFound();
			return json({
				sha: commit,
				message: found.message,
				tree: { sha: found.tree },
				parents: found.parents.map((sha) => ({ sha })),
			});
		}
		if (tail === "/git/blobs" && method === "POST") {
			if (body.encoding !== "base64" || typeof body.content !== "string") return invalid("Invalid blob");
			return json({ sha: blob(Buffer.from(body.content, "base64")) }, 201);
		}
		const treeId = tail.match(/^\/git\/trees\/([0-9a-f]{40})$/)?.[1];
		if (treeId && method === "GET" && knownTree(treeId)) {
			const entries = (id: string): Map<string, Record<string, any>> => {
				const written = network.trees[id];
				if (!written)
					return new Map(
						(id === treeOf(network) ? tree(network).tree : []).map((entry) => [entry.path, entry]),
					);
				const result = entries(written.base);
				for (const entry of written.entries as Record<string, any>[])
					if (entry.sha === null) result.delete(entry.path);
					else result.set(entry.path, { ...entry, sha: entry.sha ?? blob(entry.content ?? "") });
				return result;
			};
			return json({ sha: treeId, truncated: false, tree: [...entries(treeId).values()] });
		}
		if (tail === "/git/trees" && method === "POST") {
			if (!knownTree(body.base_tree) || !Array.isArray(body.tree)) return invalid("Invalid tree");
			const created: Tree = { base: body.base_tree, entries: body.tree };
			const sha = sha1(`tree ${JSON.stringify(created)}`);
			network.trees[sha] = created;
			return json({ sha }, 201);
		}
		if (tail === "/git/commits" && method === "POST") {
			const parents: unknown = body.parents;
			if (
				!knownTree(body.tree) ||
				!Array.isArray(parents) ||
				!parents.every((p) => network.commits[p]) ||
				typeof body.message !== "string"
			)
				return invalid("Invalid commit");
			// GitHub stamps each commit with the time, so even identical changes get a new commit.
			const sha = sha1(`commit ${Object.keys(network.commits).length} ${body.tree} ${parents} ${body.message}`);
			// No author or committer: GitHub attributes the commit to the App's bot.
			network.commits[sha] = {
				parents,
				tree: body.tree,
				message: body.message,
				committer: `${world.app.slug}[bot]`,
			};
			return json({ sha }, 201);
		}
		return null;
	}
}
