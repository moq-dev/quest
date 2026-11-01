// A signed-in maintainer of an enrolled project with complete observations,
// and a mocked GitHub that answers the requests authority checks make.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import { app } from "../src/index";
import { identity, oauth } from "./login-fixtures";

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
 * Sign in a GitHub user, enroll project 10 for them with an open issue #1 and
 * pull request #2, and mock GitHub. `github` changes what the mock reports, and
 * `mock` reinstalls it after another sign-in replaces it. Merges of #2 record
 * their request in `merged`, and land only at `head`; `refuse` makes GitHub
 * refuse them with that message. Other GitHub IDs in `maintainers` hold the
 * maintain role too, and `limited` rate-limits every role check. A `role` of
 * null removes the signed-in user from the repository, so GitHub answers 404.
 * `labels` are #2's labels and `events` its label and landing timeline, which
 * label requests change; `landing` says it is queued or auto-merging.
 * `approved` lists the commits of #2 another maintainer approved.
 */
export async function maintainerOf() {
	const github = {
		flake: true,
		pullFlake: true,
		signature: null as { isValid: boolean; signer: { databaseId: number; login: string } | null } | null,
		role: "maintain" as string | null,
		issue: "open",
		pull: "open",
		head,
		methods: ["squash", "merge", "rebase"],
		refuse: null as string | null,
		merged: [] as unknown[],
		maintainers: [] as string[],
		limited: false,
		labels: [] as string[],
		events: [] as { id: string; label: string | null }[],
		landing: false,
		approved: [head] as string[],
	};
	const who = identity("github");
	const cookie = (await oauth(who)).session!;
	const user = (await db
		.prepare("SELECT userId FROM account WHERE providerId='github' AND accountId=?")
		.bind(who.id)
		.first<{ userId: string }>())!.userId;
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
	const mock = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const path = url.pathname;
		if (path.endsWith("/installation"))
			return Response.json({
				id: 5,
				app_id: 123,
				suspended_at: null,
				permissions: {
					metadata: "read",
					contents: "write",
					issues: "write",
					pull_requests: "write",
					checks: "read",
				},
			});
		if (path === "/graphql" && String(init?.body).includes("signature {"))
			return Response.json({
				data: {
					repository: {
						pullRequest: { state: github.pull.toUpperCase(), headRefOid: github.head },
						defaultBranchRef: {
							name: "trunk",
							target: { oid: commit },
							compare: {
								baseTarget: { oid: commit },
								headTarget: { oid: github.head },
								commits: {
									totalCount: 1,
									nodes: [{ oid: github.head, signature: github.signature }],
									pageInfo: { hasNextPage: false, endCursor: null },
								},
							},
						},
					},
				},
			});

		if (path === "/graphql" && String(init?.body).includes("latestOpinionatedReviews(")) {
			const reviewer = { __typename: "User", login: "reviewer" };
			return Response.json({
				data: {
					repository: {
						pullRequest: {
							state: github.pull.toUpperCase(),
							headRefOid: github.head,
							baseRefName: "trunk",
							author: { __typename: "User", login: "contributor" },
							latestOpinionatedReviews: {
								nodes: github.approved.map((oid) => ({
									state: "APPROVED",
									author: reviewer,
									commit: { oid },
								})),
							},
						},
					},
				},
			});
		}
		if (path === "/repos/upstream/project/rules/branches/trunk") return Response.json([]);
		if (/^\/repos\/upstream\/project\/commits\/[0-9a-f]{40}\/check-runs$/.test(path))
			return Response.json({ total_count: 0, check_runs: [] });
		const commitRead = path.match(/^\/repos\/upstream\/project\/git\/commits\/([0-9a-f]{40})$/)?.[1];
		if (commitRead) return Response.json({ sha: commitRead, tree: { sha: commit }, parents: [{ sha: commit }] });
		if (path === "/graphql" && String(init?.body).includes("timelineItems")) {
			return Response.json({
				data: {
					repository: {
						pullRequest: {
							id: "PR_2",
							state: github.pull.toUpperCase(),
							headRefOid: github.head,
							mergeStateStatus: "BLOCKED",
							isMergeQueueEnabled: false,
							autoMergeRequest: github.landing ? {} : null,
							mergeQueueEntry: null,
							labels: { nodes: github.labels.map((name) => ({ name })) },
							timelineItems: {
								nodes: github.events.map((event) =>
									event.label === null
										? { __typename: "AutoMergeEnabledEvent", id: event.id }
										: { __typename: "LabeledEvent", id: event.id, label: { name: event.label } },
								),
							},
						},
					},
				},
			});
		}
		if (path === "/repos/upstream/project/issues/2/labels" && init?.method === "POST") {
			const [name] = JSON.parse(String(init.body)).labels as string[];
			if (!github.labels.includes(name!)) github.labels.push(name!);
			github.events.push({ id: `LE_${github.events.length + 1}`, label: name! });
			return Response.json([]);
		}
		const unlabel = path.match(/^\/repos\/upstream\/project\/issues\/2\/labels\/(.+)$/)?.[1];
		if (unlabel && init?.method === "DELETE") {
			const name = decodeURIComponent(unlabel);
			if (!github.labels.includes(name))
				return Response.json({ message: "Label does not exist" }, { status: 404 });
			github.labels = github.labels.filter((label) => label !== name);
			return Response.json([]);
		}
		if (path.endsWith("/access_tokens")) return Response.json({ token: "installation-token" });
		if (path === "/installation/token") return new Response(null, { status: 204 });
		if (path === "/repos/upstream/project")
			return Response.json({
				id: 10,
				name: "project",
				owner: { login: "upstream" },
				private: false,
				visibility: "public",
				default_branch: "trunk",
				archived: false,
				disabled: false,
				allow_squash_merge: github.methods.includes("squash"),
				allow_merge_commit: github.methods.includes("merge"),
				allow_rebase_merge: github.methods.includes("rebase"),
			});
		if (path === "/repos/upstream/project/pulls/2/merge" && init?.method === "PUT") {
			const body = JSON.parse(String(init.body));
			github.merged.push(body);
			if (body.sha !== head) return Response.json({ message: "Head branch was modified." }, { status: 409 });
			if (github.refuse) return Response.json({ message: github.refuse }, { status: 405 });
			return Response.json({ sha: "e".repeat(40), merged: true, message: "Pull Request successfully merged" });
		}
		if (path.startsWith("/user/")) {
			const id = path.split("/").at(-1)!;
			return Response.json({ id: Number(id), login: `person${id}` });
		}
		// Only the signed-in maintainer and `maintainers` hold the maintain role; anyone else may read.
		const permission = path.match(/\/collaborators\/person(\d+)\/permission$/);
		if (permission && github.limited) return Response.json({ message: "API rate limit exceeded" }, { status: 429 });
		if (permission?.[1] === who.id && github.role === null)
			return Response.json({ message: "Not Found" }, { status: 404 });
		if (permission)
			return Response.json(
				permission[1] === who.id
					? { user: { id: Number(who.id) }, permission: "write", role_name: github.role }
					: github.maintainers.includes(permission[1]!)
						? { user: { id: Number(permission[1]) }, permission: "write", role_name: "maintain" }
						: { user: { id: Number(permission[1]) }, permission: "read", role_name: "read" },
			);
		// The live issue and pull request that a job binds, which observations can lag.
		if (path === "/repos/upstream/project/issues/1") return Response.json({ state: github.issue });
		if (path === "/repos/upstream/project/pulls/2")
			return Response.json({ state: github.pull, head: { sha: github.head }, base: { ref: "trunk" } });
		const ref = url.searchParams.get("ref");
		if (path === "/repos/upstream/project/contents/flake.nix" && (ref === commit || ref === head))
			return (ref === commit ? github.flake : github.pullFlake)
				? Response.json({ type: "file" })
				: new Response(null, { status: 404 });
		throw new Error(`Unexpected GitHub request ${path}`);
	};
	vi.spyOn(globalThis, "fetch").mockImplementation(mock);
	return { user, cookie, github, mock };
}

/** Deliver a signed GitHub webhook, and finish the background read it asks for. */
export async function delivery(
	event: string,
	payload: unknown,
	id = crypto.randomUUID(),
	changes: Record<string, string> = {},
	bindings: Env = env,
) {
	const body = typeof payload === "string" ? payload : JSON.stringify(payload);
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
