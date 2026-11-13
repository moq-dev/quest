import { mkdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { type AdmissionDependencies, PENDING_MS, type Window, admit, codexAccount } from "../src/cli/admission";
import { type Admission, type Host, RECENT_MS, SETTLE_MS, fileHost, processStart } from "../src/cli/gate";
import { tempDir } from "./fixture";

const GiB = 2 ** 30;
const signal = new AbortController().signal;
const me = { pid: process.pid, start: processStart(process.pid) };

/** A host of 8 CPUs with real ledgers, and load, memory, a clock, and process liveness the test controls. */
function host(windows: Window[] | null = null) {
	const state = {
		now: 10 * PENDING_MS,
		load: 0,
		memory: Infinity,
		dead: new Set<number>(),
		stop: Infinity,
		account: "main",
	};
	const sleeps: number[] = [];
	const notices: string[] = [];
	const ledger = (directory: string): Host => ({
		...fileHost(directory, () => state.now),
		load: () => state.load,
		memory: () => state.memory,
		running: (admission) => admission.pid !== undefined && !state.dead.has(admission.pid),
		sleep: async (ms) => {
			// A wait that outlasts the test's patience ends it, as a cancelled caller's would.
			if (state.now >= state.stop) throw new Error("still waiting");
			sleeps.push(ms);
			state.now += ms;
		},
	});
	const deps: AdmissionDependencies = {
		limits: { load: 8, memory: 4 * GiB },
		gate: ledger(tempDir()),
		agents: ledger(tempDir()),
		account: (harness) => windows && { id: `${harness} ${state.account}`, windows },
		notice: (text) => notices.push(text),
	};
	const gated = (admissions: Admission[]) => deps.gate.publish(deps.gate.ledger(), admissions);
	/** Whether one more agent is admitted without waiting. */
	const atOnce = async (harness = "claude", held?: number) => {
		state.stop = state.now;
		try {
			return (await admit(harness, deps, signal, held)) === null;
		} catch (error) {
			if ((error as Error).message !== "still waiting") throw error;
			return false;
		}
	};
	return { state, sleeps, notices, deps, gated, atOnce };
}

test("a fan-out fills the host's headroom, and each agent frees its share once it would have built", async () => {
	const { state, deps, sleeps, notices, atOnce } = host();
	state.load = 5;
	// Load 5 plus 0, 1, and 2 agents not yet building stays under 8 CPUs; a fourth would not.
	expect([await atOnce(), await atOnce(), await atOnce(), await atOnce()]).toEqual([true, true, true, false]);
	// The fourth waits as the gate's callers do, and starts once the first three no longer count.
	state.stop = Infinity;
	expect(await admit("claude", deps, signal)).toBeNull();
	expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(PENDING_MS);
	expect(new Set(sleeps)).toEqual(new Set([SETTLE_MS]));
	// Each waiting call names what it waits for once, however long it waits.
	expect(notices.filter((text) => text.startsWith("waiting"))).toEqual(
		Array(2).fill("waiting for the load average to fall before starting an agent"),
	);
});

test("each agent not yet building takes one command's memory", async () => {
	const { state, atOnce } = host();
	state.memory = 9 * GiB;
	expect([await atOnce(), await atOnce(), await atOnce()]).toEqual([true, true, false]);
});

test("a queued or running gated command holds agents back as it would another command", async () => {
	const { state, gated, atOnce, notices } = host();
	state.load = 6;
	// One command queued for the gate: an arrival would wait behind it only once the host is short.
	gated([{ id: "queued", at: state.now, ...me, queued: true }]);
	expect([await atOnce(), await atOnce()]).toEqual([true, false]);
	expect(notices.at(-1)).toContain("gated commands queued");
	// Running commands that kept every CPU busy hold the host whatever the load average says.
	state.load = 0;
	state.now += PENDING_MS;
	gated([{ id: "build", at: state.now - RECENT_MS, ...me, cores: 8 }]);
	expect(await atOnce()).toBe(false);
	// A recent gated admission counts once, as the gate counts it.
	gated([{ id: "build", at: state.now, ...me, cores: 1 }]);
	state.load = 6;
	expect([await atOnce(), await atOnce()]).toEqual([true, false]);
});

test("a host loaded by work no gate holds still starts one agent at a time", async () => {
	const { state, atOnce } = host();
	state.load = 40;
	expect([await atOnce(), await atOnce()]).toEqual([true, false]);
	state.now += PENDING_MS;
	expect(await atOnce()).toBe(true);
	// Memory is never waived.
	state.now += PENDING_MS;
	state.memory = GiB;
	expect(await atOnce()).toBe(false);
});

test("an agent whose launcher exited no longer counts, and one still running counts only while it may yet build", async () => {
	const { state, atOnce } = host();
	state.load = 7;
	expect([await atOnce("codex", 4242), await atOnce("codex")]).toEqual([true, false]);
	state.dead.add(4242);
	expect(await atOnce("codex")).toBe(true);
	state.now += PENDING_MS;
	expect([await atOnce("codex", 4243), await atOnce("codex")]).toEqual([true, false]);
	state.now += PENDING_MS;
	expect(await atOnce("codex")).toBe(true);
});

test("the account admits an agent only while its windows cover it and the agents in flight", async () => {
	const resets = 20 * PENDING_MS;
	const { state, deps, atOnce, notices } = host([
		{ used: 70, resets, expected: 10 },
		{ used: 99, resets: 5 * PENDING_MS, expected: 10 },
	]);
	// The second window reset before now, so it holds nothing; 70 + 10 per agent covers three.
	expect([await atOnce("codex", 1), await atOnce("codex", 2), await atOnce("codex", 3)]).toEqual([true, true, true]);
	expect(await admit("codex", deps, signal)).toEqual({ resets });
	// Another account's agents spend their own windows, on the same harness or another.
	state.account = "other";
	expect(await atOnce("codex", 4)).toBe(true);
	expect(await atOnce("claude")).toBe(true);
	state.account = "main";
	// An agent that ended is no longer in flight, however recently it started.
	state.dead.add(2);
	expect(await atOnce("codex")).toBe(true);
	// One without a launcher counts as in flight only while it counts against the host.
	expect(await admit("codex", deps, signal)).toEqual({ resets });
	state.now += PENDING_MS;
	expect(await atOnce("codex")).toBe(true);
	expect(notices).toEqual([]);
});

test("usage spent while an agent waits for the host refuses it, and an account that changes under it fails", async () => {
	const resets = 20 * PENDING_MS;
	const windows = [{ used: 50, resets, expected: 10 }];
	const { state, deps, sleeps } = host(windows);
	state.memory = GiB;
	// Other agents spend the account during the second wait, and memory never frees.
	deps.agents.sleep = async (ms) => {
		sleeps.push(ms);
		state.now += ms;
		if (sleeps.length === 2) windows[0].used = 95;
	};
	expect(await admit("codex", deps, signal)).toEqual({ resets });
	expect(sleeps).toHaveLength(2);
	windows[0].used = 50;
	deps.agents.sleep = async () => {
		state.account = "other";
	};
	await expect(admit("codex", deps, signal)).rejects.toThrow("stopped reporting the usage of the account");
});

test("a harness that reports no usage is admitted on the host alone, saying so", async () => {
	const { atOnce, notices } = host(null);
	expect(await atOnce("claude")).toBe(true);
	expect(notices).toEqual(["claude reports no account usage here, so only the host is checked"]);
});

const minute = 60_000;
const now = 1_000_000 * minute;

/**
 * A Codex rollout at `path` under `home`, last written at `modified` ms, holding a `token_count`
 * event per `[time, total tokens, rate limits]`, then `tail`.
 */
function rollout(home: string, path: string, modified: number, events: [number, number, unknown][], tail = "") {
	const file = join(home, path.includes("/") ? path : `sessions/2026/11/12/rollout-${path}.jsonl`);
	mkdirSync(dirname(file), { recursive: true });
	const lines = events.map(([at, tokens, limits]) =>
		JSON.stringify({
			timestamp: new Date(at).toISOString(),
			type: "event_msg",
			payload: {
				type: "token_count",
				info: { total_token_usage: { total_tokens: tokens } },
				rate_limits: limits,
			},
		}),
	);
	writeFileSync(file, `{"type":"session_meta"}\n${lines.join("\n")}\n${tail}`);
	utimesSync(file, modified / 1000, modified / 1000);
}

const week = { used_percent: 40, window_minutes: 10_080, resets_at: (now + 1000 * minute) / 1000 };
const hours = { used_percent: 10, window_minutes: 300, resets_at: (now + 100 * minute) / 1000 };
const old = { primary: { ...week, used_percent: 5 }, secondary: null };

test("Codex's windows come from its newest report, with an agent's share from this host's sessions", () => {
	const home = tempDir();
	// Written before the 5-hour window opened, inside the week's.
	rollout(home, "a", now - 400 * minute, [[now - 400 * minute, 300, old]]);
	// An archived session still spent the window, and one seen in both trees counts once.
	rollout(home, "archived_sessions/rollout-b.jsonl", now - 50 * minute, [[now - 50 * minute, 100, old]]);
	rollout(home, "sessions/2026/11/13/rollout-b.jsonl", now - 50 * minute, [[now - 50 * minute, 100, old]]);
	// The newest report's rollout has a last line still being written, so its last whole one counts.
	rollout(
		home,
		"c",
		now - 2 * minute,
		[[now - 2 * minute, 100, { primary: week, secondary: hours }]],
		'{"type":"event_msg","payload":{"type":"token_c',
	);
	// A rollout written since, by a tool's output, holds only an older report.
	rollout(home, "d", now - minute, [[now - 30 * minute, 0, old]]);
	const { id, windows } = codexAccount(home, now)!;
	expect(id).toBe(`codex ${realpathSync(home)}`);
	// Sessions of 300, 100, and 100 tokens: a token's session holds (9 + 1 + 1) / 25 of the window's spend.
	expect(windows).toEqual([
		{ used: 40, resets: now + 1000 * minute, expected: (40 * 11) / 25 },
		{ used: 10, resets: now + 100 * minute, expected: 10 / 2 },
	]);
	// A window that reset since the report is unknown, not spent.
	expect(codexAccount(home, now + 200 * minute)!.windows).toEqual([expect.objectContaining({ used: 40 })]);
});

test("a session resumed across a window's reset counts only its tokens since", () => {
	const home = tempDir();
	const opened = now + 100 * minute - 300 * minute;
	// 900 of its 1000 tokens were spent before the 5-hour window opened.
	rollout(home, "1970-06-01T00-00-00-a", now - minute, [
		[opened - 500 * minute, 400, old],
		[opened - minute, 900, old],
		[now - minute, 1000, { primary: hours, secondary: null }],
	]);
	rollout(home, "b", now - 10 * minute, [[now - 10 * minute, 100, old]]);
	// Two sessions of 100 tokens each in the window: half of its 10 points apiece.
	expect(codexAccount(home, now)!.windows).toEqual([{ used: 10, resets: now + 100 * minute, expected: 5 }]);
});

test("two Codex homes are one account only when their logins name the same one", () => {
	const [first, second] = [tempDir(), tempDir()];
	for (const home of [first, second]) rollout(home, "a", now, [[now, 1, { primary: week, secondary: null }]]);
	expect(codexAccount(first, now)!.id).not.toBe(codexAccount(second, now)!.id);
	for (const home of [first, second]) writeFileSync(join(home, "auth.json"), '{"tokens":{"account_id":"acct"}}');
	expect([codexAccount(first, now)!.id, codexAccount(second, now)!.id]).toEqual(["codex acct", "codex acct"]);
	// An API key's login names no account.
	writeFileSync(join(second, "auth.json"), '{"OPENAI_API_KEY":"sk","tokens":null}');
	expect(codexAccount(second, now)!.id).toBe(`codex ${realpathSync(second)}`);
});

test("Codex without a usage report gives no signal, and an unreadable one fails", () => {
	const home = tempDir();
	expect(codexAccount(home, 0)).toBeNull();
	rollout(home, "a", 1000, [[1000, 100, null]]);
	expect(codexAccount(home, 0)).toBeNull();
	rollout(home, "b", 2000, [[2000, 100, { primary: { used_percent: "40%" }, secondary: null }]]);
	expect(() => codexAccount(home, 0)).toThrow("Codex reported a primary usage window quest cannot read");
});
