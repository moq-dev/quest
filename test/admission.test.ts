import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { type AdmissionDependencies, PENDING_MS, type Window, admit, codexAccount } from "../src/cli/admission";
import { type Admission, type Host, RECENT_MS, SETTLE_MS, fileHost, processStart } from "../src/cli/gate";
import { tempDir } from "./fixture";

const GiB = 2 ** 30;
const signal = new AbortController().signal;
const me = { pid: process.pid, start: processStart(process.pid) };

/** A host of 8 CPUs with real ledgers, and load, memory, a clock, and process liveness the test controls. */
function host(windows: Window[] | null = null) {
	const state = { now: 10 * PENDING_MS, load: 0, memory: Infinity, dead: new Set<number>(), stop: Infinity };
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
		account: () => windows,
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
	// Another harness's agents spend another account.
	expect(await atOnce("claude")).toBe(true);
	// An agent that ended is no longer in flight, however recently it started.
	state.dead.add(2);
	expect(await atOnce("codex")).toBe(true);
	// One without a launcher counts as in flight only while it counts against the host.
	expect(await admit("codex", deps, signal)).toEqual({ resets });
	state.now += PENDING_MS;
	expect(await atOnce("codex")).toBe(true);
	expect(notices).toEqual([]);
});

test("a harness that reports no usage is admitted on the host alone, saying so", async () => {
	const { atOnce, notices } = host(null);
	expect(await atOnce("claude")).toBe(true);
	expect(notices).toEqual(["claude reports no account usage here, so only the host is checked"]);
});

/** A Codex rollout in `home` last written at `modified` ms, ending with a `token_count` event. */
function rollout(home: string, name: string, modified: number, tokens: number, limits: unknown, tail = "") {
	const dir = join(home, "sessions", "2026", "11", "12");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `rollout-${name}.jsonl`);
	const event = {
		type: "event_msg",
		payload: { type: "token_count", info: { total_token_usage: { total_tokens: tokens } }, rate_limits: limits },
	};
	writeFileSync(path, `{"type":"session_meta"}\n${JSON.stringify(event)}\n${tail}`);
	utimesSync(path, modified / 1000, modified / 1000);
}

test("Codex's windows come from its newest report, with an agent's share from this host's sessions", () => {
	const home = tempDir();
	const minute = 60_000;
	const now = 1_000_000 * minute;
	const week = { used_percent: 40, window_minutes: 10_080, resets_at: (now + 1000 * minute) / 1000 };
	const hours = { used_percent: 10, window_minutes: 300, resets_at: (now + 100 * minute) / 1000 };
	const old = { primary: { ...week, used_percent: 5 }, secondary: null };
	// Written before the 5-hour window opened, inside the week's.
	rollout(home, "a", now - 400 * minute, 300, old);
	rollout(home, "b", now - 50 * minute, 100, old);
	// The newest rollout's last line is still being written, so its last whole report counts.
	rollout(
		home,
		"c",
		now - minute,
		100,
		{ primary: week, secondary: hours },
		'{"type":"event_msg","payload":{"type":"token_c',
	);
	const [weekly, hourly] = codexAccount(home, now)!;
	// Sessions of 300, 100, and 100 tokens: a token's session holds (9 + 1 + 1) / 25 of the window's spend.
	expect(weekly).toEqual({ used: 40, resets: now + 1000 * minute, expected: (40 * 11) / 25 });
	expect(hourly).toEqual({ used: 10, resets: now + 100 * minute, expected: 10 / 2 });
	// A window that reset since the report is unknown, not spent.
	expect(codexAccount(home, now + 200 * minute)).toEqual([expect.objectContaining({ used: 40 })]);
});

test("Codex without a usage report gives no signal, and an unreadable one fails", () => {
	const home = tempDir();
	expect(codexAccount(home, 0)).toBeNull();
	rollout(home, "a", 1000, 100, null);
	expect(codexAccount(home, 0)).toBeNull();
	rollout(home, "b", 2000, 100, { primary: { used_percent: "40%" }, secondary: null });
	expect(() => codexAccount(home, 0)).toThrow("Codex reported a primary usage window quest cannot read");
});
