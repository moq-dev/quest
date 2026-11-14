import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { SPLIT_CATEGORIES, type SessionRecord, type SessionWait, parseRecord } from "../src/core";
import { SPLITTERS, SPLIT_CHECKERS, type Model } from "../src/cli/models";
import type { Answer, Question } from "../src/cli/review";
import {
	type Labeled,
	keptSplit,
	labelSession,
	labelsPath,
	parseLabels,
	parts,
	readSteps,
	sampled,
	splitOf,
	splitPrompt,
} from "../src/cli/split";
import { tempDir } from "./fixture";

const at = (minute: number, second = 0) =>
	`2026-11-06T10:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
const lines = (...records: unknown[]) => records.map((r) => `${JSON.stringify(r)}\n`).join("");

/** A Claude transcript: a turn, a reply in two lines sharing usage, a call and its result, then a second turn. */
function claudeTranscript(): string {
	const path = join(tempDir(), "claude.jsonl");
	const usage = { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 };
	writeFileSync(
		path,
		lines(
			{ type: "user", timestamp: at(0), message: { content: "Fix the bug" } },
			{
				type: "user",
				timestamp: at(0, 1),
				isMeta: true,
				message: { content: [{ type: "text", text: "skill" }] },
			},
			{
				type: "assistant",
				timestamp: at(1),
				message: { id: "m1", usage, content: [{ type: "text", text: "Reading\nthe code" }] },
			},
			{
				type: "assistant",
				timestamp: at(1),
				message: {
					id: "m1",
					usage,
					content: [
						{
							type: "tool_use",
							id: "t1",
							name: "Bash",
							input: { command: "bun test", description: "Run tests" },
						},
					],
				},
			},
			{
				type: "user",
				timestamp: at(4),
				message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "1 failed" }] },
			},
			{ type: "user", timestamp: at(10), message: { content: [{ type: "text", text: "Try again" }] } },
			{
				type: "assistant",
				timestamp: at(12),
				message: { id: "m2", usage: { output_tokens: 5 }, content: [{ type: "text", text: "Done" }] },
			},
		),
	);
	return path;
}

describe("readSteps", () => {
	test("reads a Claude transcript's actions, results, turns, and each reply's tokens once", () => {
		const steps = readSteps("claude", [claudeTranscript()]);
		expect(steps.actions.map((a) => [a.head, a.result, a.tokens])).toEqual([
			["says: Reading the code", null, 100],
			["Bash: Run tests (bun test)", "error: 1 failed", 0],
			["says: Done", null, 5],
		]);
		expect(steps.turns.map((t) => [t.before, t.text])).toEqual([
			[0, "Fix the bug"],
			[2, "Try again"],
		]);
		expect(steps.marks.map((m) => m.owner)).toEqual(["idle", 0, 1, 1, "idle", 2]);
	});

	test("reads a Codex transcript's calls and outputs, taking tokens from the running total once", () => {
		const path = join(tempDir(), "codex.jsonl");
		const total = (n: number) => ({
			type: "event_msg",
			timestamp: at(2),
			payload: { type: "token_count", info: { total_token_usage: { total_tokens: n } } },
		});
		writeFileSync(
			path,
			lines(
				{ type: "session_meta", timestamp: at(0), payload: { id: "c1" } },
				{
					type: "response_item",
					timestamp: at(0),
					payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Do it" }] },
				},
				{
					type: "response_item",
					timestamp: at(1),
					payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"ls"}', call_id: "c" },
				},
				total(100),
				total(100),
				{
					type: "response_item",
					timestamp: at(2),
					payload: { type: "function_call_output", call_id: "c", output: "a b" },
				},
				{
					type: "response_item",
					timestamp: at(3),
					payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Listed" }] },
				},
				total(150),
			),
		);
		const steps = readSteps("codex", [path]);
		expect(steps.actions.map((a) => [a.head, a.result, a.tokens])).toEqual([
			['exec_command: {"cmd":"ls"}', "a b", 100],
			["says: Listed", null, 50],
		]);
		expect(steps.turns.map((t) => t.text)).toEqual(["Do it"]);
	});

	test("a Codex message the harness injected opens no turn", () => {
		const path = join(tempDir(), "codex.jsonl");
		const message = (text: string, provenance?: string[]) => ({
			type: "response_item",
			timestamp: at(0),
			payload: {
				type: "message",
				role: "user",
				content: [{ type: "input_text", text }],
				...(provenance && {
					internal_chat_message_metadata_passthrough: {
						content_item_metadata: provenance.map((type) => ({ provenance: { type } })),
					},
				}),
			},
		});
		writeFileSync(
			path,
			lines(
				message("typed", ["user"]),
				message("skill text", ["skills"]),
				message("rules", ["agents_md", "harness"]),
				message("older log"),
			),
		);
		expect(readSteps("codex", [path]).turns.map((t) => t.text)).toEqual(["typed", "older log"]);
	});

	test("fails on a harness it cannot read", () => {
		expect(() => readSteps("cursor", [])).toThrow("cannot read a cursor transcript");
	});
});

describe("parseLabels", () => {
	const part = { from: 3, to: 6 };
	test("expands ranges that cover the part in order", () => {
		expect(
			parseLabels(
				{
					ranges: [
						{ from: 3, to: 4, category: "writing" },
						{ from: 5, to: 5, category: "git" },
					],
					note: " a  merge\nwent wrong ",
				},
				part,
			),
		).toEqual({ labels: ["writing", "writing", "git"], note: "a merge went wrong" });
	});

	test.each([
		[
			"a gap",
			[
				{ from: 3, to: 3 },
				{ from: 5, to: 5 },
			],
		],
		[
			"an overlap",
			[
				{ from: 3, to: 4 },
				{ from: 4, to: 5 },
			],
		],
		["a range past the part", [{ from: 3, to: 6 }]],
		["a short cover", [{ from: 3, to: 4 }]],
		["a backward range", [{ from: 3, to: 2 }]],
	])("refuses %s", (_, ranges) => {
		expect(() =>
			parseLabels({ ranges: ranges.map((r) => ({ ...r, category: "writing" })), note: "" }, part),
		).toThrow("time splitter's reply");
	});

	test("refuses idle, which is measured, and a note past its limit", () => {
		expect(() => parseLabels({ ranges: [{ from: 3, to: 5, category: "idle" }], note: "" }, part)).toThrow(
			"without a category",
		);
		expect(() =>
			parseLabels({ ranges: [{ from: 3, to: 5, category: "other" }], note: "x".repeat(400) }, part),
		).toThrow("longer than one line");
	});
});

const wait = (start: string, end: string): SessionWait => ({ kind: "gate-run", start, end, until: null });

describe("splitOf", () => {
	test("gives each stretch to the action it ends at, less timed waits, and sums to the span", () => {
		const steps = readSteps("claude", [claudeTranscript()]);
		const labeled: Labeled = {
			digest: "",
			labels: ["understanding", "testing", "reporting"],
			notes: ["tests failed first"],
			checks: [{ from: 1, labels: ["writing"] }],
			usage: [],
		};
		const split = splitOf(steps, labeled, [wait(at(2), at(3)), wait(at(2, 30), at(3, 30))]);
		const ms = (m: number) => m * 60_000;
		expect(split.categories.understanding).toEqual({ ms: ms(1), tokens: 100 });
		// The call ran 1:00 to 4:00, less the merged waits from 2:00 to 3:30.
		expect(split.categories.testing).toEqual({ ms: ms(1.5), tokens: 0 });
		expect(split.categories.idle.ms).toBe(ms(6));
		expect(split.categories.reporting).toEqual({ ms: ms(2), tokens: 5 });
		const total = SPLIT_CATEGORIES.reduce((sum, c) => sum + split.categories[c].ms, 0);
		expect(total + ms(1.5)).toBe(ms(12));
		expect(split.check).toEqual({ ms: ms(1.5), disagreed: ms(1.5) });
		expect(split.notes).toEqual(["tests failed first"]);
	});

	test("counts only what falls in the window, keeping the whole session's labels", () => {
		const steps = readSteps("claude", [claudeTranscript()]);
		const labeled: Labeled = {
			digest: "",
			labels: ["understanding", "testing", "reporting"],
			notes: [],
			checks: [],
			usage: [],
		};
		const split = splitOf(steps, labeled, [], Date.parse(at(3)));
		expect(split.categories.understanding).toEqual({ ms: 0, tokens: 0 });
		expect(split.categories.testing.ms).toBe(60_000);
		expect(split.categories.reporting).toEqual({ ms: 120_000, tokens: 5 });
	});

	test("needs every action labeled", () => {
		const steps = readSteps("claude", [claudeTranscript()]);
		expect(() => splitOf(steps, { digest: "", labels: [], notes: [], checks: [], usage: [] }, [])).toThrow(
			"every action labeled",
		);
	});
});

/** A fake model that labels every action of a part `label`, recording which list and prompt it was asked. */
function fakeAsk(label = "writing") {
	const asked: { entries: readonly Model[]; prompt: string }[] = [];
	const ask = async (entries: readonly Model[], question: Question): Promise<Answer> => {
		asked.push({ entries, prompt: question.prompt });
		expect(question.tools).toBe("");
		const [, from, to] = /Label every numbered action from #(\d+) to #(\d+)/.exec(question.prompt)!;
		return {
			entry: entries[0]!,
			session: "x",
			value: { ranges: [{ from: Number(from), to: Number(to), category: label }], note: "" },
			usage: { input: 100, cached: 40, output: 10 },
		};
	};
	return { ask, asked };
}

describe("labelSession", () => {
	test("labels only the actions not labeled yet, keeping them across stops", async () => {
		const state = tempDir();
		const path = claudeTranscript();
		const { ask, asked } = fakeAsk();
		const deps = { ask, state, env: {} };
		const first = await labelSession("claude", "s1", readSteps("claude", [path]), deps);
		expect(first.labels).toHaveLength(3);
		appendFileSync(
			path,
			lines({
				type: "assistant",
				timestamp: at(13),
				message: {
					id: "m3",
					content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "a.ts" } }],
				},
			}),
		);
		const later = await labelSession("claude", "s1", readSteps("claude", [path]), deps);
		expect(later.labels).toHaveLength(4);
		const splitterPrompts = asked.filter((a) => a.entries === SPLITTERS).map((a) => a.prompt);
		expect(splitterPrompts).toHaveLength(2);
		expect(splitterPrompts[1]).toContain("from #3; earlier steps are labeled already");
		expect(splitterPrompts[1]).not.toContain("#0 ");
		// Nothing new asks nothing.
		await labelSession("claude", "s1", readSteps("claude", [path]), deps);
		expect(asked.filter((a) => a.entries === SPLITTERS)).toHaveLength(2);
		// The kept labels give the split without a model.
		const kept = keptSplit(state, { harness: "claude", id: "s1", files: [path], skippedLines: 0 }, []);
		expect(kept?.categories.writing.tokens).toBe(105);
		expect(kept?.usage[0]).toMatchObject({ model: SPLITTERS[0]!.model, input: expect.any(Number) });
	});

	test("labels afresh when the transcript no longer reads as the labeled actions", async () => {
		const state = tempDir();
		const path = claudeTranscript();
		const { ask, asked } = fakeAsk();
		await labelSession("claude", "s1", readSteps("claude", [path]), { ask, state, env: {} });
		writeFileSync(
			path,
			lines({ type: "assistant", timestamp: at(0), message: { content: [{ type: "text", text: "New" }] } }),
		);
		const relabeled = await labelSession("claude", "s1", readSteps("claude", [path]), { ask, state, env: {} });
		expect(relabeled.labels).toEqual(["writing"]);
		expect(asked.at(-1)!.prompt).toContain("Steps from the start");
	});

	test("a sampled part is labeled again by a checker", async () => {
		const path = claudeTranscript();
		// Find a session ID whose first part is sampled.
		let id = 0;
		while (!sampled("claude", `s${id}`, 0)) id++;
		const { ask, asked } = fakeAsk();
		const labeled = await labelSession("claude", `s${id}`, readSteps("claude", [path]), {
			ask,
			state: tempDir(),
			env: {},
		});
		expect(asked.map((a) => a.entries)).toEqual([SPLITTERS, SPLIT_CHECKERS]);
		expect(labeled.checks).toEqual([{ from: 0, labels: ["writing", "writing", "writing"] }]);
		expect(labeled.usage.map((u) => u.model)).toEqual([SPLITTERS[0]!.model, SPLIT_CHECKERS[0]!.model]);
	});

	test("a transcript token-max could not read all of has no split", async () => {
		const state = tempDir();
		const path = claudeTranscript();
		const { ask } = fakeAsk();
		await labelSession("claude", "s1", readSteps("claude", [path]), { ask, state, env: {} });
		expect(keptSplit(state, { harness: "claude", id: "s1", files: [path], skippedLines: 0 }, [])).not.toBeNull();
		expect(keptSplit(state, { harness: "claude", id: "s1", files: [path], skippedLines: 1 }, [])).toBeNull();
	});

	test("a malformed reply fails, keeping no label", async () => {
		const state = tempDir();
		const ask = async (entries: readonly Model[]): Promise<Answer> => ({
			entry: entries[0]!,
			session: "x",
			value: { ranges: [], note: "" },
			usage: null,
		});
		await expect(
			labelSession("claude", "s1", readSteps("claude", [claudeTranscript()]), { ask, state, env: {} }),
		).rejects.toThrow("does not cover");
		expect(
			keptSplit(state, { harness: "claude", id: "s1", files: [claudeTranscript()], skippedLines: 0 }, []),
		).toBeNull();
		expect(labelsPath(state, "claude", "s1")).toContain("splits");
	});
});

test("one sampled part in about ten", () => {
	const hits = Array.from({ length: 2000 }, (_, i) => sampled("claude", "s", i)).filter(Boolean).length;
	expect(hits).toBeGreaterThan(150);
	expect(hits).toBeLessThan(260);
});

test("parts split a long session within the budget, and each prompt names its range", () => {
	const path = join(tempDir(), "long.jsonl");
	const big = "x".repeat(200);
	writeFileSync(
		path,
		lines(
			...Array.from({ length: 1500 }, (_, i) => ({
				type: "assistant",
				timestamp: at(Math.floor(i / 60), i % 60),
				message: { content: [{ type: "text", text: `${i} ${big}` }] },
			})),
		),
	);
	const steps = readSteps("claude", [path]);
	const found = parts(steps, 0);
	expect(found.length).toBeGreaterThan(1);
	expect(found[0]!.from).toBe(0);
	expect(found.at(-1)!.to).toBe(1500);
	for (let i = 1; i < found.length; i++) expect(found[i]!.from).toBe(found[i - 1]!.to);
	for (const part of found) expect(splitPrompt(steps, part)).toContain(`from #${part.from} to #${part.to - 1}`);
});

describe("parseRecord's split", () => {
	const base = (): SessionRecord => ({
		harness: "claude",
		session: "s1",
		parent: null,
		repository: "acme/proj",
		branch: null,
		quest: null,
		pulls: [],
		role: "implementing",
		models: [],
		cost: 0,
		complete: true,
		start: at(0),
		end: at(1),
		waits: [],
		split: {
			categories: Object.fromEntries(SPLIT_CATEGORIES.map((c) => [c, { ms: 1, tokens: 2 }])) as never,
			notes: ["one line"],
			check: { ms: 5, disagreed: 1 },
			usage: [{ harness: "claude", model: "claude-haiku-5-5", effort: "low", input: 10, cached: 4, output: 1 }],
		},
	});

	test("round-trips a valid split", () => {
		expect(parseRecord(base())).toEqual(base());
	});

	test.each([
		[
			"a missing category",
			(r: SessionRecord) => delete (r.split!.categories as Record<string, unknown>).idle,
			"the split's idle",
		],
		[
			"an unknown category",
			(r: SessionRecord) => ((r.split!.categories as Record<string, unknown>).lunch = { ms: 1, tokens: 1 }),
			"unknown field lunch",
		],
		["a multi-line note", (r: SessionRecord) => (r.split!.notes = ["a\nb"]), "not one short line"],
		[
			"a disagreement past the check",
			(r: SessionRecord) => (r.split!.check = { ms: 1, disagreed: 2 }),
			"more time than it checked",
		],
		["cached past input", (r: SessionRecord) => (r.split!.usage[0]!.cached = 11), "exceed its input"],
		["a split without waits", (r: SessionRecord) => (r.waits = null), "without the waits"],
	])("refuses %s", (_, change, message) => {
		const record = base();
		change(record);
		expect(() => parseRecord(record)).toThrow(message);
	});
});
