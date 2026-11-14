import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import { REFERENCE_LINE, parseUpload } from "../src/core";
import { hook } from "../src/cli/hooks";
import { type SendDependencies, queue, runSender, sendPass, tokensPath } from "../src/cli/send";
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

/** A user's state and config, with a token for `ENDPOINT` unless told otherwise, and a sender running. */
function home(token: string | null = "secret"): NodeJS.ProcessEnv {
	const env = { XDG_STATE_HOME: tempDir(), XDG_CONFIG_HOME: tempDir() };
	mkdirSync(join(env.XDG_STATE_HOME, "quest", "records"), { recursive: true });
	writeFileSync(senderPid(env), String(process.pid));
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

const senderPid = (env: NodeJS.ProcessEnv) => join(env.XDG_STATE_HOME!, "quest", "records", "sender.pid");

const stopped = (cwd: string) => ({ harness: "claude", session: "s1", transcript: transcript(), cwd });

test("a checkout naming no endpoint, or one without the user's token, queues nothing and says so once", () => {
	const env = home(null);
	const bare = checkout();
	expect(queue(stopped(bare), env)).toEqual({
		notices: [expect.stringContaining("acme/proj names no Kixel Code endpoint in .quest.json")],
		queued: false,
	});
	expect(queue(stopped(bare), env)).toEqual({ notices: [], queued: false });
	const named = checkout(ENDPOINT);
	expect(queue(stopped(named), env).notices).toEqual([expect.stringContaining(`holds no token for ${ENDPOINT}`)]);
	expect(queue(stopped(named), env).notices).toEqual([]);
	// Outside a checkout that uses Quest, nothing is said.
	expect(queue(stopped(tempDir()), env)).toEqual({ notices: [], queued: false });
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
function sender(
	env: NodeJS.ProcessEnv,
	status: number | (() => number),
	sessions: Session[] | null,
	during: () => void = () => {},
) {
	const uploads: { token: string; body: unknown }[] = [];
	const windows: Date[] = [];
	const slept: number[] = [];
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
		sleep: async (ms) => {
			slept.push(ms);
		},
		interval: 60_000,
		fetch: (async (input: string | URL | Request, init?: RequestInit) => {
			expect(String(input)).toBe(ENDPOINT);
			uploads.push({
				token: String((init?.headers as Record<string, string>).authorization),
				body: JSON.parse(String(init?.body)),
			});
			during();
			return new Response("", { status: typeof status === "number" ? status : status() });
		}) as typeof fetch,
	};
	return { deps, uploads, windows, slept };
}

const pending = (env: NodeJS.ProcessEnv) => readdirSync(join(env.XDG_STATE_HOME!, "quest", "records", "pending"));

test("the sender posts each queued session with its sub-agents, from its transcript's start", async () => {
	const env = home();
	const root = checkout(ENDPOINT);
	expect(queue(stopped(root), env)).toEqual({ notices: [], queued: true });
	const sessions = [
		session("s1", "quest/m0/a"),
		session("sub", "quest/m0/a", { parent: "s1" }),
		session("other", "quest/m0/a"),
	];
	const { deps, uploads, windows } = sender(env, 200, sessions);
	expect(await sendPass(deps)).toEqual([{ endpoint: ENDPOINT, repository: "acme/proj", records: 2, refused: false }]);
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
	await expect(sendPass(failing.deps)).rejects.toThrow("answered 500");
	expect(pending(env)).toHaveLength(1);
	const again = queue(stopped(root), env);
	expect(again.notices).toEqual([expect.stringContaining("answered 500")]);
	expect(queue(stopped(root), env).notices).toEqual([]);

	const refusing = sender(env, 403, [session("s1", "quest/m0/a")]);
	expect(await sendPass(refusing.deps)).toEqual([
		{ endpoint: ENDPOINT, repository: "acme/proj", records: 1, refused: true },
	]);
	expect(pending(env)).toEqual([]);
	expect(queue(stopped(root), env)).toEqual({
		notices: [expect.stringContaining("refused this host's token (403)")],
		queued: false,
	});
	// A new token is tried again.
	writeFileSync(tokensPath(env), JSON.stringify({ [ENDPOINT]: "fresh" }));
	expect(queue(stopped(root), env).queued).toBe(true);
});

test("the sender fails loud without token-max or a session it was queued for, keeping the queue", async () => {
	const env = home();
	queue(stopped(checkout(ENDPOINT)), env);
	await expect(sendPass(sender(env, 200, null).deps)).rejects.toThrow("token-max is not installed");
	await expect(sendPass(sender(env, 200, [session("x", "quest/m0/a")]).deps)).rejects.toThrow(
		"lists no claude session s1",
	);
	expect(pending(env)).toHaveLength(1);
});

test("Claude Code's and Codex's Stop queue the session", () => {
	const env = home();
	const cwd = checkout(ENDPOINT);
	const deps = { env };
	const base = { hook_event_name: "Stop", cwd, session_id: "c1", transcript_path: transcript() };
	expect(hook({ ...base, background_tasks: [] }, deps)).toBe("");
	expect(hook({ ...base, session_id: "x1", turn_id: "t1" }, deps)).toBe("");
	expect(pending(env)).toHaveLength(2);
	// A sub-agent goes with its parent, so its stop queues nothing.
	expect(hook({ ...base, hook_event_name: "SubagentStop", background_tasks: [] }, deps)).toBe("");
	expect(pending(env)).toHaveLength(2);
	// What it cannot queue, it says instead of failing the hook.
	writeFileSync(join(cwd, ".quest.json"), "{");
	expect(JSON.parse(hook({ ...base, background_tasks: [] }, deps)).systemMessage).toContain(
		"cannot queue this session's record",
	);
	expect(() => hook({ hook_event_name: "Stop", cwd, turn_id: "t1" }, deps)).toThrow("session_id");
});

test("the sender passes every interval, records its PID, and outlives a failed pass", async () => {
	const env = home();
	writeFileSync(senderPid(env), "");
	const root = checkout(ENDPOINT);
	queue(stopped(root), env);
	let status = 500;
	const { deps, uploads, slept } = sender(env, () => status, [session("s1", "quest/m0/a")]);
	const log: string[] = [];
	deps.sleep = async (ms) => {
		slept.push(ms);
		status = 200;
		if (slept.length === 3) throw new Error("stopped");
	};
	await expect(runSender(deps, (line) => log.push(line))).rejects.toThrow("stopped");
	expect(readFileSync(senderPid(env), "utf8")).toBe(String(process.pid));
	expect(slept).toEqual([60_000, 60_000, 60_000]);
	// The failed pass keeps the session; the next sends it, and the last finds the queue empty.
	expect(uploads).toHaveLength(2);
	expect(log).toEqual([expect.stringContaining("answered 500"), `sent 1 records of acme/proj to ${ENDPOINT}`]);
	expect(pending(env)).toEqual([]);
});

test("a stop with no sender running queues the session and says so once per outage", () => {
	const env = home();
	const root = checkout(ENDPOINT);
	writeFileSync(senderPid(env), "999999999");
	const down = queue(stopped(root), env);
	expect(down).toEqual({
		notices: [expect.stringContaining("no session record sender runs on this host")],
		queued: true,
	});
	expect(down.notices[0]).toContain("quest records install");
	expect(queue(stopped(root), env)).toEqual({ notices: [], queued: true });
	expect(pending(env)).toHaveLength(2);
	// A sender that ran again and stopped is a new outage.
	writeFileSync(senderPid(env), "999999998");
	expect(queue(stopped(root), env).notices).toHaveLength(1);
	writeFileSync(senderPid(env), String(process.pid));
	expect(queue(stopped(root), env).notices).toEqual([]);
});

test("a stop queued while its earlier record uploads stays queued", async () => {
	const env = home();
	const root = checkout(ENDPOINT);
	queue(stopped(root), env);
	const first = sender(env, 200, [session("s1", "quest/m0/a")], () => {
		if (first.uploads.length === 1) queue(stopped(root), env);
	});
	await sendPass(first.deps);
	expect(pending(env)).toHaveLength(1);
	const next = sender(env, 200, [session("s1", "quest/m0/a")]);
	await sendPass(next.deps);
	expect(next.uploads).toHaveLength(1);
	expect(pending(env)).toEqual([]);
});

test("a queued session for an endpoint that refused its token is dropped unsent", async () => {
	const env = home();
	const root = checkout(ENDPOINT);
	queue(stopped(root), env);
	const refusing = sender(env, 403, [session("s1", "quest/m0/a")]);
	// Queued before the refusal, so queue() could not drop it.
	const dir = join(env.XDG_STATE_HOME!, "quest", "records", "pending");
	const [name] = readdirSync(dir);
	const copy = readFileSync(join(dir, name!), "utf8");
	await sendPass(refusing.deps);
	writeFileSync(join(dir, name!), copy);
	const later = sender(env, 200, [session("s1", "quest/m0/a")]);
	await sendPass(later.deps);
	expect(later.uploads).toEqual([]);
	expect(pending(env)).toEqual([]);
});
