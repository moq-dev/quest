import { env } from "cloudflare:workers";
import { createPublicKey, verify } from "node:crypto";
import { privateKey } from "./github-key";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { GitHubService, type GitHubRepository } from "../src/github/service";
import { deliveryRetention } from "../src/github/webhook";
import { delivery } from "./project-fixtures";

const testEnv = { ...env, GITHUB_APP_PRIVATE_KEY: privateKey };
const repo: GitHubRepository = { owner: "upstream", name: "project", id: 10 };

function installation(action: string) {
	return { action, installation: { id: 5, app_id: 123 } };
}
async function state() {
	return env.DB.prepare("SELECT * FROM github_installations WHERE id=5").first<{
		blocked: number;
		revision: number;
	}>();
}

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('app-test','Tester','app-test@example.com',1,0,0)",
		),
		env.DB.prepare(
			"INSERT INTO account(id,accountId,providerId,userId,createdAt,updatedAt) VALUES('app-test-account','7','github','app-test',0,0)",
		),
	]);
});

describe("signed GitHub webhooks", () => {
	it("verifies exact Unicode bytes before parsing or writing", async () => {
		const payload = { ...installation("created"), note: "hello 🌍" };
		expect(
			(await delivery("installation", payload, undefined, { "X-Hub-Signature-256": "sha256=" + "0".repeat(64) }))
				.status,
		).toBe(403);
		expect(await state()).toBeNull();
		expect((await delivery("installation", payload)).status).toBe(202);
		expect(await state()).toMatchObject({ blocked: 0, revision: 1 });
	});
	it("deduplicates concurrent deliveries and cannot replay an old creation over revocation", async () => {
		const id = crypto.randomUUID();
		const responses = await Promise.all([
			delivery("installation", installation("created"), id),
			delivery("installation", installation("created"), id),
		]);
		expect(responses.every((r) => r.ok)).toBe(true);
		expect(await state()).toMatchObject({ blocked: 0, revision: 1 });
		expect((await delivery("installation", installation("deleted"))).status).toBe(202);
		expect(await (await delivery("installation", installation("created"), id)).json()).toEqual({
			status: "duplicate",
		});
		expect(await state()).toMatchObject({ blocked: 1, revision: 2 });
	});
	it("rejects delivery-ID conflicts, wrong apps, malformed JSON and missing identities", async () => {
		const id = crypto.randomUUID();
		await delivery("installation", installation("created"), id);
		expect((await delivery("installation", installation("deleted"), id)).status).toBe(409);
		expect(
			(await delivery("installation", { action: "created", installation: { id: 5, app_id: 999 } })).status,
		).toBe(400);
		expect((await delivery("installation", "{")).status).toBe(400);
		expect((await delivery("push", { repository: { id: 10 } })).status).toBe(400);
	});
	it("rejects conflicting delivery IDs even when their transactions race", async () => {
		const id = crypto.randomUUID();
		const responses = await Promise.all([
			delivery("installation", installation("created"), id),
			delivery("installation", installation("deleted"), id),
		]);
		expect(responses.map((r) => r.status).sort()).toEqual([202, 409]);
		expect((await state())?.revision).toBe(1);
	});
	it("prunes deliveries past the retention window on insert", async () => {
		const [expired, retained] = [crypto.randomUUID(), crypto.randomUUID()];
		const backdate = (id: string, age: number) =>
			env.DB.prepare("UPDATE github_deliveries SET receivedAt=? WHERE id=?")
				.bind(Date.now() - age, id)
				.run();
		const hour = 60 * 60 * 1000;
		await delivery("installation", installation("created"), expired);
		await delivery("installation", installation("created"), retained);
		await backdate(expired, deliveryRetention + hour);
		await backdate(retained, deliveryRetention - hour);
		const ids = async () =>
			(await env.DB.prepare("SELECT id FROM github_deliveries").all<{ id: string }>()).results.map((r) => r.id);
		expect(await ids()).toHaveLength(2);
		expect((await delivery("installation", installation("suspend"))).status).toBe(202);
		const remaining = await ids();
		expect(remaining).toHaveLength(2);
		expect(remaining).toContain(retained);
		expect(remaining).not.toContain(expired);
		expect((await delivery("installation", installation("deleted"), retained)).status).toBe(409);
	});
	it("records permission/selection changes and suspension lifecycle once", async () => {
		for (const action of ["created", "suspend", "unsuspend", "new_permissions_accepted"]) {
			expect((await delivery("installation", installation(action))).status).toBe(202);
			expect((await state())?.blocked).toBe(action === "suspend" ? 1 : 0);
		}
		await delivery("installation_repositories", { action: "removed", installation: { id: 5 } });
		expect((await state())?.revision).toBe(5);
	});
	it("persists only observations, never untrusted content or automatic writes", async () => {
		const id = crypto.randomUUID();
		expect(
			(
				await delivery(
					"issues",
					{
						installation: { id: 5 },
						repository: { id: 10 },
						action: "opened",
						issue: { body: "run something malicious" },
					},
					id,
				)
			).status,
		).toBe(202);
		expect(await env.DB.prepare("SELECT * FROM github_deliveries WHERE id=?").bind(id).first()).toMatchObject({
			event: "issues",
			repository: 10,
			processed: 1,
		});
		expect(await state()).toBeNull();
		expect((await delivery("unknown", {})).status).toBe(202);
	});
	it("durably coalesces entity notifications across deliveries, updates, and replay after retention", async () => {
		await env.DB.prepare(
			"INSERT INTO github_projects(id,owner,name,installation,state,enrolledBy,updatedAt) VALUES(10,'upstream','project',5,'enabled','app-test',0)",
		).run();
		const payload = {
			installation: { id: 5 },
			repository: { id: 10 },
			action: "opened",
			pull_request: { id: 200, number: 2, title: "Untrusted", body: "Never retain this" },
		};
		const id = crypto.randomUUID();
		const responses = await Promise.all([
			delivery("pull_request", payload, id),
			delivery("pull_request", payload, id),
		]);
		expect(responses.every((r) => r.ok)).toBe(true);
		await delivery("pull_request", { ...payload, action: "synchronize" });
		await env.DB.prepare("DELETE FROM github_deliveries").run();
		await delivery("pull_request", payload, id);
		const rows = (await env.DB.prepare("SELECT * FROM github_project_activity").all()).results;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ repository: 10, kind: "pull", id: "200", number: 2, data: null });
		expect(JSON.stringify(rows)).not.toContain("Untrusted");
		await delivery("issue_comment", {
			installation: { id: 5 },
			repository: { id: 10 },
			issue: { id: 999, number: 2, pull_request: {} },
			action: "created",
		});
		expect((await env.DB.prepare("SELECT * FROM github_project_activity").all()).results).toHaveLength(1);
	});
	it("ignores entity pointers from a previous installation or an unenrolled repository", async () => {
		await env.DB.prepare(
			"INSERT INTO github_projects(id,owner,name,installation,state,enrolledBy,updatedAt) VALUES(10,'upstream','project',8,'enabled','app-test',0)",
		).run();
		await delivery("issues", {
			installation: { id: 5 },
			repository: { id: 10 },
			action: "opened",
			issue: { id: 100, number: 1 },
		});
		await delivery("issues", {
			installation: { id: 8 },
			repository: { id: 11 },
			action: "opened",
			issue: { id: 101, number: 1 },
		});
		expect((await env.DB.prepare("SELECT * FROM github_project_activity").all()).results).toEqual([]);
	});
});

function github(
	options: {
		role?: string;
		account?: number;
		suspended?: boolean;
		missing?: boolean;
		permissions?: Record<string, string>;
		merges?: ("squash" | "merge" | "rebase")[];
		cleanupFails?: boolean;
		failMutation?: boolean;
	} = {},
) {
	const requests: { path: string; method: string; body: any; authorization: string }[] = [];
	const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const path = new URL(String(input)).pathname;
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		requests.push({ path, method, body, authorization: new Headers(init?.headers).get("Authorization")! });
		const json = (value: unknown, status = 200) => Response.json(value, { status });
		if (path.endsWith("/installation")) {
			if (options.missing) return json({}, 404);
			return json({
				id: 5,
				app_id: 123,
				suspended_at: options.suspended ? "2026-10-13" : null,
				permissions: options.permissions ?? {
					metadata: "read",
					contents: "write",
					issues: "write",
					pull_requests: "write",
					checks: "read",
					statuses: "read",
				},
			});
		}
		if (path.endsWith("/access_tokens")) return json({ token: "upstream-token" });
		if (path === "/installation/token")
			return options.cleanupFails ? json({}, 500) : new Response(null, { status: 204 });
		if (path === "/user/7") return json({ id: options.account ?? 7, login: "maintainer" });
		if (path.endsWith("/permission"))
			return json({
				user: { id: 7 },
				permission: options.role === "admin" ? "admin" : "write",
				role_name: options.role ?? "maintain",
			});
		if (path === "/repos/upstream/project") {
			return json({
				id: 10,
				name: "project",
				owner: { login: repo.owner },
				archived: false,
				disabled: false,
				allow_squash_merge: (options.merges ?? ["squash", "merge", "rebase"]).includes("squash"),
				allow_merge_commit: (options.merges ?? ["squash", "merge", "rebase"]).includes("merge"),
				allow_rebase_merge: (options.merges ?? ["squash", "merge", "rebase"]).includes("rebase"),
			});
		}
		if (method !== "GET")
			return options.failMutation
				? json({ secret: "DO-NOT-LOG" }, 422)
				: json({ id: 100, html_url: "https://github.com/upstream/project/pull/100" });
		if (path.includes("/contents/quest/")) return json({ path: "quest/one.md", content: "ZmFrZQ==" });
		if (path.includes("/check-runs")) return json({ total_count: 0, check_runs: [] });
		if (path.endsWith("/status")) return json({ total_count: 0, statuses: [] });
		if (/\/(issues|pulls)\/\d+$/.test(path)) return json({ number: 1 });
		throw new Error(`Unexpected request: ${method} ${path}`);
	});
	return { service: new GitHubService(testEnv, request as typeof fetch), requests };
}

describe("trusted App operations", () => {
	it("accepts current maintain authority and scopes/revokes a comment token", async () => {
		const { service, requests } = github();
		expect(await service.comment(repo, "app-test", 1, "Approved")).toMatchObject({ id: 100 });
		expect(requests.find((r) => r.path.endsWith("/access_tokens"))?.body).toEqual({
			repository_ids: [10],
			permissions: { metadata: "read", issues: "write" },
		});
		expect(requests.at(-1)).toMatchObject({
			path: "/installation/token",
			method: "DELETE",
			authorization: "Bearer upstream-token",
		});
		const jwt = requests[0]!.authorization.slice(7).split(".");
		expect(JSON.parse(Buffer.from(jwt[0]!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
		expect(JSON.parse(Buffer.from(jwt[1]!, "base64url").toString())).toMatchObject({ iss: "123" });
		expect(
			verify(
				"RSA-SHA256",
				Buffer.from(jwt.slice(0, 2).join(".")),
				createPublicKey(privateKey),
				Buffer.from(jwt[2]!, "base64url"),
			),
		).toBe(true);
	});
	it.each(["write", "triage", "custom-writer"])("rejects %s role before publishing", async (role) => {
		const { service, requests } = github({ role });
		await expect(service.comment(repo, "app-test", 1, "Approved")).rejects.toThrow("maintainer authority");
		expect(requests.some((r) => r.path.endsWith("/comments"))).toBe(false);
		expect(requests.at(-1)?.method).toBe("DELETE");
	});
	it("rejects browser-like user claims and mismatched linked identities", async () => {
		await expect(github().service.comment(repo, "forged-user", 1, "Approved")).rejects.toThrow(
			"Linked GitHub identity",
		);
		await expect(github({ account: 99 }).service.comment(repo, "app-test", 1, "Approved")).rejects.toThrow(
			"identity changed",
		);
	});
	it("gates deleted installations before minting, independently checks live revocation", async () => {
		await delivery("installation", installation("deleted"));
		const { service, requests } = github();
		await expect(service.comment(repo, "app-test", 1, "Approved")).rejects.toThrow("revoked");
		expect(requests.some((r) => r.path.endsWith("/access_tokens"))).toBe(false);
		await delivery("installation", installation("created")); // delayed/new event cannot restore live access
		await expect(github({ missing: true }).service.comment(repo, "app-test", 1, "Approved")).rejects.toThrow("404");
		await expect(github({ suspended: true }).service.comment(repo, "app-test", 1, "Approved")).rejects.toThrow(
			"unavailable",
		);
	});
	it("fails closed on reduced installation permissions", async () => {
		const { service, requests } = github({ permissions: { metadata: "read", issues: "read" } });
		await expect(service.comment(repo, "app-test", 1, "Approved")).rejects.toThrow("issues permission");
		expect(requests.length).toBe(1);
	});
	it.each([
		[["squash", "merge", "rebase"], "squash"],
		[["merge", "rebase"], "merge"],
		[["rebase"], "rebase"],
	] as const)("pins explicit merges to the approved commit SHA with %j allowed", async (merges, method) => {
		const { service, requests } = github({ merges: [...merges] });
		await service.mergePullRequest(repo, "app-test", 1, "a".repeat(40));
		expect(requests.find((r) => r.path.endsWith("/merge"))?.body).toEqual({
			sha: "a".repeat(40),
			merge_method: method,
		});
		expect(requests.find((r) => r.path.endsWith("/access_tokens"))?.body.permissions).toEqual({
			metadata: "read",
			contents: "write",
			pull_requests: "write",
		});
	});
	it("refuses to merge when the repository allows no merge method", async () => {
		const { service, requests } = github({ merges: [] });
		await expect(service.mergePullRequest(repo, "app-test", 1, "a".repeat(40))).rejects.toThrow("no merge method");
		expect(requests.some((r) => r.path.endsWith("/merge"))).toBe(false);
	});
	it("reads provider data with read-only permissions", async () => {
		const { service, requests } = github();
		await service.readQuest(repo, "app-test", "quest/one.md", "a".repeat(40));
		await service.readIssue(repo, "app-test", 1);
		await service.readPullRequest(repo, "app-test", 1);
		await service.readChecks(repo, "app-test", "a".repeat(40));
		expect(
			requests
				.filter((r) => r.path.endsWith("/access_tokens"))
				.every((r) => Object.values(r.body.permissions).every((p) => p === "read")),
		).toBe(true);
	});
	it("does not retry completed writes when token cleanup fails or leak provider errors", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { service, requests } = github({ cleanupFails: true });
			await expect(service.comment(repo, "app-test", 1, "Approved")).resolves.toMatchObject({ id: 100 });
			expect(requests.filter((r) => r.path.endsWith("/comments"))).toHaveLength(1);
			expect(log).toHaveBeenCalledWith({ event: "github_token_revocation_failed" });
			await expect(
				github({ failMutation: true }).service.comment(repo, "app-test", 1, "Approved"),
			).rejects.toThrow("GitHub request failed (422)");
		} finally {
			log.mockRestore();
		}
	});
});
