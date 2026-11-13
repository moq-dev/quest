import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { implementer } from "../src/github/models";
import { fixes } from "../src/cli/land-fixer";
import type { Round, Tally } from "../src/cli/review";
import { parseReview, reviewRecord } from "../src/cli/review-record";
import { type Session, causes, fold, parseSessions, usage, usageLines } from "../src/cli/usage";
import { tempDir } from "./fixture";

const THREAD = "01a1b8e8-8fca-7793-99d1-062f41f8a7b0";
const CLAUDE = "0d8d9084-40a0-48e2-921b-8ba0d67baa2f";
const OTHER = "961c731d-399c-46c5-81ef-069105f87cc4";
const OWNED = "f1913a12-44c4-438c-a9d9-06e5b1192c04";
const GONE = "83a08f0e-6ef1-4b41-ad0c-58b37fc993f8";
const BOTH = "5d2c7f3e-8a41-4b6e-9f0d-2c6a1e7b4d93";
const REMOTE = "a1c2e3f4-0000-4000-8000-000000000001";
const ITERATE = "11111111-1111-1111-1111-111111111111";

/** A session as `token-max sessions` prints it, on one model and effort. */
const exported = (session: string, model: string, effort: string, cost: number, extra: object = {}) => ({
	host: null,
	harness: model.startsWith("gpt") ? "codex" : "claude",
	session,
	parent: null,
	review: false,
	cwd: "/work",
	repositories: ["https://github.com/acme/proj.git"],
	repositoriesSource: "checkout",
	branches: [{ name: "quest/m0/a", first: "2026-11-06T10:05:00Z", last: "2026-11-06T10:06:00Z" }],
	start: "2026-11-06T10:05:00Z",
	end: "2026-11-06T10:06:00Z",
	models: [
		{
			model,
			effort,
			requests: 3,
			inputTokens: 10,
			cacheWriteTokens: 20,
			cacheReadTokens: 30,
			outputTokens: 40,
			costUsd: cost,
			complete: true,
		},
	],
	costUsd: cost,
	complete: true,
	skippedLines: 0,
	files: ["/home/me/.claude/projects/-work/x.jsonl"],
	...extra,
});

const parse = (...rows: object[]) => parseSessions(rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

describe("parseSessions", () => {
	test("reads each session's host, ID, repositories, branches, and spend per model and effort", () => {
		const [session] = parse(
			exported(THREAD, "gpt-6.1-sol", "high", 0.5, {
				host: "box",
				repositories: ["https://github.com/Acme/Proj.git", "https://gitlab.com/acme/proj.git"],
			}),
		);
		expect(session).toEqual({
			host: "box",
			harness: "codex",
			id: THREAD,
			review: false,
			cwd: "/work",
			repositories: ["acme/proj"],
			branches: [
				{
					name: "quest/m0/a",
					first: Date.parse("2026-11-06T10:05:00Z"),
					last: Date.parse("2026-11-06T10:06:00Z"),
				},
			],
			start: Date.parse("2026-11-06T10:05:00Z"),
			models: [
				{
					model: "gpt-6.1-sol",
					effort: "high",
					input: 10,
					cacheWrite: 20,
					cacheRead: 30,
					output: 40,
					cost: 0.5,
					complete: true,
				},
			],
			cost: 0.5,
			complete: true,
			skippedLines: 0,
		});
		// A session token-max could not resolve a repository, model, or ID for keeps the gap as null.
		const [unknown] = parse({
			...exported(THREAD, "gpt-6.1-sol", "high", 1, { repositories: null, session: null }),
			models: [{ ...exported(THREAD, "x", "y", 1).models[0], model: null, effort: null }],
		});
		expect([unknown!.id, unknown!.repositories, unknown!.models[0]!.model]).toEqual([null, null, null]);
	});

	test("fails on a session missing a field, and on a line that is not JSON", () => {
		const { skippedLines: _, ...missing } = exported(THREAD, "gpt-6.1-sol", "high", 1);
		expect(() => parse(missing)).toThrow(/skipped line count/);
		expect(() => parse(exported(THREAD, "gpt-6.1-sol", "high", 1, { start: "soon" }))).toThrow(/a start/);
		expect(() => parseSessions('{"host"\n')).toThrow();
	});
});

describe("fold", () => {
	test("keeps each session's costliest copy across hosts, and leaves alone sessions without an ID", () => {
		const [here, there, alone, anonymous, again] = parse(
			exported(CLAUDE, "claude-opus-5-5", "high", 2),
			exported(CLAUDE, "claude-opus-5-5", "high", 5, { host: "box" }),
			exported(OTHER, "claude-opus-5-5", "high", 1, { host: "box" }),
			exported(THREAD, "gpt-6.1-sol", "high", 1, { session: null }),
			exported(THREAD, "gpt-6.1-sol", "high", 1, { session: null, host: "box" }),
		);
		const { kept, dropped } = fold([here!, there!, alone!, anonymous!, again!]);
		expect(kept).toEqual([there, alone, anonymous, again]);
		expect(dropped).toEqual([here]);
	});
});

describe("causes", () => {
	const repository = { owner: "moq-dev", repo: "moq" };
	const link = (n: number) => `[moq-dev/moq#${n}](https://github.com/moq-dev/moq/pull/${n})`;
	const body = (section: string) => `Fix.\n\n## Caused by\n\n${section}\n\n## Models\n\n- Size: S\n`;

	test("counts only a bullet that opens with the culprit's link and says why", () => {
		// The shapes the 2026-11-11 mistake audit found counted by mistake, from moq-dev/moq's PRs.
		expect(causes(body(`No bug on \`main\`; the \`release\` fix is ${link(8469)}.`), repository)).toEqual([]);
		expect(
			causes(body(`- No single PR: see ${link(8441)}.\n\nMerged \`main\`: ${link(8441)}.`), repository),
		).toEqual([]);
		expect(causes(body(`None: new coverage for the models ${link(8447)} added.`), repository)).toEqual([]);
		expect(causes(body(`- ${link(8054)} - \`ready\` waits (fixed by ${link(8351)})`), repository)).toEqual([8054]);
		expect(causes(body(`- ${link(8459)} put a shaper profile among the fixtures.`), repository)).toEqual([]);
		// Another repository's culprit, or a link whose text names another PR, is no culprit here.
		expect(
			causes(body(`- [moq-dev/quest#494](https://github.com/moq-dev/quest/pull/494) - a gap`), repository),
		).toEqual([]);
		expect(causes(body(`- [moq-dev/moq#1](https://github.com/moq-dev/moq/pull/2) - mismatch`), repository)).toEqual(
			[],
		);
		expect(causes(body(`- ${link(7)} - one\r\n- ${link(8)} - two\n- ${link(7)} - again`), repository)).toEqual([
			7, 8,
		]);
		expect(causes(`- ${link(7)} - outside the section`, repository)).toEqual([]);
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
					number: 1,
					disposition: "fixed",
					reason: "done",
				},
				{
					file: "b",
					line: 2,
					severity: "low",
					title: "y",
					body: "b",
					number: 2,
					disposition: "refuted",
					reason: "holds",
				},
				{
					file: "c",
					line: 3,
					severity: "low",
					title: "z",
					body: "b",
					number: 3,
					disposition: "fixed",
					reason: "done",
				},
			],
		},
		unchanged: false,
	};

	// The shadow: the pick one effort lower, in its own session.
	const second: Round = {
		...round,
		shadow: true,
		effort: "medium",
		session: "thread-2",
		round: 1,
		score: 10,
		findings: [],
		earlier: null,
	};

	const tally = (
		reviewer: Tally["reviewer"],
		rounds: number,
		findings: Tally["findings"],
		fixed: number,
		refuted: number,
	): Tally => ({
		reviewer,
		model: "m",
		effort: "high",
		rounds,
		findings,
		fixed,
		refuted,
	});
	const tallies = [
		tally("codex", 3, { high: 1, medium: 1, low: 2 }, 2, 1),
		{ ...tally("codex", 1, { high: 0, medium: 0, low: 0 }, 0, 0), shadow: true as const },
		// A left-out reviewer still names its session, so `quest usage` counts that session as reviewing.
		{ ...tally("claude", 2, { high: 2, medium: 0, low: 0 }, 1, 0), session: CLAUDE },
	];

	test("reads back each reviewer's round and tally quest review records, after the land fixer's lines", () => {
		const body = `Summary.\n\n## Review\n\nmechanical fix by codex, gpt-6.1-sol, medium effort: \`merged\` (head ${"d".repeat(40)})\n\n${reviewRecord([round, second], tallies)}\n\n## Models\n\n- Size: L\n`;
		expect(body).toContain("\n- Rounds: 3; findings 4 (high 1, medium 1, low 2): fixed 2, refuted 1, open 1\n");
		expect(parseReview(body)).toEqual([
			{
				harness: "Codex",
				model: "gpt-6.1-sol",
				effort: "high",
				shadow: false,
				session: THREAD,
				round: 3,
				score: 7,
				tally: {
					rounds: 3,
					findings: { high: 1, medium: 1, low: 2 },
					fixed: 2,
					refuted: 1,
					settled: 0,
					open: 1,
				},
				open: { high: 0, medium: 1, low: 0 },
			},
			{
				harness: "Codex",
				model: "gpt-6.1-sol",
				effort: "medium",
				shadow: true,
				session: "thread-2",
				round: 1,
				score: 10,
				tally: {
					rounds: 1,
					findings: { high: 0, medium: 0, low: 0 },
					fixed: 0,
					refuted: 0,
					settled: 0,
					open: 0,
				},
				open: { high: 0, medium: 0, low: 0 },
			},
			// A reviewer the run left out, such as the pick a new one replaced, keeps its tally.
			{
				harness: "Claude Code",
				model: "m",
				effort: "high",
				shadow: false,
				session: CLAUDE,
				round: null,
				score: null,
				tally: {
					rounds: 2,
					findings: { high: 2, medium: 0, low: 0 },
					fixed: 1,
					refuted: 0,
					settled: 0,
					open: 1,
				},
				open: { high: 0, medium: 0, low: 0 },
			},
		]);
		// An open finding keeps the head short; once no reviewer reports one, it is named in full.
		expect(body).not.toContain("b".repeat(40));
		// Claude's left-out tally still holds an open finding, which keeps it short too.
		const clean = [{ ...round, findings: [] }, second];
		expect(reviewRecord(clean, tallies)).not.toContain("b".repeat(40));
		const settledAll = [tally("codex", 3, { high: 1, medium: 1, low: 2 }, 3, 1), tallies[1]!];
		expect(reviewRecord(clean, settledAll)).toContain(`- Head: ${"b".repeat(40)}\n`);
		expect(fixes(body)).toEqual(["codex, gpt-6.1-sol, medium effort"]);
	});

	test("a record written before tallies has none, and a Rounds line that does not add up fails", () => {
		const record = reviewRecord([second], [tallies[1]!]);
		const older = `## Review\n\n${record.replace(/^- Rounds: .*\n/m, "")}\n`;
		expect(parseReview(older)[0]!.tally).toBeNull();
		// The settled count `quest usage` prints reads back.
		const settled = "1; findings 2 (low 2): fixed 1, refuted 0, settled 1, open 0";
		expect(
			parseReview(`## Review\n\n${record.replace(/^- Rounds: .*$/m, `- Rounds: ${settled}`)}\n`)[0]!.tally,
		).toEqual({ rounds: 1, findings: { high: 0, medium: 0, low: 2 }, fixed: 1, refuted: 0, settled: 1, open: 0 });
		for (const line of [
			"1; findings 1 (high 1): fixed 0, refuted 0, open 0",
			"1; findings 2 (high 1): fixed 1, refuted 0, open 1",
			"1; findings 2 (low 2): fixed 1, refuted 0, settled 1, open 1",
			"1; findings 1 (severe 1): fixed 1, refuted 0, open 0",
			"one",
		])
			expect(() =>
				parseReview(`## Review\n\n${record.replace(/^- Rounds: .*$/m, `- Rounds: ${line}`)}\n`),
			).toThrow(/Rounds line/);
	});

	test("a skipped review or a fixer-only section has no round", () => {
		expect(parseReview("## Review\n\nSkipped: too trivial to need one.\n")).toEqual([]);
		expect(parseReview("## Review\n\nmechanical fix by quest land watch: `merged main` (head x)\n")).toEqual([]);
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

		const sessions: Session[] = parse(
			exported(CLAUDE, "claude-opus-5-5", "high", 5, {
				branches: [
					{ name: "t3/scratch", first: "2026-11-06T09:00:00Z", last: "2026-11-06T09:00:00Z" },
					{ name: "quest/m0/a", first: "2026-11-06T10:05:00Z", last: "2026-11-06T10:06:00Z" },
				],
				start: "2026-11-06T09:00:00Z",
			}),
			// A session in a checkout of another repository, on a branch of the same name.
			exported(OTHER, "claude-opus-5-5", "high", 6, {
				cwd: "/other/sub",
				repositories: ["git@github.com:other/repo.git"],
			}),
			// The reviewer, named by #10's record; an iterate on #10, with a cheaper copy on another host; one on
			// another repository's branch of the same name.
			exported(THREAD, "gpt-6.1-sol", "high", 1, { start: "2026-11-06T12:00:00Z" }),
			exported(ITERATE, "gpt-6.1-sol", "high", 2, { start: "2026-11-06T13:00:00Z" }),
			exported(ITERATE, "gpt-6.1-sol", "high", 1, {
				start: "2026-11-06T13:00:00Z",
				host: "box",
				repositories: null,
			}),
			exported("22222222-2222-2222-2222-222222222222", "gpt-6.1-sol", "high", 3, {
				cwd: "/other",
				repositories: ["https://github.com/other/repo.git"],
				start: "2026-11-06T13:00:00Z",
			}),
			// Two sessions in checkouts since deleted: one in the directory the Codex sessions name, and one in a
			// clone nested below it, which may be another repository's and so is not charged to this one. The
			// nested one had lines token-max could not read, so its cost is a lower bound.
			exported(OWNED, "claude-opus-5-5", "unknown", 7, {
				repositories: null,
				start: "2026-11-06T14:00:00Z",
			}),
			{
				...exported(GONE, "claude-opus-5-5", "high", 8, {
					cwd: "/work/nested",
					repositories: null,
					start: "2026-11-06T14:00:00Z",
					complete: false,
					skippedLines: 2,
				}),
				models: [{ ...exported(GONE, "claude-opus-5-5", "high", 8).models[0], complete: false }],
			},
			// Another host's session in a directory of the same path: this host's sessions there tell nothing of it.
			exported(REMOTE, "claude-opus-5-5", "high", 4, { host: "box", repositories: null }),
			// A checkout with remotes for both the fork and its upstream, on a branch each has a PR from.
			exported(BOTH, "claude-opus-5-5", "high", 9, {
				cwd: "/both",
				repositories: ["https://github.com/fork/proj.git", "https://github.com/acme/proj.git"],
			}),
		);

		const body10 = [
			"Change.",
			"",
			"## Models",
			"",
			"- Size: L",
			"- Implementer: Claude Code, claude-opus-5-5, high effort",
			"- Implementer: Claude Code, claude-opus-5-5, high effort (iterate, L)",
			"- Implementer: Codex, gpt-6.1-sol, medium effort (iterate, S)",
			"- Implementer: Claude Code, Some Model",
			"",
			"## Review",
			"",
			"Rewritten by `quest review` after each round.",
			"",
			`- Head: ${"b".repeat(40)}`,
			`- Base: origin/main at ${"a".repeat(12)}`,
			"",
			"- Reviewer: Codex, gpt-6.1-sol, high effort",
			`- Session: \`${THREAD}\`, round 2`,
			"- Score: 9/10, `Fine.`",
			"- Rounds: 2; findings 2 (high 1, low 1): fixed 1, refuted 1, open 0",
			"- Findings: none",
			"",
			// A harness quest review does not run, as a hand-written record may name, reads as any other.
			"- Reviewer: Gemini CLI, gemini-3-pro, high effort",
			"- Session: `ses_1`, round 1",
			"- Score: 8/10, `Fine.`",
			"- Rounds: 1; findings 0: fixed 0, refuted 0, open 0",
			"- Findings: none",
			"",
			// A reviewer the latest run left out, such as one a new size pick replaced, has only its tally.
			"- Reviewer: Claude Code, claude-opus-5-5, high effort",
			"- Rounds: 1; findings 1 (medium 1): fixed 1, refuted 0, open 0",
			"",
			// The shadow, which measures an effort step and so stays out of the writer's accuracy.
			"- Reviewer: Codex, gpt-6.1-sol, medium effort, shadow",
			"- Rounds: 1; findings 3 (high 3): fixed 2, refuted 1, open 0",
		].join("\n");
		// #9's record and #10's tally the same branch, so the rollup counts the tally once, from #10.
		const body9 = `${body10.slice(body10.indexOf("## Review"))}\n\n## Models\n\n- Size: L\n- Implementer: Claude Code, claude-opus-5-5, high effort\n`;
		const fork13 = body10.slice(body10.indexOf("## Review")).replaceAll(THREAD, "thread-fork");
		const body11 =
			"Fix.\n\n## Caused by\n\n- [acme/proj#10](https://github.com/acme/proj/pull/10) - missed a case\n";
		// A closed duplicate of #11's fix: it never landed, so it fixed nothing.
		const pulls = [
			pr(11, "fix/a", body11, "2026-11-06T20:00:00Z"),
			pr(10, "quest/m0/a", body10, "2026-11-06T10:00:00Z"),
			// The same branch's earlier claim, closed before any session reached the branch.
			pr(9, "quest/m0/a", body9, "2026-11-01T00:00:00Z", {
				merged_at: null,
				closed_at: "2026-11-02T00:00:00Z",
				updated_at: "2026-11-06T00:00:00Z",
			}),
			// A fork's PR whose head shares #10's branch name, opened earlier and still open: no session here is
			// shown to be its.
			// Its tally is the fork's own, so it counts beside #10's.
			pr(7, "quest/m0/a", body9, "2026-11-03T00:00:00Z", {
				state: "open",
				merged_at: null,
				closed_at: null,
				updated_at: "2026-11-06T00:00:00Z",
				head: { ref: "quest/m0/a", repo: { full_name: "fork/proj" } },
			}),
			// The fork's newer PR has no implementer to count its tally for, so #7 still counts the fork's.
			// Its own sessions, so it takes none of #10's.
			pr(13, "quest/m0/a", fork13, "2026-11-04T00:00:00Z", {
				state: "open",
				merged_at: null,
				closed_at: null,
				updated_at: "2026-11-06T00:00:00Z",
				head: { ref: "quest/m0/a", repo: { full_name: "fork/proj" } },
			}),
			// Two deleted forks' merged PRs from a branch of the same name: neither names its repository, so each
			// counts. Each merged with one finding open: #5's last round's all low, so merging settled it, and
			// #6's medium, so it stays open.
			...[
				[5, "low 1): fixed 1, refuted 0, open 1", "Low"],
				[6, "medium 1): fixed 1, refuted 0, open 1", "Medium"],
			].map(([number, counts, severity]) =>
				pr(
					number as number,
					"quest/m0/a",
					body9.replace(
						"low 1): fixed 1, refuted 1, open 0\n- Findings: none",
						`${counts}\n- Findings, open until the next round settles them:\n  - ${severity}, \`a:1\`: \`x\``,
					),
					"2026-11-02T00:00:00Z",
					{ updated_at: "2026-11-06T00:00:00Z", head: { ref: "quest/m0/a", repo: null } },
				),
			),
			// Two open PRs from another branch, whose older record holds the later tally (3 Sol rounds against
			// 2), as when a round rewrote only its own PR's record: the older counts, not the stale newer one.
			...[
				[3, body9.replace("- Rounds: 2;", "- Rounds: 3;")],
				[4, body9],
			].map(([number, body]) =>
				pr(number as number, "quest/m0/b", body as string, "2026-11-02T00:00:00Z", {
					state: "open",
					merged_at: null,
					closed_at: null,
					updated_at: "2026-11-06T00:00:00Z",
				}),
			),
			pr(12, "fix/a-again", body11, "2026-11-06T21:00:00Z", { merged_at: null }),
			pr(8, "old", "", "2026-10-01T00:00:00Z", { updated_at: "2026-10-01T00:00:00Z" }),
		];
		const requests: string[] = [];
		const connection = (nodes: object[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });
		// #10's final head got a bot's review with one thread, which the agent fixed.
		const activity = (number: number) => ({
			headRefOid: "b".repeat(40),
			commits: connection([{ commit: { oid: "b".repeat(40), committedDate: "2026-11-06T14:00:00Z" } }]),
			reviews: connection(
				number === 10
					? [
							{
								id: "r1",
								url: "https://github.com/acme/proj/pull/10#pullrequestreview-1",
								author: { __typename: "Bot", login: "rabbit" },
								body: "One finding.",
								submittedAt: "2026-11-06T15:00:00Z",
								commit: { oid: "b".repeat(40) },
							},
						]
					: [],
			),
			reviewThreads: connection(
				number === 10
					? [
							{
								isResolved: false,
								resolvedBy: null,
								id: "t1",
								// The answer is on the thread's second page of comments.
								comments: {
									pageInfo: { hasNextPage: true, endCursor: "c1" },
									nodes: [
										{
											author: { __typename: "Bot", login: "rabbit" },
											body: "Bug.",
											pullRequestReview: { id: "r1" },
										},
									],
								},
							},
						]
					: [],
			),
			comments: connection([]),
		});
		const fetch = async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			requests.push(url.pathname);
			if (url.pathname === "/graphql") {
				const { query, variables } = JSON.parse(String(init?.body)) as {
					query: string;
					variables: Record<string, unknown>;
				};
				if (variables.id === "t1" && variables.after === "c1")
					return json({
						data: {
							node: {
								comments: connection([
									{
										author: { __typename: "User", login: "acme" },
										body: "Fixed.",
										pullRequestReview: { id: "r2" },
									},
								]),
							},
						},
					});
				const numbers = [...query.matchAll(/p(\d+): pullRequest/g)].map((match) => Number(match[1]));
				return json({
					data: { repository: Object.fromEntries(numbers.map((number) => [`p${number}`, activity(number)])) },
				});
			}
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
			return new Response("not found", { status: 404 });
		};
		const calls: [Date, string[]][] = [];
		const deps = (exported: Session[] | null) => ({
			github: () => ({
				fetch: fetch as typeof globalThis.fetch,
				now: Date.now,
				sleep: async () => {},
				token: "t",
				warn: () => {},
			}),
			warn: () => {},
			sessions: (since: Date, ssh: string[]) => {
				calls.push([since, ssh]);
				return exported;
			},
		});
		return { root, deps, sessions, calls, requests };
	}

	test("ties each session to its PR and role, and rolls up spend and accuracy", async () => {
		const { root, deps, sessions, calls } = setup();
		const report = await usage(root, { since: "2026-11-05", ssh: ["box"] }, deps(sessions));
		expect(calls).toEqual([[new Date("2026-11-05T00:00:00"), ["box"]]]);
		expect(report.pulls.map((p) => p.number)).toEqual([11, 10, 9, 7, 13, 5, 6, 3, 4, 12]);
		const ten = report.pulls.find((p) => p.number === 10)!;
		expect(ten.sessions.map((s) => [s.host, s.harness, s.session, s.role, s.models[0]!.effort])).toEqual([
			[null, "claude", CLAUDE, "implementing", "high"],
			[null, "codex", THREAD, "reviewing", "high"],
			[null, "codex", ITERATE, "iterating", "high"],
			[null, "claude", OWNED, "iterating", "unknown"],
		]);
		// #12 names #10 too, but closed without merging.
		expect(ten.fixedBy).toEqual([11]);
		expect(report.folded).toEqual({ copies: 1, hosts: ["box"] });
		expect(report.incomplete).toEqual([{ host: null, harness: "claude", session: GONE, skippedLines: 2 }]);
		expect(ten.implementers).toEqual([
			{ harness: "Claude Code", model: "claude-opus-5-5", effort: "high", size: null },
			{ harness: "Claude Code", model: "claude-opus-5-5", effort: "high", size: "L" },
			{ harness: "Codex", model: "gpt-6.1-sol", effort: "medium", size: "S" },
		]);
		expect(ten.unread).toEqual(["Implementer: Claude Code, Some Model"]);
		expect(usageLines(report)).toContain("  unread: Implementer: Claude Code, Some Model");
		expect(report.pulls.find((p) => p.number === 9)!.sessions).toEqual([]);
		expect(report.pulls.find((p) => p.number === 7)!.sessions).toEqual([]);
		expect(report.unattributed).toEqual({
			sessions: 5,
			input: 50,
			cacheWrite: 100,
			cacheRead: 150,
			output: 200,
			cost: 30,
			complete: false,
		});
		expect(report.spend.map((s) => [s.size, s.role, s.harness, s.cost])).toEqual([
			["L", "implementing", "claude", 5],
			["L", "iterating", "claude", 7],
			["L", "iterating", "codex", 2],
			["L", "reviewing", "codex", 1],
		]);
		const tally = {
			rounds: 2,
			findings: { high: 1, medium: 1, low: 1 },
			fixed: 2,
			refuted: 1,
			settled: 0,
			open: 0,
		};
		// #10's, #7's, each deleted fork's, and #3's.
		const five = {
			rounds: 11,
			findings: { high: 5, medium: 6, low: 4 },
			fixed: 10,
			refuted: 3,
			settled: 1,
			open: 1,
		};
		const codex = (n: number) => report.pulls.find((p) => p.number === n)!.review[0]!.tally;
		expect([codex(5), codex(6)].map((t) => [t!.settled, t!.open])).toEqual([
			[1, 0],
			[0, 1],
		]);
		expect(report.accuracy.map((a) => [a.size, a.model, a.pulls, a.reviewed, a.score, a.tally, a.fixes])).toEqual([
			["S", "gpt-6.1-sol", 1, 1, 17, tally, 1],
			["L", "claude-opus-5-5", 7, 5, 85, five, 1],
		]);
		expect(ten.online).toEqual([
			{
				reviewer: "rabbit[bot]",
				finalHead: true,
				findings: 1,
				accepted: 1,
				declined: 0,
				unclassified: 0,
				unanswered: 0,
			},
		]);
		// #11, #10, #5, and #6 merged; #9 closed and #7 is open, so neither counts.
		expect(report.online).toEqual([
			{
				reviewer: "rabbit[bot]",
				merged: 4,
				reviewed: 1,
				finalHead: 1,
				findings: 1,
				accepted: 1,
				declined: 0,
				unclassified: 0,
				unanswered: 0,
			},
		]);
		const text = usageLines(report).join("\n");
		expect(text).toContain(
			"  review: Claude Code, claude-opus-5-5, high effort; not in the latest run; rounds 1, findings 1 (medium 1): fixed 1, refuted 0, open 0\n",
		);
		expect(text).toContain("rounds 2.0, findings 3 (high 1, medium 1, low 1): fixed 2, refuted 1, open 0;");
		expect(ten.review.map((r) => [r.effort, r.shadow])).toEqual([
			["high", false],
			["high", false],
			["high", false],
			["medium", true],
		]);
		expect(text).toContain(
			"  review: Codex, gpt-6.1-sol, medium effort, shadow; not in the latest run; rounds 1, findings 3 (high 3): fixed 2, refuted 1, open 0\n",
		);
		expect(text).toContain("#10 L merged: PR 10 (quest/m0/a)");
		expect(text).toContain("findings 2 (high 1, low 1): fixed 1, refuted 0, settled 1, open 0\n");
		expect(text).toContain(
			"online review: rabbit[bot], at the final head; 1 finding: 1 accepted, 0 declined, 0 unclassified, 0 unanswered",
		);
		expect(text).toContain(
			"rabbit[bot]  reviewed 1/4 (25%), final head 1 (25%), 1.0 findings per PR reviewed, 100% accepted;",
		);
		expect(text).toContain("fixed later by: #11\n");
		expect(text).toContain(
			"    implementing  local  claude  claude-opus-5-5  high     in 10, cache 20 written 30 read, out 40, ~$5.00\n",
		);
		expect(text).toContain(
			"Unattributed: 5 sessions on no PR here, any repository or agent: in 50, cache 100 written 150 read, out 200, ~$30.00 or more\n",
		);
		expect(text).toContain(
			"Folded 1 copy of sessions found on several hosts, keeping each one's costliest; left out from box\n",
		);
		expect(text).toContain(`  local  claude  ${GONE}  2 unreadable lines`);
		expect(text).not.toContain("SECRET");
		expect(JSON.stringify(report)).not.toContain("SECRET");
	});

	test("a folded copy still names its directory's repository, and a session's gaps reach each model", async () => {
		const { root, deps } = setup();
		// On `box`, a deleted checkout's only repository evidence is a copy that folds into this host's costlier one.
		const sessions = parse(
			exported(THREAD, "gpt-6.1-sol", "high", 2, { cwd: "/gone", branches: [] }),
			exported(THREAD, "gpt-6.1-sol", "high", 1, { cwd: "/gone", branches: [], host: "box" }),
			exported(OWNED, "claude-opus-5-5", "high", 7, {
				cwd: "/gone",
				host: "box",
				repositories: null,
				start: "2026-11-06T14:00:00Z",
				complete: false,
			}),
		);
		expect(sessions[2]!.models[0]!.complete).toBe(false);
		const report = await usage(root, { since: "2026-11-05", pr: 10 }, deps(sessions));
		// The folded copy's session is unattributed, so a report narrowed to #10 leaves it out.
		expect(report.folded).toEqual({ copies: 0, hosts: [] });
		expect((await usage(root, { since: "2026-11-05" }, deps(sessions))).folded).toEqual({
			copies: 1,
			hosts: ["box"],
		});
		expect(report.pulls[0]!.sessions.map((s) => [s.host, s.session, s.role])).toEqual([
			["box", OWNED, "iterating"],
		]);
		expect(usageLines(report).join("\n")).toContain("~$7.00 or more");
	});

	test("narrows to one PR, and reports the records alone without token-max", async () => {
		const { root, deps, sessions } = setup();
		const one = await usage(root, { since: "2026-11-05", pr: 10 }, deps(sessions));
		expect(one.pulls.map((p) => p.number)).toEqual([10]);
		expect(one.pulls[0]!.fixedBy).toEqual([11]);
		expect(one.unattributed).toBeNull();
		// The unreadable lines were an unattributed session's, which a narrowed report leaves out.
		expect(one.incomplete).toEqual([]);
		// #9 shares #10's branch but closed before any session reached it, so narrowing to it hands it none.
		const nine = await usage(root, { since: "2026-11-05", pr: 9 }, deps(sessions));
		expect(nine.pulls.map((p) => [p.number, p.sessions.length])).toEqual([[9, 0]]);
		const quest = await usage(root, { since: "2026-11-05", quest: "quest/m0/a.md" }, deps(null));
		expect(quest.priced).toBe(false);
		expect(quest.pulls.map((p) => [p.number, p.sessions.length])).toEqual([
			[10, 0],
			[9, 0],
			[7, 0],
			[13, 0],
			[5, 0],
			[6, 0],
		]);
		expect(quest.pulls[0]!.review.map((r) => r.score)).toEqual([9, 8, null, null]);
	});
});
