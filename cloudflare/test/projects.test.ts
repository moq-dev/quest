import { env } from "cloudflare:workers";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { readBoard } from "../src/board/model";
import { type ActivityPage, associatedQuest, RETENTION, readActivity } from "../src/github/state";
import { GitHubService } from "../src/github/service";
import { privateKey } from "./github-key";
import { identity, oauth, origin } from "./login-fixtures";
import { delivery } from "./project-fixtures";

const testEnv = { ...env, GITHUB_APP_PRIVATE_KEY: privateKey };
const repo = { owner: "upstream", name: "project", id: 10 };
const commit = "a".repeat(40);
const tree = "b".repeat(40);
function blobOid(content: string) {
	const bytes = Buffer.from(content, "utf8");
	return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}
const documents = [
	{
		path: "quest/README.md",
		content:
			"# Project\n\n## Goal\n\nBuild it.\n\n## Required\n\n- [First](/quest/first.md)\n- [Second](/quest/second.md)\n",
	},
	{ path: "quest/first.md", content: "# [S] First\n\n## Goal\n\nBuild first.\n" },
	{
		path: "quest/second.md",
		content: "# [M] Second\n\n## Goal\n\nBuild second.\n\n## Required\n\n- [First](/quest/first.md)\n",
	},
];

function github(
	options: {
		role?: string;
		activity?: ActivityPage;
		/** What a read by number finds, by number; otherwise the activity page's entity with it. */
		entities?: Record<number, unknown>;
		onActivity?: () => Promise<void>;
		activityErrors?: boolean;
		repositoryName?: string;
		repositoryOwner?: string;
		installation?: number;
		account?: number;
		private?: boolean;
		archived?: boolean;
		disabled?: boolean;
		missing?: boolean;
		suspended?: boolean;
		id?: number;
		truncated?: boolean;
		noQuests?: boolean;
		invalid?: boolean;
		documents?: typeof documents;
		subrequestLimit?: number;
		graphqlErrors?: boolean;
		missingBlob?: boolean;
		missingRepository?: boolean;
		blob?: { oid?: string; text?: string | null; isBinary?: boolean | null; isTruncated?: boolean };
		symlink?: boolean;
		license?: string | null;
		changedLicense?: string | null;
		approval?: boolean[];
		licenseData?: unknown;
		licenseStatus?: number;
		licenseFails?: boolean;
		onLicenseRead?: () => void;
	} = {},
) {
	const repositoryName = options.repositoryName ?? repo.name;
	const repositoryOwner = options.repositoryOwner ?? repo.owner;
	const repositoryBase = `/repos/${repositoryOwner}/${repositoryName}`;
	const snapshot = (options.documents ?? documents).map((doc, i) => ({
		...doc,
		content: options.invalid && i === 1 ? "# Bad quest" : doc.content,
	}));
	let repositoryReads = 0;
	let licenseReads = 0;
	const calls: { path: string; method: string; body: any; authorization: string | null }[] = [];
	const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const path = url.pathname;
		calls.push({
			path: path + url.search,
			method: init?.method ?? "GET",
			body: init?.body && JSON.parse(String(init.body)),
			authorization: new Headers(init?.headers).get("Authorization"),
		});
		if (options.subrequestLimit !== undefined && calls.length > options.subrequestLimit)
			throw new Error("Worker subrequest limit exceeded");
		if (url.hostname === "spdx.org") {
			licenseReads++;
			options.onLicenseRead?.();
			if (options.licenseFails) throw new TypeError("Network unavailable");
			const licenseId = decodeURIComponent(
				path
					.split("/")
					.at(-1)!
					.replace(/\.json$/, ""),
			);
			return Response.json(
				options.licenseData ?? {
					licenseId,
					isOsiApproved: options.approval?.[Math.min(licenseReads - 1, options.approval.length - 1)] ?? true,
				},
				{ status: options.licenseStatus ?? 200 },
			);
		}
		if (path === "/app") return Response.json({ id: 123, slug: "quest-test" });
		if (path.endsWith("/installation"))
			return Response.json(
				options.missing
					? {}
					: {
							id: options.installation ?? 5,
							app_id: 123,
							suspended_at: options.suspended ? "2026-10-15" : null,
							permissions: {
								metadata: "read",
								contents: "read",
								issues: "read",
								pull_requests: "read",
								checks: "read",
								statuses: "read",
							},
						},
				{ status: options.missing ? 404 : 200 },
			);
		if (path.endsWith("/access_tokens")) return Response.json({ token: "installation-token" });
		if (path === "/installation/token") return new Response(null, { status: 204 });
		if (path === repositoryBase) {
			repositoryReads++;
			const detected =
				repositoryReads > 1 && options.changedLicense !== undefined
					? options.changedLicense
					: options.license === undefined
						? "MIT"
						: options.license;
			return Response.json({
				...repo,
				name: repositoryName,
				id: options.id ?? repo.id,
				owner: { login: repositoryOwner },
				private: options.private ?? false,
				visibility: options.private ? "private" : "public",
				default_branch: "trunk",
				archived: options.archived ?? false,
				disabled: options.disabled ?? false,
				license: detected ? { spdx_id: detected, name: `${detected} License` } : null,
			});
		}
		if (path.startsWith("/user/"))
			return Response.json({ id: Number(path.split("/").at(-1)), login: "maintainer" });
		if (path.endsWith("/permission")) {
			return Response.json({
				user: { id: options.account ?? 7007 },
				permission: options.role === "admin" ? "admin" : "write",
				role_name: options.role ?? "maintain",
			});
		}
		if (path === `${repositoryBase}/commits/trunk`)
			return Response.json({ sha: commit, commit: { tree: { sha: tree } } });
		if (path === `${repositoryBase}/git/trees/${tree}`)
			return Response.json({
				truncated: options.truncated ?? false,
				tree: options.noQuests
					? []
					: [
							{ path: "quest", type: "tree", mode: "040000", sha: "c".repeat(40) },
							...snapshot.map((doc) => ({
								path: doc.path,
								type: "blob",
								mode: options.symlink ? "120000" : "100644",
								sha: blobOid(doc.content),
							})),
						],
			});
		if (path.includes("/git/blobs/")) {
			const doc = snapshot.find((doc) => blobOid(doc.content) === path.split("/").at(-1));
			if (!doc) throw new Error("Unknown blob");
			return Response.json({ encoding: "base64", content: Buffer.from(doc.content).toString("base64") });
		}
		if (path === "/graphql") {
			const query = JSON.parse(String(init?.body)).query as string;
			if (!query.includes("object(oid:")) {
				await options.onActivity?.();
				const page = options.activity ?? activity();
				const repository: Record<string, unknown> = { ...page };
				const errors: unknown[] = options.activityErrors ? [{ message: "partial" }] : [];
				for (const [, alias, field, number] of query.matchAll(
					/([sb]\d+):(issue|pullRequest)\(number:(\d+)\)/g,
				)) {
					const nodes = (field === "issue" ? [page.issues] : [page.pullRequests, page.open]).flatMap(
						(c) => c?.nodes ?? [],
					);
					const found =
						options.entities && Number(number) in options.entities
							? options.entities[Number(number)]
							: (nodes.find((node) => node.number === Number(number)) ?? null);
					repository[alias!] =
						found && alias!.startsWith("b")
							? { ...found, body: (found as { body?: string }).body ?? "" }
							: found;
					if (!found) errors.push({ type: "NOT_FOUND", path: ["repository", alias] });
				}
				return Response.json({ data: { repository }, errors: errors.length ? errors : undefined });
			}

			const body = calls.at(-1)!.body;
			expect(body.variables).toEqual({ owner: repositoryOwner, name: repositoryName });
			const blobs = Object.fromEntries(
				[...body.query.matchAll(/(q\d+): object\(oid: "([a-f0-9]{40})"\)/g)].map(([, alias, oid]) => {
					const doc = snapshot.find((doc) => blobOid(doc.content) === oid);
					if (!doc) throw new Error("Unknown blob");
					return [
						alias,
						options.missingBlob
							? null
							: { oid, text: doc.content, isBinary: false, isTruncated: false, ...options.blob },
					];
				}),
			);

			return Response.json({
				data: { repository: options.missingRepository ? null : blobs },
				errors: options.graphqlErrors ? [{ message: "Partial result" }] : undefined,
			});
		}
		throw new Error(`Unexpected GitHub request ${path}`);
	});
	return { calls, request, service: new GitHubService(testEnv, request as typeof fetch) };
}

async function state() {
	return env.DB.prepare("SELECT * FROM github_projects WHERE id=10").first<{ state: string }>();
}

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('enrollment-test','Maintainer','enrollment-test@example.test',1,0,0)",
		),
		env.DB.prepare(
			"INSERT INTO account(id,accountId,providerId,userId,createdAt,updatedAt) VALUES('enrollment-account','7007','github','enrollment-test',0,0)",
		),
	]);
});
afterEach(() => vi.restoreAllMocks());

describe("project enrollment", () => {
	it("keeps App installation and read-only default-branch preview separate from opt-in", async () => {
		const { service, calls } = github();
		expect(await service.installationURL()).toBe("https://github.com/apps/quest-test/installations/new");
		expect(await service.resolveRepository(repo.owner, repo.name)).toEqual(repo);
		expect(await service.previewProject(repo, "enrollment-test")).toMatchObject({
			commit,
			branch: "trunk",
			state: null,
			quests: [{ path: "quest/first.md", title: "[S] First" }],
		});
		expect(await state()).toBeNull();
		expect(
			calls
				.filter((call) => call.path === "/repos/upstream/project")
				.every((call) => call.authorization === "Bearer installation-token"),
		).toBe(true);
		expect(calls.filter((call) => call.path.endsWith("/access_tokens")).map((call) => call.body)).toEqual([
			{ repositories: ["project"], permissions: { metadata: "read" } },
			{ repository_ids: [10], permissions: { metadata: "read", contents: "read" } },
		]);
		expect(calls.some((call) => call.path === `/repos/upstream/project/git/trees/${tree}?recursive=1`)).toBe(true);
		expect(calls.at(-1)?.path).toBe("/installation/token");
	});
	it.each(["AGENTS.md", "CLAUDE.md"])("ignores root and nested %s instructions like the CLI", async (filename) => {
		const { service, calls } = github({
			documents: [
				...documents,
				{ path: `quest/${filename}`, content: "Repository instructions, not a quest." },
				{ path: `quest/nested/${filename}`, content: "Nested instructions, not a quest." },
			],
		});
		expect((await service.previewProject(repo, "enrollment-test")).quests).toEqual([
			{ path: "quest/first.md", title: "[S] First" },
		]);
		await service.setContributions(repo, "enrollment-test", "enabled");
		expect(await state()).toMatchObject({ state: "enabled" });
		expect(
			calls
				.filter((call) => call.path === "/graphql")
				.every(
					(call) =>
						!call.body.query.includes(blobOid("Repository instructions, not a quest.")) &&
						!call.body.query.includes(blobOid("Nested instructions, not a quest.")),
				),
		).toBe(true);
	});
	it("enables a 38-document project within Workers Free's 50 external subrequests", async () => {
		const quests = Array.from({ length: 37 }, (_, i) => ({
			path: `quest/quest-${i}.md`,
			content: `# [S] Quest ${i}\n\n## Goal\n\nBuild it.\n`,
		}));
		const snapshot = [
			{
				path: "quest/README.md",
				content: `# Project\n\n## Goal\n\nBuild it.\n\n## Required\n\n${quests.map((q, i) => `- [Quest ${i}](/${q.path})`).join("\n")}\n`,
			},
			...quests,
		];
		const { service, calls } = github({ documents: snapshot, subrequestLimit: 50 });
		// Enrollment routes resolve the submitted repository before enabling it.
		await service.resolveRepository(repo.owner, repo.name);
		await service.setContributions(repo, "enrollment-test", "enabled");
		expect(await state()).toMatchObject({ state: "enabled" });
		expect(calls.length).toBeLessThanOrEqual(50);
		expect(calls.filter((call) => call.path === "/graphql")).toHaveLength(1);
		expect(calls.some((call) => call.path.includes("/git/blobs/"))).toBe(false);
		expect(calls.find((call) => call.path === "/graphql")?.authorization).toBe("Bearer installation-token");
		expect(calls.at(-1)?.path).toBe("/installation/token");
	});
	it.each([
		{ graphqlErrors: true },
		{ missingBlob: true },
		{ missingRepository: true },
		{ blob: { isTruncated: true } },
		{ blob: { isBinary: true } },
		{ blob: { isBinary: null } },
		{ blob: { text: null } },
		{ blob: { oid: "f".repeat(40) } },
		{ blob: { text: "# Replaced text\n\n## Goal\n\nDifferent content.\n" } },
	])("rejects incomplete or altered batched content: %j", async (options) => {
		const { service, calls } = github(options);
		await expect(service.setContributions(repo, "enrollment-test", "enabled")).rejects.toThrow(
			"Quest content unavailable",
		);
		expect(await state()).toBeNull();
		expect(calls.at(-1)?.path).toBe("/installation/token");
	});
	it.each(["MIT", "Apache-2.0", "GPL-3.0"])("enrolls GitHub-detected OSI-approved %s licensing", async (license) => {
		const { service, calls } = github({ license });
		await service.setContributions(repo, "enrollment-test", "enabled");
		expect(await state()).toMatchObject({ state: "enabled" });
		const lookups = calls.filter((call) => call.path === `/licenses/${license}.json`);
		expect(lookups).toHaveLength(2);
		expect(lookups.every((call) => call.authorization === null)).toBe(true);
	});
	it.each([
		{ license: null },
		{ license: "NOASSERTION" },
		{ license: "LicenseRef-custom", licenseStatus: 404 },
		{ license: "BUSL-1.1", approval: [false] },
		{ license: "MIT", licenseData: { licenseId: "Apache-2.0", isOsiApproved: true } },
	])("rejects unsupported or unmatched detected licenses: %j", async (options) => {
		const { service } = github(options);
		expect((await service.previewProject(repo, "enrollment-test")).licenseError).toContain(
			"GitHub must detect an OSI-approved license",
		);
		await expect(service.setContributions(repo, "enrollment-test", "enabled")).rejects.toThrow(
			"OSI-approved license",
		);
		expect(await state()).toBeNull();
	});
	it.each([
		{ licenseStatus: 503 },
		{ licenseFails: true },
		{ licenseData: {} },
		{ licenseData: { licenseId: "MIT", isOsiApproved: "true" } },
	])("fails closed when approval metadata is unavailable or invalid: %j", async (options) => {
		await expect(github(options).service.setContributions(repo, "enrollment-test", "enabled")).rejects.toThrow(
			"could not be verified",
		);
		expect(await state()).toBeNull();
	});
	it("rejects changes to the detected license and revoked OSI approval during opt-in", async () => {
		await expect(
			github({ changedLicense: "BUSL-1.1" }).service.setContributions(repo, "enrollment-test", "enabled"),
		).rejects.toThrow("eligibility changed");
		await expect(
			github({ approval: [true, false] }).service.setContributions(repo, "enrollment-test", "enabled"),
		).rejects.toThrow("OSI-approved license");
		expect(await state()).toBeNull();
	});
	it("rechecks licensing and OSI approval on resume instead of reusing enrollment eligibility", async () => {
		await github().service.setContributions(repo, "enrollment-test", "enabled");
		await github().service.setContributions(repo, "enrollment-test", "paused");
		for (const options of [{ license: null }, { license: "BUSL-1.1", approval: [false] }, { approval: [false] }]) {
			await expect(github(options).service.setContributions(repo, "enrollment-test", "enabled")).rejects.toThrow(
				"OSI-approved license",
			);
			expect(await state()).toMatchObject({ state: "paused" });
		}
	});
	it("persists explicit opt-in, pauses new work, resumes only through eligibility, and disconnects", async () => {
		const { service, calls } = github();
		await service.setContributions(repo, "enrollment-test", "enabled");
		expect(await state()).toMatchObject({ state: "enabled" });
		expect(await service.projects("enrollment-test")).toEqual([{ ...repo, state: "enabled" }]);
		await service.setContributions(repo, "enrollment-test", "paused");
		expect(await state()).toMatchObject({ state: "paused" });
		await service.setContributions(repo, "enrollment-test", "enabled");
		expect(await service.previewProject(repo, "enrollment-test")).toMatchObject({ state: "enabled" });
		await service.setContributions(repo, "enrollment-test", "disconnected");
		expect(await state()).toBeNull();
		expect(calls.filter((call) => call.path.endsWith("/permission"))).toHaveLength(7);
		expect(
			calls
				.filter((call) => call.method !== "GET")
				.every(
					(call) =>
						call.path.endsWith("/access_tokens") ||
						call.path === "/installation/token" ||
						(call.path === "/graphql" && call.body.query.startsWith("query(")),
				),
		).toBe(true);
	});
	it.each([{ archived: true }, { disabled: true }])(
		"can stop an unavailable project without enabling it: %j",
		async (options) => {
			await github().service.setContributions(repo, "enrollment-test", "enabled");
			const { service, calls } = github(options);
			await expect(service.previewProject(repo, "enrollment-test")).rejects.toThrow("availability");
			await expect(service.setContributions(repo, "enrollment-test", "enabled")).rejects.toThrow("availability");
			await service.setContributions(repo, "enrollment-test", "paused");
			expect(await state()).toMatchObject({ state: "paused" });
			await expect(
				github({ ...options, role: "write" }).service.setContributions(repo, "enrollment-test", "disconnected"),
			).rejects.toThrow("maintainer authority");
			await service.setContributions(repo, "enrollment-test", "disconnected");
			expect(await state()).toBeNull();
			expect(calls.some((call) => call.path.includes("/git/") || call.path === "/graphql")).toBe(false);
		},
	);
	it("can pause and disconnect even after Quest files disappear or the project becomes private", async () => {
		await github().service.setContributions(repo, "enrollment-test", "enabled");
		const { service, calls } = github({ noQuests: true, private: true });
		await service.setContributions(repo, "enrollment-test", "paused");
		expect(await state()).toMatchObject({ state: "paused" });
		await service.setContributions(repo, "enrollment-test", "disconnected");
		expect(await state()).toBeNull();
		expect(calls.some((call) => call.path.includes("/git/"))).toBe(false);
	});
	it.each(["write", "triage", "custom-writer"])("rejects %s authority on every control", async (role) => {
		for (const change of ["enabled", "paused", "disconnected"] as const)
			await expect(github({ role }).service.setContributions(repo, "enrollment-test", change)).rejects.toThrow(
				"maintainer authority",
			);
		expect(await state()).toBeNull();
	});
	it.each([
		[{ missing: true }, "404"],
		[{ suspended: true }, "unavailable"],
		[{ id: 99 }, "identity"],
		[{ private: true }, "public"],
		[{ truncated: true }, "incomplete"],
		[{ noQuests: true }, "setup guide"],
		[{ invalid: true }, "quest check"],
		[{ symlink: true }, "regular files"],
	] as const)("rejects unavailable or ineligible snapshots: %j", async (options, message) => {
		await expect(github(options).service.setContributions(repo, "enrollment-test", "enabled")).rejects.toThrow(
			message,
		);
		expect(await state()).toBeNull();
	});
	it("rechecks authority after snapshot and eligibility checks before saving opt-in", async () => {
		const options = {
			role: "maintain",
			onLicenseRead: () => {
				options.role = "write";
			},
		};
		await expect(github(options).service.setContributions(repo, "enrollment-test", "enabled")).rejects.toThrow(
			"maintainer authority",
		);
		expect(await state()).toBeNull();
	});
	it("does not trust the enrollment record as authority after role revocation", async () => {
		await github().service.setContributions(repo, "enrollment-test", "enabled");
		await expect(
			github({ role: "write" }).service.setContributions(repo, "enrollment-test", "disconnected"),
		).rejects.toThrow("maintainer authority");
		expect(await state()).toMatchObject({ state: "enabled" });
	});
});

describe("project setup routes", () => {
	it.each([
		{ private: true, repositoryName: repo.name },
		{ archived: true, repositoryName: repo.name },
		{ invalid: true, repositoryName: repo.name },
		{ private: true, repositoryName: "renamed" },
		{ archived: true, repositoryName: "renamed" },
		{ invalid: true, repositoryName: "renamed" },
	])("lets a replacement maintainer reach stop controls when preview fails: %j", async (options) => {
		await github().service.setContributions(repo, "enrollment-test", "enabled");
		const who = identity("github");
		const { session } = await oauth(who);
		const account = await env.DB.prepare("SELECT userId FROM account WHERE providerId='github' AND accountId=?")
			.bind(who.id)
			.first<{ userId: string }>();
		expect(account!.userId).not.toBe("enrollment-test");
		expect(await github().service.projects(account!.userId)).toEqual([]);
		const { request } = github({ ...options, account: Number(who.id) });
		const route = `${origin}/projects/github/upstream/${options.repositoryName}`;
		vi.spyOn(globalThis, "fetch").mockImplementation(request as typeof fetch);
		const response = await app.request(route, { headers: { Cookie: session! } }, testEnv);
		expect(response.status).toBe(403);
		const html = await response.text();
		expect(html).toContain('name="id" value="10"');
		expect(html).toContain('name="state" value="paused"');
		expect(html).toContain('name="state" value="disconnected"');
		expect(await env.DB.prepare("SELECT name FROM github_projects WHERE id=10").first()).toEqual({
			name: options.repositoryName,
		});
		// Passing the maintainer check joins the project's inbox even when its preview fails.
		expect(await github().service.projects(account!.userId)).toEqual([expect.objectContaining({ id: 10 })]);
		for (const next of ["paused", "disconnected"]) {
			const stopped = await app.request(
				route,
				{
					method: "POST",
					headers: { Cookie: session!, Origin: origin },
					body: new URLSearchParams({ id: "10", state: next }),
				},
				testEnv,
			);
			expect(stopped.status).toBe(303);
		}
		expect(await state()).toBeNull();
		// Disconnecting removes every maintainer's membership with the project.
		expect(await env.DB.prepare("SELECT count(*) AS n FROM github_project_members").first()).toEqual({ n: 0 });
	});

	it("keeps stop controls after transfer without inheriting opt-in for the new installation", async () => {
		await github().service.setContributions(repo, "enrollment-test", "enabled");
		const who = identity("github");
		const { session } = await oauth(who);
		const { request } = github({ account: Number(who.id), repositoryOwner: "receiving", installation: 6 });
		vi.spyOn(globalThis, "fetch").mockImplementation(request as typeof fetch);
		const route = `${origin}/projects/github/receiving/project`;
		const response = await app.request(route, { headers: { Cookie: session! } }, testEnv);
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("The App installation changed");
		expect(html).toContain("Enable contributions");
		expect(html).toContain('name="state" value="paused"');
		expect(html).toContain('name="state" value="disconnected"');
		const row = () => env.DB.prepare("SELECT installation,state FROM github_projects WHERE id=10").first();
		expect(await row()).toEqual({ installation: 5, state: "enabled" });
		const post = (state: string) =>
			app.request(
				route,
				{
					method: "POST",
					headers: { Cookie: session!, Origin: origin },
					body: new URLSearchParams({ id: "10", state }),
				},
				testEnv,
			);
		expect((await post("paused")).status).toBe(303);
		expect(await row()).toEqual({ installation: 5, state: "paused" });
		expect((await post("enabled")).status).toBe(303);
		expect(await row()).toEqual({ installation: 6, state: "enabled" });
		expect((await post("disconnected")).status).toBe(303);
		expect(await state()).toBeNull();
	});
	it("does not expose enrolled stop controls or accept their forms without current authority", async () => {
		await github().service.setContributions(repo, "enrollment-test", "enabled");
		const who = identity("github");
		const { session } = await oauth(who);
		const { request } = github({ account: Number(who.id), role: "write", private: true });
		vi.spyOn(globalThis, "fetch").mockImplementation(request as typeof fetch);
		const response = await app.request(
			`${origin}/projects/github/upstream/project`,
			{ headers: { Cookie: session! } },
			testEnv,
		);
		expect(response.status).toBe(403);
		const html = await response.text();
		expect(html).not.toContain("Pause contributions");
		expect(html).not.toContain("Disconnect project");
		expect(html).not.toContain('name="id" value="10"');
		const posted = await app.request(
			`${origin}/projects/github/upstream/project`,
			{
				method: "POST",
				headers: { Cookie: session!, Origin: origin },
				body: new URLSearchParams({ id: "10", state: "paused" }),
			},
			testEnv,
		);
		expect(posted.status).toBe(403);
		expect(await state()).toMatchObject({ state: "enabled" });
	});
	it("requires a session and same-origin posts, validates choices before provider requests", async () => {
		expect((await app.request(`${origin}/projects`, undefined, testEnv)).headers.get("location")).toBe(
			"/sign-in?next=/projects",
		);
		const input = { method: "POST", body: new URLSearchParams({ id: "10", state: "enabled" }) };
		expect((await app.request(`${origin}/projects/github/upstream/project`, input, testEnv)).status).toBe(403);
		expect(
			(
				await app.request(
					`${origin}/projects/github/upstream/project`,
					{ ...input, headers: { Origin: origin } },
					testEnv,
				)
			).status,
		).toBe(401);
		expect(
			(await app.request(`${origin}/projects/select?repository=//evil.example`, undefined, testEnv)).headers.get(
				"location",
			),
		).toBe("/projects?error=repository");
	});
	it("disables opt-in for unapproved licensing and rejects a forged enable form", async () => {
		const who = identity("github");
		const { session } = await oauth(who);
		const { request } = github({ account: Number(who.id), license: "BUSL-1.1", approval: [false, false] });
		vi.spyOn(globalThis, "fetch").mockImplementation(request as typeof fetch);
		const response = await app.request(
			`${origin}/projects/github/upstream/project`,
			{ headers: { Cookie: session! } },
			testEnv,
		);
		const html = await response.text();
		expect(html).toContain("disabled");
		expect(html).toContain("GitHub must detect an OSI-approved license");
		const posted = await app.request(
			`${origin}/projects/github/upstream/project`,
			{
				method: "POST",
				headers: { Cookie: session!, Origin: origin },
				body: new URLSearchParams({ id: "10", state: "enabled" }),
			},
			testEnv,
		);
		expect(posted.status).toBe(403);
		expect(await state()).toBeNull();
	});
	it("renders ready quests in the existing visual system and enables eligible repositories through authenticated forms", async () => {
		const who = identity("github");
		const { session } = await oauth(who);
		// The fixture verifies the actual linked account supplied by this session.
		const { request } = github({ account: Number(who.id) });
		vi.spyOn(globalThis, "fetch").mockImplementation(request as typeof fetch);
		const response = await app.request(
			`${origin}/projects/github/upstream/project`,
			{ headers: { Cookie: session! } },
			testEnv,
		);
		expect(response.status).toBe(200);
		const html = await response.text();
		for (const content of [
			"/theme/theme.css",
			"ql-panel panel",
			"Ready quests",
			"First",
			"trunk",
			"no second approval flag",
			"OSI-approved license",
		])
			expect(html).toContain(content);
		expect(html).not.toContain(">Second<");
		expect(html).not.toContain("disabled");
		const posted = await app.request(
			`${origin}/projects/github/upstream/project`,
			{
				method: "POST",
				headers: { Cookie: session!, Origin: origin },
				body: new URLSearchParams({ id: "10", state: "enabled" }),
			},
			testEnv,
		);
		expect(posted.status).toBe(303);
		expect(await state()).toMatchObject({ state: "enabled" });
		// Authenticated stop controls do not depend on readable Quest snapshots.
		const unavailable = github({ account: Number(who.id), noQuests: true, private: true });
		vi.mocked(globalThis.fetch).mockImplementation(unavailable.request as typeof fetch);
		for (const state of ["paused", "disconnected"]) {
			const stopped = await app.request(
				`${origin}/projects/github/upstream/project`,
				{
					method: "POST",
					headers: { Cookie: session!, Origin: origin },
					body: new URLSearchParams({ id: "10", state }),
				},
				testEnv,
			);
			expect(stopped.status).toBe(303);
		}
		expect(await state()).toBeNull();
	});
});

/** A listed repository: public, MIT-licensed, maintained, with a quest directory unless the test says otherwise. */
type Listed = {
	id: number;
	name: string;
	role?: "admin" | "maintain" | "push";
	private?: boolean;
	archived?: boolean;
	license?: string | null;
	quest?: { name: string; type: string }[] | null;
};

/**
 * GitHub as the picker's user token sees it: the App's installations the user
 * reaches, their repositories with the user's role, and each default branch's
 * `quest` directory. Any other request fails the test.
 */
function picker(installations: { id: number; app_id?: number; suspended?: boolean; repos: Listed[] }[]) {
	const calls: { url: string; authorization: string | null }[] = [];
	const repos = installations.flatMap((installation) => installation.repos);
	const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		calls.push({ url: url.href, authorization: new Headers(init?.headers).get("Authorization") });
		if (url.hostname === "spdx.org") {
			const licenseId = decodeURIComponent(
				url.pathname
					.split("/")
					.at(-1)!
					.replace(/\.json$/, ""),
			);
			return Response.json({ licenseId, isOsiApproved: licenseId !== "BUSL-1.1" });
		}
		const page = Number(url.searchParams.get("page"));
		const slice = <T>(items: T[]) => items.slice((page - 1) * 100, page * 100);
		if (url.pathname === "/app") return Response.json({ id: 123, slug: "quest-test" });
		if (url.pathname === "/user/installations") {
			const listed = installations.map((installation) => ({
				id: installation.id,
				app_id: installation.app_id ?? 123,
				suspended_at: installation.suspended ? "2026-10-30" : null,
				permissions: { metadata: "read" },
			}));
			return Response.json({ total_count: listed.length, installations: slice(listed) });
		}
		const listing = url.pathname.match(/^\/user\/installations\/(\d+)\/repositories$/);
		if (listing) {
			const installation = installations.find((installation) => installation.id === Number(listing[1]))!;
			const listed = installation.repos.map((repo) => ({
				id: repo.id,
				name: repo.name,
				owner: { login: "upstream" },
				private: repo.private ?? false,
				visibility: repo.private ? "private" : "public",
				archived: repo.archived ?? false,
				disabled: false,
				default_branch: "trunk",
				license: repo.license === null ? null : { spdx_id: repo.license ?? "MIT", name: "License" },
				permissions: {
					admin: repo.role === "admin",
					maintain: (repo.role ?? "maintain") !== "push",
					push: true,
					pull: true,
				},
			}));
			return Response.json({ total_count: listed.length, repositories: slice(listed) });
		}
		if (url.pathname === "/graphql") {
			const { query, variables } = JSON.parse(String(init?.body)) as {
				query: string;
				variables: Record<string, string>;
			};
			const data: Record<string, unknown> = {};
			for (const [, alias, index] of query.matchAll(/(r(\d+)): repository/g)) {
				const repo = repos.find((repo) => repo.name === variables[`n${index}`])!;
				expect(variables[`o${index}`]).toBe("upstream");
				const entries = repo.quest === undefined ? [{ name: "README.md", type: "blob" }] : repo.quest;
				data[alias!] = { databaseId: repo.id, object: entries && { entries } };
			}
			return Response.json({ data });
		}
		throw new Error(`Unexpected GitHub request ${url.pathname}`);
	});
	return { calls, request, service: new GitHubService(testEnv, request as typeof fetch) };
}

describe("project picker", () => {
	// Write access alone never lists a repository; a hundred of them push the list to a second page.
	const writers: Listed[] = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, name: `w${i}`, role: "push" }));
	const listed: Listed[] = [
		{ id: 10, name: "project", role: "admin" },
		{ id: 12, name: "secret", private: true },
		{ id: 13, name: "old", archived: true },
		{ id: 14, name: "bare", quest: null },
		{ id: 15, name: "instructions", quest: [{ name: "AGENTS.md", type: "blob" }] },
		{ id: 16, name: "nested", quest: [{ name: "m0", type: "tree" }] },
		{ id: 17, name: "source", license: "BUSL-1.1" },
		{ id: 18, name: "unlicensed", license: null },
		{ id: 19, name: "paused" },
		{ id: 20, name: "moved" },
	];
	const installations = [
		{ id: 5, repos: [...writers, ...listed] },
		{ id: 6, app_id: 999, repos: [{ id: 30, name: "other-app" }] },
		{ id: 7, suspended: true, repos: [{ id: 31, name: "suspended" }] },
	];
	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO github_projects(id,owner,name,installation,state,enrolledBy,updatedAt) VALUES(19,'upstream','paused',5,'paused','enrollment-test',0)",
			),
			// Enrolled under an earlier installation, so this one still needs an explicit opt-in.
			env.DB.prepare(
				"INSERT INTO github_projects(id,owner,name,installation,state,enrolledBy,updatedAt) VALUES(20,'upstream','moved',4,'enabled','enrollment-test',0)",
			),
		]);
	});

	it("lists maintained repositories across the App's installations with why each cannot be enabled", async () => {
		const { service, calls } = picker(installations);
		const candidates = await service.candidates("user-token");
		const rows = Object.fromEntries(
			candidates.map(({ name, state, problems, setup }) => [name, { state, problems, setup }]),
		);
		expect(Object.keys(rows)).toEqual([
			"bare",
			"instructions",
			"moved",
			"nested",
			"old",
			"paused",
			"project",
			"secret",
			"source",
			"unlicensed",
		]);
		const eligible = { state: null, problems: [], setup: false };
		expect(rows.project).toEqual(eligible);
		expect(rows.nested).toEqual(eligible);
		expect(rows.moved).toEqual(eligible);
		expect(rows.paused).toEqual({ state: "paused", problems: [], setup: false });
		expect(rows.secret).toEqual({
			state: null,
			problems: ["Private. Contributions need a public repository."],
			setup: false,
		});
		expect(rows.old).toEqual({ state: null, problems: ["Archived or disabled on GitHub."], setup: false });
		for (const name of ["bare", "instructions"])
			expect(rows[name]).toEqual({
				state: null,
				problems: ["No Quest files on the default branch yet."],
				setup: true,
			});
		for (const name of ["source", "unlicensed"])
			expect(rows[name]!.problems).toEqual([
				expect.stringContaining("GitHub must detect an OSI-approved license"),
			]);
		expect(candidates.find((candidate) => candidate.name === "project")).toMatchObject({
			id: 10,
			owner: "upstream",
		});

		// The user's token makes every GitHub read: no installation token, and a few requests in all.
		const github = calls.filter((call) => call.url.startsWith("https://api.github.com/"));
		expect(github.every((call) => call.authorization === "Bearer user-token")).toBe(true);
		expect(github.map((call) => call.url.replace("https://api.github.com", ""))).toEqual([
			"/user/installations?per_page=100&page=1",
			"/user/installations/5/repositories?per_page=100&page=1",
			"/user/installations/5/repositories?per_page=100&page=2",
			"/graphql",
		]);
		// One license lookup per distinct detected license; a missing one needs none.
		expect(calls.filter((call) => call.url.startsWith("https://spdx.org/")).map((call) => call.url)).toEqual([
			"https://spdx.org/licenses/MIT.json",
			"https://spdx.org/licenses/BUSL-1.1.json",
		]);
	});
	it("skips an installation the webhook gate has blocked", async () => {
		await env.DB.prepare("INSERT INTO github_installations(id,blocked,action) VALUES(5,1,'suspend')").run();
		const { service, calls } = picker(installations);
		expect(await service.candidates("user-token")).toEqual([]);
		expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/user/installations"]);
	});

	it("renders rows on the project setup page, whose Enable form opts in through the live checks", async () => {
		const who = identity("github");
		const { session } = await oauth(who);
		const listing = picker([
			{
				id: 5,
				repos: [
					{ id: 10, name: "project" },
					{ id: 14, name: "bare", quest: null },
				],
			},
		]);
		vi.spyOn(globalThis, "fetch").mockImplementation(listing.request as typeof fetch);
		const response = await app.request(`${origin}/projects`, { headers: { Cookie: session! } }, testEnv);
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("Your repositories");
		expect(html).toContain('action="/projects/github/upstream/project"');
		expect(html).toContain("Enable contributions");
		expect(html).toContain("No Quest files on the default branch yet.");
		expect(html).toContain('<a href="/setup">Set up Quest</a>');
		expect(html).not.toContain('action="/projects/github/upstream/bare"');
		expect(html).toContain("https://github.com/apps/quest-test/installations/new");
		// The session's GitHub sign-in token lists repositories.
		expect(
			listing.calls
				.filter((call) => new URL(call.url).pathname.startsWith("/user/"))
				.every((call) => call.authorization === "Bearer mock-token"),
		).toBe(true);
		// The row's form is the setup page's: enabling rechecks authority and eligibility with an installation token.
		vi.mocked(globalThis.fetch).mockImplementation(github({ account: Number(who.id) }).request as typeof fetch);
		const posted = await app.request(
			`${origin}/projects/github/upstream/project`,
			{
				method: "POST",
				headers: { Cookie: session!, Origin: origin },
				body: new URLSearchParams({ id: "10", state: "enabled" }),
			},
			testEnv,
		);
		expect(posted.status).toBe(303);
		expect(await state()).toMatchObject({ state: "enabled" });
	});
	it("asks to sign in with GitHub again when the user's token cannot list repositories", async () => {
		const { session } = await oauth(identity("github"));
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = new URL(String(input));
			if (url.pathname === "/app") return Response.json({ id: 123, slug: "quest-test" });
			return Response.json({ message: "Bad credentials" }, { status: 401 });
		});
		const html = await (await app.request(`${origin}/projects`, { headers: { Cookie: session! } }, testEnv)).text();
		expect(html).toContain("Your GitHub repositories could not be listed");
		expect(html).toContain("Find an enrolled project");
	});
	it("asks a user without a linked GitHub account to link one", async () => {
		const { session } = await oauth(identity("google"));
		const outbound = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = new URL(String(input));
			if (url.pathname === "/app") return Response.json({ id: 123, slug: "quest-test" });
			throw new Error(`Unexpected request ${url.href}`);
		});
		const html = await (await app.request(`${origin}/projects`, { headers: { Cookie: session! } }, testEnv)).text();
		expect(html).toContain(
			'<a href="/account">Link your GitHub account</a> to list the repositories you maintain.',
		);
		expect(outbound.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual(["/app"]);
	});
});

function connection<T>(nodes: T[], more = false, cursor: string | null = null) {
	return { nodes, pageInfo: { hasNextPage: more, endCursor: cursor } };
}
/** A quest branch that no merged PR left behind. */
function ref(name: string) {
	return {
		name,
		prefix: "refs/heads/quest/",
		target: { oid: "b".repeat(40) },
		associatedPullRequests: { nodes: [] },
	};
}
function issue(id = 100, number = 1) {
	return {
		databaseId: String(id),
		number,
		title: "Untrusted <script>title</script>",
		state: "OPEN",
		updatedAt: "2026-10-15T12:00:00Z",
		author: { login: "human" },
		comments: { totalCount: 0 },
	};
}
function pull(branch = "quest/first", id = 200) {
	return {
		...issue(id, id - 198),
		headRefName: branch,
		headRefOid: commit,
		isDraft: false,
		reviewDecision: "CHANGES_REQUESTED",
		reviews: { totalCount: 1 },
		latestReviews: {
			nodes: [{ state: "CHANGES_REQUESTED", author: { login: "reviewer" }, commit: { oid: commit } }],
			pageInfo: { hasNextPage: false },
		},
		commits: { nodes: [{ commit: { oid: commit, statusCheckRollup: { state: "FAILURE" } } }] },
	};
}
function activity(): ActivityPage {
	const pulls = [pull(), pull("human-branch", 201)];
	return {
		issues: connection([issue()]),
		pullRequests: connection(pulls),
		open: connection(pulls),
		refs: connection([ref("second")]),
	};
}
// A long history whose open PRs and quest branches fit in one page.
function history(): ActivityPage {
	return {
		issues: connection([issue()], true, "issue-cursor"),
		pullRequests: connection([pull("human-branch", 201)]),
		open: connection([]),
		refs: connection([]),
	};
}
const event = { installation: { id: 5 }, repository: { id: 10, default_branch: "trunk" } };

describe("enrolled project observations", () => {
	it("maps a branch to the quest it names, an epic by its README branch", () => {
		const paths = new Set(["quest/epic/README.md", "quest/epic/child.md"]);
		expect(associatedQuest("quest/epic/README", paths)).toBe("quest/epic/README.md");
		expect(associatedQuest("quest/epic/child", paths)).toBe("quest/epic/child.md");
		expect(associatedQuest("quest/epic", paths)).toBeNull();
	});
	async function enrolled() {
		await github().service.setContributions(repo, "enrollment-test", "enabled");
	}
	it("pins the shared board snapshot, includes human PRs, and excludes PR/branch claims from candidates", async () => {
		await enrolled();
		const { service, calls } = github({ subrequestLimit: 50 });
		const state = await service.projectState(repo, "enrollment-test", true);
		expect(state).toMatchObject({
			complete: true,
			claims: ["quest/second.md"],
			project: {
				commit,
				available: [],
				changes: [{ quest: "quest/first.md" }],
				issues: [{ title: issue().title }],
			},
		});
		expect(state!.activity).toHaveLength(3);
		expect(state!.activity.filter((item) => item.kind === "pull")).toHaveLength(2);
		expect(
			(state!.activity.find((item) => item.id === "200")!.data as ReturnType<typeof pull>).commits.nodes[0]!
				.commit,
		).toMatchObject({ oid: commit, statusCheckRollup: { state: "FAILURE" } });
		expect(readBoard(state!.project).quests.get("quest/first.md")!.status.kind).toBe("turn-in");
		expect(readBoard(state!.project).quests.get("quest/second.md")!.status.kind).toBe("accepted");
		expect(calls.at(-1)?.method).toBe("DELETE");
		expect(calls.filter((call) => call.path.endsWith("/access_tokens"))[0]!.body.permissions).toEqual({
			metadata: "read",
			contents: "read",
			issues: "read",
			pull_requests: "read",
			checks: "read",
			statuses: "read",
		});
	});
	it("coalesces reconciliation and later pushes/comments into the existing notification", async () => {
		await enrolled();
		const first = await github().service.projectState(repo, "enrollment-test", true);
		const page = activity();
		page.pullRequests!.nodes[0]!.headRefOid = "d".repeat(40);
		page.pullRequests!.nodes[0]!.commits.nodes[0]!.commit.oid = "d".repeat(40);
		page.issues!.nodes[0]!.comments.totalCount = 2;
		const next = await github({ activity: page }).service.projectState(repo, "enrollment-test", true);
		expect(next!.activity).toHaveLength(3);
		expect(next!.activity.map((item) => item.firstSeen)).toEqual(first!.activity.map((item) => item.firstSeen));
		expect(next!.activity.find((item) => item.id === "100")!.data!.comments.totalCount).toBe(2);
		expect((next!.activity.find((item) => item.id === "200")!.data as ReturnType<typeof pull>).headRefOid).toBe(
			"d".repeat(40),
		);
	});
	it("shows a draft its starter holds as claimed, and a handed-back draft as turned in", async () => {
		await enrolled();
		const page = activity();
		const draft = Object.assign(page.pullRequests!.nodes[0]!, { isDraft: true, body: "Work so far." });
		const first = await github({ activity: page }).service.projectState(repo, "enrollment-test", true);
		expect(first!.project.changes).toMatchObject([{ quest: "quest/first.md", number: 2, owned: true }]);
		expect(readBoard(first!.project).quests.get("quest/first.md")!.status).toMatchObject({
			kind: "accepted",
			change: { number: 2 },
		});
		// Only whether the body hands the draft back is kept.
		const data = first!.activity.find((item) => item.id === "200")!.data!;
		expect(data).toMatchObject({ handedBack: false });
		expect(data).not.toHaveProperty("body");
		draft.body = "Work so far.\n\n## Decisions needed\n\n1. Which name?\n";
		const next = await github({ activity: page }).service.projectState(repo, "enrollment-test", true);
		expect(next!.project.changes).toMatchObject([{ quest: "quest/first.md", owned: false }]);
		expect(readBoard(next!.project).quests.get("quest/first.md")!.status.kind).toBe("turn-in");
	});
	it("keeps a recorded PR's state while GitHub computes its mergeability", async () => {
		await enrolled();
		const page = (status: string, oid = commit) => {
			const result = activity();
			const [mine, other] = result.pullRequests!.nodes as (ReturnType<typeof pull> & {
				mergeStateStatus?: string;
			})[];
			Object.assign(mine!, { mergeStateStatus: status, headRefOid: oid });
			mine!.commits.nodes[0]!.commit.oid = oid;
			other!.mergeStateStatus = "UNKNOWN";
			return result;
		};
		const refresh = async (status: string, oid = commit) => {
			const state = await github({ activity: page(status, oid) }).service.projectState(
				repo,
				"enrollment-test",
				true,
			);
			const rows = Object.fromEntries(
				state!.activity.map((item) => [item.id, { changedAt: item.changedAt, data: item.data as any }]),
			);
			// Forget when each changed, so the next refresh shows whether it changes again.
			await env.DB.prepare("UPDATE github_project_activity SET changedAt=0 WHERE repository=10").run();
			return rows;
		};
		const seen = await refresh("CLEAN");
		// A newly seen PR is news even while its state is unknown.
		expect(seen["201"]).toMatchObject({ data: { mergeStateStatus: "UNKNOWN" } });
		expect(seen["201"]!.changedAt).toBeGreaterThan(0);
		// At the same head, the last known state stands and nothing is new.
		expect(await refresh("UNKNOWN")).toMatchObject({ 200: { changedAt: 0, data: { mergeStateStatus: "CLEAN" } } });
		// At a new head, the state is unknown, and the change is news only once it is known.
		const moved = "e".repeat(40);
		expect(await refresh("UNKNOWN", moved)).toMatchObject({
			200: { changedAt: 0, data: { mergeStateStatus: "UNKNOWN", headRefOid: moved } },
		});
		expect((await refresh("BLOCKED", moved))["200"]!.changedAt).toBeGreaterThan(0);
	});
	it("prunes a closed entity's activity once it has been closed past retention", async () => {
		await enrolled();
		await github().service.projectState(repo, "enrollment-test", true);
		const page = activity();
		const old = new Date(Date.now() - RETENTION - 60_000).toISOString();
		Object.assign(page.issues!.nodes[0]!, { state: "CLOSED", closedAt: old });
		Object.assign(page.pullRequests!.nodes[1]!, { state: "MERGED", closedAt: new Date().toISOString() });
		page.open = connection([page.pullRequests!.nodes[0]!]);
		const state = await github({ activity: page }).service.projectState(repo, "enrollment-test", true);
		// Only open entities are read for the board and inbox; the log keeps recently closed ones.
		expect(state!.activity.map((item) => item.id)).toEqual(["200"]);
		const log = await readActivity(env.DB, repo.id);
		expect(log.items.map((item) => [item.id, item.data?.state])).toEqual([
			["201", "MERGED"],
			["200", "OPEN"],
		]);
		expect(log.next).toBeNull();
	});
	it("resumes independent cursors and reconciles closed entities and removed claims in later scans", async () => {
		await enrolled();
		const page = activity();
		page.issues = connection([issue()], true, "issue-cursor");
		const first = await github({ activity: page }).service.projectState(repo, "enrollment-test", true);
		expect(first!.complete).toBe(false);
		expect(first!.project.available).toEqual([]);
		const second = github({
			activity: { issues: connection([issue(101, 3)]), open: activity().open, refs: activity().refs },
		});
		const result = await second.service.projectState(repo, "enrollment-test", true);
		expect(result!.complete).toBe(true);
		expect(result!.activity).toHaveLength(4);
		const query = second.calls.filter((c) => c.path === "/graphql").at(-1)!;
		expect(query.body.variables.issues).toBe("issue-cursor");
		expect(query.body.query).not.toContain("pullRequests(first:50");
		const closed = activity();
		closed.issues!.nodes[0]!.state = "CLOSED";
		closed.pullRequests!.nodes.forEach((p) => (p.state = "CLOSED"));
		closed.open = connection([]);
		closed.refs = connection([]);
		const last = await github({ activity: closed }).service.projectState(repo, "enrollment-test", true);
		expect(last!.project.changes).toEqual([]);
		expect(last!.claims).toEqual([]);
		expect(last!.project.available).toEqual(["quest/first.md"]);
	});
	it("keeps candidates and history progress through activity that cannot occupy a quest", async () => {
		await enrolled();
		const first = await github({ activity: history() }).service.projectState(repo, "enrollment-test", true);
		expect(first!.complete).toBe(false);
		expect(first!.project.available).toEqual(["quest/first.md"]);
		const unrelated = [
			["check_run", {}],
			["check_suite", {}],
			["status", {}],
			["issues", { action: "opened", issue: { id: 102, number: 5 } }],
			["issue_comment", { action: "created", issue: { id: 100, number: 1 } }],
			["pull_request", { action: "edited", pull_request: { id: 201, number: 3 } }],
			["pull_request_review", { action: "submitted", pull_request: { id: 201, number: 3 } }],
			["push", { ref: "refs/heads/human-branch" }],
			["push", { ref: "refs/heads/quest/first", created: false, deleted: false }],
		] as const;
		for (const [name, payload] of unrelated)
			expect((await delivery(name, { ...event, ...payload })).status).toBe(202);
		const cached = await github().service.projectState(repo, "enrollment-test");
		expect(cached!.project.available).toEqual(["quest/first.md"]);
		// CI activity during a refresh does not race it either.
		const second = github({
			activity: { issues: connection([issue(101, 3)]), open: connection([]), refs: connection([]) },
			onActivity: async () => void (await delivery("status", event)),
		});
		const result = await second.service.projectState(repo, "enrollment-test", true);
		const query = second.calls.filter((c) => c.path === "/graphql").at(-1)!;
		expect(query.body.variables.issues).toBe("issue-cursor");
		expect(result!.complete).toBe(true);
		expect(result!.project.available).toEqual(["quest/first.md"]);
	});
	it.each([
		["pull_request", { action: "opened", pull_request: { id: 202, number: 4 } }],
		["pull_request", { action: "reopened", pull_request: { id: 202, number: 4 } }],
		["pull_request", { action: "synchronize", pull_request: { id: 202, number: 4 } }],
		["push", { ref: "refs/heads/quest/first", created: true }],
		["push", { ref: "refs/heads/trunk" }],
	] as const)("withholds candidates after %s %j until a refresh rereads occupancy", async (name, payload) => {
		await enrolled();
		await github({ activity: history() }).service.projectState(repo, "enrollment-test", true);
		expect((await delivery(name, { ...event, ...payload })).status).toBe(202);
		const cached = await github().service.projectState(repo, "enrollment-test");
		expect(cached!.project.available).toBeNull();
		expect(readBoard(cached!.project).quests.get("quest/first.md")!.status.kind).not.toBe("available");
		const second = github({
			activity: {
				issues: connection([issue(101, 3)]),
				open: connection([pull("quest/first", 202)]),
				refs: connection([]),
			},
		});
		const result = await second.service.projectState(repo, "enrollment-test", true);
		expect(second.calls.filter((c) => c.path === "/graphql").at(-1)!.body.variables.issues).toBe("issue-cursor");
		expect(result!.project.available).toEqual([]);
		expect(result!.project.changes).toMatchObject([{ quest: "quest/first.md" }]);
	});
	it("never publishes partial GraphQL results or check state from a different PR head", async () => {
		await enrolled();
		await expect(
			github({ activityErrors: true }).service.projectState(repo, "enrollment-test", true),
		).rejects.toThrow("activity unavailable");
		expect(await github().service.projectState(repo, "enrollment-test")).toBeNull();
		const page = activity();
		page.pullRequests!.nodes[0]!.commits.nodes[0]!.commit.oid = "d".repeat(40);
		await expect(github({ activity: page }).service.projectState(repo, "enrollment-test", true)).rejects.toThrow(
			"head changed",
		);
	});
	it("rejects stale concurrent refresh publication and a disconnected enrollment", async () => {
		await enrolled();
		await expect(
			github({
				onActivity: async () => {
					await env.DB.prepare(
						"UPDATE github_project_state SET revision=revision+1 WHERE repository=10",
					).run();
				},
			}).service.projectState(repo, "enrollment-test", true),
		).rejects.toThrow("changed during refresh");
		expect((await env.DB.prepare("SELECT * FROM github_project_activity").all()).results).toHaveLength(0);
		await expect(
			github({
				onActivity: async () => {
					await env.DB.prepare("DELETE FROM github_projects WHERE id=10").run();
				},
			}).service.projectState(repo, "enrollment-test", true),
		).rejects.toThrow("enrollment changed");
	});
	it("cannot publish into a replacement cache even when its numeric revision repeats", async () => {
		await enrolled();
		await expect(
			github({
				onActivity: async () => {
					await env.DB.batch([
						env.DB.prepare("DELETE FROM github_project_state WHERE repository=10"),
						env.DB.prepare("INSERT INTO github_project_state(repository,epoch) VALUES(10,'replacement')"),
					]);
				},
			}).service.projectState(repo, "enrollment-test", true),
		).rejects.toThrow("changed during refresh");
		expect((await env.DB.prepare("SELECT * FROM github_project_activity").all()).results).toEqual([]);
	});
	it("clears observations when a replacement installation is explicitly enrolled", async () => {
		await enrolled();
		await github().service.projectState(repo, "enrollment-test", true);
		await github({ installation: 8 }).service.setContributions(repo, "enrollment-test", "enabled");
		expect(await github({ installation: 8 }).service.projectState(repo, "enrollment-test")).toBeNull();
		expect((await env.DB.prepare("SELECT * FROM github_project_activity").all()).results).toEqual([]);
	});

	it.each([{ private: true }, { archived: true }, { id: 999 }, { role: "write" }, { installation: 8 }])(
		"rechecks authority and eligibility before cached reads: %j",
		async (options) => {
			await enrolled();
			await github().service.projectState(repo, "enrollment-test", true);
			await expect(github(options).service.projectState(repo, "enrollment-test")).rejects.toThrow();
		},
	);
	async function automatic(service: GitHubService) {
		await env.DB.prepare(
			"INSERT INTO github_project_state(repository,epoch,requested) VALUES(10,'automatic-test',1) ON CONFLICT(repository) DO UPDATE SET requested=1",
		).run();
		await service.observe(repo.id);
		return service.projectState(repo, "enrollment-test");
	}

	it("continues across watermark ties and stops strictly below them without losing old rows", async () => {
		await enrolled();
		const row = (id: number, updatedAt: string) => ({ ...issue(id, id), updatedAt });
		const date = (day: number) => `2026-10-${String(day).padStart(2, "0")}T12:00:00Z`;
		const page = (nodes: ReturnType<typeof issue>[], more = false, cursor: string | null = null): ActivityPage => ({
			issues: connection(nodes, more, cursor),
			pullRequests: connection([]),
			open: connection([]),
			refs: connection([]),
		});
		await automatic(github({ activity: page([row(100, date(10)), row(101, date(9))], true, "first") }).service);
		await automatic(github({ activity: page([row(102, date(1))]) }).service);
		const first = github({ activity: page([row(103, date(11)), row(104, date(9))], true, "ties") });
		expect((await automatic(first.service))!.complete).toBe(false);
		expect(
			first.calls.find((call) => call.path === "/graphql" && !call.body.query.includes("object(oid:"))!.body
				.query,
		).toContain("field:UPDATED_AT,direction:DESC");
		const last = await automatic(
			github({
				activity: page([row(105, date(9)), { ...row(102, date(1)), title: "not a new update" }], true, "older"),
			}).service,
		);
		expect(last!.complete).toBe(true);
		expect(last!.activity.map((item) => item.id).sort()).toEqual(["100", "101", "102", "103", "104", "105"]);
		expect(last!.activity.every((item) => item.missing === 0)).toBe(true);
		expect(last!.activity.find((item) => item.id === "102")!.data!.title).toBe(issue().title);
	});

	it("replays an update that moved ahead of the cursor during the preceding pass", async () => {
		await enrolled();
		const date = (day: number) => `2026-10-${String(day).padStart(2, "0")}T12:00:00Z`;
		const rows = [
			{ ...issue(100, 1), updatedAt: date(10) },
			{ ...issue(101, 3), updatedAt: date(9) },
		];
		await automatic(
			github({
				activity: {
					issues: connection(rows, true, "cursor"),
					pullRequests: connection([]),
					open: connection([]),
					refs: connection([]),
				},
			}).service,
		);
		// Entity 102 updates after the first page and jumps ahead of the cursor, so this page cannot see it.
		await automatic(
			github({
				activity: {
					issues: connection([{ ...issue(103, 5), updatedAt: date(1) }]),
					open: connection([]),
					refs: connection([]),
				},
			}).service,
		);
		const moved = { ...issue(102, 4), title: "updated during paging", updatedAt: date(11) };
		const next = await automatic(
			github({
				activity: {
					issues: connection([moved, ...rows, { ...issue(103, 5), updatedAt: date(1) }]),
					pullRequests: connection([]),
					open: connection([]),
					refs: connection([]),
				},
			}).service,
		);
		expect(next!.complete).toBe(true);
		expect(next!.activity.find((item) => item.id === "102")!.data!.title).toBe("updated during paging");
		expect(next!.activity).toHaveLength(4);
	});

	it("keeps independent issue and pull-request update boundaries", async () => {
		await enrolled();
		const old = { ...pull(), state: "CLOSED", updatedAt: "2026-10-01T12:00:00Z" };
		await automatic(
			github({
				activity: {
					issues: connection([{ ...issue(), updatedAt: "2026-10-20T12:00:00Z" }]),
					pullRequests: connection([old]),
					open: connection([]),
					refs: connection([]),
				},
			}).service,
		);
		const changed = { ...old, title: "PR changed independently", updatedAt: "2026-10-02T12:00:00Z" };
		const next = await automatic(
			github({
				activity: {
					issues: connection([]),
					pullRequests: connection([changed]),
					open: connection([]),
					refs: connection([]),
				},
			}).service,
		);
		expect((await readActivity(env.DB, 10)).items.find((item) => item.id === "200")!.data!.title).toBe(
			changed.title,
		);
		expect(next!.activity.find((item) => item.id === "100")!.missing).toBe(0);
	});

	it("expires cached closed history even when an incremental page has no updates", async () => {
		await enrolled();
		const page = activity();
		Object.assign(page.pullRequests!.nodes[0]!, { state: "CLOSED", closedAt: new Date().toISOString() });
		page.open = connection([]);
		await github({ activity: page }).service.projectState(repo, "enrollment-test", true);
		await env.DB.prepare(
			"UPDATE github_project_activity SET data=json_set(data,'$.closedAt',?) WHERE repository=10 AND id='200'",
		)
			.bind(new Date(Date.now() - RETENTION - 1000).toISOString())
			.run();
		await automatic(
			github({
				activity: {
					issues: connection([]),
					pullRequests: connection([]),
					open: connection([]),
					refs: connection([]),
				},
			}).service,
		);
		expect((await readActivity(env.DB, 10)).items.some((item) => item.id === "200")).toBe(false);
	});

	it("reads bodies once per open draft and never in metadata/history pages", async () => {
		await enrolled();
		const page = activity();
		Object.assign(page.pullRequests!.nodes[0]!, { isDraft: true, body: "## Decisions needed\n\nChoose." });
		const closed = { ...pull("closed", 203), state: "CLOSED", isDraft: true, body: "private old body" };
		page.pullRequests!.nodes.push(closed);
		const { service, calls } = github({ activity: page });
		const result = await service.projectState(repo, "enrollment-test", true);
		const queries = calls.filter((call) => call.path === "/graphql" && !call.body.query.includes("object(oid:"));
		expect(queries).toHaveLength(2);
		expect(queries[0]!.body.query).not.toMatch(/\bbody\b/);
		expect(queries[1]!.body.query).toContain("b0:pullRequest(number:2)");
		expect(queries[1]!.body.query).not.toContain("number:3");
		expect(queries[1]!.body.query).not.toContain("number:5");
		expect((result!.activity.find((item) => item.id === "200")!.data as { handedBack: boolean }).handedBack).toBe(
			true,
		);
	});

	it("does not publish mixed draft-body and metadata revisions", async () => {
		await enrolled();
		const page = activity();
		const draft = Object.assign(page.pullRequests!.nodes[0]!, { isDraft: true, body: "## Decisions needed" });
		const { service } = github({
			activity: page,
			entities: { 2: { ...draft, updatedAt: "2026-10-16T12:00:00Z" } },
		});
		await expect(service.projectState(repo, "enrollment-test", true)).rejects.toThrow();
		expect(await service.projectState(repo, "enrollment-test")).toBeNull();
	});

	it("restarts legacy creation-ordered history cursors before using update order", async () => {
		await enrolled();
		await github().service.projectState(repo, "enrollment-test", true);
		await env.DB.prepare(
			"UPDATE github_project_state SET scan=json_set(scan,'$.history',json(?)) WHERE repository=10",
		)
			.bind(JSON.stringify({ id: "legacy", issues: "old-cursor", pulls: false, complete: false }))
			.run();
		const { service, calls } = github();
		expect((await service.projectState(repo, "enrollment-test", true))!.complete).toBe(true);
		const query = calls.find((call) => call.path === "/graphql" && !call.body.query.includes("object(oid:"))!;
		expect(query.body.variables.issues).toBeNull();
		expect(query.body.variables.pulls).toBeNull();
	});

	it("keeps unchanged entities when an incremental history page contains no updates", async () => {
		await enrolled();
		await github().service.projectState(repo, "enrollment-test", true);
		const empty = github({
			activity: {
				issues: connection([]),
				pullRequests: connection([]),
				open: connection([]),
				refs: connection([]),
			},
		});
		const next = await automatic(empty.service);
		expect(next!.activity).toHaveLength(3);
		expect(next!.activity.every((item) => item.missing === 0)).toBe(true);
		expect(next!.project.changes).toEqual([]);
		expect(next!.project.issues).toHaveLength(1);
		// A missed delete webhook cannot appear in the update connection. Explicit Refresh
		// marks unseen entities stale, and the next read confirms the deletion by number.
		const swept = await empty.service.projectState(repo, "enrollment-test", true);
		expect(swept!.activity.every((item) => item.missing === 0)).toBe(true);
		const repaired = await empty.service.projectState(repo, "enrollment-test", true);
		expect(repaired!.activity.every((item) => item.missing === 1)).toBe(true);
		expect(repaired!.project.issues).toEqual([]);
	});

	it("keeps an entity that moved ahead of a full pass's cursor", async () => {
		await enrolled();
		await github().service.projectState(repo, "enrollment-test", true);
		const page = activity();
		page.issues = connection([]);
		// The issue was updated after the pass read its first page, so no history page holds it.
		const { service } = github({ activity: page, entities: { 1: { ...issue(), title: "Edited mid-pass" } } });
		await service.projectState(repo, "enrollment-test", true);
		const next = await service.projectState(repo, "enrollment-test", true);
		const item = next!.activity.find((entry) => entry.id === "100")!;
		expect(item.missing).toBe(0);
		expect((item.data as { title: string }).title).toBe("Edited mid-pass");
	});

	it("retains observations while paused, clears candidates, and cascades caches on disconnect", async () => {
		await enrolled();
		const quiet = {
			issues: connection([]),
			pullRequests: connection([]),
			open: connection([]),
			refs: connection([]),
		};
		await github({ activity: quiet }).service.projectState(repo, "enrollment-test", true);
		await github().service.setContributions(repo, "enrollment-test", "paused");
		const paused = await github().service.projectState(repo, "enrollment-test");
		expect(paused!.project.available).toEqual([]);
		expect(readBoard(paused!.project).counts.available).toBe(0);
		await github().service.setContributions(repo, "enrollment-test", "disconnected");
		expect((await env.DB.prepare("SELECT * FROM github_project_activity").all()).results).toEqual([]);
		expect(await env.DB.prepare("SELECT * FROM github_project_state").first()).toBeNull();
	});
});

describe("webhook reconciliation", () => {
	// The webhook route reads GitHub through the global fetch.
	function mocked(options: Parameters<typeof github>[0] = {}) {
		const mock = github(options);
		vi.spyOn(globalThis, "fetch").mockImplementation(mock.request as typeof fetch);
		return mock;
	}
	const reads = (calls: ReturnType<typeof github>["calls"]) =>
		calls.filter((call) => call.path === "/graphql" && !call.body.query.includes("object(oid:"));
	const opened = (id: number, number: number, id_ = crypto.randomUUID()) =>
		delivery("issues", { ...event, action: "opened", issue: { id, number } }, id_, {}, testEnv);
	async function row(id: string) {
		return env.DB.prepare("SELECT data,stale,missing FROM github_project_activity WHERE repository=10 AND id=?")
			.bind(id)
			.first<{ data: string | null; stale: number; missing: number }>();
	}
	async function enrolled() {
		await github().service.setContributions(repo, "enrollment-test", "enabled");
		await github().service.projectState(repo, "enrollment-test", true);
	}

	it("reads a new issue by number with the App's read-only token and no maintainer check", async () => {
		await enrolled();
		const { calls } = mocked({ entities: { 5: { ...issue(102, 5), title: "New idea" } } });
		expect((await opened(102, 5)).status).toBe(202);
		expect(reads(calls)).toHaveLength(1);
		expect(reads(calls)[0]!.body.query).toContain("s0:issue(number:5)");
		expect(calls.some((call) => call.path.endsWith("/permission"))).toBe(false);
		expect(calls.find((call) => call.path.endsWith("/access_tokens"))!.body.permissions).toEqual({
			metadata: "read",
			contents: "read",
			issues: "read",
			pull_requests: "read",
			checks: "read",
			statuses: "read",
		});
		expect(calls.at(-1)?.method).toBe("DELETE");
		expect(await row("102")).toMatchObject({ stale: 0, missing: 0 });
		const state = await github().service.projectState(repo, "enrollment-test");
		expect(state!.project.issues).toContainEqual({ path: "issues/5", title: "New idea" });
		expect(state!.failure).toBeNull();
	});

	it("reads once for a duplicate delivery and skips webhooks that change nothing shown", async () => {
		await enrolled();
		const { calls } = mocked({ entities: { 5: issue(102, 5) } });
		const id = crypto.randomUUID();
		await opened(102, 5, id);
		expect(await (await opened(102, 5, id)).json()).toEqual({ status: "duplicate" });
		for (const [name, payload] of [
			["check_run", {}],
			["status", {}],
			["push", { ref: "refs/heads/human-branch" }],
		] as const)
			await delivery(name, { ...event, ...payload }, undefined, {}, testEnv);
		expect(reads(calls)).toHaveLength(1);
	});

	it("coalesces a burst of deliveries into one more read", async () => {
		await enrolled();
		let started!: () => void;
		const reading = new Promise<void>((resolve) => (started = resolve));
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const { calls } = mocked({
			entities: { 5: issue(102, 5), 6: issue(103, 6), 7: issue(104, 7) },
			onActivity: async () => {
				started();
				await gate;
			},
		});
		const first = opened(102, 5);
		await reading;
		// Another update to the entity being read, and new ones, while the read is in progress.
		for (const [id, number] of [
			[102, 5],
			[103, 6],
			[104, 7],
			[103, 6],
		])
			expect((await opened(id!, number!)).status).toBe(202);
		release();
		await first;
		expect(reads(calls)).toHaveLength(2);
		expect(reads(calls)[1]!.body.query).toContain("issue(number:5)");
		for (const id of ["102", "103", "104"]) expect(await row(id)).toMatchObject({ stale: 0 });
	});

	it("reads again when a webhook during a read fails its revision check", async () => {
		await enrolled();
		let started!: () => void;
		const reading = new Promise<void>((resolve) => (started = resolve));
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let first = true;
		const { calls } = mocked({
			entities: { 5: issue(102, 5) },
			onActivity: async () => {
				if (!first) return;
				first = false;
				started();
				await gate;
			},
		});
		const pending = opened(102, 5);
		await reading;
		// A new PR head bumps the revision the read in progress publishes against.
		const synchronized = { ...event, action: "synchronize", pull_request: { id: 200, number: 2 } };
		expect((await delivery("pull_request", synchronized, undefined, {}, testEnv)).status).toBe(202);
		release();
		await pending;
		expect(reads(calls)).toHaveLength(2);
		expect(await row("102")).toMatchObject({ stale: 0 });
		expect((await github().service.projectState(repo, "enrollment-test"))!.failure).toBeNull();
	});

	it("reads again when a refresh that started first publishes first", async () => {
		await enrolled();
		const gate = () => {
			let started!: () => void;
			let release!: () => void;
			const reading = new Promise<void>((resolve) => (started = resolve));
			const held = new Promise<void>((resolve) => (release = resolve));
			return { reading, release, hold: async () => (started(), await held) };
		};
		// The refresh lists stale entities before the webhook arrives.
		const refresh = gate();
		const refreshing = github({ onActivity: refresh.hold }).service.projectState(repo, "enrollment-test", true);
		await refresh.reading;
		const observer = gate();
		let first = true;
		const { calls } = mocked({
			entities: { 5: issue(102, 5) },
			onActivity: async () => {
				if (!first) return;
				first = false;
				await observer.hold();
			},
		});
		const pending = opened(102, 5);
		await observer.reading;
		refresh.release();
		await refreshing;
		observer.release();
		await pending;
		expect(reads(calls)).toHaveLength(2);
		expect(await row("102")).toMatchObject({ stale: 0 });
		expect((await github().service.projectState(repo, "enrollment-test"))!.failure).toBeNull();
	});

	it("rereads a PR by number after a comment on it", async () => {
		await enrolled();
		const { calls } = mocked({ entities: { 2: { ...pull(), comments: { totalCount: 3 } } } });
		const comment = { ...event, action: "created", issue: { id: 999, number: 2, pull_request: {} } };
		expect((await delivery("issue_comment", comment, undefined, {}, testEnv)).status).toBe(202);
		expect(reads(calls)).toHaveLength(1);
		expect(reads(calls)[0]!.body.query).toContain("s0:pullRequest(number:2)");
		const read = await row("200");
		expect(read).toMatchObject({ stale: 0 });
		expect(JSON.parse(read!.data!).comments).toEqual({ totalCount: 3 });
		expect(await row("999")).toBeNull();
	});

	it("records a failed read without retrying, and a later webhook reads again", async () => {
		await enrolled();
		const failed = mocked({ activityErrors: true });
		await opened(102, 5);
		expect(reads(failed.calls)).toHaveLength(1);
		expect(await row("102")).toMatchObject({ data: null, stale: 1 });
		const state = await github().service.projectState(repo, "enrollment-test");
		expect(state!.failure).toBe("Project activity unavailable");
		const { calls } = mocked({ entities: { 5: issue(102, 5) } });
		await opened(102, 5);
		expect(reads(calls)).toHaveLength(1);
		expect(await row("102")).toMatchObject({ stale: 0 });
		expect((await github().service.projectState(repo, "enrollment-test"))!.failure).toBeNull();
	});

	it("shows why a background read failed next to the refresh fallback", async () => {
		const who = identity("github");
		const login = await oauth(who);
		const user = await env.DB.prepare("SELECT userId FROM account WHERE providerId='github' AND accountId=?")
			.bind(who.id)
			.first<{ userId: string }>();
		const { service } = github({ account: Number(who.id) });
		await service.setContributions(repo, user!.userId, "enabled");
		await service.projectState(repo, user!.userId, true);
		mocked({ account: Number(who.id), activityErrors: true });
		await opened(102, 5);
		const page = await app.request(
			`${origin}/projects/github/upstream/project/state`,
			{ headers: { Cookie: login.session! } },
			testEnv,
		);
		expect(await page.text()).toContain("The last background read failed: Project activity unavailable");
	});

	it("rereads a closed issue and marks a deleted one missing", async () => {
		await enrolled();
		mocked({ entities: { 1: { ...issue(), state: "CLOSED" } } });
		await delivery("issues", { ...event, action: "closed", issue: { id: 100, number: 1 } }, undefined, {}, testEnv);
		expect((await github().service.projectState(repo, "enrollment-test"))!.project.issues).toEqual([]);
		mocked({ entities: { 1: null } });
		await delivery(
			"issues",
			{ ...event, action: "deleted", issue: { id: 100, number: 1 } },
			undefined,
			{},
			testEnv,
		);
		expect(await row("100")).toMatchObject({ stale: 0, missing: 1 });
	});

	it("prunes a long-closed issue that a webhook names again", async () => {
		await enrolled();
		const closedAt = new Date(Date.now() - RETENTION - 60_000).toISOString();
		mocked({ entities: { 1: { ...issue(), state: "CLOSED", closedAt } } });
		await delivery(
			"issue_comment",
			{ ...event, action: "created", issue: { id: 100, number: 1 } },
			undefined,
			{},
			testEnv,
		);
		expect(await row("100")).toBeNull();
	});

	it("rereads availability after a webhook that can claim a quest", async () => {
		await enrolled();
		const quiet = {
			issues: connection([]),
			pullRequests: connection([]),
			open: connection([]),
			refs: connection([]),
		};
		await github({ activity: quiet }).service.projectState(repo, "enrollment-test", true);
		mocked({ activity: { ...quiet, refs: connection([ref("first")]) } });
		await delivery("push", { ...event, ref: "refs/heads/quest/first", created: true }, undefined, {}, testEnv);
		const state = await github().service.projectState(repo, "enrollment-test");
		expect(state!.claims).toEqual(["quest/first.md"]);
		expect(state!.project.available).toEqual([]);
	});

	it("does not read a paused or disconnected project", async () => {
		await enrolled();
		await github().service.setContributions(repo, "enrollment-test", "paused");
		const paused = mocked();
		expect((await opened(102, 5)).status).toBe(202);
		expect(paused.calls).toEqual([]);
		await github().service.setContributions(repo, "enrollment-test", "disconnected");
		const disconnected = mocked();
		expect((await opened(103, 6)).status).toBe(202);
		expect(disconnected.calls).toEqual([]);
		expect(await env.DB.prepare("SELECT * FROM github_project_state").first()).toBeNull();
	});
});

describe("project activity routes", () => {
	const base = `${origin}/projects/github/upstream/project`;
	let githubId = 0;
	async function session(options: Parameters<typeof github>[0] = {}) {
		const who = identity("github");
		const login = await oauth(who);
		githubId = Number(who.id);
		const mock = github({ ...options, account: githubId });
		vi.spyOn(globalThis, "fetch").mockImplementation(mock.request as typeof fetch);
		const account = await env.DB.prepare("SELECT userId FROM account WHERE providerId='github' AND accountId=?")
			.bind(who.id)
			.first<{ userId: string }>();
		await mock.service.setContributions(repo, account!.userId, "enabled");
		return login.session!;
	}
	it("guards cached data and refresh forms with authentication and origin", async () => {
		expect((await app.request(`${base}/data`, undefined, testEnv)).status).toBe(403);
		expect(
			(
				await app.request(
					`${base}/refresh`,
					{ method: "POST", headers: { Origin: "https://evil.example" } },
					testEnv,
				)
			).status,
		).toBe(403);
	});
	it("renders escaped durable activity, links live board pages, and exposes current-head data", async () => {
		const cookie = await session();
		const posted = await app.request(
			`${base}/refresh`,
			{ method: "POST", headers: { Cookie: cookie, Origin: origin } },
			testEnv,
		);
		expect(posted.status).toBe(303);
		const response = await app.request(`${base}/state`, { headers: { Cookie: cookie } }, testEnv);
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("&lt;script&gt;title&lt;/script&gt;");
		expect(html).toContain("CHANGES_REQUESTED");
		expect(html).toContain("/board");
		const data = await app.request(`${base}/data`, { headers: { Cookie: cookie } }, testEnv);
		expect(data.headers.get("cache-control")).toBe("no-store");
		expect(await data.json()).toMatchObject({ complete: true, project: { commit } });
	});
	it("pages the activity log, newest first", async () => {
		const cookie = await session();
		await app.request(`${base}/refresh`, { method: "POST", headers: { Cookie: cookie, Origin: origin } }, testEnv);
		await env.DB.batch(
			Array.from({ length: 60 }, (_, i) =>
				env.DB.prepare(
					"INSERT INTO github_project_activity(repository,kind,id,number,firstSeen,changedAt,data,seenIn) VALUES(10,'issue',?,?,?,0,?,'old')",
				).bind(
					String(1000 + i),
					1000 + i,
					i,
					JSON.stringify({ ...issue(1000 + i, 1000 + i), title: `Closed ${i}`, state: "CLOSED" }),
				),
			),
		);
		const first = await (await app.request(`${base}/state`, { headers: { Cookie: cookie } }, testEnv)).text();
		expect(first).toContain("&lt;script&gt;title&lt;/script&gt;");
		expect(first).toContain("Closed 59");
		expect(first).not.toContain("Closed 12<");
		const older = first.match(/href="([^"]+\/state\?before=[^"]+)">Older activity/)![1]!.replaceAll("&amp;", "&");
		const second = await (await app.request(`${origin}${older}`, { headers: { Cookie: cookie } }, testEnv)).text();
		expect(second).toContain("Closed 12<");
		expect(second).toContain("Closed 0<");
		expect(second).not.toContain("Closed 13<");
		expect(second).not.toContain("Older activity");
	});
	it("uses the shared board and resolves nested quest routes within the authenticated project", async () => {
		const cookie = await session();
		await app.request(`${base}/refresh`, { method: "POST", headers: { Cookie: cookie, Origin: origin } }, testEnv);
		const board = await app.request(`${base}/board`, { headers: { Cookie: cookie } }, testEnv);
		expect(board.status).toBe(200);
		expect(await board.text()).toContain(`${base.replace(origin, "")}/board/quest/first`);
		const quest = await app.request(`${base}/board/quest/first`, { headers: { Cookie: cookie } }, testEnv);
		expect(quest.status).toBe(200);
		expect(await quest.text()).toContain("Build first.");
	});
	it("keeps tree-ready quests pending until a claiming PR on an unvisited page is observed", async () => {
		const page = activity();
		page.open = connection([pull("human-branch", 201)], true, "open-cursor");
		page.refs = connection([]);
		const cookie = await session({ activity: page });
		await app.request(`${base}/refresh`, { method: "POST", headers: { Cookie: cookie, Origin: origin } }, testEnv);
		const pending = await (await app.request(`${base}/board`, { headers: { Cookie: cookie } }, testEnv)).text();
		expect(pending).toContain("Availability pending");
		expect(pending).not.toContain(">Available<");
		const quest = await (
			await app.request(`${base}/board/quest/first`, { headers: { Cookie: cookie } }, testEnv)
		).text();
		expect(quest).toContain("Availability pending");
		expect(quest).not.toContain("/quest-start");

		const rest = github({
			account: githubId,
			activity: { issues: connection([]), pullRequests: connection([pull()]), open: connection([pull()]) },
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(rest.request as typeof fetch);
		await app.request(`${base}/refresh`, { method: "POST", headers: { Cookie: cookie, Origin: origin } }, testEnv);
		const board = await (await app.request(`${base}/board`, { headers: { Cookie: cookie } }, testEnv)).text();
		expect(board).not.toContain("Availability pending");
		expect(board).toContain("Ready to turn in");
	});
	it("renders an empty board for a root-only project", async () => {
		const cookie = await session({
			documents: [{ path: "quest/README.md", content: "# Project\n\n## Goal\n\nBuild it.\n" }],
		});
		await app.request(`${base}/refresh`, { method: "POST", headers: { Cookie: cookie, Origin: origin } }, testEnv);
		const board = await app.request(`${base}/board`, { headers: { Cookie: cookie } }, testEnv);
		expect(board.status).toBe(200);
		expect(await board.text()).toContain("This project has no quests yet.");
	});
});
