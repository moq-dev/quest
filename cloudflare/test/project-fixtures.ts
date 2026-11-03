// A signed-in maintainer of an enrolled project with complete observations,
// and the fake GitHub answering from a world that matches them.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createHash } from "node:crypto";
import { vi } from "vitest";
import { type Repo, type World, commitOf, fakeGitHub } from "../dev/github";
import { app } from "../src/index";
import { type Identity, identity, oauth } from "./login-fixtures";
import { owner } from "./owners";

const db = env.DB;
export const commit = "a".repeat(40);
export const head = "d".repeat(40);
export const documents = [
	{
		path: "quest/README.md",
		content: "# Project\n\n## Goal\n\nBuild it.\n\n## Required\n\n- [First](/quest/first.md)\n",
	},
	{ path: "quest/first.md", content: "# [S] First\n\n## Goal\n\nBuild first.\n" },
];

export async function project(id: number, owner: string, state: "enabled" | "paused" = "enabled") {
	await db.batch([
		db
			.prepare(
				"INSERT INTO github_projects(id,owner,name,installation,state,enrolledBy,updatedAt) VALUES(?,'upstream','project',5,?,?,0) ON CONFLICT(id) DO UPDATE SET state=excluded.state",
			)
			.bind(id, state, owner),
		db
			.prepare("INSERT INTO github_project_members(repository,user) VALUES(?,?) ON CONFLICT DO NOTHING")
			.bind(id, owner),
	]);
}

export const pull = {
	databaseId: "21",
	number: 2,
	title: "Fix",
	state: "OPEN",
	updatedAt: "2026-10-16T00:00:00Z",
	author: null,
	comments: { totalCount: 0 },
	isDraft: false,
	reviewDecision: null,
	mergeStateStatus: "CLEAN",
	commits: { nodes: [{ commit: { oid: head, statusCheckRollup: { state: "SUCCESS" } } }] },
	headRefName: "contributor/fix",
	headRefOid: head,
};
export const issue = {
	databaseId: "11",
	number: 1,
	title: "Idea",
	state: "OPEN",
	updatedAt: "2026-10-16T00:00:00Z",
	author: { login: "reporter" },
	comments: { totalCount: 0 },
};

/**
 * GitHub as the observations `maintainerOf` records saw it: `upstream/project`
 * on installation 5, whose default branch `trunk` is at `commit` with a flake,
 * the open issue #1, and the clean pull request #2 from `contributor/fix` at
 * `head`, which a writer approved there. It carries no labels yet. Each call
 * builds a new world, so tests share no GitHub state.
 */
export function world(): World {
	return {
		app: { id: Number(env.GITHUB_APP_ID), slug: "quest-test" },
		installation: 5,
		owner,
		users: [{ id: 8, login: "reviewer", name: "Reviewer", email: "reviewer@example.test" }],
		repos: [
			{
				id: 10,
				owner: "upstream",
				name: "project",
				defaultBranch: "trunk",
				maintainers: [],
				roles: { reviewer: "write" },
				files: [...documents, { path: "flake.nix", content: "{ outputs = _: { }; }\n" }],
				issues: [{ number: 1, title: "Idea", author: "reporter" }],
				pulls: [
					{
						number: 2,
						title: "Fix",
						author: "contributor",
						branch: "contributor/fix",
						checks: "SUCCESS",
						review: null,
						reviews: [{ state: "APPROVED", author: "reviewer", commit: head }],
						merge: "CLEAN",
						labels: [],
						timeline: [],
					},
				],
				branches: { trunk: commit, "contributor/fix": head },
				commits: {},
				trees: {},
			},
		],
	};
}

/**
 * Give `sha`'s commit a tree that changes the default branch's first commit's
 * files by `entries`, as a push would; a null `sha` deletes the file at `path`.
 */
export function rewrite(repo: Repo, sha: string, entries: { path: string; content?: string; sha?: null }[]) {
	const tree = createHash("sha1")
		.update(`tree ${sha} ${JSON.stringify(entries)}`)
		.digest("hex");
	repo.trees[tree] = {
		base: repo.commits[commitOf(repo)]!.tree,
		entries: entries.map((entry) => ({ ...entry, mode: "100644", type: "blob" })),
	};
	repo.commits[sha]!.tree = tree;
}

/**
 * `github`, answering every request matching `when` with GitHub's `status`
 * error, as an outage or a rate limit does; `intercept` changes one request.
 */
export const failing =
	(github: typeof fetch, when: (url: URL) => boolean, status: number, message = "Server Error"): typeof fetch =>
	async (input, init) =>
		when(new URL(String(input))) ? Response.json({ message }, { status }) : github(input, init);
/** GitHub's GraphQL API, which every read of a project's activity uses. */
export const graphql = (url: URL) => url.pathname === "/graphql";

const userOf = async (who: Identity) =>
	(await db
		.prepare("SELECT userId FROM account WHERE providerId='github' AND accountId=?")
		.bind(who.id)
		.first<{ userId: string }>())!.userId;

/**
 * Sign in a GitHub user, enroll project 10 for them with complete observations
 * of `world()`, which their `login` maintains, and answer GitHub with the fake
 * over it. Tests change GitHub by editing `repo`. `other` signs in another
 * GitHub user with a role on the project, `read` by default.
 */
export async function maintainerOf() {
	const who = identity("github");
	const cookie = (await oauth(who)).session!;
	const user = await userOf(who);
	await project(10, user);
	const snapshot = { commit, date: "2026-10-16", documents, completed: [] };
	const scan = {
		history: { id: "scan", issues: false, pulls: false, complete: true },
		occupancy: { open: false, refs: false, pulls: ["21"], claims: [], complete: true },
	};
	await db.batch([
		db
			.prepare(
				"INSERT INTO github_project_state(repository,epoch,snapshot,scan,observedAt) VALUES(10,'e',?,?,0) ON CONFLICT(repository) DO UPDATE SET snapshot=excluded.snapshot,scan=excluded.scan,invalidated=0",
			)
			.bind(JSON.stringify(snapshot), JSON.stringify(scan)),
		db
			.prepare(
				"INSERT INTO github_project_activity(repository,kind,id,number,firstSeen,changedAt,data,seenIn) VALUES(10,'pull','21',2,0,0,?,'scan'),(10,'issue','11',1,0,0,?,'scan')",
			)
			.bind(JSON.stringify(pull), JSON.stringify(issue)),
	]);
	const data = world();
	const repo = data.repos[0]!;
	const person = (who: Identity) => {
		const login = `person${who.id}`;
		data.users.push({ id: Number(who.id), login, name: `Person ${who.id}`, email: who.email });
		return login;
	};
	const login = person(who);
	repo.roles![login] = "maintain";
	const github = fakeGitHub(data);
	vi.spyOn(globalThis, "fetch").mockImplementation(github);
	async function other(role = "read") {
		// Signing in replaces the fetch mock, so put back the one in place.
		const respond = vi.mocked(globalThis.fetch).getMockImplementation()!;
		const who = identity("github");
		const session = (await oauth(who)).session!;
		vi.spyOn(globalThis, "fetch").mockImplementation(respond);
		const login = person(who);
		repo.roles![login] = role;
		return { session, login, id: await userOf(who) };
	}
	return { user, cookie, login, repo, pr: repo.pulls[0]!, github, other };
}

/**
 * Deliver a signed GitHub webhook, and finish the background read it asks for.
 * A payload's repository and installation come from the admitted test owner
 * unless they name one, as `owner.id` and `account.id`.
 */
export async function delivery(
	event: string,
	payload: unknown,
	id = crypto.randomUUID(),
	changes: Record<string, string> = {},
	bindings: Env = env,
) {
	const body = typeof payload === "string" ? payload : JSON.stringify(admit(payload));
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
	const signature = "sha256=" + Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
	// Background work, such as reads and notifications, finishes before the test goes on.
	const ctx = createExecutionContext();
	const response = await app.request(
		"http://localhost:8787/webhooks/github",
		{
			method: "POST",
			headers: { "X-GitHub-Event": event, "X-GitHub-Delivery": id, "X-Hub-Signature-256": signature, ...changes },
			body,
		},
		bindings,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return response;
}

function admit(payload: unknown) {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	const { repository, installation } = payload as Record<string, unknown>;
	const from = (value: unknown, key: string) =>
		value && typeof value === "object" && !(key in value) ? { ...value, [key]: { id: owner } } : value;
	return { ...payload, repository: from(repository, "owner"), installation: from(installation, "account") };
}
