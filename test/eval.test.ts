import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import {
	type Defect,
	type EvalCase,
	type Scored,
	type Seated,
	defectLines,
	evalSeats,
	foundDefects,
	parseEvalSet,
	priced,
	tallies,
} from "../src/cli/review-eval";
import type { Finding } from "../src/cli/review";
import type { Session } from "../src/cli/usage";
import { type Call, effortOf, fakes, git, quest, setup, write } from "./review-fakes";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

const A = "a".repeat(40);
const B = "b".repeat(40);
const base = { base: A, head: B, size: "M", tier: "medium", reason: "It changes a command.", writer: null };
const defect: Defect = { fix: 9, what: "It drops the last item.", at: [{ file: "src/a.ts", from: 10, to: 12 }] };
const finding = (file: string, line: number | null, severity: Finding["severity"] = "high"): Finding => ({
	file,
	line,
	severity,
	title: "t",
	body: "b",
});

test("an eval set names each case once, as a culprit with defects or as clean", () => {
	const set = {
		repository: "acme/widget",
		cases: [
			{ pull: 3, ...base, defects: [defect] },
			{ pull: 4, ...base, clean: true },
		],
	};
	expect(parseEvalSet(set)).toEqual(set);
	const bad = (cases: unknown[], message: string) =>
		expect(() => parseEvalSet({ repository: "acme/widget", cases })).toThrow(message);
	bad([{ pull: 3, ...base }], "case #3 has no defects and is not clean");
	bad([{ pull: 3, ...base, defects: [] }], "case #3 has no defects and is not clean");
	bad([{ pull: 3, ...base, clean: true, defects: [defect] }], "case #3 is clean and has defects");
	bad([{ pull: 3, ...base, clean: false }], "case #3 is clean and has defects");
	bad(
		[
			{ pull: 3, ...base, clean: true },
			{ pull: 3, ...base, clean: true },
		],
		"case #3 is listed twice",
	);
	bad([{ pull: 3, ...base, head: "main", clean: true }], "case #3's head");
	bad(
		[{ pull: 3, ...base, defects: [{ ...defect, at: [{ file: "src/a.ts", from: 12, to: 10 }] }] }],
		"a defect in case #3 ends before it starts",
	);
	bad([{ pull: 3, ...base, defects: [{ ...defect, line: 4 }] }], "has an unknown field line");
	bad([{ pull: 3, ...base, defects: [{ ...defect, at: [] }] }], "a defect in case #3 is nowhere");
	bad([{ pull: 3, ...base, tier: "severe", clean: true }], "case #3's tier");
	expect(() => parseEvalSet({ repository: "Acme/Widget", cases: [] })).toThrow("lowercase owner/repo");
});

test("a defect is a path and a line or an inclusive range", () => {
	expect(defectLines("src/a.ts:4")).toEqual({ file: "src/a.ts", from: 4, to: 4 });
	expect(defectLines("src/a:b.ts:4-9")).toEqual({ file: "src/a:b.ts", from: 4, to: 9 });
	for (const at of ["src/a.ts", "src/a.ts:0", "src/a.ts:9-4", "src/a.ts:x"])
		expect(() => defectLines(at)).toThrow("--defect takes path:from-to or path:line");
});

test("a finding finds a defect only on one of its places' lines in its file", () => {
	const other: Defect = {
		...defect,
		at: [
			{ file: "src/b.ts", from: 1, to: 1 },
			{ file: "src/c.ts", from: 5, to: 6 },
		],
	};
	expect(foundDefects([defect, other], [finding("src/c.ts", 6)])).toEqual([1]);
	expect(foundDefects([defect, other], [finding("src/a.ts", 10)])).toEqual([0]);
	expect(foundDefects([defect, other], [finding("src/a.ts", 12), finding("src/b.ts", 1)])).toEqual([0, 1]);
	expect(foundDefects([defect], [finding("src/a.ts", 9), finding("src/a.ts", 13)])).toEqual([]);
	expect(foundDefects([defect], [finding("src/a.ts", null), finding("src/c.ts", 11)])).toEqual([]);
});

test("the pick avoids the case's writer, and --harness runs alone at its size's entry", () => {
	const entry = { pull: 3, ...base, size: "S", clean: true } as EvalCase;
	const names = (seats: ReturnType<typeof evalSeats>) =>
		seats.map(({ reviewer, shadow }) => `${reviewer.model} ${reviewer.effort}${shadow ? " shadow" : ""}`);
	expect(names(evalSeats(entry, {}))).toEqual(["gpt-6.1-sol medium", "gpt-6.1-sol low shadow"]);
	expect(names(evalSeats({ ...entry, writer: "gpt-6.1-sol" }, {}))).toEqual(["claude-opus-5-5 low"]);
	expect(names(evalSeats({ ...entry, writer: "gpt-6.1-sol" }, { harness: "codex" }))).toEqual(["gpt-6.1-sol medium"]);
	expect(names(evalSeats(entry, { harness: "claude", effort: "high" }))).toEqual(["claude-opus-5-5 high"]);
});

const seat = (found: number[], findings: Finding[], shadow = false): Seated => ({
	reviewer: "codex",
	model: "m",
	effort: shadow ? "low" : "medium",
	...(shadow && { shadow: true as const }),
	session: shadow ? "s2" : "s1",
	usage: [],
	score: 8,
	findings,
	found,
});

test("tallies count defects found and clean findings per seat, size, and tier, and what either seat found", () => {
	const culprit = {
		pull: 3,
		...base,
		defects: [defect, { ...defect, at: [{ file: "src/a.ts", from: 20, to: 20 }] }],
	} as EvalCase;
	const clean = { pull: 4, ...base, size: "S", tier: "low", clean: true } as EvalCase;
	const scored: Scored[] = [
		{ case: culprit, seats: [seat([0], [finding("src/a.ts", 10)]), seat([1], [finding("src/a.ts", 20)], true)] },
		{
			case: clean,
			seats: [
				seat([], [finding("x", 1, "high"), finding("x", 2, "low")]),
				seat([], [finding("x", 1, "medium")], true),
			],
		},
	];
	const { totals, by } = tallies(scored, true);
	expect(totals.pick).toEqual({ culprits: 1, found: 1, defects: 2, clean: 1, noise: { high: 1, medium: 0, low: 1 } });
	expect(totals.shadow).toEqual({
		culprits: 1,
		found: 1,
		defects: 2,
		clean: 1,
		noise: { high: 0, medium: 1, low: 0 },
	});
	expect(totals.either).toEqual({
		culprits: 1,
		found: 2,
		defects: 2,
		clean: 1,
		noise: { high: 1, medium: 1, low: 1 },
	});
	expect(by["pick M"]).toMatchObject({ culprits: 1, found: 1, clean: 0 });
	expect(by["pick low"]).toMatchObject({ culprits: 0, clean: 1 });
	expect(Object.keys(by).sort()).toEqual(
		["either M", "either S", "either low", "either medium", "pick M", "pick S", "pick low", "pick medium"]
			.concat(["shadow M", "shadow S", "shadow low", "shadow medium"])
			.sort(),
	);
});

test("either counts a case whose pick has no shadow, and a run of one named reviewer has none", () => {
	const lone = { pull: 5, ...base, defects: [defect] } as EvalCase;
	const scored: Scored[] = [{ case: lone, seats: [seat([0], [finding("src/a.ts", 11)])] }];
	expect(tallies(scored, true).totals.either).toMatchObject({ culprits: 1, found: 1, defects: 1 });
	expect(tallies(scored, false).totals).toEqual({ pick: expect.objectContaining({ found: 1 }) });
});

test("the cost sums the run's sessions token-max priced, a lower bound when one is missing or incomplete", () => {
	const scored: Scored[] = [
		{ case: { pull: 4, ...base, clean: true } as EvalCase, seats: [seat([], []), seat([], [], true)] },
	];
	const session = (id: string, cost: number, complete = true) =>
		({ harness: "codex", id, parent: null, cost, complete }) as Session;
	expect(priced(null, scored)).toBeNull();
	expect(priced([session("s1", 1.5), session("s2", 0.25), session("s3", 9)], scored)).toEqual({
		usd: 1.75,
		complete: true,
		priced: 2,
		sessions: 2,
	});
	expect(priced([session("s1", 1.5)], scored)).toMatchObject({ usd: 1.5, complete: false, priced: 1 });
	expect(priced([session("s1", 1.5), session("s2", 1, false)], scored)).toMatchObject({ complete: false });
	expect(priced([{ ...session("s1", 1.5), harness: "claude" }], scored)).toMatchObject({ priced: 0 });
	// Codex reviews in a sub-session of the seat's, which may spawn its own.
	const child = (id: string, parent: string, cost: number) => ({ ...session(id, cost), parent });
	expect(
		priced(
			[child("c2", "c1", 0.5), session("s1", 1), child("c1", "s1", 2), child("x", "y", 9), session("s2", 1)],
			scored,
		),
	).toEqual({ usd: 4.5, complete: true, priced: 2, sessions: 2 });
});

/**
 * The fixture clone on GitHub as acme/widget: PR 7 is its feature branch, a culprit, and PR 8 another branch, clean.
 * The API answers each PR's head and base, and the bodies name its size and writer.
 */
function onGitHub(repo: string) {
	const local = git(repo, "remote", "get-url", "origin");
	git(repo, "remote", "set-url", "origin", "https://github.com/acme/widget.git");
	git(repo, "config", `url.${local}.insteadOf`, "https://github.com/acme/widget.git");
	const main = git(repo, "rev-parse", "origin/main");
	git(repo, "push", "-q", "origin", "feature:refs/pull/7/head");
	git(repo, "checkout", "-qb", "other", "origin/main");
	write(repo, "src/other.ts", "export const y = 1;\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "other");
	git(repo, "push", "-q", "origin", "other:refs/pull/8/head");
	const heads: Record<string, string> = { 7: git(repo, "rev-parse", "feature"), 8: git(repo, "rev-parse", "other") };
	git(repo, "checkout", "-q", "feature");
	// The fixture's commits are pushed, so the eval fetches them as it would a real PR's.
	git(repo, "branch", "-qD", "other");
	vi.stubEnv("GH_TOKEN", "token");
	const info = (login: string, parent: string | null) => ({
		owner: { login },
		name: "widget",
		fork: parent !== null,
		...(parent === null ? {} : { parent: { owner: { login: parent }, name: "widget" } }),
		default_branch: "main",
		clone_url: `https://github.com/${login}/widget.git`,
		ssh_url: `git@github.com:${login}/widget.git`,
	});
	vi.stubGlobal("fetch", async (input: URL) => {
		const url = new URL(input);
		if (url.pathname === "/repos/acme/widget") return new Response(JSON.stringify(info("acme", null)));
		// A contributor's fork, whose parent keeps the quest tree.
		if (url.pathname === "/repos/me/widget") return new Response(JSON.stringify(info("me", "acme")));
		if (url.pathname === "/repos/acme/widget/contents/quest/README.md") return new Response("{}");
		const pull = /^\/repos\/acme\/widget\/pulls\/(\d+)$/.exec(url.pathname)?.[1];
		if (pull === undefined || heads[pull] === undefined) return new Response("{}", { status: 404 });
		return new Response(
			JSON.stringify({
				merged_at: "2026-11-01T00:00:00Z",
				head: { sha: heads[pull], ref: pull === "7" ? "feature" : "other" },
				base: { sha: main },
				body: `## Models\n\n- Size: S\n- Implementer: Claude Code, claude-opus-5-5, high effort\n`,
			}),
		);
	});
	return { heads, local };
}

fakes(
	"quest eval adds cases from GitHub and scores each reviewer at the case's head, leaving no checkout",
	async () => {
		const s = setup(null);
		const { heads, local } = onGitHub(s.repo);
		const set = join(s.repo, "review-eval.json");

		const added = await quest(
			"--root",
			s.repo,
			"eval",
			"add",
			"7",
			"--defect",
			"src/lib.ts:1",
			"--fix",
			"9",
			"--what",
			"It sets x to 2.",
		);
		expect(added.stderr).toBe("");
		expect(added.code).toBe(0);
		expect(JSON.parse(added.stdout)).toMatchObject({
			pull: 7,
			base: git(s.repo, "rev-parse", "origin/main"),
			head: heads[7],
			size: "S",
			tier: "medium",
			writer: "claude-opus-5-5",
			defects: [{ fix: 9, what: "It sets x to 2.", at: [{ file: "src/lib.ts", from: 1, to: 1 }] }],
		});
		expect((await quest("--root", s.repo, "eval", "add", "8", "--clean")).code).toBe(0);
		expect(await quest("--root", s.repo, "eval", "add", "8", "--clean")).toMatchObject({
			code: 2,
			stderr: "error: #8 is already in the set as clean\n",
		});
		expect(
			await quest("--root", s.repo, "eval", "add", "7", "--defect", "src/lib.ts:2", "--fix", "9", "--what", "x"),
		).toMatchObject({
			code: 2,
			stderr: `error: src/lib.ts ends at line 1 at ${heads[7]}\n`,
		});
		expect(await quest("--root", s.repo, "eval", "add", "6")).toMatchObject({
			code: 2,
			stderr: "error: pass either --clean or --defect with --fix and --what\n",
		});
		expect(await quest("--root", s.repo, "eval", "add", "6", "--clean")).toMatchObject({
			code: 2,
			stderr: "error: acme/widget has no PR #6\n",
		});
		const second = ["--defect", "AGENTS.md:1", "--defect", "src/lib.ts:1", "--fix", "10", "--what", "Both."];
		expect((await quest("--root", s.repo, "eval", "add", "7", ...second)).code).toBe(0);
		const saved = parseEvalSet(JSON.parse(readFileSync(set, "utf8")));
		expect(saved.cases.map((c) => c.pull)).toEqual([7, 8]);
		expect(saved.cases[0]!.defects!.map((d) => d.at.map((p) => p.file))).toEqual([
			["src/lib.ts"],
			["AGENTS.md", "src/lib.ts"],
		]);

		// The rules are the running checkout's, not the case's base's.
		write(s.repo, "REVIEW.md", "ROOT-REVIEW rule\n");
		git(s.repo, "commit", "-qam", "rules");

		vi.stubEnv(
			"FAKE_REPLY",
			JSON.stringify({ score: 6, rationale: "r", findings: [{ ...finding("src/lib.ts", 1), body: "x is 2." }] }),
		);
		const run = await quest("--root", s.repo, "eval", "run", "--json");
		expect(run.code).toBe(0);
		const report = JSON.parse(run.stdout);
		expect(report.totals.pick).toEqual({
			culprits: 1,
			found: 2,
			defects: 2,
			clean: 1,
			noise: { high: 1, medium: 0, low: 0 },
		});
		expect(report.totals.either).toEqual({
			culprits: 1,
			found: 2,
			defects: 2,
			clean: 1,
			noise: { high: 2, medium: 0, low: 0 },
		});
		expect(report.rules).toEqual({ sha: git(s.repo, "rev-parse", "HEAD") });
		expect(report.cost).toBeNull();
		expect(run.stderr).toContain("case 1/2: #7");

		// Two seats, each a review turn and a findings turn, at each case's head in a checkout since removed.
		const turns = s.calls().filter((call: Call) => effortOf(call) !== null);
		expect(turns.map(effortOf).sort()).toEqual([
			"low",
			"low",
			"low",
			"low",
			"medium",
			"medium",
			"medium",
			"medium",
		]);
		const reviews = turns.filter((call: Call) => call.stdin.includes("The change under review"));
		expect(reviews.map((call) => call.cwd.includes(join(".git", "quest", "eval")))).toEqual([
			true,
			true,
			true,
			true,
		]);
		for (const call of reviews) {
			expect(call.stdin).toContain("ROOT-REVIEW rule");
			expect(call.stdin).not.toContain("BASE-REVIEW rule");
			expect(call.argv.join(" ") + call.stdin).not.toContain("HEAD-ROOT rule");
			expect(existsSync(call.cwd)).toBe(false);
		}
		expect(git(s.repo, "worktree", "list").split("\n")).toHaveLength(1);

		const lines = await quest("--root", s.repo, "eval", "run", "--pr", "8", "--harness", "claude");
		expect(lines.code).toBe(0);
		expect(lines.stdout).toContain("pick: 0/0 defects; 1 findings on 1 clean (1 high, 0 medium, 0 low)");
		expect(lines.stdout).toContain(
			"claude claude-opus-5-5 low: score 6, 1 findings; review 101 in (0 cached), 51 out, findings 100 in (80 cached), 7 out;",
		);
		expect(await quest("--root", s.repo, "eval", "run", "--pr", "5")).toMatchObject({
			code: 2,
			stderr: "error: not in the set: #5\n",
		});

		// A contributor's clone of a fork, which holds no PR head yet, fetches the set's from the repository it names.
		const fork = join(s.repo, "..", "fork");
		git(s.repo, "clone", "-q", "--no-local", local, fork);
		git(fork, "remote", "set-url", "origin", "https://github.com/me/widget.git");
		git(fork, "config", "--add", `url.${local}.insteadOf`, "https://github.com/me/widget.git");
		git(fork, "config", "--add", `url.${local}.insteadOf`, "https://github.com/acme/widget.git");
		expect(() => git(fork, "cat-file", "-e", heads[7]!)).toThrow();
		const more = await quest(
			"--root",
			fork,
			"eval",
			"add",
			"7",
			"--set",
			set,
			"--defect",
			"src/lib.ts:1",
			"--fix",
			"11",
			"--what",
			"Again.",
		);
		expect(more.stderr).toBe("");
		expect(JSON.parse(more.stdout).defects).toHaveLength(3);
		const scored = await quest("--root", fork, "eval", "run", "--set", set, "--pr", "7", "--json");
		expect(scored.stderr).toContain("case 1/1: #7");
		expect(JSON.parse(scored.stdout).totals.pick).toMatchObject({ culprits: 1, found: 3, defects: 3 });
	},
);
