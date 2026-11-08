import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { implementer } from "../src/github/models";
import { fixes } from "../src/cli/land-fixer";
import type { Round } from "../src/cli/review";
import { parseReview, reviewRecord } from "../src/cli/review-record";
import { type Priced, parseCcusage, readClaudeLog, readCodexLog, usage, usageLines } from "../src/cli/usage";
import { tempDir } from "./fixture";

const THREAD = "01a1b8e8-8fca-7793-99d1-062f41f8a7b0";
const CLAUDE = "0d8d9084-40a0-48e2-921b-8ba0d67baa2f";
const OTHER = "961c731d-399c-46c5-81ef-069105f87cc4";
const OWNED = "f1913a12-44c4-438c-a9d9-06e5b1192c04";
const GONE = "83a08f0e-6ef1-4b41-ad0c-58b37fc993f8";
const BOTH = "5d2c7f3e-8a41-4b6e-9f0d-2c6a1e7b4d93";

const lines = (...records: unknown[]) => `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;

/** A Claude Code log line; the message stands in for a prompt the report must never read out. */
const claude = (timestamp: string, gitBranch: string, extra: object = {}) => ({
	type: "user",
	timestamp,
	gitBranch,
	message: { content: "SECRET PROMPT" },
	...extra,
});

const codexLog = (
	timestamp: string,
	branch: string | null,
	extra: { source?: unknown; url?: string; cwd?: string } = {},
) =>
	lines(
		{
			type: "session_meta",
			timestamp,
			payload: {
				id: THREAD,
				timestamp,
				cwd: extra.cwd ?? "/work",
				source: extra.source ?? "exec",
				git: branch ? { branch, repository_url: extra.url ?? "https://github.com/acme/proj.git" } : undefined,
			},
		},
		{ type: "response_item", payload: { type: "message", content: "SECRET PROMPT" } },
		{ type: "turn_context", payload: { model: "gpt-6.1-sol", effort: "medium" } },
		{ type: "turn_context", payload: { model: "gpt-6.1-sol", effort: "high" } },
	);

const spent = (model: string, cost: number) => ({
	model,
	input: 10,
	cacheWrite: 20,
	cacheRead: 30,
	output: 40,
	cost,
});

describe("parseCcusage", () => {
	test("reads each session's agent, ID, and spend per model", () => {
		const text = JSON.stringify({
			session: [
				{
					agent: "codex",
					period: `2026/11/06/rollout-2026-11-06T20-23-41-${THREAD}`,
					metadata: { lastActivity: "2026-11-07T00:00:00Z" },
					modelBreakdowns: [
						{
							modelName: "gpt-6.1-sol",
							inputTokens: 1,
							cacheCreationTokens: 0,
							cacheReadTokens: 2,
							outputTokens: 3,
							cost: 0.5,
						},
					],
				},
			],
			totals: {},
		});
		expect(parseCcusage(text)).toEqual([
			{
				harness: "codex",
				id: `2026/11/06/rollout-2026-11-06T20-23-41-${THREAD}`,
				models: [{ model: "gpt-6.1-sol", input: 1, cacheWrite: 0, cacheRead: 2, output: 3, cost: 0.5 }],
			},
		]);
	});

	test("fails on a session missing a field", () => {
		expect(() => parseCcusage(JSON.stringify({ session: [{ agent: "claude", period: "x" }] }))).toThrow(
			/modelBreakdowns/,
		);
		expect(() => parseCcusage(JSON.stringify({ daily: [] }))).toThrow(/no session list/);
	});
});

describe("session logs", () => {
	test("a Claude Code log gives each branch's first and last time, and the last reply's effort", () => {
		const path = join(tempDir(), "log.jsonl");
		writeFileSync(
			path,
			lines(
				{ type: "custom-title", customTitle: "no timestamp" },
				claude("2026-11-06T10:00:00Z", "t3/scratch"),
				claude("2026-11-06T10:05:00Z", "quest/m0/a"),
				{ type: "assistant", timestamp: "2026-11-06T10:06:00Z", gitBranch: "quest/m0/a", effort: "medium" },
				claude("2026-11-06T10:07:00Z", "HEAD"),
				{ type: "assistant", timestamp: "2026-11-06T10:09:00Z", gitBranch: "quest/m0/a", effort: "high" },
			) + '{"type":"user","timestamp":"2026-11-06T11:00',
		);
		const log = readClaudeLog(path);
		expect(log.started).toBe(Date.parse("2026-11-06T10:00:00Z"));
		expect([...log.branches]).toEqual([
			[
				"t3/scratch",
				{ first: Date.parse("2026-11-06T10:00:00Z"), last: Date.parse("2026-11-06T10:00:00Z"), cwd: null },
			],
			[
				"quest/m0/a",
				{ first: Date.parse("2026-11-06T10:05:00Z"), last: Date.parse("2026-11-06T10:09:00Z"), cwd: null },
			],
		]);
		expect(log.effort).toBe("high");
		expect(log.repository).toBeNull();
	});

	test("a malformed line before the last fails", () => {
		const path = join(tempDir(), "log.jsonl");
		writeFileSync(path, `{"oops"\n${lines(claude("2026-11-06T10:00:00Z", "main"))}`);
		expect(() => readClaudeLog(path)).toThrow(/not JSON/);
	});

	test("a Codex rollout gives its branch, remote, review mark, and last turn's effort", () => {
		const path = join(tempDir(), "rollout.jsonl");
		writeFileSync(path, codexLog("2026-11-06T10:00:00Z", "quest/m0/a", { source: { subagent: "review" } }));
		const log = readCodexLog(path);
		expect([...log.branches.keys()]).toEqual(["quest/m0/a"]);
		expect(log.repository).toEqual({ owner: "acme", repo: "proj" });
		expect(log.review).toBe(true);
		expect(log.effort).toBe("high");
	});

	test("a Codex rollout that does not start with its session_meta fails", () => {
		const path = join(tempDir(), "rollout.jsonl");
		writeFileSync(path, lines({ type: "turn_context", payload: {} }));
		expect(() => readCodexLog(path)).toThrow(/session_meta/);
	});
});

describe("PR records", () => {
	const round: Round = {
		reviewer: "codex",
		model: "gpt-6.1-sol",
		effort: "high",
		branch: "quest/m0/a",
		size: "L",
		sizeFrom: "quest/m0/a.md",
		session: THREAD,
		round: 3,
		base: { ref: "origin/main", sha: "a".repeat(40) },
		head: "b".repeat(40),
		usage: [],
		score: 7,
		rationale: "One gap.",
		findings: [{ file: "src/a.ts", line: 4, severity: "medium", title: "Misses a case", body: "b" }],
		earlier: {
			head: "c".repeat(40),
			findings: [
				{
					file: "a",
					line: null,
					severity: "high",
					title: "x",
					body: "b",
					disposition: "fixed",
					reason: "done",
				},
				{ file: "b", line: 2, severity: "low", title: "y", body: "b", disposition: "refuted", reason: "holds" },
				{ file: "c", line: 3, severity: "low", title: "z", body: "b", disposition: "fixed", reason: "done" },
			],
		},
		unchanged: false,
	};

	test("reads back the round quest review records, after the land fixer's lines", () => {
		const body = `Summary.\n\n## Review\n\nmechanical fix by codex, gpt-6.1-sol, medium effort: \`merged\` (head ${"d".repeat(40)})\n\n${reviewRecord(round)}\n\n## Models\n\n- Size: L\n`;
		expect(parseReview(body)).toEqual({
			harness: "Codex",
			model: "gpt-6.1-sol",
			effort: "high",
			session: THREAD,
			round: 3,
			score: 7,
			findings: 1,
			fixed: 2,
			refuted: 1,
		});
		expect(fixes(body)).toEqual(["codex, gpt-6.1-sol, medium effort"]);
	});

	test("a skipped review or a fixer-only section has no round", () => {
		expect(parseReview("## Review\n\nSkipped: too trivial to need one.\n")).toBeNull();
		expect(parseReview("## Review\n\nmechanical fix by quest land watch: `merged main` (head x)\n")).toBeNull();
		expect(fixes("## Review\n\nmechanical fix by quest land watch: `merged main` (head x)\n")).toEqual([
			"quest land watch",
		]);
	});

	test("an Implementer line's own size follows its effort", () => {
		expect(implementer("Implementer: Claude Code, claude-opus-5-5, low effort (iterate, XS)")).toEqual({
			harness: "Claude Code",
			model: "claude-opus-5-5",
			effort: "low",
			size: "XS",
		});
		expect(implementer("Implementer: Codex, gpt-6.1-sol, unknown effort")).toEqual({
			harness: "Codex",
			model: "gpt-6.1-sol",
			effort: "unknown",
			size: null,
		});
		expect(implementer("Implementer: someone")).toBeNull();
	});
});

describe("usage", () => {
	const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
	const pr = (number: number, branch: string, body: string, created: string, extra: object = {}) => ({
		number,
		html_url: `https://github.com/acme/proj/pull/${number}`,
		title: `PR ${number}`,
		state: "closed",
		merged_at: "2026-11-07T00:00:00Z",
		draft: false,
		created_at: created,
		closed_at: "2026-11-07T00:00:00Z",
		updated_at: "2026-11-07T00:00:00Z",
		head: { ref: branch, repo: { full_name: "acme/proj" } },
		base: { repo: { full_name: "acme/proj" } },
		body,
		...extra,
	});

	function setup() {
		const dir = tempDir();
		const root = join(dir, "repo");
		mkdirSync(root);
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/proj.git"], { cwd: root });

		const claudeHome = join(dir, "claude");
		mkdirSync(join(claudeHome, "projects", "-work"), { recursive: true });
		writeFileSync(
			join(claudeHome, "projects", "-work", `${CLAUDE}.jsonl`),
			lines(
				claude("2026-11-06T09:00:00Z", "t3/scratch"),
				claude("2026-11-06T10:05:00Z", "quest/m0/a", { cwd: root }),
				{ type: "assistant", timestamp: "2026-11-06T10:06:00Z", gitBranch: "quest/m0/a", effort: "high" },
			),
		);
		// A session in a checkout of another repository, on a branch of the same name.
		const other = join(dir, "other");
		mkdirSync(other);
		execFileSync("git", ["init", "-q"], { cwd: other });
		execFileSync("git", ["remote", "add", "origin", "git@github.com:other/repo.git"], { cwd: other });
		writeFileSync(
			join(claudeHome, "projects", "-work", `${OTHER}.jsonl`),
			lines(claude("2026-11-06T10:05:00Z", "quest/m0/a", { cwd: join(other, "sub") })),
		);
		mkdirSync(join(other, "sub"));
		// A session in a checkout with remotes for both the fork and its upstream, on a branch each has a PR from.
		const both = join(dir, "both");
		mkdirSync(both);
		execFileSync("git", ["init", "-q"], { cwd: both });
		execFileSync("git", ["remote", "add", "origin", "https://github.com/fork/proj.git"], { cwd: both });
		execFileSync("git", ["remote", "add", "upstream", "https://github.com/acme/proj.git"], { cwd: both });
		writeFileSync(
			join(claudeHome, "projects", "-work", `${BOTH}.jsonl`),
			lines(claude("2026-11-06T10:05:00Z", "quest/m0/a", { cwd: both })),
		);
		// Two sessions in checkouts since deleted: one in the directory a Codex log names, and one in a clone nested
		// below it, which may be another repository's and so is not charged to this one.
		writeFileSync(
			join(claudeHome, "projects", "-work", `${OWNED}.jsonl`),
			lines(claude("2026-11-06T14:00:00Z", "quest/m0/a", { cwd: "/work" })),
		);
		writeFileSync(
			join(claudeHome, "projects", "-work", `${GONE}.jsonl`),
			lines(claude("2026-11-06T14:00:00Z", "quest/m0/a", { cwd: "/work/nested" })),
		);
		const codexHome = join(dir, "codex");
		const day = join(codexHome, "sessions", "2026", "11", "06");
		mkdirSync(day, { recursive: true });
		// The reviewer, named by #10's record; an iterate on #10; one on another repository's branch of the same name.
		writeFileSync(join(day, `rollout-a-${THREAD}.jsonl`), codexLog("2026-11-06T12:00:00Z", "quest/m0/a"));
		writeFileSync(
			join(day, "rollout-b-11111111-1111-1111-1111-111111111111.jsonl"),
			codexLog("2026-11-06T13:00:00Z", "quest/m0/a"),
		);
		writeFileSync(
			join(day, "rollout-c-22222222-2222-2222-2222-222222222222.jsonl"),
			codexLog("2026-11-06T13:00:00Z", "quest/m0/a", { url: "https://github.com/other/repo.git", cwd: "/other" }),
		);

		const body10 = [
			"Change.",
			"",
			"## Models",
			"",
			"- Size: L",
			"- Implementer: Claude Code, claude-opus-5-5, high effort",
			"- Implementer: Claude Code, claude-opus-5-5, high effort (iterate, L)",
			"",
			"## Review",
			"",
			"Rewritten by `quest review` after each round.",
			"",
			"- Reviewer: Codex, gpt-6.1-sol, high effort",
			`- Session: \`${THREAD}\`, round 2`,
			"- Score: 9/10, `Fine.`",
			"- Findings: none",
		].join("\n");
		const body11 =
			"Fix.\n\n## Caused by\n\n- [acme/proj#10](https://github.com/acme/proj/pull/10) - missed a case\n";
		const pulls = [
			pr(11, "fix/a", body11, "2026-11-06T20:00:00Z"),
			pr(10, "quest/m0/a", body10, "2026-11-06T10:00:00Z"),
			// The same branch's earlier claim, closed before any session reached the branch.
			pr(9, "quest/m0/a", "", "2026-11-01T00:00:00Z", {
				merged_at: null,
				closed_at: "2026-11-02T00:00:00Z",
				updated_at: "2026-11-06T00:00:00Z",
			}),
			// A fork's PR whose head shares #10's branch name, opened earlier and still open: no session here is
			// shown to be its.
			pr(7, "quest/m0/a", "", "2026-11-03T00:00:00Z", {
				state: "open",
				merged_at: null,
				closed_at: null,
				updated_at: "2026-11-06T00:00:00Z",
				head: { ref: "quest/m0/a", repo: { full_name: "fork/proj" } },
			}),
			pr(8, "old", "", "2026-10-01T00:00:00Z", { updated_at: "2026-10-01T00:00:00Z" }),
		];
		const requests: string[] = [];
		const fetch = async (input: string | URL | Request) => {
			const url = new URL(String(input));
			requests.push(url.pathname);
			if (url.pathname === "/repos/acme/proj")
				return json({
					owner: { login: "acme" },
					name: "proj",
					default_branch: "main",
					clone_url: "https://github.com/acme/proj.git",
					ssh_url: "git@github.com:acme/proj.git",
					fork: false,
				});
			if (url.pathname === "/repos/acme/proj/pulls") return json(pulls);
			if (url.pathname === "/repos/acme/proj/issues/10/comments")
				return json([
					{
						body: "<!-- quest:sessions -->\nLater.\n\n## Models\n\n- Implementer: Codex, gpt-6.1-sol, medium effort (iterate, S)\n",
						performed_via_github_app: { id: 1 },
					},
				]);
			if (/^\/repos\/acme\/proj\/issues\/\d+\/comments$/.test(url.pathname)) return json([]);
			return new Response("not found", { status: 404 });
		};
		const priced: Priced[] = [
			{ harness: "claude", id: CLAUDE, models: [spent("claude-opus-5-5", 5)] },
			{ harness: "claude", id: OTHER, models: [spent("claude-opus-5-5", 6)] },
			{ harness: "codex", id: `2026/11/06/rollout-a-${THREAD}`, models: [spent("gpt-6.1-sol", 1)] },
			{
				harness: "codex",
				id: "2026/11/06/rollout-b-11111111-1111-1111-1111-111111111111",
				models: [spent("gpt-6.1-sol", 2)],
			},
			{
				harness: "codex",
				id: "2026/11/06/rollout-c-22222222-2222-2222-2222-222222222222",
				models: [spent("gpt-6.1-sol", 3)],
			},
			{ harness: "opencode", id: "ses_1", models: [spent("deepseek", 4)] },
			{ harness: "claude", id: OWNED, models: [spent("claude-opus-5-5", 7)] },
			{ harness: "claude", id: GONE, models: [spent("claude-opus-5-5", 8)] },
			{ harness: "claude", id: BOTH, models: [spent("claude-opus-5-5", 9)] },
		];
		const deps = (ccusage: Priced[] | null) => ({
			github: () => ({
				fetch: fetch as typeof globalThis.fetch,
				now: Date.now,
				sleep: async () => {},
				token: "t",
				warn: () => {},
			}),
			warn: () => {},
			ccusage: () => ccusage,
			env: { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome },
			home: dir,
		});
		return { root, deps, priced, requests };
	}

	test("ties each session to its PR and role, and rolls up spend and accuracy", async () => {
		const { root, deps, priced } = setup();
		const report = await usage(root, { since: "2026-11-05" }, deps(priced));
		expect(report.pulls.map((p) => p.number)).toEqual([11, 10, 9, 7]);
		const ten = report.pulls.find((p) => p.number === 10)!;
		expect(ten.sessions.map((s) => [s.harness, s.session, s.role, s.effort])).toEqual([
			["claude", CLAUDE, "implementing", "high"],
			["codex", THREAD, "reviewing", "high"],
			["codex", "11111111-1111-1111-1111-111111111111", "iterating", "high"],
			["claude", OWNED, "iterating", null],
		]);
		expect(ten.fixedBy).toEqual([11]);
		expect(ten.implementers).toEqual([
			{ harness: "Claude Code", model: "claude-opus-5-5", effort: "high", size: null },
			{ harness: "Claude Code", model: "claude-opus-5-5", effort: "high", size: "L" },
			{ harness: "Codex", model: "gpt-6.1-sol", effort: "medium", size: "S" },
		]);
		expect(report.pulls.find((p) => p.number === 9)!.sessions).toEqual([]);
		expect(report.pulls.find((p) => p.number === 7)!.sessions).toEqual([]);
		expect(report.unattributed).toEqual({
			sessions: 5,
			input: 50,
			cacheWrite: 100,
			cacheRead: 150,
			output: 200,
			cost: 30,
		});
		expect(report.spend.map((s) => [s.size, s.role, s.harness, s.cost])).toEqual([
			["L", "implementing", "claude", 5],
			["L", "iterating", "claude", 7],
			["L", "iterating", "codex", 2],
			["L", "reviewing", "codex", 1],
		]);
		expect(report.accuracy.map((a) => [a.size, a.model, a.pulls, a.reviewed, a.score, a.rounds, a.fixes])).toEqual([
			["S", "gpt-6.1-sol", 1, 1, 9, 2, 1],
			["L", "claude-opus-5-5", 1, 1, 9, 2, 1],
		]);
		const text = usageLines(report).join("\n");
		expect(text).toContain("#10 L merged: PR 10 (quest/m0/a)");
		expect(text).toContain("fixed later by: #11");
		expect(text).not.toContain("SECRET");
		expect(JSON.stringify(report)).not.toContain("SECRET");
	});

	test("narrows to one PR, and reports the records alone without ccusage", async () => {
		const { root, deps, priced } = setup();
		const one = await usage(root, { since: "2026-11-05", pr: 10 }, deps(priced));
		expect(one.pulls.map((p) => p.number)).toEqual([10]);
		expect(one.pulls[0]!.fixedBy).toEqual([11]);
		expect(one.unattributed).toBeNull();
		// #9 shares #10's branch but closed before any session reached it, so narrowing to it hands it none.
		const nine = await usage(root, { since: "2026-11-05", pr: 9 }, deps(priced));
		expect(nine.pulls.map((p) => [p.number, p.sessions.length])).toEqual([[9, 0]]);
		const quest = await usage(root, { since: "2026-11-05", quest: "quest/m0/a.md" }, deps(null));
		expect(quest.priced).toBe(false);
		expect(quest.pulls.map((p) => [p.number, p.sessions.length])).toEqual([
			[10, 0],
			[9, 0],
			[7, 0],
		]);
		expect(quest.pulls[0]!.review?.score).toBe(9);
	});
});
