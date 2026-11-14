import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import { REFERENCE_LINE, parseUpload } from "../src/core";
import { hook } from "../src/cli/hooks";
import { type SendDependencies, queue, reportIncident, runSender, sendPass, tokensPath } from "../src/cli/send";
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

/** One user's clock, shared by every sender built for it, so a test moves time across passes. */
const clocks = new WeakMap<NodeJS.ProcessEnv, { now: number }>();
function clockOf(env: NodeJS.ProcessEnv): { now: number } {
	if (!clocks.has(env)) clocks.set(env, { now: Date.parse("2026-11-06T12:00:00Z") });
	return clocks.get(env)!;
}

/** Sender dependencies whose endpoint answers `status`, recording each upload and token-max's window. */
function sender(
	env: NodeJS.ProcessEnv,
	status: number | (() => number),
	sessions: Session[] | null,
	during: () => void = () => {},
	pulls: object[] = [],
) {
	const uploads: { token: string; body: unknown }[] = [];
	const windows: Date[] = [];
	const slept: number[] = [];
	const clock = clockOf(env);
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
		if (url.pathname === "/repos/acme/proj/pulls/3") return json(CULPRIT);
		if (url.pathname === "/repos/acme/proj/pulls")
			return json([
				...pulls,
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
			slept.push(ms);
			clock.now += ms;
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
	return { deps, uploads, windows, slept, clock };
}

/** A merged PR older than any window, which later PRs name as a culprit. */
const CULPRIT = {
	number: 3,
	html_url: "https://github.com/acme/proj/pull/3",
	title: "C",
	head: { ref: "quest/m0/c", repo: { full_name: "acme/proj" } },
	state: "closed",
	draft: false,
	merged_at: "2026-10-01T00:00:00Z",
	created_at: "2026-09-30T00:00:00Z",
	updated_at: "2026-10-01T00:00:00Z",
	closed_at: "2026-10-01T00:00:00Z",
	body: "## Models\n\n- Size: M\n- Implementer: Claude Code, claude-opus-5-5, medium effort\n",
};

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
	expect(await sendPass(deps)).toEqual([
		{ endpoint: ENDPOINT, repository: "acme/proj", records: 2, breakages: 0, refused: false },
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
	await expect(sendPass(failing.deps)).rejects.toThrow("answered 500");
	failing.clock.now += 60_000;
	expect(pending(env)).toHaveLength(1);
	const again = queue(stopped(root), env);
	expect(again.notices).toEqual([expect.stringContaining("answered 500")]);
	expect(queue(stopped(root), env).notices).toEqual([]);

	const refusing = sender(env, 403, [session("s1", "quest/m0/a")]);
	expect(await sendPass(refusing.deps)).toEqual([
		{ endpoint: ENDPOINT, repository: "acme/proj", records: 1, breakages: 0, refused: true },
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

test("the sender fails loud without token-max, keeping the queue", async () => {
	const env = home();
	queue(stopped(checkout(ENDPOINT)), env);
	await expect(sendPass(sender(env, 200, null).deps)).rejects.toThrow("token-max is not installed");
	expect(pending(env)).toHaveLength(1);
});

test("a failing group backs off, doubling, without widening the others' window", async () => {
	const env = home();
	const root = checkout(ENDPOINT);
	queue(stopped(root), env);
	const failing = sender(env, 500, [session("s1", "quest/m0/a")]);
	await expect(sendPass(failing.deps)).rejects.toThrow("tried again in 1 minutes");
	// Within its wait, the group sits the pass out: no token-max run, no upload.
	failing.clock.now += 30_000;
	expect(await sendPass(failing.deps)).toEqual([]);
	expect(failing.windows).toHaveLength(1);
	failing.clock.now += 30_000;
	await expect(sendPass(failing.deps)).rejects.toThrow("tried again in 2 minutes");
	failing.clock.now += 60_000;
	expect(await sendPass(failing.deps)).toEqual([]);
	// Another repository's stop, queued later, is sent from its own start meanwhile.
	const other = checkout(ENDPOINT);
	execFileSync("git", ["-C", other, "remote", "set-url", "origin", "https://github.com/acme/other.git"]);
	writeFileSync(join(other, "later.jsonl"), `{"type":"user","timestamp":"2026-11-06T11:00:00Z"}\n`);
	queue({ ...stopped(other), session: "s2", transcript: join(other, "later.jsonl") }, env);
	const others = sender(env, 200, [session("s2", "main", { repositories: ["acme/other"] })]);
	// The stand-in GitHub knows no acme/other, so that group fails too, after token-max read only its window.
	await expect(sendPass(others.deps)).rejects.toThrow("acme/other");
	expect(others.windows).toEqual([new Date("2026-11-06T11:00:00Z")]);
	// Once its wait ends, the first group is tried again and sent, and only the other's stop stays queued.
	failing.clock.now += 60_000;
	const fixed = sender(env, 200, [session("s1", "quest/m0/a")]);
	await expect(sendPass(fixed.deps)).rejects.toThrow("acme/other");
	expect(fixed.uploads).toHaveLength(1);
	expect(pending(env)).toHaveLength(1);
});

test("an unreadable backoff file reads as none, so it blocks no group", async () => {
	const env = home();
	queue(stopped(checkout(ENDPOINT)), env);
	const failing = sender(env, 500, [session("s1", "quest/m0/a")]);
	await expect(sendPass(failing.deps)).rejects.toThrow("tried again in 1 minutes");
	const dir = join(env.XDG_STATE_HOME!, "quest", "records", "backoff");
	const [name] = readdirSync(dir);
	expect(readdirSync(dir)).toEqual([name]);
	// As a crash mid-write would leave it, were it written in place.
	writeFileSync(join(dir, name!), '{"failures":');
	const sent = sender(env, 200, [session("s1", "quest/m0/a")]);
	expect(await sendPass(sent.deps)).toHaveLength(1);
	expect(readdirSync(dir)).toEqual([]);
});

test("an upload this version's own parseUpload refuses fails on the host, never posted", async () => {
	const env = home();
	queue(stopped(checkout(ENDPOINT)), env);
	const { deps, uploads } = sender(env, 200, [session("s1", "quest/m0/a", { cost: -1 })]);
	await expect(sendPass(deps)).rejects.toThrow("its own parseUpload refuses");
	expect(uploads).toEqual([]);
	expect(pending(env)).toHaveLength(1);
});

test("a session token-max no longer lists is dropped and said, without holding back the rest", async () => {
	const env = home();
	const root = checkout(ENDPOINT);
	queue(stopped(root), env);
	queue({ ...stopped(root), session: "gone" }, env);
	const { deps, uploads } = sender(env, 200, [session("s1", "quest/m0/a")]);
	expect(await sendPass(deps)).toEqual([
		{ endpoint: ENDPOINT, repository: "acme/proj", records: 1, breakages: 0, refused: false },
	]);
	expect(parseUpload(uploads[0]!.body).records.map((r) => r.session)).toEqual(["s1"]);
	expect(pending(env)).toEqual([]);
	expect(queue(stopped(root), env).notices).toEqual([
		expect.stringContaining("lists no claude session gone on this host, so its record was dropped"),
	]);
});

test("a sub-agent is sent only where its own checkout routes it", async () => {
	const env = home();
	const root = checkout(ENDPOINT);
	queue(stopped(root), env);
	const other = checkout(ENDPOINT);
	execFileSync("git", ["-C", other, "remote", "set-url", "origin", "https://github.com/acme/fork.git"]);
	const sessions = [
		session("s1", "quest/m0/a"),
		// Live checkouts: this one, another of the same origin and endpoint, one opted out, and another origin's.
		session("here", "quest/m0/a", { parent: "s1", cwd: root }),
		session("twin", "quest/m0/a", { parent: "s1", cwd: checkout(ENDPOINT) }),
		session("optedOut", "quest/m0/a", { parent: "s1", cwd: checkout() }),
		// A deleted folder routes by the checkout still holding its nearest existing parent.
		session("hereGone", "quest/m0/a", { parent: "s1", cwd: join(root, "deleted", "sub") }),
		session("optedOutGone", "quest/m0/a", { parent: "s1", cwd: join(checkout(), "deleted", "sub") }),
		// A deleted nested clone of another repository, inside this checkout.
		session("nestedGone", "main", {
			parent: "s1",
			cwd: join(root, "vendor", "other"),
			repositories: ["acme/other"],
		}),
		session("fork", "quest/m0/a", { parent: "s1", cwd: other, repositories: ["acme/fork", "acme/proj"] }),
		// Deleted checkouts: every repository resolved must be this one's.
		session("gone", "quest/m0/a", { parent: "s1" }),
		session("goneFork", "quest/m0/a", { parent: "s1", repositories: ["acme/fork", "acme/proj"] }),
		session("unknown", "quest/m0/a", { parent: "s1", repositories: null }),
	];
	const { deps, uploads } = sender(env, 200, sessions);
	await sendPass(deps);
	expect(parseUpload(uploads[0]!.body).records.map((r) => r.session)).toEqual([
		"s1",
		"here",
		"twin",
		"hereGone",
		"gone",
	]);
});

test("an origin that a URL rewrite points at GitHub is read as configured", () => {
	const env = home();
	const root = checkout(ENDPOINT);
	execFileSync("git", ["-C", root, "remote", "set-url", "origin", "gh:acme/proj"]);
	execFileSync("git", ["-C", root, "config", "url.https://github.com/.insteadOf", "gh:"]);
	expect(queue(stopped(root), env).queued).toBe(true);
	execFileSync("git", ["-C", root, "config", "--unset", "url.https://github.com/.insteadOf"]);
	execFileSync("git", ["-C", root, "remote", "set-url", "origin", "https://github.com/acme/proj.git"]);
	execFileSync("git", ["-C", root, "config", "url.git@github-work:.insteadOf", "https://github.com/"]);
	expect(queue(stopped(root), env).queued).toBe(true);
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
	// An ephemeral Codex session keeps no transcript, so its stop queues nothing.
	expect(hook({ ...base, session_id: "e1", transcript_path: null, turn_id: "t1" }, deps)).toBe("");
});

test("the sender passes every interval, records its PID, and outlives a failed pass", async () => {
	const env = home();
	writeFileSync(senderPid(env), "");
	const root = checkout(ENDPOINT);
	queue(stopped(root), env);
	let status = 500;
	const { deps, uploads, slept, clock } = sender(env, () => status, [session("s1", "quest/m0/a")]);
	const log: string[] = [];
	deps.sleep = async (ms) => {
		slept.push(ms);
		clock.now += ms;
		status = 200;
		if (slept.length === 3) throw new Error("stopped");
	};
	await expect(runSender(deps, (line) => log.push(line))).rejects.toThrow("stopped");
	expect(readFileSync(senderPid(env), "utf8")).toBe(String(process.pid));
	expect(slept).toEqual([60_000, 60_000, 60_000]);
	// The failed pass keeps the session; the next sends it, and the last finds the queue empty.
	expect(uploads).toHaveLength(2);
	expect(log).toEqual([
		expect.stringContaining("answered 500"),
		`sent 1 records and 0 breakages of acme/proj to ${ENDPOINT}`,
	]);
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

test("the sender sends the breakages a merged fix in its window names, reading an older culprit", async () => {
	const env = home();
	queue(stopped(checkout(ENDPOINT)), env);
	const fix = {
		...CULPRIT,
		number: 8,
		head: { ref: "fix/c", repo: { full_name: "acme/proj" } },
		merged_at: "2026-11-06T10:50:00Z",
		created_at: "2026-11-06T10:20:00Z",
		updated_at: "2026-11-06T10:50:00Z",
		closed_at: "2026-11-06T10:50:00Z",
		body: "## Caused by\n\n- [acme/proj#3](https://github.com/acme/proj/pull/3) - lost a frame (found by the queue)\n",
	};
	const { deps, uploads } = sender(env, 200, [session("s1", "quest/m0/a")], () => {}, [fix]);
	expect(await sendPass(deps)).toEqual([
		{ endpoint: ENDPOINT, repository: "acme/proj", records: 1, breakages: 1, refused: false },
	]);
	expect(parseUpload(uploads[0]!.body).breakages).toEqual([
		{
			repository: "acme/proj",
			culprit: {
				number: 3,
				merged: "2026-10-01T00:00:00.000Z",
				tier: null,
				size: "M",
				writers: [{ harness: "Claude Code", model: "claude-opus-5-5", effort: "medium" }],
				reviewers: [],
			},
			fix: 8,
			incident: null,
			found: "queue",
			at: "2026-11-06T10:20:00.000Z",
		},
	]);
});

test("an incident is posted at once, open until reported again with its culprit, and fails loud", async () => {
	const env = home();
	const root = checkout(ENDPOINT);
	const { deps, uploads } = sender(env, 200, []);
	const report = (pull: number | null) =>
		reportIncident(
			{
				cwd: root,
				id: "https://alerts.example/1",
				found: "canary",
				pull,
				at: Date.parse("2026-11-06T12:00:00Z"),
			},
			deps,
		);
	expect((await report(null)).culprit).toBeNull();
	expect((await report(3)).culprit).toMatchObject({ number: 3, size: "M" });
	expect(uploads.map((u) => parseUpload(u.body))).toEqual([
		{
			records: [],
			breakages: [
				expect.objectContaining({
					incident: "https://alerts.example/1",
					culprit: null,
					fix: null,
					found: "canary",
					at: "2026-11-06T12:00:00.000Z",
				}),
			],
		},
		{ records: [], breakages: [expect.objectContaining({ culprit: expect.objectContaining({ number: 3 }) })] },
	]);
	await expect(report(4)).rejects.toThrow("acme/proj has no PR #4");
	await expect(
		reportIncident({ cwd: root, id: "x", found: "person", pull: null, at: 0 }, sender(env, 403, []).deps),
	).rejects.toThrow("answered 403");
	await expect(
		reportIncident({ cwd: root, id: "x", found: "person", pull: null, at: 0 }, sender(home(null), 200, []).deps),
	).rejects.toThrow("holds no token");
	await expect(
		reportIncident({ cwd: checkout(), id: "x", found: "person", pull: null, at: 0 }, deps),
	).rejects.toThrow("names no record endpoint");
});
