import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import {
	claudeText,
	messageLines,
	messages,
	readClaudeMessages,
	readCodexMessages,
	readT3Messages,
} from "../src/cli/messages";
import { tempDir } from "./fixture";

const SESSION = "0d8d9084-40a0-48e2-921b-8ba0d67baa2f";
const THREAD = "01a1b8e8-8fca-7793-99d1-062f41f8a7b0";
const SINCE = Date.parse("2026-11-01T00:00:00");

const lines = (...records: unknown[]) => `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
const plain = (dir: string) => dir;

/** A Claude Code user turn. */
const turn = (timestamp: string, content: unknown, extra: object = {}) => ({
	type: "user",
	timestamp,
	cwd: "/work/proj",
	entrypoint: "claude-desktop",
	origin: { kind: "human" },
	message: { role: "user", content },
	...extra,
});

const codexMeta = (payload: object) => ({
	type: "session_meta",
	timestamp: "2026-11-06T10:00:00Z",
	payload: { id: THREAD, cwd: "/work/proj", source: "vscode", originator: "Codex Desktop", ...payload },
});

/** A Codex user turn whose parts carry these provenances. */
const codexTurn = (timestamp: string, parts: [string, string][]) => ({
	type: "response_item",
	timestamp,
	payload: {
		type: "message",
		role: "user",
		content: parts.map(([text]) => ({ type: "input_text", text })),
		internal_chat_message_metadata_passthrough: {
			content_item_metadata: parts.map(([, type]) => ({ provenance: { type } })),
		},
	},
});

/** A T3 Code state holding the given user messages, each in a Claude Code run of a project at `root`. */
function t3State(path: string, root: string, rows: { id: string; at: string; payload: object }[]): void {
	const db = new DatabaseSync(path);
	db.exec(`
		CREATE TABLE orchestration_v2_projection_messages (message_id TEXT, thread_id TEXT, run_id TEXT, role TEXT, created_at TEXT, payload_json TEXT);
		CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, provider_thread_id TEXT);
		CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT, payload_json TEXT);
		CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT);
		CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT);
		INSERT INTO orchestration_v2_projection_runs VALUES ('run', 'pt');
		INSERT INTO orchestration_v2_projection_threads VALUES ('thread', 'project');
	`);
	db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES ('pt', ?)").run(
		JSON.stringify({ driver: "claudeAgent", nativeThreadRef: { driver: "claudeAgent", nativeId: SESSION } }),
	);
	db.prepare("INSERT INTO projection_projects VALUES ('project', ?)").run(root);
	const insert = db.prepare(
		"INSERT INTO orchestration_v2_projection_messages VALUES (?, 'thread', 'run', 'user', ?, ?)",
	);
	for (const row of rows) insert.run(row.id, row.at, JSON.stringify(row.payload));
	db.close();
}

describe("claudeText", () => {
	test("drops harness reminders and spells a slash command as typed", () => {
		expect(claudeText("<system-reminder>\nworktree\n</system-reminder>\n\nship it")).toBe("ship it");
		expect(
			claudeText(
				"<command-message>quest-start</command-message>\n<command-name>/quest-start</command-name>\n<command-args>quest/m0/a.md</command-args>",
			),
		).toBe("/quest-start quest/m0/a.md");
		expect(claudeText("<command-message>merge</command-message>\n<command-name>/merge</command-name>")).toBe(
			"/merge",
		);
		expect(claudeText([{ type: "text", text: "look" }, { type: "image" }, { type: "text", text: "here" }])).toBe(
			"look\nhere",
		);
	});

	test("drops tool results, shell output, and canned prompts", () => {
		expect(claudeText([{ type: "tool_result", content: "out" }])).toBeNull();
		expect(claudeText("<bash-input>ls</bash-input><bash-stdout>a</bash-stdout>")).toBeNull();
		expect(claudeText("<local-command-stdout>done</local-command-stdout>")).toBeNull();
		expect(claudeText("<create-pr-command>\n## Overview\n</create-pr-command>")).toBeNull();
		expect(claudeText("<system-reminder>only</system-reminder>")).toBeNull();
	});
});

describe("readCodexMessages", () => {
	test("reads only the parts Codex marks as the user's", () => {
		const path = join(tempDir(), `rollout-${THREAD}.jsonl`);
		writeFileSync(
			path,
			lines(
				codexMeta({ git: { repository_url: "git@github.com:acme/proj.git" } }),
				codexTurn("2026-10-30T10:00:00Z", [["too early", "user"]]),
				codexTurn("2026-11-06T10:00:00Z", [
					["# AGENTS.md instructions", "agents_md"],
					["<environment_context>", "harness"],
				]),
				codexTurn("2026-11-06T10:01:00Z", [["fix the build", "user"]]),
				{
					type: "response_item",
					timestamp: "2026-11-06T10:02:00Z",
					payload: { role: "assistant", content: [] },
				},
			),
		);
		expect(readCodexMessages(path, SINCE, plain)).toEqual([
			{
				kind: "message",
				time: "2026-11-06T10:01:00.000Z",
				harness: "codex",
				repository: "acme/proj",
				session: THREAD,
				text: "fix the build",
			},
		]);
	});

	test("skips headless, sub-agent, and T3 Code sessions", () => {
		for (const meta of [{ source: "exec" }, { source: { subagent: "review" } }, { originator: "T3 Code" }]) {
			const path = join(tempDir(), "rollout.jsonl");
			writeFileSync(path, lines(codexMeta(meta), codexTurn("2026-11-06T10:01:00Z", [["brief", "user"]])));
			expect(readCodexMessages(path, SINCE, plain)).toEqual([]);
		}
	});

	test("reads a record written with spaces", () => {
		const path = join(tempDir(), "rollout.jsonl");
		writeFileSync(
			path,
			`${JSON.stringify(codexMeta({}))}\n${JSON.stringify(codexTurn("2026-11-06T10:01:00Z", [["hi", "user"]]), null, 1).replaceAll("\n", "")}\n`,
		);
		expect(readCodexMessages(path, SINCE, plain).map((m) => m.kind === "message" && m.text)).toEqual(["hi"]);
	});

	test("fails on a user turn whose provenance does not cover each part, which cannot be told apart", () => {
		const turn = (meta: object | undefined) => ({
			type: "response_item",
			timestamp: "2026-11-06T10:01:00Z",
			payload: {
				role: "user",
				content: [
					{ type: "input_text", text: "hi" },
					{ type: "input_text", text: "there" },
				],
				internal_chat_message_metadata_passthrough: meta,
			},
		});
		for (const meta of [
			undefined,
			{},
			{ content_item_kinds: ["user.text", "unknown"] },
			{ content_item_kinds: ["user.text", "plugins.mystery"] },
			{ content_item_metadata: [{ provenance: { type: "user" } }] },
			{ content_item_metadata: [{ provenance: { type: "user" } }, { kind: "user" }] },
			{ content_item_metadata: [{ provenance: { type: "user" } }, { provenance: { type: "plugin" } }] },
		]) {
			const path = join(tempDir(), "rollout.jsonl");
			writeFileSync(path, lines(codexMeta({}), turn(meta)));
			expect(() => readCodexMessages(path, SINCE, plain)).toThrow(/provenance/);
		}
	});
});

describe("readCodexMessages from Codex 0.162's TUI", () => {
	/** A user turn that marks its parts with content kinds and carries no provenance, as codex-tui 0.162 writes. */
	const kindTurn = (timestamp: string, parts: [string, string][]) => ({
		type: "response_item",
		timestamp,
		payload: {
			type: "message",
			role: "user",
			content: parts.map(([text]) => ({ type: "input_text", text })),
			internal_chat_message_metadata_passthrough: { content_item_kinds: parts.map(([, kind]) => kind) },
		},
	});

	test("reads typed text and sets injected kinds and compaction replays aside", () => {
		const path = join(tempDir(), "rollout.jsonl");
		writeFileSync(
			path,
			lines(
				codexMeta({ source: "cli", originator: "codex-tui" }),
				kindTurn("2026-11-06T10:00:00Z", [
					["# AGENTS.md", "agents_md.instructions"],
					["<environment_context/>", "environments.environment_context"],
				]),
				kindTurn("2026-11-06T10:01:00Z", [["fix it", "user.text"]]),
				kindTurn("2026-11-06T10:02:00Z", [["replayed", "unknown"]]),
			),
		);
		expect(readCodexMessages(path, SINCE, plain).map((m) => m.kind === "message" && m.text)).toEqual(["fix it"]);
	});

	test("fails on a kind it does not know", () => {
		const path = join(tempDir(), "rollout.jsonl");
		writeFileSync(path, lines(codexMeta({}), kindTurn("2026-11-06T10:01:00Z", [["x", "plugins.mystery"]])));
		expect(() => readCodexMessages(path, SINCE, plain)).toThrow(/unknown provenance: plugins.mystery/);
	});
});

/** A Claude Code answer to `AskUserQuestion`, as the tool result's record holds it. */
const claudeAnswer = (timestamp: string, answers: object, extra: object = {}) => ({
	type: "user",
	timestamp,
	cwd: "/work/proj",
	entrypoint: "t3-code",
	message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "answered" }] },
	toolUseResult: {
		questions: [
			{
				question: "Which color?",
				header: "Color",
				multiSelect: false,
				options: [{ label: "Red (Recommended)" }, { label: "Blue" }],
			},
			{ question: "Which sizes?", header: "Sizes", multiSelect: true, options: [{ label: "S" }, { label: "M" }] },
		],
		answers,
	},
	...extra,
});

/** The meta turn Claude Code writes when a skill loads, typed or called. */
const skillTurn = (timestamp: string, dir: string) => ({
	type: "user",
	isMeta: true,
	timestamp,
	cwd: "/work/proj",
	message: { role: "user", content: [{ type: "text", text: `Base directory for this skill: ${dir}\n\n# Body` }] },
});

describe("readClaudeMessages", () => {
	test("reads answers with the recommended options and the skill the session last ran, in every session", () => {
		const path = join(tempDir(), `${SESSION}.jsonl`);
		writeFileSync(
			path,
			lines(
				claudeAnswer("2026-10-30T10:00:00Z", { "Which color?": "Blue" }),
				turn("2026-11-06T09:00:00Z", "<command-name>/quest-plan</command-name><command-args>x</command-args>"),
				skillTurn("2026-11-06T09:00:01Z", "/my repo/.claude/skills/quest-plan"),
				claudeAnswer("2026-11-06T09:01:00Z", {
					"Which color?": "Red (Recommended)",
					"Which sizes?": ["S", "M"],
				}),
				skillTurn("2026-11-06T09:02:00Z", "/plugins/p/skills/quest-merge/"),
				turn("2026-11-06T09:02:30Z", "<command-name>/compact</command-name>", { entrypoint: "t3-code" }),
				claudeAnswer("2026-11-06T09:03:00Z", { "Which color?": "green, please" }),
				claudeAnswer("2026-11-06T09:04:00Z", { "Which color?": "Blue" }, { isSidechain: true }),
			),
		);
		const base = {
			kind: "answer",
			harness: "claude",
			repository: "/work/proj",
			session: SESSION,
			options: ["Red (Recommended)", "Blue"],
			recommended: ["Red (Recommended)"],
		};
		expect(readClaudeMessages(path, SESSION, SINCE, plain)).toEqual([
			{
				kind: "message",
				time: "2026-11-06T09:00:00.000Z",
				harness: "claude",
				repository: "/work/proj",
				session: SESSION,
				text: "/quest-plan x",
			},
			{
				...base,
				time: "2026-11-06T09:01:00.000Z",
				skill: "quest-plan",
				header: "Color",
				question: "Which color?",
				picked: ["Red (Recommended)"],
			},
			{
				...base,
				time: "2026-11-06T09:01:00.000Z",
				skill: "quest-plan",
				header: "Sizes",
				question: "Which sizes?",
				options: ["S", "M"],
				recommended: [],
				picked: ["S", "M"],
			},
			{
				...base,
				time: "2026-11-06T09:03:00.000Z",
				skill: "quest-merge",
				header: "Color",
				question: "Which color?",
				picked: ["green, please"],
			},
		]);
	});

	test("skips and counts a malformed line, such as a partial record left mid-file", () => {
		const path = join(tempDir(), `${SESSION}.jsonl`);
		const partial = JSON.stringify(turn("2026-11-06T09:00:00Z", "lost")).slice(0, -10);
		const cut = JSON.stringify({ type: "assistant", message: { content: "long reply" } }).slice(0, 30);
		writeFileSync(
			path,
			`${partial}\n${cut}\n{"type":"user","message":{"content":"lost"}\n${lines(turn("2026-11-06T09:01:00Z", "kept"))}`,
		);
		expect(() => readClaudeMessages(path, SESSION, SINCE, plain)).toThrow(/not JSON/);
		let skipped = 0;
		const found = readClaudeMessages(path, SESSION, SINCE, plain, () => skipped++);
		expect(found.map((m) => m.kind === "message" && m.text)).toEqual(["kept"]);
		expect(skipped).toBe(3);
	});

	test("fails on answers in a shape it does not know", () => {
		for (const answers of [{ "Which color?": 3 }, null]) {
			const path = join(tempDir(), "s.jsonl");
			writeFileSync(path, lines(claudeAnswer("2026-11-06T09:01:00Z", answers as object)));
			expect(() => readClaudeMessages(path, SESSION, SINCE, plain)).toThrow(/shape/);
		}
	});
});

describe("readCodexMessages answers", () => {
	const call = (name: string, id: string, questions: object[]) => ({
		type: "response_item",
		timestamp: "2026-11-06T10:01:00Z",
		payload: { type: "function_call", name, call_id: id, arguments: JSON.stringify({ questions }) },
	});
	const reply = (answers: object[]) =>
		`<send_user_message_question_reply>\n${JSON.stringify(answers)}\n</send_user_message_question_reply>`;

	test("pairs each answer with the question its call asked, in T3 Code's sessions too", () => {
		for (const originator of ["Codex Desktop", "T3 Code"]) {
			const path = join(tempDir(), "rollout.jsonl");
			writeFileSync(
				path,
				lines(
					codexMeta({ originator }),
					codexTurn("2026-11-06T10:00:00Z", [
						["<skill>\n<name>quest-start</name>\n<path>/s</path>", "skills"],
					]),
					call("request_user_input_async", "call_a", [
						{ title: "Ship it?", options: ["Yes (Recommended)", "No"] },
					]),
					{
						type: "response_item",
						timestamp: "2026-11-06T10:01:01Z",
						payload: { type: "function_call_output", call_id: "call_a", output: '{"accepted":true}' },
					},
					call("request_user_input", "call_b", [
						{
							id: "q1",
							header: "Mode",
							question: "Which mode?",
							options: [{ label: "Fast" }, { label: "Safe (Recommended)" }],
						},
					]),
					{
						type: "response_item",
						timestamp: "2026-11-06T10:02:00Z",
						payload: {
							type: "function_call_output",
							call_id: "call_b",
							output: '{"answers":{"q1":{"answers":["Fast"]}}}',
						},
					},
					codexTurn("2026-11-06T10:03:00Z", [
						[
							reply([
								{
									questionItemId: '["request_user_input_async","call_a",0]',
									question: "Ship it?",
									answer: "No",
								},
							]),
							"user",
						],
						["also rename it", "user"],
					]),
				),
			);
			const base = {
				kind: "answer",
				harness: "codex",
				repository: "/work/proj",
				session: THREAD,
				skill: "quest-start",
			};
			const answers = [
				{
					...base,
					time: "2026-11-06T10:02:00.000Z",
					header: "Mode",
					question: "Which mode?",
					options: ["Fast", "Safe (Recommended)"],
					recommended: ["Safe (Recommended)"],
					picked: ["Fast"],
				},
				{
					...base,
					time: "2026-11-06T10:03:00.000Z",
					header: null,
					question: "Ship it?",
					options: ["Yes (Recommended)", "No"],
					recommended: ["Yes (Recommended)"],
					picked: ["No"],
				},
			];
			const typed = {
				kind: "message",
				time: "2026-11-06T10:03:00.000Z",
				harness: "codex",
				repository: "/work/proj",
				session: THREAD,
				text: "also rename it",
			};
			expect(readCodexMessages(path, SINCE, plain)).toEqual(
				originator === "T3 Code" ? answers : [...answers, typed],
			);
		}
	});

	test("skips a cancelled question and reads turns before the window only for their skill", () => {
		const path = join(tempDir(), "rollout.jsonl");
		writeFileSync(
			path,
			lines(
				codexMeta({}),
				{
					type: "response_item",
					timestamp: "2026-10-30T10:00:00Z",
					payload: { role: "user", content: [{ text: "old" }] },
				},
				{ ...call("request_user_input", "call_old", [{ bogus: 1 }]), timestamp: "2026-10-30T10:00:00Z" },
				call("request_user_input", "call_b", [
					{ id: "q1", question: "Which mode?", options: [{ label: "Fast" }] },
				]),
				{
					type: "response_item",
					timestamp: "2026-11-06T10:02:00Z",
					payload: {
						type: "function_call_output",
						call_id: "call_b",
						output: "request_user_input was cancelled",
					},
				},
			),
		);
		expect(readCodexMessages(path, SINCE, plain)).toEqual([]);
	});

	test("fails on an answer to a question its log does not hold", () => {
		const path = join(tempDir(), "rollout.jsonl");
		writeFileSync(
			path,
			lines(
				codexMeta({}),
				codexTurn("2026-11-06T10:03:00Z", [
					[reply([{ questionItemId: '["request_user_input_async","call_x",0]', answer: "No" }]), "user"],
				]),
			),
		);
		expect(() => readCodexMessages(path, SINCE, plain)).toThrow(/does not hold/);
	});
});

describe("readT3Messages", () => {
	test("reads what a person sent from a client, never an agent's relay, an answer, or a scheduled prompt", () => {
		const path = join(tempDir(), "statev2.sqlite");
		t3State(path, "/work/proj", [
			{
				id: "a",
				at: "2026-11-06T10:00:00.000Z",
				payload: { createdBy: "user", creationSource: "web", text: " go " },
			},
			{
				id: "b",
				at: "2026-11-06T10:01:00.000Z",
				payload: { createdBy: "user", creationSource: "mobile", text: "?" },
			},
			{
				id: "c",
				at: "2026-11-06T10:02:00.000Z",
				payload: { createdBy: "agent", creationSource: "mcp", text: "relay" },
			},
			{
				id: "async-answer:x",
				at: "2026-11-06T10:03:00.000Z",
				payload: { createdBy: "user", creationSource: "server", text: "Merge it?\nYes (Recommended)" },
			},
			{
				id: "scheduled-task-message:x",
				at: "2026-11-06T10:04:00.000Z",
				payload: { createdBy: "user", creationSource: "web", scheduledTaskId: "t", text: "wake up" },
			},
			{
				id: "d",
				at: "2026-10-30T10:00:00.000Z",
				payload: { createdBy: "user", creationSource: "web", text: "old" },
			},
		]);
		expect(readT3Messages(path, SINCE, plain)).toEqual([
			{
				kind: "message",
				time: "2026-11-06T10:00:00.000Z",
				harness: "claude",
				repository: "/work/proj",
				session: SESSION,
				text: "go",
			},
			{
				kind: "message",
				time: "2026-11-06T10:01:00.000Z",
				harness: "claude",
				repository: "/work/proj",
				session: SESSION,
				text: "?",
			},
		]);
	});

	test("fails on a sender or client it does not know", () => {
		const path = join(tempDir(), "statev2.sqlite");
		t3State(path, "/work/proj", [
			{
				id: "a",
				at: "2026-11-06T10:00:00.000Z",
				payload: { createdBy: "user", creationSource: "watch", text: "hi" },
			},
		]);
		expect(() => readT3Messages(path, SINCE, plain)).toThrow(/unknown client: watch/);
	});
});

describe("messages", () => {
	test("gathers every source once, oldest first, naming each checkout's GitHub origin", () => {
		const home = tempDir();
		const checkout = join(home, "proj");
		mkdirSync(checkout);
		execFileSync("git", ["init", "-q", checkout]);
		execFileSync("git", ["-C", checkout, "remote", "add", "origin", "https://github.com/acme/proj.git"]);
		const log = lines(
			turn("2026-11-06T09:00:00Z", "<system-reminder>r</system-reminder>\nplan it", { cwd: checkout }),
			turn("2026-11-06T09:01:00Z", "brief", { origin: undefined, entrypoint: "sdk-cli" }),
			turn("2026-11-06T09:02:00Z", "relay", { entrypoint: "t3-code" }),
			turn("2026-11-06T09:03:00Z", "skill body", { isMeta: true }),
			{ type: "assistant", timestamp: "2026-11-06T09:04:00Z", message: { content: "human" } },
		);
		for (const dir of [".claude", join(".config", "claude")]) {
			mkdirSync(join(home, dir, "projects", "p"), { recursive: true });
			writeFileSync(join(home, dir, "projects", "p", `${SESSION}.jsonl`), log);
		}
		const rollout = lines(codexMeta({ cwd: "/gone" }), codexTurn("2026-11-06T11:00:00Z", [["and test", "user"]]));
		for (const dir of [join("sessions", "2026", "11", "06"), "archived_sessions"]) {
			mkdirSync(join(home, ".codex", dir), { recursive: true });
			writeFileSync(join(home, ".codex", dir, `rollout-2026-11-06T10-00-00-${THREAD}.jsonl`), rollout);
		}
		mkdirSync(join(home, ".t3", "userdata"), { recursive: true });
		t3State(join(home, ".t3", "userdata", "statev2.sqlite"), checkout, [
			{
				id: "a",
				at: "2026-11-06T10:00:00.000Z",
				payload: { createdBy: "user", creationSource: "web", text: "go" },
			},
		]);

		const notes: string[] = [];
		const found = messages("2026-11-01", { env: {}, home, warn: (line) => notes.push(line) });
		expect(notes).toEqual([]);
		expect(found).toEqual([
			{
				kind: "message",
				time: "2026-11-06T09:00:00.000Z",
				harness: "claude",
				repository: "acme/proj",
				session: SESSION,
				text: "plan it",
			},
			{
				kind: "message",
				time: "2026-11-06T10:00:00.000Z",
				harness: "claude",
				repository: "acme/proj",
				session: SESSION,
				text: "go",
			},
			{
				kind: "message",
				time: "2026-11-06T11:00:00.000Z",
				harness: "codex",
				repository: "/gone",
				session: THREAD,
				text: "and test",
			},
		]);
		expect(messageLines(found.slice(2))).toEqual([`2026-11-06T11:00:00.000Z codex /gone ${THREAD}`, "  and test"]);
	});

	test("prints an answer with its skill, question, recommendation, and pick", () => {
		expect(
			messageLines([
				{
					kind: "answer",
					time: "2026-11-06T09:01:00.000Z",
					harness: "claude",
					repository: "acme/proj",
					session: SESSION,
					skill: "quest-plan",
					header: "Color",
					question: "Which color?",
					options: ["Red (Recommended)", "Blue"],
					recommended: ["Red (Recommended)"],
					picked: ["Blue"],
				},
			]),
		).toEqual([
			`2026-11-06T09:01:00.000Z claude acme/proj ${SESSION} answer quest-plan`,
			"  [Color] Which color?",
			"  recommended: Red (Recommended)",
			"  picked: Blue",
		]);
	});

	test("fails when T3 Code is installed but its state is elsewhere", () => {
		const home = tempDir();
		mkdirSync(join(home, ".t3"));
		expect(() => messages("2026-11-01", { env: {}, home })).toThrow(/keeps no state/);
	});
});
