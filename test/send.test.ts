import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import { REFERENCE_LINE, parseUpload } from "../src/core";
import { hook } from "../src/cli/hooks";
import { type SendDependencies, queue, sendQueued, tokensPath } from "../src/cli/send";
import type { Session } from "../src/cli/usage";
import { tempDir } from "./fixture";

const ENDPOINT = "https://kixel.example/records";

/** A checkout that uses Quest, with a GitHub origin, naming `endpoint` when given. */
function checkout(endpoint?: unknown): string {
	const dir = tempDir();
	execFileSync("git", ["init", "-q", dir]);
	execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/acme/proj.git"]);
	writeFileSync(join(dir, "AGENTS.md"), `${REFERENCE_LINE}\n`);
	if (endpoint !== undefined) writeFileSync(join(dir, ".quest.json"), JSON.stringify({ records: endpoint }));
	return dir;
}

/** A user's state and config, with a token for `ENDPOINT` unless told otherwise. */
function home(token: string | null = "secret"): NodeJS.ProcessEnv {
	const env = { XDG_STATE_HOME: tempDir(), XDG_CONFIG_HOME: tempDir() };
	if (token !== null) {
		mkdirSync(join(env.XDG_CONFIG_HOME, "quest"));
		writeFileSync(tokensPath(env), JSON.stringify({ [ENDPOINT]: token }));
	}
	return env;
}

function transcript(): string {
	const path = join(tempDir(), "s.jsonl");
	writeFileSync(path, `{"type":"summary"}\n{"type":"user","timestamp":"2026-11-06T10:00:00Z"}\n`);
	return path;
}

const stopped = (cwd: string) => ({ harness: "claude", session: "s1", transcript: transcript(), cwd });

test("a checkout naming no endpoint, or one without the user's token, queues nothing and says so once", () => {
	const env = home(null);
	const bare = checkout();
	expect(queue(stopped(bare), env)).toEqual({
		notices: [expect.stringContaining("acme/proj names no Kixel Code endpoint in .quest.json")],
		send: false,
	});
	expect(queue(stopped(bare), env)).toEqual({ notices: [], send: false });
	const named = checkout(ENDPOINT);
	expect(queue(stopped(named), env).notices).toEqual([expect.stringContaining(`holds no token for ${ENDPOINT}`)]);
	expect(queue(stopped(named), env).notices).toEqual([]);
	// Outside a checkout that uses Quest, nothing is said.
	expect(queue(stopped(tempDir()), env)).toEqual({ notices: [], send: false });
});

test("a checkout's endpoint must be HTTPS, or HTTP to this host", () => {
	const env = home();
	expect(() => queue(stopped(checkout("http://kixel.example/records")), env)).toThrow("not an HTTPS URL");
	expect(() => queue(stopped(checkout(7)), env)).toThrow("not a URL");
	expect(queue(stopped(checkout("http://127.0.0.1:8080/records")), env).notices).toEqual([
		expect.stringContaining("holds no token for http://127.0.0.1:8080/records"),
	]);
});

/** A token-max session in acme/proj on `branch`. */
const session = (id: string, branch: string, extra: Partial<Session> = {}): Session => ({
	host: null,
	harness: "claude",
	id,
	parent: null,
	review: false,
	cwd: "/w",
	repositories: ["acme/proj"],
	branches: [{ name: branch, first: Date.parse("2026-11-06T10:00:00Z"), last: Date.parse("2026-11-06T10:30:00Z") }],
	start: Date.parse("2026-11-06T10:00:00Z"),
	end: Date.parse("2026-11-06T11:00:00Z"),
	models: [{ model: "m", effort: "high", input: 1, cacheWrite: 0, cacheRead: 0, output: 1, cost: 2, complete: true }],
	cost: 2,
	complete: true,
	skippedLines: 0,
	files: [],
	...extra,
});

/** Sender dependencies whose endpoint answers `status`, recording each upload and token-max's window. */
function sender(env: NodeJS.ProcessEnv, status: number, sessions: Session[] | null, interval = 0) {
	const uploads: { token: string; body: unknown }[] = [];
	const windows: Date[] = [];
	const clock = { now: Date.parse("2026-11-06T12:00:00Z"), slept: [] as number[] };
	const json = (value: unknown) =>
		new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
	const github = async (input: string | URL | Request) => {
		const url = new URL(String(input));
		if (url.pathname === "/repos/acme/proj")
			return json({
				owner: { login: "acme" },
				name: "proj",
				default_branch: "main",
				clone_url: "https://github.com/acme/proj.git",
				ssh_url: "git@github.com:acme/proj.git",
				fork: false,
			});
		if (url.pathname === "/repos/acme/proj/pulls")
			return json([
				{
					number: 7,
					html_url: "https://github.com/acme/proj/pull/7",
					title: "A",
					head: { ref: "quest/m0/a", repo: { full_name: "acme/proj" } },
					state: "open",
					draft: true,
					merged_at: null,
					created_at: "2026-11-06T10:10:00Z",
					updated_at: "2026-11-06T11:00:00Z",
					closed_at: null,
					body: "",
				},
			]);
		return new Response("not found", { status: 404 });
	};
	const deps: SendDependencies = {
		env,
		github: () => ({
			fetch: github as typeof fetch,
			now: Date.now,
			sleep: async () => {},
			token: "t",
			warn: () => {},
		}),
		sessions: (since) => {
			windows.push(since);
			return sessions;
		},
		waits: () => [],
		now: () => clock.now,
		sleep: async (ms) => {
			clock.slept.push(ms);
			clock.now += ms;
		},
		interval,
		fetch: (async (input: string | URL | Request, init?: RequestInit) => {
			expect(String(input)).toBe(ENDPOINT);
			uploads.push({
				token: String((init?.headers as Record<string, string>).authorization),
				body: JSON.parse(String(init?.body)),
			});
			return new Response("", { status });
		}) as typeof fetch,
	};
	return { deps, uploads, windows, clock };
}

const pending = (env: NodeJS.ProcessEnv) => readdirSync(join(env.XDG_STATE_HOME!, "quest", "records", "pending"));

test("the sender posts each queued session with its sub-agents, from its transcript's start", async () => {
	const env = home();
	const root = checkout(ENDPOINT);
	expect(queue(stopped(root), env)).toEqual({ notices: [], send: true });
	const sessions = [
		session("s1", "quest/m0/a"),
		session("sub", "quest/m0/a", { parent: "s1" }),
		session("other", "quest/m0/a"),
	];
	const { deps, uploads, windows } = sender(env, 200, sessions);
	expect(await sendQueued(deps)).toEqual([
		{ endpoint: ENDPOINT, repository: "acme/proj", records: 2, refused: false },
	]);
	expect(windows).toEqual([new Date("2026-11-06T10:00:00Z")]);
	expect(uploads).toHaveLength(1);
	expect(uploads[0]!.token).toBe("Bearer secret");
	const { records } = parseUpload(uploads[0]!.body);
	expect(records.map((r) => [r.session, r.pulls, r.role, r.quest])).toEqual([
		["s1", [7], "implementing", "quest/m0/a.md"],
		["sub", [7], "implementing", "quest/m0/a.md"],
	]);
	expect(pending(env)).toEqual([]);
});

test("a failed upload stays queued and is said once; a refused token stops sending", async () => {
	const env = home();
	const root = checkout(ENDPOINT);
	queue(stopped(root), env);
	const failing = sender(env, 500, [session("s1", "quest/m0/a")]);
	await expect(sendQueued(failing.deps)).rejects.toThrow("answered 500");
	expect(pending(env)).toHaveLength(1);
	const again = queue(stopped(root), env);
	expect(again.notices).toEqual([expect.stringContaining("answered 500")]);
	expect(queue(stopped(root), env).notices).toEqual([]);

	const refusing = sender(env, 403, [session("s1", "quest/m0/a")]);
	expect(await sendQueued(refusing.deps)).toEqual([
		{ endpoint: ENDPOINT, repository: "acme/proj", records: 1, refused: true },
	]);
	expect(pending(env)).toEqual([]);
	expect(queue(stopped(root), env)).toEqual({
		notices: [expect.stringContaining("refused this host's token (403)")],
		send: false,
	});
	// A new token is tried again.
	writeFileSync(tokensPath(env), JSON.stringify({ [ENDPOINT]: "fresh" }));
	expect(queue(stopped(root), env).send).toBe(true);
});

test("the sender fails loud without token-max or a session it was queued for, keeping the queue", async () => {
	const env = home();
	queue(stopped(checkout(ENDPOINT)), env);
	await expect(sendQueued(sender(env, 200, null).deps)).rejects.toThrow("token-max is not installed");
	await expect(sendQueued(sender(env, 200, [session("x", "quest/m0/a")]).deps)).rejects.toThrow(
		"lists no claude session s1",
	);
	expect(pending(env)).toHaveLength(1);
});

test("a second sender leaves the queue to the one running", async () => {
	const env = home();
	const dir = join(env.XDG_STATE_HOME!, "quest", "records");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "send.lock"), String(process.pid));
	expect(await sendQueued(sender(env, 200, []).deps)).toBeNull();
	expect(existsSync(join(dir, "send.again"))).toBe(true);
	// A lock whose sender died is taken over.
	writeFileSync(join(dir, "send.lock"), "999999999");
	expect(await sendQueued(sender(env, 200, []).deps)).toEqual([]);
});

test("Claude Code's and Codex's Stop queue the session and start a sender", () => {
	const env = home();
	const cwd = checkout(ENDPOINT);
	const started: NodeJS.ProcessEnv[] = [];
	const deps = { env, send: (e: NodeJS.ProcessEnv) => started.push(e) };
	const base = { hook_event_name: "Stop", cwd, session_id: "c1", transcript_path: transcript() };
	expect(hook({ ...base, background_tasks: [] }, deps)).toBe("");
	expect(hook({ ...base, session_id: "x1", turn_id: "t1" }, deps)).toBe("");
	expect(started).toHaveLength(2);
	expect(pending(env)).toHaveLength(2);
	// A sub-agent goes with its parent, so its stop queues nothing.
	expect(hook({ ...base, hook_event_name: "SubagentStop", background_tasks: [] }, deps)).toBe("");
	expect(started).toHaveLength(2);
	// What it cannot queue, it says instead of failing the hook.
	writeFileSync(join(cwd, ".quest.json"), "{");
	expect(JSON.parse(hook({ ...base, background_tasks: [] }, deps)).systemMessage).toContain(
		"cannot queue this session's record",
	);
	expect(() => hook({ hook_event_name: "Stop", cwd, turn_id: "t1" }, deps)).toThrow("session_id");
});

test("a background sender's passes start an interval apart, across senders", async () => {
	const env = home();
	const root = checkout(ENDPOINT);
	queue(stopped(root), env);
	const first = sender(env, 200, [session("s1", "quest/m0/a")], 60_000);
	await sendQueued(first.deps);
	expect(first.clock.slept).toEqual([]);
	queue(stopped(root), env);
	const second = sender(env, 200, [session("s1", "quest/m0/a")], 60_000);
	second.clock.now = first.clock.now + 15_000;
	await sendQueued(second.deps);
	expect(second.clock.slept).toEqual([45_000]);
	expect(second.uploads).toHaveLength(1);
});
