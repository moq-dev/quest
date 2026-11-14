import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { type SessionRecord, parseRecord, parseUpload } from "../src/core";
import { buildRecords } from "../src/cli/records";
import { transcriptFacts } from "../src/cli/transcript";
import type { Pull, Session } from "../src/cli/usage";
import { type LoggedWait, logWait, pullWaitKind, readWaits, waitsDirectory } from "../src/cli/waits";
import { tempDir } from "./fixture";

const record = (extra: Partial<SessionRecord> = {}): SessionRecord => ({
	harness: "claude",
	session: "s1",
	parent: null,
	repository: "acme/proj",
	branch: "quest/m0/a",
	quest: "quest/m0/a.md",
	pulls: [10],
	role: "implementing",
	models: [
		{
			model: "claude-opus-5-5",
			effort: "high",
			input: 1,
			cacheWrite: 2,
			cacheRead: 3,
			output: 4,
			cost: 0.5,
			complete: true,
		},
	],
	cost: 0.5,
	complete: true,
	start: "2026-11-06T10:00:00.000Z",
	end: "2026-11-06T11:00:00.000Z",
	waits: [
		{ kind: "pull", start: "2026-11-06T10:10:00.000Z", end: "2026-11-06T10:20:00.000Z", until: "checks:passed" },
	],
	...extra,
});

describe("parseRecord", () => {
	test("orders instants by time, not by their text", () => {
		expect(parseRecord(record({ start: "2026-11-06T10:00:00Z", end: "2026-11-06T10:00:00.001Z" })).end).toBe(
			"2026-11-06T10:00:00.001Z",
		);
	});

	test("keeps a well-formed record exactly", () => {
		const sent = record();
		expect(parseRecord(JSON.parse(JSON.stringify(sent)))).toEqual(sent);
		expect(parseRecord(record({ waits: null, pulls: [], branch: null, quest: null }))).toMatchObject({
			waits: null,
		});
	});

	test.each([
		["an unknown field", { ...record(), extra: 1 }, "unknown field extra"],
		["an unknown role", record({ role: "lurking" as never }), "role"],
		["a negative cost", record({ cost: -1 }), "cost"],
		["a PR listed twice", record({ pulls: [10, 10] }), "twice"],
		["a local-time instant", record({ start: "2026-11-06T10:00:00" }), "start"],
		[
			"a wait ending before it starts",
			record({
				waits: [
					{ kind: "person", start: "2026-11-06T10:20:00.000Z", end: "2026-11-06T10:10:00.000Z", until: null },
				],
			}),
			"ends before",
		],
		[
			"a gate wait naming an event",
			record({
				waits: [
					{
						kind: "gate-run",
						start: "2026-11-06T10:10:00.000Z",
						end: "2026-11-06T10:20:00.000Z",
						until: "merged",
					},
				],
			}),
			"names what ended it",
		],
		[
			"an end before its start in finer precision",
			record({ start: "2026-11-06T10:00:00.001Z", end: "2026-11-06T10:00:00Z" }),
			"ends before it starts",
		],
		["a mixed-case repository", record({ repository: "Acme/Proj" }), "lowercase"],
		["a quest that is not a path", record({ quest: "a.md" }), "quest path"],
	])("refuses %s", (_, value, message) => {
		expect(() => parseRecord(value)).toThrow(message);
	});

	test("an upload fails whole on one bad record or a session sent twice", () => {
		expect(parseUpload({ records: [record(), record({ session: "s2" })] }).records).toHaveLength(2);
		expect(() => parseUpload({ records: [record(), record({ session: "s2", cost: Number.NaN })] })).toThrow("cost");
		expect(() => parseUpload({ records: [record(), record()] })).toThrow("twice");
		expect(() => parseUpload({ records: [], more: true })).toThrow("unknown field");
		// A record may name no session, but no upload carries one, since the store replaces records by session.
		expect(parseRecord(record({ session: null })).session).toBeNull();
		expect(() => parseUpload({ records: [record({ session: null })] })).toThrow("names no session");
	});
});

describe("wait log", () => {
	const env = (extra: NodeJS.ProcessEnv = {}) => ({ XDG_STATE_HOME: tempDir(), ...extra });
	const wait = {
		kind: "gate-run" as const,
		start: "2026-11-06T10:00:00.000Z",
		end: "2026-11-06T10:05:00.000Z",
		until: null,
	};

	test("logs only in an agent session, naming every session the environment does", () => {
		const outside = env();
		logWait(wait, { env: outside, cwd: "/w", now: Date.parse(wait.end) });
		expect(existsSync(waitsDirectory(outside))).toBe(false);
		const inside = env({ CLAUDE_CODE_SESSION_ID: "c1", CODEX_THREAD_ID: "x1" });
		logWait(wait, { env: inside, cwd: "/w", now: Date.parse(wait.end) });
		expect(readWaits(0, inside)).toEqual([
			{
				...wait,
				sessions: [
					{ harness: "claude", session: "c1" },
					{ harness: "codex", session: "x1" },
				],
				directory: "/w",
			},
		]);
	});

	test("reads waits that ended since an instant, tolerating only a cut-off last line", () => {
		const e = env({ CODEX_THREAD_ID: "x1" });
		logWait(wait, { env: e, cwd: "/w", now: Date.parse(wait.end) });
		const later = { ...wait, start: "2026-11-07T10:00:00.000Z", end: "2026-11-07T10:05:00.000Z" };
		logWait(later, { env: e, cwd: "/w", now: Date.parse(later.end) });
		expect(readWaits(Date.parse("2026-11-07T00:00:00Z"), e).map((w) => w.end)).toEqual([later.end]);
		const today = join(waitsDirectory(e), "2026-11-07.jsonl");
		appendFileSync(today, '{"kind":"gate-r');
		expect(readWaits(0, e)).toHaveLength(2);
		appendFileSync(today, '\n{"kind":"gate-run"}\n');
		expect(() => readWaits(0, e)).toThrow("2026-11-07.jsonl:2");
	});

	test("drops days past what it keeps", () => {
		const e = env({ CODEX_THREAD_ID: "x1" });
		const dir = waitsDirectory(e);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "2026-01-01.jsonl"), "");
		writeFileSync(join(dir, "notes.txt"), "");
		logWait(wait, { env: e, cwd: "/w", now: Date.parse("2026-11-06T10:05:00Z") });
		expect(readdirSync(dir).sort()).toEqual(["2026-11-06.jsonl", "notes.txt"]);
	});

	test("a quest wait that ends on a merge or a dequeue waited on the merge queue", () => {
		expect(pullWaitKind("merged")).toBe("merge-queue");
		expect(pullWaitKind("removed_from_merge_queue")).toBe("merge-queue");
		expect(pullWaitKind("checks:passed")).toBe("pull");
		expect(pullWaitKind(null)).toBe("pull");
	});
});

const line = (value: object) => `${JSON.stringify(value)}\n`;

describe("transcriptFacts", () => {
	test("reads a Claude transcript's first quest skill and how long each question waited", () => {
		const path = join(tempDir(), "s.jsonl");
		const skill = (name: string, at: string) =>
			line({
				type: "user",
				isMeta: true,
				isSidechain: true,
				timestamp: at,
				message: {
					content: [{ type: "text", text: `Base directory for this skill: /x/.claude/skills/${name}` }],
				},
			});
		writeFileSync(
			path,
			line({ type: "summary" }) +
				skill("simplify", "2026-11-06T10:00:00Z") +
				skill("quest-start", "2026-11-06T10:01:00Z") +
				skill("quest-review", "2026-11-06T10:02:00Z") +
				line({
					type: "assistant",
					timestamp: "2026-11-06T10:03:00Z",
					message: { content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: {} }] },
				}) +
				line({
					type: "user",
					timestamp: "2026-11-06T10:13:00Z",
					message: { content: [{ type: "tool_result", tool_use_id: "q1", content: "x" }] },
					toolUseResult: { questions: [], answers: {} },
				}) +
				// A question still open has no wait yet.
				line({
					type: "assistant",
					timestamp: "2026-11-06T10:20:00Z",
					message: { content: [{ type: "tool_use", id: "q2", name: "AskUserQuestion", input: {} }] },
				}),
		);
		expect(transcriptFacts("claude", [path])).toEqual({
			skill: "quest-start",
			questions: [{ start: Date.parse("2026-11-06T10:03:00Z"), end: Date.parse("2026-11-06T10:13:00Z") }],
		});
	});

	test("reads Codex's blocking and asynchronous questions", () => {
		const path = join(tempDir(), "rollout.jsonl");
		const item = (at: string, payload: object) => line({ timestamp: at, type: "response_item", payload });
		writeFileSync(
			path,
			line({ timestamp: "2026-11-06T10:00:00Z", type: "session_meta", payload: { id: "t1" } }) +
				item("2026-11-06T10:00:01Z", {
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "<skill><name>quest-iterate</name></skill>" }],
					internal_chat_message_metadata_passthrough: {
						content_item_metadata: [{ provenance: { type: "skills" } }],
					},
				}) +
				item("2026-11-06T10:01:00Z", {
					type: "function_call",
					name: "request_user_input",
					call_id: "c1",
					arguments: "{}",
				}) +
				item("2026-11-06T10:02:00Z", {
					type: "function_call_output",
					call_id: "c1",
					output: '{"answers":{}}',
				}) +
				item("2026-11-06T10:03:00Z", {
					type: "function_call",
					name: "request_user_input_async",
					call_id: "c2",
					arguments: "{}",
				}) +
				item("2026-11-06T10:03:01Z", {
					type: "function_call_output",
					call_id: "c2",
					output: '{"status":"sent"}',
				}) +
				item("2026-11-06T10:09:00Z", {
					type: "message",
					role: "user",
					content: [
						{
							type: "input_text",
							text: `<send_user_message_question_reply>${JSON.stringify([{ questionItemId: JSON.stringify(["x", "c2", 0]), answer: "A" }])}</send_user_message_question_reply>`,
						},
					],
				}),
		);
		expect(transcriptFacts("codex", [path])).toEqual({
			skill: "quest-iterate",
			questions: [
				{ start: Date.parse("2026-11-06T10:01:00Z"), end: Date.parse("2026-11-06T10:02:00Z") },
				{ start: Date.parse("2026-11-06T10:03:00Z"), end: Date.parse("2026-11-06T10:09:00Z") },
			],
		});
	});
});

describe("buildRecords", () => {
	const at = (time: string) => Date.parse(`2026-11-06T${time}Z`);
	const session = (id: string, extra: Partial<Session> = {}): Session => ({
		host: null,
		harness: "claude",
		id,
		parent: null,
		review: false,
		cwd: "/w",
		repositories: ["acme/proj"],
		branches: [],
		start: at("10:00:00"),
		end: at("12:00:00"),
		models: [
			{ model: "m", effort: "high", input: 1, cacheWrite: 0, cacheRead: 0, output: 1, cost: 1, complete: true },
		],
		cost: 1,
		complete: true,
		skippedLines: 0,
		files: [],
		...extra,
	});
	const pull = (number: number, branch: string, created: string): Pull => ({
		number,
		url: `https://github.com/acme/proj/pull/${number}`,
		title: "t",
		branch,
		repository: "acme/proj",
		state: "open",
		draft: false,
		created: at(created),
		closed: null,
		body: "",
	});
	const logged = (kind: LoggedWait["kind"], start: string, sessions: string[], directory = "/w"): LoggedWait => ({
		kind,
		start: `2026-11-06T${start}.000Z`,
		end: `2026-11-06T${start.replace(/:\d\d$/, ":59")}.000Z`,
		until: null,
		sessions: sessions.map((s) => ({ harness: "claude", session: s })),
		directory,
	});

	test("a coordinator shares its sub-agents' PRs, and a helper sub-agent its parent's", () => {
		const coordinator = session("run");
		const a = session("a", { parent: "run", cwd: "/w/.worktrees/a", start: at("10:10:00"), end: at("10:50:00") });
		const b = session("b", { parent: "run", cwd: "/w/.worktrees/b", start: at("10:20:00"), end: at("11:00:00") });
		const helper = session("h", { parent: "a", start: at("10:15:00"), end: at("10:16:00") });
		const loose = session("loose", {
			branches: [{ name: "quest-plan/x", first: at("10:00:00"), last: at("10:01:00") }],
		});
		const p1 = pull(1, "quest/m0/a", "10:30:00");
		const p2 = pull(2, "quest/m0/b", "10:05:00");
		const records = buildRecords({
			repository: "acme/proj",
			sessions: [coordinator, a, b, helper, loose],
			own: new Map([
				[a, p1],
				[b, p2],
			]),
			reviewers: new Set(),
			waits: [
				logged("gate-run", "10:40:00", ["run"], "/w/.worktrees/a/src"),
				logged("gate-queue", "10:25:00", ["run"], "/w"),
				logged("pull", "10:30:00", ["run"], "/w/.worktrees"),
				// Outside any session's window that is running there, it stays with the coordinator.
				logged("gate-run", "11:30:00", ["run"], "/w/.worktrees/b"),
			],
			emit: new Set([coordinator, a, b, helper, loose]),
			since: 0,
		});
		const of = (s: Session) => records.get(s)!;
		expect(of(coordinator)).toMatchObject({ pulls: [1, 2], role: "coordinating", branch: null, quest: null });
		expect(of(a)).toMatchObject({ pulls: [1], role: "implementing", branch: "quest/m0/a", quest: "quest/m0/a.md" });
		expect(of(b)).toMatchObject({ pulls: [2], role: "iterating" });
		expect(of(helper)).toMatchObject({ pulls: [1], role: "implementing", parent: "a" });
		expect(of(loose)).toMatchObject({ pulls: [], role: "planning", branch: "quest-plan/x", quest: null });
		expect(of(a).waits!.map((w) => w.kind)).toEqual(["gate-run"]);
		expect(of(b).waits).toEqual([]);
		// Two sub-agents are running where the wait ran, so the coordinator keeps it.
		expect(of(coordinator).waits!.map((w) => [w.kind, w.start.slice(11, 16)])).toEqual([
			["gate-queue", "10:25"],
			["pull", "10:30"],
			["gate-run", "11:30"],
		]);
	});

	test("reviewers, skills, and the innermost of several sessions a wait names", () => {
		const transcript = join(tempDir(), "t.jsonl");
		writeFileSync(
			transcript,
			line({
				type: "user",
				isMeta: true,
				timestamp: "2026-11-06T10:00:00Z",
				message: { content: [{ type: "text", text: "Base directory for this skill: /s/quest-merge" }] },
			}),
		);
		const merger = session("m", { files: [transcript] });
		const reviewer = session("r", { harness: "codex", start: at("10:30:00") });
		const remote = session("far", { host: "box" });
		const p = pull(3, "quest/m0/c", "09:00:00");
		const records = buildRecords({
			repository: "acme/proj",
			sessions: [merger, reviewer, remote],
			own: new Map([
				[merger, p],
				[reviewer, p],
				[remote, p],
			]),
			reviewers: new Set(["r"]),
			waits: [
				{
					...logged("gate-run", "10:40:00", []),
					sessions: [
						{ harness: "claude", session: "m" },
						{ harness: "codex", session: "r" },
					],
				},
			],
			since: 0,
		});
		expect(records.get(merger)).toMatchObject({ role: "merging", waits: [] });
		expect(records.get(reviewer)!.role).toBe("reviewing");
		expect(records.get(reviewer)!.waits!.map((w) => w.kind)).toEqual(["gate-run"]);
		expect(records.get(remote)!.waits).toBeNull();
		for (const r of records.values()) expect(parseRecord(JSON.parse(JSON.stringify(r)))).toEqual(r);
	});

	test("without emit, only sessions on a PR get a record", () => {
		const on = session("on");
		const off = session("off");
		const records = buildRecords({
			repository: "acme/proj",
			sessions: [on, off],
			own: new Map([[on, pull(1, "quest/m0/a", "09:00:00")]]),
			reviewers: new Set(),
			waits: [],
			since: 0,
		});
		expect([...records.keys()]).toEqual([on]);
	});

	test("a session with no ID keeps its PR, and a wait begun before the window still counts", () => {
		const anonymous = { ...session("x"), id: null };
		// Its first request in the window comes after the wait ended.
		const named = session("n", { start: at("10:45:00") });
		const records = buildRecords({
			repository: "acme/proj",
			sessions: [anonymous, named],
			own: new Map([
				[anonymous, pull(1, "quest/m0/a", "09:00:00")],
				[named, pull(1, "quest/m0/a", "09:00:00")],
			]),
			reviewers: new Set(),
			// Begun at 10:10, before the window opened at 10:20 and before the session's first request in it.
			waits: [{ ...logged("pull", "10:10:00", ["n"]), end: "2026-11-06T10:40:00.000Z" }],
			since: at("10:20:00"),
		});
		expect(records.get(anonymous)).toMatchObject({ session: null, pulls: [1] });
		expect(records.get(named)!.waits!.map((w) => w.kind)).toEqual(["pull"]);
	});

	test("a person's wait is windowed, and an unreadable transcript leaves waits unknown", () => {
		const transcript = join(tempDir(), "t.jsonl");
		const ask = (id: string, asked: string, answered: string) =>
			line({
				type: "assistant",
				timestamp: `2026-11-06T${asked}Z`,
				message: { content: [{ type: "tool_use", id, name: "AskUserQuestion", input: {} }] },
			}) +
			line({
				type: "user",
				timestamp: `2026-11-06T${answered}Z`,
				message: { content: [{ type: "tool_result", tool_use_id: id }] },
			});
		writeFileSync(transcript, ask("q1", "08:00:00", "08:30:00") + ask("q2", "10:10:00", "10:20:00"));
		const asked = session("asked", { files: [transcript] });
		const broken = join(tempDir(), "b.jsonl");
		writeFileSync(broken, '{"type":"assistant","AskUserQuestion" not json\n{"type":"summary"}\n');
		const skipped = session("skipped", { files: [broken], skippedLines: 1, complete: false });
		const p = pull(1, "quest/m0/a", "09:00:00");
		const input = {
			repository: "acme/proj",
			sessions: [asked, skipped],
			own: new Map([
				[asked, p],
				[skipped, p],
			]),
			reviewers: new Set<string>(),
			waits: [],
			since: at("09:00:00"),
		};
		const records = buildRecords(input);
		expect(records.get(asked)!.waits).toEqual([
			{ kind: "person", start: "2026-11-06T10:10:00.000Z", end: "2026-11-06T10:20:00.000Z", until: null },
		]);
		expect(records.get(skipped)!.waits).toBeNull();
		// A line token-max read but quest cannot is a shape quest does not know.
		const unknown = { ...skipped, skippedLines: 0 };
		expect(() => buildRecords({ ...input, sessions: [unknown], own: new Map([[unknown, p]]) })).toThrow("not JSON");
	});
});
