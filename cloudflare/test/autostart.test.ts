import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Repo } from "../dev/github";
import type { ProjectState } from "../src/github/state";
import { app } from "../src/index";
import { autostart, candidates, digest, milestones, optIns, save } from "../src/jobs/autostart";
import * as store from "../src/jobs/store";
import { privateKey } from "./github-key";
import { origin } from "./login-fixtures";
import { skip } from "../src/inbox/model";
import { documents, head, maintainerOf, project } from "./project-fixtures";

const testEnv = { ...env, GITHUB_APP_PRIVATE_KEY: privateKey };
const db = env.DB;

describe("choosing what to start", () => {
	const doc = (path: string, body: string) => ({ path, content: `# [S] ${path}\n\n## Goal\n\nDo it.\n${body}` });
	const documents = [
		{ path: "quest/README.md", content: "# Project\n\n## Goal\n\nBuild it.\n" },
		{ path: "quest/m0/README.md", content: "# Now\n\n## Goal\n\nFirst.\n" },
		{ path: "quest/m1/README.md", content: "# Next\n\n## Goal\n\nLater.\n" },
		doc("quest/m1/a.md", ""),
		doc("quest/m1/b.md", ""),
		doc("quest/m1/c.md", "\n## Required\n\n- [B](/quest/m1/b.md) - first\n"),
		doc("quest/m0/d.md", ""),
		doc("quest/m0/claimed.md", ""),
	];
	const state = (available: string[] | null) => ({ project: { documents, available } }) as unknown as ProjectState;
	const all = { milestones: null };
	const none = new Set<string>();

	it("ranks unclaimed ready quests as quest unblocked does, within the opted-in milestones", () => {
		const available = ["quest/m0/d.md", "quest/m1/a.md", "quest/m1/b.md"];
		// Milestone first, then downstream impact: b unblocks c.
		expect(candidates(state(available), all, none, none)).toEqual([
			"quest/m0/d.md",
			"quest/m1/b.md",
			"quest/m1/a.md",
		]);
		expect(candidates(state(available), { milestones: ["m1"] }, none, none)).toEqual([
			"quest/m1/b.md",
			"quest/m1/a.md",
		]);
		// Unknown occupancy starts nothing.
		expect(candidates(state(null), all, none, none)).toEqual([]);
	});

	it("leaves a quest that already had a job, or that the maintainer skipped at its current text", () => {
		const available = ["quest/m0/d.md", "quest/m1/b.md"];
		const d = documents.find((x) => x.path === "quest/m0/d.md")!.content;
		expect(candidates(state(available), all, new Set(["quest/m0/d.md"]), none)).toEqual(["quest/m1/b.md"]);
		expect(candidates(state(available), all, none, new Set([`quest/m0/d.md\n${digest(d)}`]))).toEqual([
			"quest/m1/b.md",
		]);
		// A skip of older text lapses once the quest changes.
		expect(candidates(state(available), all, none, new Set(["quest/m0/d.md\nold"]))).toHaveLength(2);
	});

	it("reads a milestone list, refusing anything else", () => {
		expect(milestones(undefined)).toBeNull();
		expect(milestones("m0, m1 m0")).toEqual(["m0", "m1"]);
		expect(() => milestones("m0,../x")).toThrow("Name milestones like m0, m1");
	});
});

describe("starting ready quests on free slots", () => {
	let user = "";
	let cookie = "";
	let repo: Repo;
	beforeEach(async () => {
		({ user, cookie, repo } = await maintainerOf());
	});
	afterEach(() => vi.restoreAllMocks());
	const sockets: WebSocket[] = [];
	afterEach(() => {
		for (const ws of sockets.splice(0)) ws.close();
	});

	function opt(fields: [string, string][]) {
		return app.request(
			`${origin}/projects/github/upstream/project/autostart`,
			{ method: "POST", headers: { Cookie: cookie, Origin: origin }, body: new URLSearchParams(fields) },
			testEnv,
		);
	}
	async function connect(slots: number) {
		const { token } = await store.createRunner(db, user, "laptop", "linux", false, 0);
		const response = await app.request(
			`${origin}/api/runner/connect`,
			{ headers: { Authorization: `Bearer ${token}`, Upgrade: "websocket" } },
			testEnv,
		);
		const ws = response.webSocket!;
		ws.accept();
		sockets.push(ws);
		const inbox: any[] = [];
		const waiting: ((message: any) => void)[] = [];
		ws.addEventListener("message", (event) => {
			const message = JSON.parse(event.data as string);
			const next = waiting.shift();
			if (next) next(message);
			else inbox.push(message);
		});
		const next = (): Promise<any> =>
			inbox.length ? Promise.resolve(inbox.shift()) : new Promise((resolve) => waiting.push(resolve));
		const account = { id: "main", provider: "anthropic", kind: "subscription", label: "Main", limited: false };
		ws.send(JSON.stringify({ id: 1, type: "status", accounts: [account], attempts: [], slots }));
		expect(await next()).toMatchObject({ type: "reply", id: 1 });
		return next;
	}
	const jobs = async () =>
		(await db.prepare("SELECT target,workflow,actor FROM jobs WHERE repository=10").all()).results;

	it("starts the next ready quest once opted in, and only once", async () => {
		const next = await connect(2);
		// Without an opt-in, a free slot starts nothing.
		expect(await autostart(testEnv, user, 2)).toBe(0);
		const saved = await opt([["enabled", "1"]]);
		expect(saved.status).toBe(303);
		expect(await next()).toMatchObject({
			type: "assign",
			job: { workflow: "start", target: "quest/first.md", attempt: 1 },
			instructions: expect.stringContaining("worth starting"),
		});
		expect(await jobs()).toEqual([{ target: "quest/first.md", workflow: "start", actor: user }]);
		// A slot is still free, but nothing else is ready, and a quest with a job is not started again.
		expect(await autostart(testEnv, user, 1)).toBe(0);
		const [{ id }] = (await db.prepare("SELECT id FROM jobs").all<{ id: string }>()).results;
		await store.cancel(db, id!, user, Date.now());
		expect(await autostart(testEnv, user, 1)).toBe(0);
		expect(await jobs()).toHaveLength(1);
	});

	it("keeps to the chosen milestones and stops when opted out", async () => {
		expect(
			(
				await opt([
					["enabled", "1"],
					["milestones", "m3"],
				])
			).status,
		).toBe(303);
		expect(await db.prepare("SELECT milestones FROM autostart WHERE user=?").bind(user).first()).toEqual({
			milestones: '["m3"]',
		});
		expect(await autostart(testEnv, user, 1)).toBe(0);
		expect((await opt([["enabled", "0"]])).status).toBe(303);
		expect(await db.prepare("SELECT 1 FROM autostart").first()).toBeNull();
		expect((await opt([["enabled", "maybe"]])).status).toBe(409);
	});

	it("creates no start the maintainer opted out of while it read GitHub", async () => {
		await save(db, 10, user, { milestones: null }, 0);
		const github = vi.mocked(globalThis.fetch).getMockImplementation()!;
		vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
			// The flake read is the last GitHub request before the job is created.
			if (String(input).includes("/contents/flake.nix")) await save(db, 10, user, null, 0);
			return github(input, init);
		});
		expect(await autostart(testEnv, user, 1)).toBe(0);
		expect(await jobs()).toEqual([]);
		// Narrowing the milestones works the same way, checked in the same insert.
		await save(db, 10, user, { milestones: ["m3"] }, 0);
		const start = {
			repository: 10,
			actor: user,
			workflow: "start",
			target: "quest/m0/x.md",
			revision: head,
			branch: "quest/m0/x",
			trusted: true,
			automatic: { version: "v1" },
		} as const;
		await expect(store.createJob(db, start, 0)).rejects.toThrow(store.NotOptedIn);
		await save(db, 10, user, { milestones: ["m0"] }, 0);
		expect((await store.createJob(db, start, 0)).created).toBe(true);
	});

	it("creates no start the maintainer skipped, or another pass started, while it read GitHub", async () => {
		await save(db, 10, user, { milestones: null }, 0);
		const quest = documents.find((d) => d.path === "quest/first.md")!;
		const github = vi.mocked(globalThis.fetch).getMockImplementation()!;
		let during = async () => {};
		vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
			if (String(input).includes("/contents/flake.nix")) await during();
			return github(input, init);
		});
		// A skip at the quest's current text commits while the pass reads GitHub.
		during = async () => void (await skip(db, user, 10, quest.path, digest(quest.content)));
		expect(await autostart(testEnv, user, 1)).toBe(0);
		expect(await jobs()).toEqual([]);
		// A skip at an older text no longer applies.
		await skip(db, user, 10, quest.path, "stale");
		// Another pass's start commits and is cancelled while this one reads GitHub.
		during = async () => {
			during = async () => {};
			const start = { ...startOf(quest.path), automatic: { version: digest(quest.content) } };
			const { id } = await store.createJob(db, start, 0);
			await store.cancel(db, id, user, 0);
		};
		expect(await autostart(testEnv, user, 1)).toBe(0);
		expect(await jobs()).toHaveLength(1);
	});

	function startOf(target: string) {
		return {
			repository: 10,
			actor: user,
			workflow: "start",
			target,
			revision: head,
			branch: target.replace(/\.md$/, ""),
			trusted: true,
		} as const;
	}

	it("takes turns across projects, the least recently started first", async () => {
		await project(11, user);
		await save(db, 10, user, { milestones: null }, 0);
		await save(db, 11, user, { milestones: null }, 1);
		expect((await optIns(db, user)).map((o) => o.project.id)).toEqual([10, 11]);
		await store.createJob(
			db,
			{
				repository: 10,
				actor: user,
				workflow: "start",
				target: "quest/x.md",
				revision: head,
				branch: "quest/x",
				trusted: true,
			},
			5,
		);
		expect((await optIns(db, user)).map((o) => o.project.id)).toEqual([11, 10]);
	});

	it("ends an opt-in with its membership, so regaining access never resumes it", async () => {
		await save(db, 10, user, { milestones: null }, 0);
		await db.prepare("DELETE FROM github_project_members WHERE repository=10 AND user=?").bind(user).run();
		expect(await db.prepare("SELECT 1 FROM autostart").first()).toBeNull();
	});

	it("ends the opt-in of a maintainer who lost their role", async () => {
		await opt([["enabled", "1"]]);
		await db.prepare("DELETE FROM jobs").run();
		for (const login of Object.keys(repo.roles!)) repo.roles![login] = "read";
		expect(await autostart(testEnv, user, 1)).toBe(0);
		expect(await db.prepare("SELECT 1 FROM autostart").first()).toBeNull();
		expect(await jobs()).toEqual([]);
	});

	it("marks a handed-back draft ready at the head on screen", async () => {
		const pr = repo.pulls[0]!;
		pr.draft = true;
		const ready = (sha: string) =>
			app.request(
				`${origin}/projects/github/upstream/project/pulls/2/ready`,
				{
					method: "POST",
					headers: { Cookie: cookie, Origin: origin },
					body: new URLSearchParams([["head", sha]]),
				},
				testEnv,
			);
		expect((await ready("e".repeat(40))).status).toBe(403);
		expect(pr.draft).toBe(true);
		// A start job that published this draft keeps its quest as its target, yet may still push to it.
		const { id } = await store.createJob(db, startOf("quest/first.md"), 0);
		await store.delivered(db, id, 2);
		expect((await ready(head)).status).toBe(409);
		expect(pr.draft).toBe(true);
		await store.cancel(db, id, user, 0);
		// So may a job on the pull request itself.
		const iterate = await store.createJob(
			db,
			{ ...startOf("quest/first.md"), workflow: "iterate", target: "pulls/2", branch: pr.branch },
			0,
		);
		expect((await ready(head)).status).toBe(409);
		await store.cancel(db, iterate.id, user, 0);
		expect((await ready(head)).status).toBe(303);
		expect(pr.draft).toBe(false);
	});
});
