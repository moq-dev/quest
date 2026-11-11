import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { claudeText, messageLines, messages, readCodexMessages, readT3Messages } from "../src/cli/messages";
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

	test("fails on a user turn without provenance, which cannot be told apart", () => {
		const path = join(tempDir(), "rollout.jsonl");
		writeFileSync(
			path,
			lines(codexMeta({}), {
				type: "response_item",
				timestamp: "2026-11-06T10:01:00Z",
				payload: { role: "user", content: [{ type: "input_text", text: "hi" }] },
			}),
		);
		expect(() => readCodexMessages(path, SINCE, plain)).toThrow(/provenance/);
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
				time: "2026-11-06T10:00:00.000Z",
				harness: "claude",
				repository: "/work/proj",
				session: SESSION,
				text: "go",
			},
			{
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

		const found = messages("2026-11-01", { env: {}, home });
		expect(found).toEqual([
			{
				time: "2026-11-06T09:00:00.000Z",
				harness: "claude",
				repository: "acme/proj",
				session: SESSION,
				text: "plan it",
			},
			{
				time: "2026-11-06T10:00:00.000Z",
				harness: "claude",
				repository: "acme/proj",
				session: SESSION,
				text: "go",
			},
			{
				time: "2026-11-06T11:00:00.000Z",
				harness: "codex",
				repository: "/gone",
				session: THREAD,
				text: "and test",
			},
		]);
		expect(messageLines(found.slice(2))).toEqual([`2026-11-06T11:00:00.000Z codex /gone ${THREAD}`, "  and test"]);
	});

	test("fails when T3 Code is installed but its state is elsewhere", () => {
		const home = tempDir();
		mkdirSync(join(home, ".t3"));
		expect(() => messages("2026-11-01", { env: {}, home })).toThrow(/keeps no state/);
	});
});
