// A fake of the GitHub (and SPDX) endpoints the Worker calls, answering from
// an in-memory world. It backs the seeded local server and the Worker tests
// that drive GitHub, so it never holds or forwards real credentials, and it
// refuses anything it does not model. Like GitHub, it scopes each installation
// token to the repositories and permissions it was minted for.
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
};
export type Thread = { path: string; line: number | null; resolved?: boolean; outdated?: boolean; comments: Comment[] };
export type Pull = Issue & {
	/** The PR base; retargeting changes its commit list, never the trusted default branch. */
	base?: string;
	/** Head branch; `quest/<path>` associates the pull request with that quest. */
	branch: string;
	checks: "SUCCESS" | "FAILURE" | "PENDING" | null;
	/** The check runs behind `checks`. */
	runs?: { name: string; conclusion: string; url: string; app?: number; context?: boolean }[];
	review: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
	reviews?: { state: string; author: string; body?: string }[];
	threads?: Thread[];
	draft?: boolean;
	/** Opened from the service fork, so its branch is not on the upstream. */
	fork?: boolean;
	/** Opened from this contributor's own fork, which the bot cannot update. */
	contributor?: string;
	/** A `## Decisions needed` section in it hands a draft back to the maintainer. */
	body?: string;
	/** Closed by merging it; set with `closed`. */
	merged?: boolean;
	/** Optional squash result supplied by fixtures that model real git merges. */
	squash?: string;
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
	/** The enabled auto-merge's time and commit body; `quest land` reads its queue from them. */
	autoMerge?: { enabledAt: string; commitBody: string };
	/** A fork's head branch accepts pushes from the upstream's maintainers. */
	maintainerCanModify?: boolean;
};
export type Commit = {
	parents: string[];
	tree: string;
	message: string;
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
	/** Defaults to main. */
	defaultBranch?: string;
	/** The default branch's files. */
	files: { path: string; content: string }[];
	issues: Issue[];
	pulls: Pull[];
	/**
	 * Upstream branches and their commits. A pull request's branch that is not
	 * listed is at a commit derived from its number; a `quest/*` branch with no
	 * open pull request is a claim, unless it is still at a merged one's head.
	 * Listing `main` moves the default branch on for comparisons with it.
	 */
	branches: Record<string, string>;
	/** Branches on the repository's service fork, `<forks>/<name>`, and their commits. */
	fork: Record<string, string>;
	/**
	 * Commits beyond the default branch's, shared with the service fork as a fork
	 * network shares objects. The fake adds the default branch's commit and every
	 * branch tip it does not find here, as children of the default branch.
	 */
	commits: Record<string, Commit>;
	/** Trees written through the API. */
	trees: Record<string, Tree>;
	/** Check names the default branch's rulesets require. */
	required?: string[];
	/** The default branch's other ruleset rules, as `GET /rules/branches/main` lists them. */
	rules?: Record<string, unknown>[];
	/** The default branch's classic protection, as `GET /branches/main/protection` returns it; none when absent. */
	protection?: Record<string, any>;
};
export type World = {
	app: { id: number; slug: string };
	/** The installation on the repositories' owner. */
	installation: number;
	/** The installation on the service fork namespace. */
	forkInstallation: number;
	/** The service fork namespace, `GITHUB_FORK_OWNER`. */
	forks: string;
	users: User[];
	repos: Repo[];
};

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");
/** The Git object ID of a file's content, which the Worker verifies. */
export const blob = (content: string | Uint8Array) => {
	const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
	return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
};
/** The default branch's commit. */
export const commitOf = (repo: Repo) => sha1(`commit ${repo.owner}/${repo.name}`);
const treeOf = (repo: Repo) => sha1(`tree ${repo.owner}/${repo.name}`);
/** A pull request's head commit: the one it ended at, or its branch's tip where the world lists one. */
export const headOf = (repo: Repo, pull: Pull) =>
	pull.head ??
	(pull.fork ? repo.fork : pull.contributor ? {} : repo.branches)[pull.branch] ??
	sha1(`head ${repo.owner}/${repo.name}#${pull.number}`);
// GitHub's database IDs differ from numbers; derive stable ones per repository.
export const databaseId = (repo: Repo, number: number) => String(repo.id * 1000 + number);
const updatedAt = "2026-10-20T12:00:00Z";
const nodeId = (repo: Repo, pull: Pull) => `PR_${databaseId(repo, pull.number)}`;
// The open pull requests whose branch is on the upstream itself.
const upstreamPulls = (repo: Repo) => repo.pulls.filter((pull) => !pull.closed && !pull.fork && !pull.contributor);

function entity(repo: Repo, item: Issue) {
	return {
		databaseId: databaseId(repo, item.number),
		number: item.number,
		title: item.title,
		state: (item as Pull).merged ? "MERGED" : item.closed ? "CLOSED" : "OPEN",
		updatedAt,
		closedAt: item.closed ? updatedAt : null,
		author: { login: item.author },
		comments: { totalCount: item.comments?.length ?? 0 },
	};
}

const mergeState = (pull: Pull) => pull.merge ?? (pull.draft ? "DRAFT" : "BLOCKED");

function pullNode(repo: Repo, pull: Pull) {
	const oid = headOf(repo, pull);
	const reviews = pull.reviews ?? [];
	return {
		...entity(repo, pull),
		body: pull.body ?? "",
		headRefName: pull.branch,
		headRefOid: oid,
		isDraft: !!pull.draft,
		reviewDecision: pull.review,
		mergeStateStatus: mergeState(pull),
		labels: { nodes: (pull.labels ?? []).map((name) => ({ name })) },
		reviews: { totalCount: reviews.length },
		latestReviews: {
			nodes: reviews.map((r) => ({ state: r.state, author: { login: r.author }, commit: { oid } })),
			pageInfo: { hasNextPage: false },
		},
		commits: { nodes: [{ commit: { oid, statusCheckRollup: pull.checks ? { state: pull.checks } : null } }] },
	};
}

/** One connection page, using opaque positions just as the service uses GitHub's cursors. */
function connection<T>(nodes: T[], size: number, after: unknown = null) {
	const start = typeof after === "string" ? Number(after) : 0;
	const end = start + size;
	return {
		nodes: nodes.slice(start, end),
		pageInfo: { hasNextPage: end < nodes.length, endCursor: end < nodes.length ? String(end) : null },
	};
}

const comments = (list: Comment[] = [], size = 100, after: unknown = null) =>
	connection(
		list.map((c) => ({ author: c.author === null ? null : { login: c.author }, body: c.body, createdAt: c.at })),
		size,
		after,
	);

/** An issue with its discussion, as a job's agent reads it. */
const issueTarget = (item: Issue, after: unknown = null) => ({
	number: item.number,
	title: item.title,
	state: item.closed ? "CLOSED" : "OPEN",
	body: item.body ?? "",
	author: { login: item.author },
	comments: comments(item.comments, 100, after),
});

const threadId = (repo: Repo, pull: Pull, index: number) => `PRT_${databaseId(repo, pull.number)}_${index}`;

/** A pull request with its discussion, reviews, threads, and checks, as a job's agent reads it. */
function pullTarget(repo: Repo, pull: Pull, after: unknown) {
	const oid = headOf(repo, pull);
	return {
		...issueTarget(pull, after),
		isDraft: !!pull.draft,
		baseRefName: "main",
		headRefName: pull.branch,
		headRefOid: oid,
		reviews: connection(
			(pull.reviews ?? []).map((r) => ({
				author: { login: r.author },
				state: r.state,
				body: r.body ?? "",
				submittedAt: updatedAt,
			})),
			50,
			after,
		),
		reviewThreads: connection(
			(pull.threads ?? []).map((t, index) => ({
				id: threadId(repo, pull, index),
				isResolved: !!t.resolved,
				isOutdated: !!t.outdated,
				path: t.path,
				line: t.line,
				comments: comments(t.comments, 50),
			})),
			100,
			after,
		),
		commits: {
			nodes: [
				{
					commit: {
						oid,
						statusCheckRollup: pull.checks && {
							state: pull.checks,
							contexts: contextPage(pull, null),
						},
					},
				},
			],
		},
	};
}

/** A pull request's labels, the timeline that added them, and its landing, as a merge hold reads them. */
function holdsTarget(repo: Repo, pull: Pull) {
	return {
		id: nodeId(repo, pull),
		state: pull.merged ? "MERGED" : pull.closed ? "CLOSED" : "OPEN",
		baseRefName: "main",
		headRefOid: headOf(repo, pull),
		mergeStateStatus: mergeState(pull),
		isMergeQueueEnabled: false,
		autoMergeRequest: pull.landing ? { enabledAt: updatedAt } : null,
		mergeQueueEntry: null,
		labels: { nodes: (pull.labels ?? []).map((name) => ({ name })) },
		timelineItems: {
			nodes: (pull.timeline ?? []).map((event) =>
				event.label === null
					? { __typename: "AutoMergeEnabledEvent", id: event.id }
					: { __typename: "LabeledEvent", id: event.id, label: { name: event.label } },
			),
		},
	};
}

const page = <T>(nodes: T[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });

/** The repository holding a pull request's head branch, as `owner/name`. */
const holderOf = (repo: Repo, pull: Pull, forks: string) =>
	`${pull.fork ? forks : (pull.contributor ?? repo.owner)}/${repo.name}`;

/** A pull request as `quest land` reads its queue: auto-merge, head, reviews, and checks. */
function queueTarget(repo: Repo, pull: Pull, forks: string) {
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
		headRepository: { nameWithOwner: holderOf(repo, pull, forks) },
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
function contextPage(pull: Pull, after: unknown) {
	const start = typeof after === "string" ? Number(after) : 0;
	const all = (pull.runs ?? []).map((run) =>
		run.context
			? { __typename: "StatusContext", context: run.name, state: run.conclusion, targetUrl: run.url }
			: {
					__typename: "CheckRun",
					name: run.name,
					status: "COMPLETED",
					conclusion: run.conclusion,
					detailsUrl: run.url,
					checkSuite: { app: { databaseId: run.app ?? ACTIONS_APP } },
				},
	);
	const end = start + 100;
	return {
		nodes: all.slice(start, end),
		pageInfo: { hasNextPage: end < all.length, endCursor: end < all.length ? String(end) : null },
	};
}

function graphql(repo: Repo, query: string, variables: Record<string, unknown>, forks: string) {
	const blobs = [...query.matchAll(/(q\d+): object\(oid: "([0-9a-f]{40})"\)/g)];
	if (blobs.length) {
		const files = new Map(repo.files.map((file) => [blob(file.content), file.content]));
		const objects = Object.fromEntries(
			blobs.map(([, alias, oid]) => {
				const text = files.get(oid!);
				return [alias, text === undefined ? null : { oid, text, isBinary: false, isTruncated: false }];
			}),
		);
		return { data: { repository: objects } };
	}
	if (query.includes("signature {")) {
		const pull = repo.pulls.find((p) => p.number === variables.number);
		if (!pull) return { data: { repository: { pullRequest: null } } };
		const branch = repo.defaultBranch ?? "main";
		const anchor = repo.branches[branch] ?? commitOf(repo);
		const comparison = query.includes("compare(headRef:");
		const base = comparison ? anchor : (repo.branches[pull.base ?? branch] ?? anchor);
		const head = comparison ? String(variables.revision) : headOf(repo, pull);
		const ancestors = (tip: string, seen = new Set<string>()): Set<string> => {
			if (seen.has(tip)) return seen;
			seen.add(tip);
			for (const parent of repo.commits[tip]?.parents ?? []) ancestors(parent, seen);
			return seen;
		};
		const inherited = ancestors(base);
		const commits = [...ancestors(head)].filter((oid) => !inherited.has(oid));
		const start = variables.after ? Number(variables.after) : 0;
		const end = Math.min(start + 100, commits.length);
		const nodes = commits
			.slice(start, end)
			.map((oid) => ({ oid, signature: repo.commits[oid]?.signature ?? null }));
		const connection = {
			totalCount: commits.length,
			nodes,
			pageInfo: { hasNextPage: end < commits.length, endCursor: String(end) },
		};
		const live = { state: pull.closed ? "CLOSED" : "OPEN", headRefOid: headOf(repo, pull) };
		return {
			data: {
				repository: comparison
					? {
							pullRequest: live,
							defaultBranchRef: {
								name: branch,
								target: { oid: anchor },
								compare: repo.commits[head]
									? {
											baseTarget: { oid: base },
											headTarget: { oid: head },
											commits: connection,
										}
									: null,
							},
						}
					: {
							pullRequest: {
								...live,
								baseRefOid: base,
								commits: { ...connection, nodes: nodes.map((commit) => ({ commit })) },
							},
						},
			},
		};
	}

	if (query.includes("timelineItems(")) {
		const pull = repo.pulls.find((p) => p.number === variables.number);
		return { data: { repository: { pullRequest: pull ? holdsTarget(repo, pull) : null } } };
	}
	if (query.includes("object(oid: $oid)")) {
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
	if (query.includes("defaultBranchRef")) return { data: { repository: { defaultBranchRef: { name: "main" } } } };
	if (query.includes("queue:pullRequests(")) {
		const queued = repo.pulls.filter((pull) => !pull.closed && variables.base === "main");
		return {
			data: {
				repository: {
					ref:
						variables.qualified === "refs/heads/main"
							? { target: { oid: repo.branches.main ?? commitOf(repo) } }
							: null,
					queue: page(queued.map((pull) => queueTarget(repo, pull, forks))),
				},
			},
		};
	}
	const open = repo.pulls.filter((pull) => !pull.closed);
	const result: Record<string, unknown> = {};
	const errors: unknown[] = [];
	if (query.includes("issues(")) result.issues = page(repo.issues.map((issue) => entity(repo, issue)));
	if (/(?<!:)pullRequests\(/.test(query)) result.pullRequests = page(repo.pulls.map((pull) => pullNode(repo, pull)));
	if (query.includes("open:pullRequests(")) result.open = page(open.map((pull) => pullNode(repo, pull)));
	if (query.includes("refs(")) {
		// Quest branches at their tips, with the pull requests from them that merged, newest first.
		const tips = new Map<string, string>();
		for (const pull of upstreamPulls(repo)) tips.set(pull.branch, headOf(repo, pull));
		for (const [branch, oid] of Object.entries(repo.branches)) tips.set(branch, oid);
		const merged = (branch: string) =>
			repo.pulls
				.filter((pull) => pull.merged && !pull.fork && !pull.contributor && pull.branch === branch)
				.reverse();
		result.refs = page(
			[...tips].flatMap(([branch, oid]) =>
				branch.startsWith("quest/")
					? [
							{
								name: branch.slice("quest/".length),
								prefix: "refs/heads/quest/",
								target: { oid },
								associatedPullRequests: page(
									merged(branch).map((pull) => ({ headRefOid: headOf(repo, pull) })),
								),
							},
						]
					: [],
			),
		);
	}
	// A job's issue or pull request, read with its discussion.
	for (const field of ["issue", "pullRequest"] as const)
		if (query.includes(`${field}(number: $number)`)) {
			const pull = repo.pulls.find((p) => p.number === variables.number);
			const issue = repo.issues.find((i) => i.number === variables.number);
			const found =
				field === "pullRequest"
					? pull && pullTarget(repo, pull, variables.after)
					: issue && issueTarget(issue, variables.after);
			result[field] = found ?? null;
			if (!found) errors.push({ type: "NOT_FOUND", path: ["repository", field] });
		}
	// Entities a webhook named, read by number as GitHub does: an issue number
	// that is a pull request, or a missing one, is NOT_FOUND at its alias.
	for (const [, alias, field, number] of query.matchAll(/([sb]\d+):(issue|pullRequest)\(number:(\d+)\)/g)) {
		const pull = repo.pulls.find((p) => p.number === Number(number));
		const issue = repo.issues.find((i) => i.number === Number(number));
		const found = field === "pullRequest" ? pull && pullNode(repo, pull) : issue && entity(repo, issue);
		result[alias!] = found ?? null;
		if (!found) errors.push({ type: "NOT_FOUND", path: ["repository", alias] });
	}
	return { data: { repository: result }, ...(errors.length ? { errors } : {}) };
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
	const tips = [
		...Object.values(repo.branches),
		...Object.values(repo.fork),
		...repo.pulls.map((pull) => headOf(repo, pull)),
	];
	for (const tip of tips) repo.commits[tip] ??= { parents: [main], tree: treeOf(repo), message: "Work" };
}

/** A tree's `.github/workflows` files and their blob IDs: the default branch's files, then each written tree's changes. */
function workflowsOf(repo: Repo, sha: string): Record<string, string> {
	const workflow = (path: string) => path.startsWith(".github/workflows/");
	if (sha === treeOf(repo))
		return Object.fromEntries(repo.files.filter((f) => workflow(f.path)).map((f) => [f.path, blob(f.content)]));
	const written = repo.trees[sha];
	if (!written) return {};
	const files = workflowsOf(repo, written.base);
	for (const entry of written.entries as { path: string; sha?: string | null; content?: string }[])
		if (workflow(entry.path))
			if (entry.sha === null) delete files[entry.path];
			else files[entry.path] = entry.sha ?? blob(entry.content ?? "");
	return files;
}

type Permission = "metadata" | "contents" | "issues" | "pull_requests" | "checks" | "statuses" | "administration";
/** What an installation token may do: the repositories (`owner/name`) and permissions it was minted for. */
type Grant = { repositories: Set<string>; permissions: Partial<Record<Permission, string>> };

/**
 * Answer one outbound request from the Worker. Sign-in always completes as the
 * world's first user; repository reads check that user's maintainer role.
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
	const upstream = (name: string) => world.repos.find((r) => r.name === name);
	// The service fork of `repo`, and a contributor's fork, as GitHub describes their repositories.
	const forkId = (repo: Repo) => repo.id * 10;
	const headRepo = (repo: Repo, pull: Pull) =>
		pull.fork
			? { id: forkId(repo), name: repo.name, owner: { login: world.forks } }
			: pull.contributor
				? { id: forkId(repo) + 1, name: repo.name, owner: { login: pull.contributor } }
				: { id: repo.id, name: repo.name, owner: { login: repo.owner } };
	const restPull = (repo: Repo, pull: Pull) => ({
		number: pull.number,
		node_id: nodeId(repo, pull),
		html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
		state: pull.closed ? "closed" : "open",
		merged: pull.merged ?? false,
		mergeable: pull.mergeable !== undefined ? pull.mergeable : pull.merge !== "DIRTY",
		mergeable_state: pull.mergeableState ?? (pull.merge === "DIRTY" ? "dirty" : "clean"),
		title: pull.title,
		body: pull.body ?? "",
		draft: !!pull.draft,
		user: { login: pull.author },
		created_at: new Date(pull.createdAt ?? Date.parse(updatedAt)).toISOString(),
		base: { ref: "main" },
		head: { ref: pull.branch, sha: headOf(repo, pull), repo: headRepo(repo, pull) },
	});

	/** The repositories an installation token may name, by `owner/name`. */
	function grant(installation: number, input: { repository_ids?: number[]; repositories?: string[] }) {
		const fork = installation === world.forkInstallation;
		if (!fork && installation !== world.installation) return null;
		const names = (input.repositories ?? []).map((name) => {
			const repo = fork ? upstream(name) : world.repos.find((r) => r.name === name);
			return repo && `${fork ? world.forks : repo.owner}/${repo.name}`;
		});
		const ids = (input.repository_ids ?? []).map((id) => {
			const repo = world.repos.find((r) => (fork ? forkId(r) : r.id) === id);
			return repo && `${fork ? world.forks : repo.owner}/${repo.name}`;
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
		const me = world.users[0]!;
		if (url.origin === "https://spdx.org") return json({ licenseId: "MIT", isOsiApproved: true });
		if (url.origin === "https://github.com" && path === "/login/oauth/access_token")
			return json({ access_token: "fake-user-token", token_type: "bearer", scope: "" });
		if (url.origin !== "https://api.github.com") return missing(method, request.url);
		const text = await request.text();
		const body = text ? (JSON.parse(text) as Record<string, any>) : {};
		if (path === "/user") return json({ id: me.id, login: me.login, name: me.name, email: me.email });
		if (path === "/user/emails") return json([{ email: me.email, primary: true, verified: true }]);

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
		const service = match?.[1] === world.forks ? upstream(match[2]!) : undefined;
		const repo = service ?? (match && world.repos.find((r) => r.owner === match[1] && r.name === match[2]));
		if (match && tail === "/installation") {
			if (!app) return unauthorized();
			if (!repo) return notFound();
			const permissions = service
				? { metadata: "read", contents: "write" }
				: Object.fromEntries(
						["metadata", "contents", "issues", "pull_requests", "checks", "statuses"].map((p) => [
							p,
							"write",
						]),
					);
			const installation = service ? world.forkInstallation : world.installation;
			return json({ id: installation, app_id: world.app.id, suspended_at: null, permissions });
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
			// Later pages of one review thread's comments, addressed by its node ID.
			if (query.includes("... on PullRequestReviewThread")) {
				for (const repo of world.repos)
					for (const pull of repo.pulls)
						for (const [index, thread] of (pull.threads ?? []).entries())
							if (threadId(repo, pull, index) === variables.id) {
								if (!scope.repositories.has(`${repo.owner}/${repo.name}`))
									return json({ errors: [{ type: "NOT_FOUND" }] });
								return json({
									data: { node: { comments: comments(thread.comments, 50, variables.after) } },
								});
							}
				return json({ data: { node: null } });
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
											headRefOid: headOf(repo, pull),
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
			const landing = query.match(/\b(enablePullRequestAutoMerge|mergePullRequest)\(/)?.[1];
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
							if (landing === "mergePullRequest") {
								if (!["CLEAN", "HAS_HOOKS", "UNSTABLE"].includes(mergeState(pull)))
									return json({ errors: [{ message: "Pull Request is not mergeable" }] });
								pull.closed = pull.merged = true;
							} else {
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
			return json(graphql(repo, query, variables, world.forks));
		}
		if (!repo || !scope.repositories.has(fullName!)) return notFound();
		if (service) return serviceFork(repo, tail, method, body, writes) ?? missing(method, request.url);

		if (tail === "")
			return json({
				id: repo.id,
				name: repo.name,
				owner: { login: repo.owner },
				private: false,
				visibility: "public",
				default_branch: repo.defaultBranch ?? "main",
				archived: false,
				disabled: false,
				license: { spdx_id: "MIT" },
				allow_squash_merge: true,
				allow_auto_merge: true,
			});
		const permission = tail.match(/^\/collaborators\/([^/]+)\/permission$/);
		if (permission) {
			const found = world.users.find((u) => u.login === permission[1]);
			if (!found) return notFound();
			const role = repo.maintainers.includes(found.login) ? "maintain" : "read";
			return json({
				user: { id: found.id },
				permission: role === "maintain" ? "write" : "read",
				role_name: role,
			});
		}
		if (tail === "/commits/main") return json({ sha: commitOf(repo), commit: { tree: { sha: treeOf(repo) } } });
		// Read access sees whether classic protection is on and its required checks; the rest needs administration.
		if (tail === "/branches/main" && method === "GET") {
			const checks = repo.protection?.required_status_checks;
			return json({
				name: "main",
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
		if (tail === "/branches/main/protection" && method === "GET") {
			if (!scope.permissions.administration) return forbidden();
			return repo.protection ? json(repo.protection) : json({ message: "Branch not protected" }, 404);
		}
		if (tail.startsWith("/rules/branches/main") && method === "GET") {
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
			const [owner, branch] = String(body.head).split(":");
			const fork = owner === world.forks;
			if ((!fork && owner !== repo.owner) || !branch || body.base !== "main")
				return json({ message: "Validation Failed" }, 422);
			if (!(fork ? repo.fork[branch] : branches.get(branch)))
				return json({ message: "Validation Failed: head is invalid" }, 422);
			if (repo.pulls.some((pull) => !pull.closed && !!pull.fork === fork && pull.branch === branch))
				return json({ message: `A pull request already exists for ${body.head}.` }, 422);
			const pull: Pull = {
				number: Math.max(0, ...repo.issues.map((i) => i.number), ...repo.pulls.map((p) => p.number)) + 1,
				title: body.title,
				author: `${world.app.slug}[bot]`,
				body: body.body,
				branch,
				fork,
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
					pull.landing = false;
					pull.autoMerge = undefined;
				}
			}
			return json(restPull(repo, pull));
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
			if (pull.merge !== "CLEAN") return json({ message: "Pull Request is not mergeable" }, 405);
			pull.closed = true;
			pull.merged = true;
			pull.landing = false;
			pull.autoMerge = undefined;
			if (pull.squash) repo.branches[pull.base ?? repo.defaultBranch ?? "main"] = pull.squash;
			return json({
				sha: pull.squash ?? commitOf(repo),
				merged: true,
				message: "Pull Request successfully merged",
			});
		}
		const comment = tail.match(/^\/issues\/(\d+)\/comments$/);
		if (comment && method === "GET") {
			const item = [...repo.pulls, ...repo.issues].find((i) => String(i.number) === comment[1]);
			if (!item) return notFound();
			return json((item.comments ?? []).map((c) => ({ body: c.body, user: { login: c.author } })));
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
		const compare = tail.match(/^\/compare\/([0-9a-f]{40})\.\.\.main$/);
		if (compare && method === "GET") {
			const base = repo.branches.main ?? commitOf(repo);
			const from = compare[1]!;
			if (!repo.commits[from]) return notFound();
			const reaches = (sha: string, target: string): boolean =>
				sha === target || (repo.commits[sha]?.parents ?? []).some((parent) => reaches(parent, target));
			const status =
				from === base
					? "identical"
					: reaches(base, from)
						? "ahead"
						: reaches(from, base)
							? "behind"
							: "diverged";
			return json({ status });
		}
		if (tail === "/contents/.github" && method === "GET") {
			const tree = repo.commits[url.searchParams.get("ref") ?? ""]?.tree;
			const files = Object.entries(tree ? workflowsOf(repo, tree) : {}).sort();
			if (!files.length) return notFound();
			const sha = sha1(`workflows ${JSON.stringify(files)}`);
			return json([{ name: "workflows", path: ".github/workflows", type: "dir", sha }]);
		}
		if (tail.startsWith("/contents/")) {
			const file = repo.files.find((f) => f.path === decodeURIComponent(tail.slice("/contents/".length)));
			return file ? json({ type: "file", path: file.path }) : notFound();
		}
		return missing(method, request.url);
	};

	/** The upstream's service fork: its identity, and its branches in the upstream's object store. */
	function serviceFork(
		upstream: Repo,
		tail: string,
		method: string,
		body: Record<string, any>,
		writes: (permission: Permission) => boolean,
	) {
		if (tail === "")
			return json({
				id: forkId(upstream),
				name: upstream.name,
				owner: { login: world.forks },
				fork: true,
				parent: { id: upstream.id },
				private: false,
				visibility: "public",
				default_branch: "main",
				archived: false,
				disabled: false,
			});
		const branches = {
			get: (name: string) => upstream.fork[name] ?? null,
			set: (name: string, sha: string) => (upstream.fork[name] = sha),
		};
		return gitData(upstream, branches, tail, method, body, writes);
	}

	/**
	 * Git's database API on one repository's `branches`, with the objects its
	 * fork network shares: commits and trees build on known ones, and a branch
	 * update fast-forwards unless forced. Null when `tail` is not a Git request.
	 */
	function gitData(
		network: Repo,
		branches: { get(name: string): string | null; set(name: string, sha: string): void },
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
			network.commits[sha] = { parents, tree: body.tree, message: body.message };
			return json({ sha }, 201);
		}
		return null;
	}
}

/**
 * Wrap a fetch so the first request matching `when` is answered by `change`,
 * which may pass it on with `next`. Tests inject a failure this way, or act
 * while the request is in flight.
 */
export function intercept(
	fetch: typeof globalThis.fetch,
	when: (url: URL, method: string) => boolean,
	change: (next: () => Promise<Response>) => Promise<Response>,
): typeof globalThis.fetch {
	let done = false;
	return async function (this: unknown, input, init) {
		const request = new Request(input, init);
		if (done || !when(new URL(request.url), request.method)) return fetch.call(this, input, init);
		done = true;
		return change(() => fetch.call(this, input, init));
	};
}

/** Sign a webhook body the way GitHub does. */
export async function webhookSignature(secret: string, body: string) {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
	return "sha256=" + Buffer.from(digest).toString("hex");
}
