import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { constants, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	admit,
	alive,
	COMMAND_MEMORY,
	claimDirectory,
	direct,
	fileHost,
	gate,
	group,
	inside,
	type Admission,
	type Host,
	hostLimits,
	linuxMemory,
	measure,
	type Owner,
	owner,
	processStart,
	QUICK_MS,
	RECENT_MS,
	SETTLE_MS,
	job,
	scope,
} from "../src/cli/gate";
import { forwards, foregroundStat, statProcess } from "../src/cli/interrupt";
import { gateBoundary, main } from "../src/cli/main";
import { alive as ownerAlive, questScope } from "../src/cli/supervise";
import { created, onTerminal, run, signalled, tempDir } from "./fixture";

// Linux reports a /proc read that races a process's exit as ESRCH rather than ENOENT, so fail
// one process's stat read with either code, without timing.
const racing = vi.hoisted(() => ({ read: undefined as { path: string; code: string } | undefined }));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
			if (racing.read && args[0] === racing.read.path) {
				throw Object.assign(new Error(`${racing.read.code}: no such process, read`), {
					code: racing.read.code,
				});
			}
			return fs.readFileSync(...args);
		},
	};
});

const GiB = 2 ** 30;

/** How this process's gate records itself in an admission. */
const me = { pid: process.pid, start: processStart(process.pid) };

afterEach(() => vi.unstubAllEnvs());

test("limits derive from the host's CPUs and memory", () => {
	// The host-wide load average is compared with every host CPU, not the
	// process's affinity subset, so an idle assigned CPU is not held back.
	expect(hostLimits(24, 64 * GiB)).toEqual({ load: 24, memory: COMMAND_MEMORY });
	// A small host still runs one command, and reserves a quarter of its RAM.
	expect(hostLimits(4, 2 * GiB)).toEqual({ load: 4, memory: GiB / 2 });
	expect(hostLimits().load).toBeGreaterThanOrEqual(1);
});

/** A real ledger in `directory`, with load, memory, and a clock the test controls. */
function testHost(
	directory: string,
	state: { now: number; load: number; memory: number },
	events: string[] = [],
): Host {
	return {
		...fileHost(directory, () => state.now),
		load: () => state.load,
		memory: () => state.memory,
		sleep: async (ms) => {
			events.push(`sleep ${ms}`);
			state.now += ms;
		},
	};
}

const signal = new AbortController().signal;

test("an idle host admits a burst at once, then spaces admissions from the previous one", async () => {
	const directory = tempDir();
	const state = { now: 5 * SETTLE_MS - 1, load: 1, memory: Infinity };
	const limits = { load: 4, memory: GiB };
	const sleeps = async () => {
		const events: string[] = [];
		await admit(limits, testHost(directory, state, events), signal);
		return events;
	};
	// Load 1 plus 0, 1, and 2 recent admissions stays under 4 CPUs.
	for (let i = 0; i < 3; i++) expect(await sleeps()).toEqual([]);
	// Now only the raw load has room: one at a time, waking as the interval ends,
	// even when it crosses what used to be a window boundary.
	state.now += 1;
	expect(await sleeps()).toEqual([`sleep ${SETTLE_MS - 1}`]);
	expect(await sleeps()).toEqual([`sleep ${SETTLE_MS}`]);
	// Every admission counts as recent for a minute.
	state.now += RECENT_MS;
	expect(await sleeps()).toEqual([]);
});

test("each recent admission takes one command's memory from a shared free-memory sample", async () => {
	const directory = tempDir();
	// Memory has not yet reflected the first build, so every caller reads 6 GiB.
	const state = { now: 0, load: 0, memory: 6 * GiB };
	const limits = { load: 24, memory: 4 * GiB };
	const events: string[] = [];
	await admit(limits, testHost(directory, state, events), signal);
	expect(events).toEqual([]);
	await admit(limits, testHost(directory, state, events), signal);
	expect(events).toEqual([`sleep ${SETTLE_MS}`]);
});

test("load and memory pressure wait whatever the ledger holds", async () => {
	const events: string[] = [];
	const state = { now: 0, load: 9, memory: 0 };
	const host = testHost(tempDir(), state, events);
	// A build admitted long ago still runs, so the load is the gate's to wait out.
	const build = { id: "build", at: -10 * RECENT_MS, ...me };
	expect(host.publish(host.ledger(), [build])).toBe(true);
	const sleep = host.sleep;
	host.sleep = async (ms, signal) => {
		await sleep(ms, signal);
		if (state.load > 4) state.load = 3;
		else state.memory = GiB;
	};
	await admit({ load: 4, memory: GiB }, host, signal, (reason) => events.push(reason));
	expect(events).toEqual(["load", `sleep ${SETTLE_MS}`, "memory", `sleep ${SETTLE_MS}`]);
	expect(host.ledger().admissions).toEqual([build, { id: expect.any(String), at: 2 * SETTLE_MS, ...me }]);
});

test("load from outside the gate admits one command at a time while none runs", async () => {
	// Work outside the job holds a fresh macOS runner's load above its CPUs for the whole job.
	const directory = tempDir();
	const state = { now: 0, load: 12, memory: Infinity };
	const limits = { load: 3, memory: GiB };
	const finished = new Set<string>();
	const host = (events: string[]) => ({
		...testHost(directory, state, events),
		running: (admission: Admission) => !finished.has(admission.id),
	});
	const events: string[] = [];
	const lone = host(events);
	lone.sleep = async () => {
		throw new Error("a lone command waited for load it cannot wait out");
	};
	await admit(limits, lone, signal, (reason) => events.push(reason));
	expect(events).toEqual([]);
	// The first command still runs, so the next waits for the load until it ends.
	const [first] = host([]).ledger().admissions;
	const next = host(events);
	next.sleep = async (ms) => {
		events.push(`sleep ${ms}`);
		state.now += ms;
		finished.add(first.id);
	};
	await admit(limits, next, signal, (reason) => events.push(reason));
	expect(events).toEqual(["load", `sleep ${SETTLE_MS}`]);
	expect(next.ledger().admissions.map(({ id }) => id)).toEqual([first.id, expect.any(String)]);
});

test("a running admission keeps its slot past the minute, and a finished one expires", async () => {
	const directory = tempDir();
	const now = 10 * RECENT_MS;
	const host = fileHost(directory, () => now);
	const exited = spawnSync(process.execPath, ["-e", ""]).pid;
	expect(alive(process.pid)).toBe(true);
	expect(alive(exited)).toBe(false);
	host.publish(host.ledger(), [
		{ id: "running", at: 0, ...me },
		{ id: "exited", at: 0, pid: exited },
		{ id: "unknown", at: 0 },
	]);
	expect(host.ledger().admissions.map((admission) => host.running(admission))).toEqual([true, false, false]);
	const events: string[] = [];
	// The running build's load is the gate's own, so it waits for the load to fall.
	const state = { now, load: 2, memory: Infinity };
	const busy = testHost(directory, state, events);
	busy.sleep = async (ms) => {
		events.push(`sleep ${ms}`);
		state.load = 0;
	};
	await admit({ load: 1, memory: 1 }, busy, signal, (reason) => events.push(reason));
	expect(events).toEqual(["load", `sleep ${SETTLE_MS}`]);
	expect(host.ledger().admissions).toEqual([
		{ id: "running", at: 0, ...me },
		{ id: expect.any(String), at: now, ...me },
	]);
	// A malformed process ID reads as a version cut short.
	writeFileSync(join(directory, "100"), JSON.stringify([{ id: "a", at: 0, pid: -1 }]));
	expect(host.ledger()).toEqual({ version: 100, admissions: [] });
});

test("a running command that kept every CPU busy holds the host through a lull in the load", async () => {
	const events: string[] = [];
	// Between a build's phases, the load average falls below the host's CPUs.
	const state = { now: 0, load: 1, memory: Infinity };
	const host = testHost(tempDir(), state, events);
	const build = { id: "build", at: -10 * RECENT_MS, ...me, cores: 4 };
	expect(host.publish(host.ledger(), [build])).toBe(true);
	const sleep = host.sleep;
	host.sleep = async (ms, signal) => {
		await sleep(ms, signal);
		// Its busiest minute now left one CPU free.
		const ledger = host.ledger();
		host.publish(
			ledger,
			ledger.admissions.map((admission) => (admission.id === build.id ? { ...build, cores: 3 } : admission)),
		);
	};
	await admit({ load: 4, memory: GiB }, host, signal, (reason) => events.push(reason));
	expect(events).toEqual(["load", `sleep ${SETTLE_MS}`]);
	expect(host.ledger().admissions).toEqual([
		{ ...build, cores: 3 },
		{ id: expect.any(String), at: SETTLE_MS, ...me },
	]);
});

test("a gate records the most CPUs its command kept busy in the last minute", async () => {
	const state = { now: 0, load: 0, memory: Infinity };
	const host = testHost(tempDir(), state);
	host.publish(host.ledger(), [{ id: "build", at: 0, ...me }]);
	// CPUs busy over each SETTLE_MS: before systemd creates the scope, the first reading, a
	// build on four CPUs, then its tests on one for over a minute.
	const busy = [undefined, 0, 4, 4, ...Array(RECENT_MS / SETTLE_MS).fill(1)];
	let usage: number | undefined;
	let total = 0;
	host.usage = () => usage;
	const published: string[] = [];
	const publish = host.publish;
	host.publish = (base, admissions) => {
		published.push(`${admissions[0].cores} at ${state.now}`);
		return publish(base, admissions);
	};
	const stop = new AbortController();
	host.sleep = async (ms) => {
		if (busy.length === 0) {
			stop.abort();
			throw stop.signal.reason;
		}
		state.now += ms;
		const cores = busy.shift();
		if (cores === undefined) return;
		total += cores * ms * 1000;
		usage = total;
	};
	await measure(host, { id: "build", unit: "quest-gate-build.scope" }, stop.signal);
	// The build's last sample, at 20 s, holds its four CPUs for a minute.
	expect(published).toEqual([`4 at ${3 * SETTLE_MS}`, `1 at ${4 * SETTLE_MS + RECENT_MS}`]);
	expect(host.ledger().admissions).toEqual([{ id: "build", at: 0, ...me, cores: 1 }]);
});

test("a priority caller waits for memory, never for load, even while a gated command runs", async () => {
	const directory = tempDir();
	const state = { now: 0, load: 99, memory: 0 };
	const limits = { load: 4, memory: GiB };
	const events: string[] = [];
	const host = testHost(directory, state, events);
	// A build admitted long ago still runs, so an ordinary caller would wait out the load.
	const build = { id: "build", at: -10 * RECENT_MS, ...me };
	expect(host.publish(host.ledger(), [build])).toBe(true);
	const sleep = host.sleep;
	host.sleep = async (ms, signal) => {
		await sleep(ms, signal);
		state.memory = 8 * GiB;
	};
	await admit(limits, host, signal, (reason) => events.push(reason), { priority: true });
	expect(events).toEqual(["memory", `sleep ${SETTLE_MS}`]);
	expect(host.ledger().admissions).toEqual([build, { id: expect.any(String), at: SETTLE_MS, ...me }]);
	// Its admission takes headroom from an ordinary caller once the load falls.
	state.load = 3;
	const ordinary: string[] = [];
	await admit(limits, testHost(directory, state, ordinary), signal, (reason) => ordinary.push(reason));
	expect(ordinary).toEqual([`sleep ${SETTLE_MS}`]);
});

test("a quick caller starts after at most QUICK_MS, and its admission is recorded", async () => {
	const directory = tempDir();
	const state = { now: 0, load: 99, memory: 0 };
	const events: string[] = [];
	const host = testHost(directory, state, events);
	// A build admitted long ago still runs: the load is the gate's own, and its slot survives.
	const build = { id: "build", at: -10 * RECENT_MS, ...me };
	expect(host.publish(host.ledger(), [build])).toBe(true);
	await admit({ load: 4, memory: GiB }, host, signal, undefined, { quick: true });
	const sleeps = Array.from({ length: QUICK_MS / SETTLE_MS }, () => `sleep ${SETTLE_MS}`);
	expect(events).toEqual(sleeps);
	expect(host.ledger().admissions).toEqual([build, { id: expect.any(String), at: QUICK_MS, ...me }]);
	// A sleep that overran shortens the last one, which ends at the deadline.
	const late = { now: 0, load: 99, memory: 0 };
	const overran: string[] = [];
	const slow = testHost(tempDir(), late, overran);
	const sleep = slow.sleep;
	slow.sleep = async (ms, signal) => {
		await sleep(ms, signal);
		if (overran.length === 1) late.now += 3000;
	};
	await admit({ load: 4, memory: GiB }, slow, signal, undefined, { quick: true });
	expect(overran.at(-1)).toBe(`sleep ${SETTLE_MS - 3000}`);
	expect(slow.ledger().admissions).toEqual([{ id: expect.any(String), at: QUICK_MS, ...me }]);
});

test("waiting callers start in arrival order, a later one first only while the host has room for both", async () => {
	const limits = { load: 4, memory: GiB };
	// A build still runs, and an earlier caller waits for its turn.
	const build = { id: "build", at: -10 * RECENT_MS, ...me };
	const earlier = { id: "earlier", at: 0, ...me, queued: true };
	const directory = tempDir();
	const state = { now: 0, load: 3, memory: Infinity };
	const events: string[] = [];
	const host = testHost(directory, state, events);
	expect(host.publish(host.ledger(), [build, earlier])).toBe(true);
	const sleep = host.sleep;
	host.sleep = async (ms, signal) => {
		await sleep(ms, signal);
		// The earlier caller takes its turn.
		const ledger = host.ledger();
		const rest = ledger.admissions.filter(({ id }) => id !== "earlier");
		if (rest.length < ledger.admissions.length)
			expect(host.publish(ledger, [...rest, { id: "started", at: state.now, ...me }])).toBe(true);
	};
	// Alone, this caller would start at once; behind the earlier one, it waits, then spaces itself.
	await admit(limits, host, signal, (reason) => events.push(reason));
	expect(events).toEqual(["queue", `sleep ${SETTLE_MS}`, `sleep ${SETTLE_MS}`]);
	expect(host.ledger().admissions).toEqual([
		build,
		{ id: "started", at: SETTLE_MS, ...me },
		{ id: expect.any(String), at: 2 * SETTLE_MS, ...me },
	]);
	// With room for both, it starts at once and leaves the earlier caller's place.
	const roomy = testHost(tempDir(), { now: 0, load: 2, memory: Infinity }, events);
	expect(roomy.publish(roomy.ledger(), [build, earlier])).toBe(true);
	events.length = 0;
	await admit(limits, roomy, signal, (reason) => events.push(reason));
	expect(events).toEqual([]);
	expect(roomy.ledger().admissions).toEqual([build, earlier, { id: expect.any(String), at: 0, ...me }]);
});

test("a place frees once its gate ends or its caller cancels, or a minute after its last refresh without a start", async () => {
	const limits = { load: 4, memory: GiB };
	const build = { id: "build", at: -10 * RECENT_MS, ...me };
	const exited = spawnSync(process.execPath, ["-e", ""]).pid;
	const directory = tempDir();
	const state = { now: 0, load: 3, memory: Infinity };
	const host = testHost(directory, state);
	expect(
		host.publish(host.ledger(), [
			build,
			{ id: "ended", at: 0, pid: exited, queued: true },
			{ id: "reused", at: 0, pid: process.pid, start: "an earlier process", queued: true },
			{ id: "unrefreshed", at: -RECENT_MS, pid: process.pid, queued: true },
		]),
	).toBe(true);
	const events: string[] = [];
	await admit(limits, testHost(directory, state, events), signal, (reason) => events.push(reason));
	expect(events).toEqual([]);
	expect(host.ledger().admissions).toEqual([build, { id: expect.any(String), at: 0, ...me }]);
	// A place refreshed within the minute still holds, and a cancelled caller behind it leaves the queue.
	const fresh = { id: "fresh", at: -RECENT_MS / 2, pid: process.pid, queued: true };
	const queued = testHost(tempDir(), state);
	expect(queued.publish(queued.ledger(), [build, fresh])).toBe(true);
	const controller = new AbortController();
	const waited: string[] = [];
	queued.sleep = async () => {
		expect(queued.ledger().admissions).toEqual([build, fresh, expect.objectContaining({ queued: true, ...me })]);
		controller.abort(new Error("cancelled"));
	};
	await expect(admit(limits, queued, controller.signal, (reason) => waited.push(reason))).rejects.toThrow(
		"cancelled",
	);
	expect(waited).toEqual(["queue"]);
	expect(queued.ledger().admissions).toEqual([build, fresh]);
});

test("a priority caller goes ahead of the queue, and a quick one starts at its deadline whatever its place", async () => {
	const limits = { load: 4, memory: GiB };
	const build = { id: "build", at: -10 * RECENT_MS, ...me };
	const earlier = { id: "earlier", at: 0, ...me, queued: true };
	const directory = tempDir();
	const state = { now: 0, load: 3, memory: Infinity };
	const host = testHost(directory, state);
	expect(host.publish(host.ledger(), [build, earlier])).toBe(true);
	const events: string[] = [];
	await admit(limits, testHost(directory, state, events), signal, undefined, { priority: true });
	expect(events).toEqual([]);
	await admit(limits, testHost(directory, state, events), signal, undefined, { quick: true });
	expect(events).toEqual(Array.from({ length: QUICK_MS / SETTLE_MS }, () => `sleep ${SETTLE_MS}`));
	expect(host.ledger().admissions).toEqual([
		build,
		earlier,
		{ id: expect.any(String), at: 0, ...me },
		{ id: expect.any(String), at: QUICK_MS, ...me },
	]);
});

test("a lone quick or priority caller starts at once on load from outside the gate", async () => {
	// No gated command runs, so the load is work the gate cannot wait out, whatever the precedence.
	const state = { now: 0, load: 12, memory: Infinity };
	const limits = { load: 3, memory: GiB };
	for (const precedence of [{ quick: true }, { priority: true }]) {
		const host = { ...testHost(tempDir(), state), running: () => false };
		host.sleep = async () => {
			throw new Error("a lone command waited for load it cannot wait out");
		};
		await admit(limits, host, signal, undefined, precedence);
		expect(host.ledger().admissions).toEqual([{ id: expect.any(String), at: 0, ...me }]);
	}
});

test("a burst that all read the ledger before any records admits only what the rule allows", async () => {
	const directory = tempDir();
	const state = { now: 0, load: 1, memory: Infinity };
	const limits = { load: 2, memory: GiB };
	const events: string[] = [];
	const late = testHost(directory, state, events);
	const publish = late.publish;
	let raced = false;
	late.publish = (base, admissions) => {
		// Another caller read the same empty ledger and publishes first.
		if (!raced) {
			raced = true;
			const other = testHost(directory, state);
			expect(other.publish(other.ledger(), [{ id: "other", at: state.now }])).toBe(true);
		}
		return publish(base, admissions);
	};
	await admit(limits, late, signal);
	// The late caller saw the other admission once its publish failed, and spaced itself.
	expect(events).toEqual([`sleep ${SETTLE_MS}`]);
	expect(late.ledger().admissions.map(({ at }) => at)).toEqual([0, SETTLE_MS]);
});

test("a caller stalled after sampling the host decides again and records when it published", async () => {
	const directory = tempDir();
	const state = { now: 0, load: 0, memory: Infinity };
	const limits = { load: 1, memory: 1 };
	const stalled = testHost(directory, state);
	let stalls = 1;
	stalled.memory = () => {
		// Descheduled between reading the clock and publishing.
		if (stalls-- > 0) state.now += SETTLE_MS;
		return state.memory;
	};
	await admit(limits, stalled, signal);
	expect(stalled.ledger().admissions).toEqual([{ id: expect.any(String), at: SETTLE_MS, ...me }]);
	// The next caller spaces itself from the publication, not from the stale sample.
	const events: string[] = [];
	await admit(limits, testHost(directory, state, events), signal);
	expect(events).toEqual([`sleep ${SETTLE_MS}`]);
});

test("a stalled caller cannot publish into a version already pruned", () => {
	const directory = tempDir();
	const host = fileHost(directory, () => 0);
	expect(host.publish(host.ledger(), [{ id: "a", at: 0 }])).toBe(true);
	const stale = host.ledger();
	for (const id of ["b", "c"]) {
		const base = host.ledger();
		expect(host.publish(base, [...base.admissions, { id, at: 0 }])).toBe(true);
	}
	expect(readdirSync(directory)).toEqual(["3"]);
	// Version 2 is free again, but outside the ledger's history.
	expect(host.publish(stale, [...stale.admissions, { id: "stale", at: 0 }])).toBe(false);
	expect(readdirSync(directory)).toEqual(["3"]);
	expect(host.ledger().admissions.map(({ id }) => id)).toEqual(["a", "b", "c"]);
});

test("a caller that dies mid-admission blocks no one past a minute", async () => {
	const directory = tempDir();
	// Drafts age by file time, so this clock is the real one.
	const state = { now: Date.now(), load: 0, memory: Infinity };
	const host = testHost(directory, state);
	// One caller died a minute ago after publishing, another before it could link its draft.
	expect(host.publish(host.ledger(), [{ id: "dead", at: state.now - RECENT_MS }])).toBe(true);
	const draft = join(directory, "dead.tmp");
	writeFileSync(draft, "[");
	utimesSync(draft, new Date(state.now - 2 * RECENT_MS), new Date(state.now - 2 * RECENT_MS));
	writeFileSync(join(directory, "live.tmp"), "[");
	const events: string[] = [];
	await admit({ load: 1, memory: 1 }, testHost(directory, state, events), signal);
	expect(events).toEqual([]);
	// The stale draft is gone; one still being written stays.
	expect(readdirSync(directory).sort()).toEqual(["3", "live.tmp"]);
	// A version cut short, as by power loss, reads as empty rather than wedging every caller.
	writeFileSync(join(directory, "100"), "");
	expect(host.ledger()).toEqual({ version: 100, admissions: [] });
});

test("expired admissions do not count, wherever they sit in the ledger", async () => {
	const directory = tempDir();
	const now = 10 * RECENT_MS;
	const host = fileHost(directory, () => now);
	const ages = [RECENT_MS, 1, RECENT_MS + 1, 2];
	host.publish(
		host.ledger(),
		ages.map((age, i) => ({ id: String(i), at: now - age })),
	);
	const events: string[] = [];
	await admit({ load: 3, memory: 1 }, testHost(directory, { now, load: 0, memory: Infinity }, events), signal);
	// Two recent admissions plus load 0 stays under 3, so this one starts at once.
	expect(events).toEqual([]);
	expect(host.ledger().admissions.map(({ id }) => id)).toEqual(["1", "3", expect.any(String)]);
});

test("a backward clock step dates future admissions now, and they expire a minute later", async () => {
	const directory = tempDir();
	const state = { now: RECENT_MS, load: 0, memory: Infinity };
	const host = testHost(directory, state);
	// Admitted just before the clock stepped back by ten minutes.
	host.publish(host.ledger(), [{ id: "before", at: state.now + 10 * RECENT_MS }]);
	const events: string[] = [];
	await admit({ load: 1, memory: 1 }, testHost(directory, state, events), signal);
	// It still spaces the next admission, from the step rather than from the future.
	expect(events).toEqual([`sleep ${SETTLE_MS}`]);
	expect(host.ledger().admissions).toEqual([
		{ id: "before", at: RECENT_MS },
		{ id: expect.any(String), at: RECENT_MS + SETTLE_MS, ...me },
	]);
	state.now += RECENT_MS + SETTLE_MS;
	events.length = 0;
	await admit({ load: 1, memory: 1 }, testHost(directory, state, events), signal);
	expect(events).toEqual([]);
});

test("a forward clock step forgets at most the last minute of admissions", async () => {
	const directory = tempDir();
	const state = { now: 0, load: 0, memory: Infinity };
	const limits = { load: 1, memory: 1 };
	await admit(limits, testHost(directory, state), signal);
	state.now += 10 * RECENT_MS;
	const events: string[] = [];
	// The step expires the earlier admission early, so this one starts at once…
	await admit(limits, testHost(directory, state, events), signal);
	expect(events).toEqual([]);
	// …but admissions after the step count and space as usual.
	await admit(limits, testHost(directory, state, events), signal);
	expect(events).toEqual([`sleep ${SETTLE_MS}`]);
});

test("concurrent processes never admit past the headroom, and admit every caller", { timeout: 30_000 }, async () => {
	const directory = tempDir();
	const ledger = join(directory, "ledger");
	const go = join(directory, "go");
	const gate = fileURLToPath(new URL("../src/cli/gate.ts", import.meta.url));
	// Each caller waits for the others, then races for one of 4 CPUs' headroom. Their shared clock
	// runs 20 times faster from the start, so spacing the other 8 takes seconds rather than a minute.
	// The last version a caller publishes ends with its own admission, which it reports.
	const script = `
		const { existsSync, readFileSync } = await import("node:fs");
		const { admit, fileHost } = await import(${JSON.stringify(gate)});
		console.log("ready");
		while (!existsSync(${JSON.stringify(go)})) await new Promise((resolve) => setTimeout(resolve, 2));
		const start = Number(readFileSync(${JSON.stringify(go)}, "utf8"));
		const file = fileHost(${JSON.stringify(ledger)}, () => start + (Date.now() - start) * 20);
		let admission;
		const host = {
			...file,
			load: () => 0,
			memory: () => Infinity,
			publish: (base, admissions) => file.publish(base, admissions) && Boolean((admission = admissions.at(-1))),
			sleep: (ms, signal) => file.sleep(ms / 20, signal),
		};
		await admit({ load: 4, memory: 1 }, host, new AbortController().signal);
		console.log(JSON.stringify(admission));
	`;
	const callers = Array.from({ length: 12 }, () => {
		const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
		let stdout = "";
		child.stdout.setEncoding("utf8");
		const ready = new Promise<void>((resolve) =>
			child.stdout.on("data", (data: string) => {
				stdout += data;
				if (stdout.includes("ready\n")) resolve();
			}),
		);
		return { ready, exited: once(child, "exit").then(([code]) => ({ code, stdout })) };
	});
	await Promise.all(callers.map(({ ready }) => ready));
	writeFileSync(`${go}.tmp`, String(Date.now()));
	renameSync(`${go}.tmp`, go);
	const results = await Promise.all(callers.map(({ exited }) => exited));
	expect(results.map(({ code }) => code)).toEqual(Array(12).fill(0));
	const admissions: { id: string; at: number }[] = results
		.map(({ stdout }) => JSON.parse(stdout.split("\n")[1]))
		.sort((a, b) => a.at - b.at);
	expect(new Set(admissions.map(({ id }) => id)).size).toBe(12);
	// However slowly the callers arrive, one that finds 4 admissions from the last minute
	// comes SETTLE_MS after the previous one.
	admissions.forEach(({ at }, i) => {
		const recent = admissions.slice(0, i).filter((previous) => previous.at > at - RECENT_MS);
		if (recent.length >= 4) expect(at - admissions[i - 1].at).toBeGreaterThanOrEqual(SETTLE_MS);
	});
	// The ledger holds only those admissions, up to the last.
	const recorded = fileHost(ledger).ledger().admissions;
	expect(admissions).toEqual(expect.arrayContaining(recorded));
	expect(recorded).toContainEqual(admissions.at(-1));
});

test.each(["v1", "v2"])("Linux memory counts reclaimable cache and bounds %s container headroom", (version) => {
	const proc = tempDir();
	const cgroups = tempDir();
	mkdirSync(join(proc, "self"));
	writeFileSync(
		join(proc, "meminfo"),
		`MemTotal: ${(64 * GiB) / 1024} kB\nMemFree: 1024 kB\nMemAvailable: ${(24 * GiB) / 1024} kB\n`,
	);
	const unified = version === "v2";
	writeFileSync(join(proc, "self/cgroup"), unified ? "0::/container/child\n" : "3:memory:/container/child\n");
	const root = unified ? cgroups : join(cgroups, "memory");
	const container = join(root, "container");
	const child = join(container, "child");
	mkdirSync(child, { recursive: true });
	const limit = unified ? "memory.max" : "memory.limit_in_bytes";
	const usage = unified ? "memory.current" : "memory.usage_in_bytes";
	const cache = unified ? "inactive_file" : "total_inactive_file";
	writeFileSync(join(child, limit), unified ? "max" : String(128 * GiB));
	writeFileSync(join(child, usage), String(GiB));
	expect(linuxMemory(proc, cgroups)).toEqual({ total: 64 * GiB, available: 24 * GiB });
	// The child is unlimited, but shares an almost-full 8 GiB parent budget.
	writeFileSync(join(container, limit), String(8 * GiB));
	writeFileSync(join(container, usage), String(8 * GiB - GiB / 4));
	expect(linuxMemory(proc, cgroups)).toEqual({ total: 8 * GiB, available: GiB / 4 });
	// Inactive file cache inside the budget is reclaimable, so it counts as available.
	writeFileSync(join(container, "memory.stat"), `active_file 1\n${cache} ${6 * GiB}\nanon 2\n`);
	expect(linuxMemory(proc, cgroups)).toEqual({ total: 8 * GiB, available: 6 * GiB + GiB / 4 });
	writeFileSync(join(container, "memory.stat"), `${cache} 0\n`);
	writeFileSync(join(container, usage), String(9 * GiB));
	expect(linuxMemory(proc, cgroups).available).toBe(0);
});

test("Linux memory reads the container cgroup mounted as the root", () => {
	const proc = tempDir();
	const cgroups = tempDir();
	mkdirSync(join(proc, "self"));
	writeFileSync(join(proc, "meminfo"), `MemTotal: ${(64 * GiB) / 1024} kB\nMemAvailable: ${(24 * GiB) / 1024} kB\n`);
	writeFileSync(join(cgroups, "memory.max"), String(8 * GiB));
	writeFileSync(join(cgroups, "memory.current"), String(2 * GiB));
	const limited = { total: 8 * GiB, available: 6 * GiB };
	// With a cgroup namespace, the container's own cgroup is `/`.
	writeFileSync(join(proc, "self/cgroup"), "0::/\n");
	expect(linuxMemory(proc, cgroups)).toEqual(limited);
	// Without one, the host path is absent below the bind-mounted container cgroup.
	writeFileSync(join(proc, "self/cgroup"), "0::/system.slice/docker-abc.scope\n");
	expect(linuxMemory(proc, cgroups)).toEqual(limited);
	// A cgroup outside the namespace is not mounted, so nothing visible bounds it.
	writeFileSync(join(proc, "self/cgroup"), "0::/../sibling\n");
	expect(linuxMemory(proc, cgroups)).toEqual({ total: 64 * GiB, available: 24 * GiB });
});

test("every caller on this host shares one ledger, whatever its environment or sessions", () => {
	// A home directory shared between machines keeps each host's admissions apart.
	expect(claimDirectory("/home/u", "a")).toBe(join("/home/u", ".cache", "quest", "admissions", "a"));
	expect(claimDirectory("/home/u", "b")).not.toBe(claimDirectory("/home/u", "a"));
	// A login session's runtime directory comes and goes; an overridden HOME is still this
	// account. Runtimes may read both once at startup, so each caller is a new process.
	const gate = fileURLToPath(new URL("../src/cli/gate.ts", import.meta.url));
	const script = `const { claimDirectory } = await import(${JSON.stringify(gate)}); console.log(claimDirectory());`;
	const directory = (env: NodeJS.ProcessEnv) =>
		spawnSync(process.execPath, ["-e", script], {
			env: { ...process.env, ...env },
			encoding: "utf8",
		}).stdout.trim();
	const shared = claimDirectory();
	expect(directory({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe(shared);
	expect(directory({ XDG_RUNTIME_DIR: undefined })).toBe(shared);
	expect(directory({ HOME: tempDir() })).toBe(shared);
});

// An account missing from the user database has a UID, which Windows lacks.
test.skipIf(process.platform === "win32")("an account without a home shares a private directory by UID", () => {
	const uid = process.getuid!();
	const tmp = tempDir();
	const root = join(tmp, `quest-${uid}`);
	expect(claimDirectory(null, "a", uid, tmp)).toBe(join(root, "admissions", "a"));
	expect(statSync(root).mode & 0o777).toBe(0o700);
	expect(claimDirectory(null, "a", uid, tmp)).toBe(join(root, "admissions", "a"));
	// Another user may create the name first, writable by them or owned by them.
	chmodSync(root, 0o777);
	expect(() => claimDirectory(null, "a", uid, tmp)).toThrow("only UID");
	chmodSync(root, 0o700);
	expect(() => claimDirectory(null, "a", uid + 1, tmp)).toThrow("only UID");
	// Or point it elsewhere.
	const elsewhere = tempDir();
	symlinkSync(root, join(elsewhere, `quest-${uid}`));
	expect(() => claimDirectory(null, "a", uid, elsewhere)).toThrow("only UID");
});

test("cancelling a waiting caller rejects admission", async () => {
	const controller = new AbortController();
	const file = fileHost(tempDir());
	// A build still runs, so the load is the gate's to wait out.
	file.publish(file.ledger(), [{ id: "build", at: 0, ...me }]);
	const busy: Host = {
		...file,
		load: () => 9,
		sleep: async () => controller.abort(new Error("cancelled")),
	};
	await expect(admit({ load: 1, memory: 1 }, busy, controller.signal)).rejects.toThrow("cancelled");
});

/** A cancellation the test drives: `stop` asks the command to stop, and `kill` stops it outright. */
function cancellation() {
	const stop = new AbortController();
	const kill = new AbortController();
	return { stop, kill, cancel: { signal: stop.signal, kill: kill.signal } };
}

test("a command runs in place with the given environment and its exact exit status", async () => {
	const script = "process.exit(process.env.QUEST_GATE_ADMITTED === '1' ? 7 : 1)";
	const env = { ...process.env, QUEST_GATE_ADMITTED: "1" };
	expect(await direct([process.execPath, "-e", script], env, cancellation().cancel)).toBe(7);
});

test("a nested gate runs at once and keeps the exact exit status", async () => {
	// A gated recipe that calls another one must not wait for admission twice.
	vi.stubEnv("QUEST_GATE_ADMITTED", "1");
	expect(await gate([process.execPath, "-e", "process.exit(23)"])).toBe(23);
});

// Bun 1.4.2 marked the gate's own piped output O_NONBLOCK, a flag its command shares, and uv
// aborts on the EAGAIN that follows (astral-sh/uv#22170). Bun 1.4.4 clears it before spawning.
test.runIf(process.platform === "linux")("a gated command's piped output blocks", () => {
	const O_NONBLOCK = 0o4000;
	const fds = ["/proc/self/fdinfo/1", "/proc/self/fdinfo/2"];
	const result = spawnSync(process.execPath, [config, bin, "gate", "--", "grep", "-h", "^flags:", ...fds], {
		env: { ...process.env, QUEST_GATE_ADMITTED: "1" },
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
	});
	expect(result.status, result.stderr).toBe(0);
	const flags = result.stdout
		.trim()
		.split("\n")
		.map((line) => parseInt(line.split(/\s+/)[1]!, 8));
	expect(flags).toHaveLength(2);
	for (const flag of flags) expect(flag & O_NONBLOCK).toBe(0);
});

test("a command cancelled before listener registration still stops", async () => {
	const { stop, cancel } = cancellation();
	stop.abort();
	const result = await direct([process.execPath, "-e", "setInterval(() => {}, 1000)"], process.env, cancel);
	expect(result).not.toBe(0);
});

// Windows has no POSIX signals to forward; kill() always terminates there.
test.skipIf(process.platform === "win32")("cancellation forwards the received signal to the command", async () => {
	const { stop, cancel } = cancellation();
	stop.abort("SIGHUP");
	const result = await direct([process.execPath, "-e", "setInterval(() => {}, 1000)"], process.env, cancel);
	expect(result).toBe(128 + constants.signals.SIGHUP);
});

test("a nested call, or one inside a Quest scope, leaves its command to the enclosing owner", () => {
	const dir = tempDir();
	const slice = "/user.slice/user-1000.slice/user@1000.service/app.slice";
	const cgroup = (path: string) => {
		const file = join(dir, path.replaceAll("/", "_"));
		writeFileSync(file, `0::${slice}/${path}\n`);
		return file;
	};
	const unit = "quest-worktree-0f18849e-1c60-4b6e-9d2a-7a1c2b3d4e5f.scope";
	const terminal = cgroup("app-terminal-42.scope");
	const worktree = cgroup(unit);
	const gated = cgroup("quest-gate-0f18849e-1c60-4b6e-9d2a-7a1c2b3d4e5f.scope");
	// A gate's child cgroup, and one a gate inside it made, stay in the scope.
	const child = cgroup(`${unit}/quest-gate-1a2b/quest-gate-3c4d`);
	expect(questScope(worktree)).toEqual({ unit, group: `/sys/fs/cgroup${slice}/${unit}` });
	expect(questScope(gated)?.unit).toBe("quest-gate-0f18849e-1c60-4b6e-9d2a-7a1c2b3d4e5f.scope");
	expect(questScope(child)).toEqual({
		unit,
		group: `/sys/fs/cgroup${slice}/${unit}/quest-gate-1a2b/quest-gate-3c4d`,
	});
	expect(questScope(terminal)).toBeUndefined();
	expect(questScope(cgroup(`${unit}-not`))).toBeUndefined();
	if (process.platform === "win32") return expect(owner({ QUEST_GATE_ADMITTED: "1" }).run).toBe(direct);
	// The enclosing owner signals the command too unless it was not one of Quest's.
	expect(owner({ QUEST_GATE_ADMITTED: "1" }, terminal)).toEqual({ run: direct });
	expect(owner({ QUEST_GATE_ADMITTED: "1", QUEST_GATE_GROUP: "1" }, terminal)).toEqual({ run: inside });
	if (process.platform !== "linux") return;
	expect(owner({ QUEST_GATE_ADMITTED: "1" }, gated)).toEqual({ run: inside });
	expect(owner({ QUEST_GATE_ADMITTED: "1" }, child)).toEqual({ run: inside });
	// An unadmitted call runs beside the enclosing scope, not inside it, in a scope the gate names.
	const beside = owner({}, worktree);
	expect([direct, inside]).not.toContain(beside.run);
	expect(beside.unit).toMatch(/^quest-gate-[0-9a-f-]+\.scope$/);
});

/** Gone, or a zombie its new parent has not reaped yet: either way it runs no code. */
function stopped(pid: number): boolean {
	const ps = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
	return ps.status !== 0 || ps.stdout.trim().startsWith("Z");
}

async function until(done: () => boolean, what: string) {
	for (let tries = 0; !done(); tries++) {
		if (tries === 200) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** A command that starts a descendant which outlives it unless owned, recording its PID. */
function descendant(dir: string, rest: string, { leave = false } = {}) {
	const pid = join(dir, "descendant");
	// A descendant that leaves its process group starts a new session, as a daemon would.
	const start = leave
		? `${JSON.stringify(process.execPath)} -e "const c = require('node:child_process').spawn('sleep', ['1000'], { detached: true, stdio: 'ignore' }); c.unref(); process.stdout.write(String(c.pid))"`
		: "sleep 1000 & echo $!";
	return {
		command: ["/bin/sh", "-c", `${start} > ${JSON.stringify(pid)}; ${rest}`],
		pid: () => Number(readFileSync(pid, "utf8")),
	};
}

/** A systemd scope owner with a new unit, as the gate names one. */
const scoped: Owner = (command, env, cancel) => scope(`quest-gate-${randomUUID()}.scope`)(command, env, cancel);

const owners: [string, Owner][] =
	process.platform === "linux"
		? [
				["a systemd scope", scoped],
				["a process group", group],
			]
		: process.platform === "win32"
			? []
			: [["a process group", group]];

const bin = fileURLToPath(new URL("../src/cli/bin.ts", import.meta.url));
// Bun reads the checkout's config only from its working directory, which Just changes.
const config = `--config=${fileURLToPath(new URL("../bunfig.toml", import.meta.url))}`;
const quote = (word: string) => JSON.stringify(word);

/** Just runs `recipe` in `dir`, from a justfile holding only that recipe. */
function just(dir: string, recipe: string): string[] {
	const justfile = join(dir, "justfile");
	writeFileSync(justfile, `phase:\n    ${recipe}\n`);
	return ["just", "--justfile", justfile, "--working-directory", dir, "phase"];
}

/**
 * A check's phase: Just runs a Bash script that traps SIGTERM and SIGHUP, which runs `leaf` under
 * GNU time. Bash runs a trap only once its foreground command ends, and GNU time dies on either
 * signal without forwarding it, so only a signal delivered to every layer reaches the leaf.
 */
function phase(dir: string, leaf: string): string[] {
	const script = join(dir, "phase.sh");
	writeFileSync(
		script,
		`trap 'exit 143' TERM\ntrap 'exit 129' HUP\ncommand time -o /dev/null ${quote(process.execPath)} ${quote(leaf)}\n`,
	);
	return just(dir, `bash ${quote(script)}`);
}

describe.each(owners)("an owner using %s", (_name, run) => {
	test("keeps the exact exit status and stops descendants left behind", { timeout: 30_000 }, async () => {
		const { command, pid } = descendant(tempDir(), "exit 7");
		expect(await run(command, process.env, cancellation().cancel)).toBe(7);
		await until(() => stopped(pid()), "the orphan to stop");
	});

	test("cancelling stops a grandchild", { timeout: 30_000 }, async () => {
		const dir = tempDir();
		const ready = join(dir, "ready");
		const { command, pid } = descendant(dir, `: > ${JSON.stringify(ready)}; wait`);
		const { stop, cancel } = cancellation();
		const result = run(command, process.env, cancel);
		await until(() => existsSync(ready), "the command to start");
		stop.abort("SIGTERM");
		expect(await result).toBe(128 + constants.signals.SIGTERM);
		await until(() => stopped(pid()), "the grandchild to stop");
	});

	for (const name of ["SIGTERM", "SIGHUP"] as const)
		test(`${name} reaches a phase under Just, a trapping Bash, and GNU time`, { timeout: 30_000 }, async () => {
			const dir = tempDir();
			const leaf = signalled(dir, ["SIGTERM", "SIGHUP"], 200);
			const { stop, cancel } = cancellation();
			const result = run(phase(dir, leaf.script), process.env, cancel);
			await created(leaf.ready);
			stop.abort(name);
			// The leaf runs until signalled, so a gate that left it running never returns.
			expect(await result).toBe(128 + constants.signals[name]);
			expect(leaf.log()).toEqual([name]);
			await until(() => stopped(leaf.pid()), "the leaf to stop");
		});

	test("lets a cancelled phase finish its cleanup after its wrappers exit", { timeout: 30_000 }, async () => {
		const dir = tempDir();
		const leaf = signalled(dir, ["SIGTERM"], 200);
		const { stop, cancel } = cancellation();
		const result = run(phase(dir, leaf.script), process.env, cancel);
		await created(leaf.ready);
		stop.abort("SIGTERM");
		expect(await result).toBe(128 + constants.signals.SIGTERM);
		expect(existsSync(leaf.done)).toBe(true);
	});

	test("a second signal kills a phase still cleaning up", { timeout: 30_000 }, async () => {
		const dir = tempDir();
		const leaf = signalled(dir, ["SIGTERM"]);
		const { stop, kill, cancel } = cancellation();
		const result = run(phase(dir, leaf.script), process.env, cancel);
		await created(leaf.ready);
		stop.abort("SIGTERM");
		await created(leaf.received);
		kill.abort();
		// Signalled, whether Just exited on the first signal or the second killed it.
		expect(await result).toBeGreaterThan(128);
		await until(() => stopped(leaf.pid()), "the leaf to stop");
	});

	for (const name of ["SIGTERM", "SIGHUP"] as const)
		test(
			`delivers ${name} once to a command under a nested gate, without killing it`,
			{ timeout: 30_000 },
			async () => {
				const dir = tempDir();
				const leaf = signalled(dir, [name], 200);
				const { stop, cancel } = cancellation();
				const env = { ...process.env, QUEST_GATE_ADMITTED: "1" };
				// Just also forwards SIGTERM to its own child, the nested gate, on top of the owner's.
				const nested = [process.execPath, config, bin, "gate", process.execPath, leaf.script]
					.map(quote)
					.join(" ");
				const result = run(just(dir, nested), env, cancel);
				await created(leaf.ready);
				stop.abort(name);
				expect(await result).toBe(128 + constants.signals[name]);
				expect(leaf.log()).toEqual([name]);
				// The leaf finished its own cleanup: neither gate killed it.
				expect(existsSync(leaf.done)).toBe(true);
			},
		);

	test("killing stops a command that ignores the request", { timeout: 30_000 }, async () => {
		const dir = tempDir();
		const ready = join(dir, "ready");
		const { command, pid } = descendant(dir, `trap '' TERM; : > ${JSON.stringify(ready)}; wait`);
		const { stop, kill, cancel } = cancellation();
		const result = run(command, process.env, cancel);
		await until(() => existsSync(ready), "the command to start");
		stop.abort("SIGTERM");
		kill.abort();
		expect(await result).not.toBe(0);
		await until(() => stopped(pid()), "the grandchild to stop");
	});
});

/**
 * Just, as a recipe like `[script("quest", "gate", "--", "bash")]` has it, runs an outermost gate
 * that owns `command` through a process group, as on macOS or Linux without a systemd user
 * manager: a Bun script that follows its own signals as `quest gate` does, short of admission, and
 * creates `handled-<n>` once it has handled its nth signal. Just leads a process group of its own,
 * as under a terminal or a CI runner.
 */
function outermostUnderJust(dir: string, command: string[]) {
	const script = join(dir, "outermost.ts");
	const pid = join(dir, "gate");
	const gate = fileURLToPath(new URL("../src/cli/gate.ts", import.meta.url));
	const interrupt = fileURLToPath(new URL("../src/cli/interrupt.ts", import.meta.url));
	writeFileSync(
		script,
		`import { writeFileSync } from "node:fs";
		import { group } from ${JSON.stringify(gate)};
		import { cancelled, interrupts } from ${JSON.stringify(interrupt)};
		const cancel = interrupts();
		let handled = 0;
		for (const name of ["SIGINT", "SIGTERM", "SIGHUP"])
			process.on(name, () => writeFileSync(${JSON.stringify(dir)} + "/handled-" + ++handled, ""));
		writeFileSync(${JSON.stringify(pid)}, String(process.pid));
		const status = await group(${JSON.stringify(command)}, process.env, cancel);
		cancel.close();
		process.exit(cancel.signal.aborted ? cancelled(cancel.signal) : status);`,
	);
	const env = { ...process.env };
	delete env.QUEST_GATE_ADMITTED;
	delete env.QUEST_GATE_GROUP;
	const [file, ...args] = just(dir, [process.execPath, config, script].map(quote).join(" "));
	const child = spawn(file, args, { env, stdio: "inherit", detached: true });
	return {
		/** Signal Just alone, which forwards SIGTERM to the gate. */
		just: (name: NodeJS.Signals) => process.kill(child.pid!, name),
		/** Signal the gate alone. */
		gate: (name: NodeJS.Signals) => process.kill(Number(readFileSync(pid, "utf8")), name),
		/** Signal Just's whole process group, which holds the gate too. */
		group: (name: NodeJS.Signals) => process.kill(-child.pid!, name),
		/** Resolves once the gate has handled its nth signal. */
		handled: (n: number) => created(join(dir, `handled-${n}`)),
		exited: once(child, "exit"),
	};
}

describe.skipIf(process.platform === "win32")("an outermost gate owning a process group under Just", () => {
	test(
		"takes Just's copy of a SIGTERM it already handled as the same cancellation",
		{ timeout: 30_000 },
		async () => {
			const dir = tempDir();
			const leaf = signalled(dir, ["SIGTERM"], 200);
			const run = outermostUnderJust(dir, [process.execPath, leaf.script]);
			await created(leaf.ready);
			// A SIGTERM to Just's process group reaches the gate directly and again through Just, whose
			// copy may come only after the gate handled the first.
			run.gate("SIGTERM");
			await run.handled(1);
			run.just("SIGTERM");
			await run.handled(2);
			await run.exited;
			expect(leaf.log()).toEqual(["SIGTERM"]);
			// The leaf finished its own cleanup: the gate did not take Just's copy as a second signal.
			expect(existsSync(leaf.done)).toBe(true);
		},
	);

	test(
		"lets the command finish its cleanup after a SIGTERM to Just's process group",
		{ timeout: 30_000 },
		async () => {
			const dir = tempDir();
			const leaf = signalled(dir, ["SIGTERM"], 200);
			const run = outermostUnderJust(dir, [process.execPath, leaf.script]);
			await created(leaf.ready);
			run.group("SIGTERM");
			await run.exited;
			expect(leaf.log()).toEqual(["SIGTERM"]);
			expect(existsSync(leaf.done)).toBe(true);
		},
	);

	test("a SIGTERM beyond Just's copy kills a command still cleaning up", { timeout: 30_000 }, async () => {
		const dir = tempDir();
		const leaf = signalled(dir, ["SIGTERM"]);
		const run = outermostUnderJust(dir, [process.execPath, leaf.script]);
		await created(leaf.ready);
		run.gate("SIGTERM");
		await run.handled(1);
		run.just("SIGTERM");
		await run.handled(2);
		run.gate("SIGTERM");
		await run.exited;
		await until(() => stopped(leaf.pid()), "the leaf to stop");
	});

	test(
		"a repeated SIGINT, which Just does not forward, kills a command still cleaning up",
		{ timeout: 30_000 },
		async () => {
			const dir = tempDir();
			const leaf = signalled(dir, ["SIGINT"]);
			const run = outermostUnderJust(dir, [process.execPath, leaf.script]);
			await created(leaf.ready);
			run.group("SIGINT");
			await run.handled(1);
			run.group("SIGINT");
			await run.exited;
			await until(() => stopped(leaf.pid()), "the leaf to stop");
		},
	);
});

describe.runIf(process.platform === "linux")("a systemd scope", () => {
	test("also stops a descendant that left its process group", { timeout: 30_000 }, async () => {
		const { command, pid } = descendant(tempDir(), "exit 3", { leave: true });
		expect(await scoped(command, process.env, cancellation().cancel)).toBe(3);
		await until(() => stopped(pid()), "the daemon to stop");
	});

	test("reports its CPU use to the gate until it ends", { timeout: 30_000 }, async () => {
		const host = fileHost(tempDir());
		const unit = `quest-gate-${randomUUID()}.scope`;
		const done = join(tempDir(), "done");
		expect(host.usage(unit)).toBeUndefined();
		const spin = ["/bin/sh", "-c", `while [ ! -e ${quote(done)} ]; do :; done`];
		const result = scope(unit)(spin, process.env, cancellation().cancel);
		await until(() => (host.usage(unit) ?? 0) > 0, "the scope's CPU use to show");
		writeFileSync(done, "");
		expect(await result).toBe(0);
		await until(() => host.usage(unit) === undefined, "systemd to remove the scope");
	});
});

/**
 * Run a Bun script that picks the gate's owner in a scope started by `launch`, outside any admitted
 * command, and reports which one it picked; with `run`, it also runs a command through that owner
 * that leaves a descendant behind and reports what became of it.
 */
async function insideScope(launch: (command: string[], env: NodeJS.ProcessEnv) => Promise<number>, run: boolean) {
	const dir = tempDir();
	const script = join(dir, "inside.ts");
	const result = join(dir, "result.json");
	const gate = fileURLToPath(new URL("../src/cli/gate.ts", import.meta.url));
	writeFileSync(
		script,
		`import { spawnSync } from "node:child_process";
		import { existsSync, readFileSync, writeFileSync } from "node:fs";
		import { direct, group, inside, job, owner } from ${JSON.stringify(gate)};
		const dir = ${JSON.stringify(dir)};
		const { run: own, unit } = owner(process.env);
		const kind = unit ? "scope" : new Map([[direct, "direct"], [group, "group"], [inside, "inside"], [job, "job"]]).get(own);
		let report = { kind };
		if (${run}) {
			const never = new AbortController().signal;
			const command = "cat /proc/self/cgroup > " + dir + "/cgroup; systemctl --user show --property=BindsTo --value " + unit + " > " + dir + "/binds; sleep 1000 & echo $! > " + dir + "/pid; exit 7";
			const status = await own(["/bin/sh", "-c", command], process.env, { signal: never, kill: never });
			const path = readFileSync(dir + "/cgroup", "utf8").trim().slice(3);
			const pid = readFileSync(dir + "/pid", "utf8").trim();
			const ps = spawnSync("ps", ["-o", "stat=", "-p", pid], { encoding: "utf8" });
			const stopped = ps.status !== 0 || ps.stdout.trim().startsWith("Z");
			const binds = readFileSync(dir + "/binds", "utf8").trim();
			report = { kind, status, path, binds, stopped, removed: !existsSync("/sys/fs/cgroup" + path) };
		}
		writeFileSync(${JSON.stringify(result)}, JSON.stringify(report));`,
	);
	const env = { ...process.env };
	delete env.QUEST_GATE_ADMITTED;
	expect(await launch([process.execPath, script], env)).toBe(0);
	return JSON.parse(readFileSync(result, "utf8"));
}

describe.runIf(process.platform === "linux")("a gate inside a Quest scope", () => {
	test("runs its command in a background scope beside the enclosing one", { timeout: 30_000 }, async () => {
		const report = await insideScope((command, env) => scoped(command, env, cancellation().cancel), true);
		expect(report).toMatchObject({ kind: "scope", status: 7, stopped: true, removed: true });
		// Bound to the enclosing scope, a gate's scope here, so that scope's owner stops it too.
		expect(report.binds).toMatch(/^quest-gate-[0-9a-f-]+\.scope$/);
		// A sibling, so only the gated command yields the CPU, not the rest of the enclosing scope.
		expect(report.path).toMatch(/\/background\.slice\/quest-gate-[0-9a-f-]+\.scope$/);
	});

	test("is stopped when the enclosing scope's owner kills it", { timeout: 30_000 }, async () => {
		const dir = tempDir();
		const ready = join(dir, "ready");
		const pid = join(dir, "pid");
		// Ignoring SIGTERM, it outlives the forwarded signal, so only the bound scope's stop ends it.
		const command = [
			"/bin/sh",
			"-c",
			`trap '' TERM; sleep 1000 & echo $! > ${quote(pid)}; : > ${quote(ready)}; wait`,
		];
		const { stop, kill, cancel } = cancellation();
		const result = scoped(nestedGate(dir, command), outside(), cancel);
		await until(() => existsSync(ready), "the command to start");
		stop.abort("SIGTERM");
		kill.abort();
		await result;
		// The enclosing run resolves only once the bound scope is empty too.
		expect(stopped(Number(readFileSync(pid, "utf8")))).toBe(true);
	});

	/**
	 * A Bun script that runs `command` through the owner a gate picks, outside any admitted command,
	 * and exits with its status. It follows its own signals as the gate does, unless `abort` names a
	 * file whose creation makes it cancel the run itself, without a signal.
	 */
	function nestedGate(dir: string, command: string[], abort?: string): string[] {
		const script = join(dir, "nested.ts");
		const gate = fileURLToPath(new URL("../src/cli/gate.ts", import.meta.url));
		const interrupt = fileURLToPath(new URL("../src/cli/interrupt.ts", import.meta.url));
		writeFileSync(
			script,
			`import { existsSync } from "node:fs";
			import { direct, inside, owner } from ${JSON.stringify(gate)};
			import { cancelled, interrupts } from ${JSON.stringify(interrupt)};
			const { run: own } = owner(process.env);
			if (own === direct || own === inside) process.exit(90);
			const signals = interrupts();
			const stop = new AbortController();
			const abort = ${JSON.stringify(abort ?? null)};
			const cancel = abort ? { signal: stop.signal, kill: new AbortController().signal } : signals;
			if (abort) {
				const poll = setInterval(() => {
					if (!existsSync(abort)) return;
					clearInterval(poll);
					stop.abort(new Error("cancelled by its caller"));
				}, 25);
			}
			const status = await own(${JSON.stringify(command)}, process.env, cancel);
			signals.close();
			process.exit(cancel.signal.aborted ? cancelled(cancel.signal) : status);`,
		);
		return [process.execPath, script];
	}

	const outside = () => {
		const env = { ...process.env };
		delete env.QUEST_GATE_ADMITTED;
		return env;
	};

	test("lets a phase finish its cleanup once the enclosing scope signals it", { timeout: 30_000 }, async () => {
		const dir = tempDir();
		const leaf = signalled(dir, ["SIGTERM"], 200);
		const { stop, cancel } = cancellation();
		const result = scoped(nestedGate(dir, phase(dir, leaf.script)), outside(), cancel);
		await created(leaf.ready);
		stop.abort("SIGTERM");
		expect(await result).toBe(128 + constants.signals.SIGTERM);
		// Delivered once, by the enclosing scope, and the nested gate did not kill the leaf once Just exited.
		expect(leaf.log()).toEqual(["SIGTERM"]);
		expect(existsSync(leaf.done)).toBe(true);
	});

	test("cancelled by its caller, signals every process in its scope", { timeout: 30_000 }, async () => {
		const dir = tempDir();
		const leaf = signalled(dir, ["SIGTERM"], 200);
		const abort = join(dir, "abort");
		// The shell waits on the leaf in the background, so only a signal to the whole cgroup reaches it.
		const command = ["/bin/sh", "-c", `${quote(process.execPath)} ${quote(leaf.script)} & wait`];
		const result = scoped(nestedGate(dir, command, abort), outside(), cancellation().cancel);
		await created(leaf.ready);
		writeFileSync(abort, "");
		expect(await result).toBe(128 + constants.signals.SIGTERM);
		expect(leaf.log()).toEqual(["SIGTERM"]);
		expect(existsSync(leaf.done)).toBe(true);
	});
});

/** Whether a process is still running, on any platform. */
function running(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** A Bun command that starts a detached descendant, records its PID, then runs `rest`. */
function detached(dir: string, rest: string) {
	const pid = join(dir, "descendant");
	const start =
		"const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], " +
		"{ detached: true, stdio: 'ignore' }); c.unref(); " +
		`require('node:fs').writeFileSync(${JSON.stringify(pid)}, String(c.pid)); `;
	return {
		command: [process.execPath, "-e", start + rest],
		pid: () => Number(readFileSync(pid, "utf8")),
	};
}

describe.runIf(process.platform === "linux")("a process that exits while its stat is read", () => {
	const pid = 4242;
	const identity = { host: hostname(), pid, start: "1" };
	afterEach(() => (racing.read = undefined));

	test.each(["ENOENT", "ESRCH"])("reads as gone when the stat read fails with %s", (code) => {
		racing.read = { path: `/proc/${pid}/stat`, code };
		expect(processStart(pid)).toBeUndefined();
		expect(ownerAlive(identity)).toBe(false);
	});

	test("surfaces any other read error", () => {
		racing.read = { path: `/proc/${pid}/stat`, code: "EACCES" };
		expect(() => processStart(pid)).toThrow("EACCES");
		expect(() => ownerAlive(identity)).toThrow("EACCES");
	});
});

describe("the Windows job stub", () => {
	test("passes the exact exit status and restores the caller's environment", async () => {
		const script =
			"process.exit(process.env.BUN_BE_BUN === process.env.EXPECTED && !('QUEST_GATE_JOB' in process.env) ? 7 : 1)";
		const env: NodeJS.ProcessEnv = { ...process.env, EXPECTED: "keep" };
		delete env.BUN_BE_BUN;
		const command = [process.execPath, "-e", script];
		expect(await job(command, { ...env, BUN_BE_BUN: "keep" }, cancellation().cancel)).toBe(7);
		const unset = "process.exit(process.env.BUN_BE_BUN === undefined ? 7 : 1)";
		expect(await job([process.execPath, "-e", unset], env, cancellation().cancel)).toBe(7);
	});

	test("passes the command's arguments as running it directly would", async () => {
		// Compared with `direct`, since Bun's process.argv for a script passed with -e differs on Windows.
		const dir = tempDir();
		const args = ["a b", 'say "hi"', "back\\slash\\", ""];
		const script = "require('node:fs').writeFileSync(process.env.OUT, JSON.stringify(process.argv.slice(1)))";
		const argv = async (owner: Owner, out: string) => {
			const env = { ...process.env, OUT: join(dir, out) };
			expect(await owner([process.execPath, "-e", script, ...args], env, cancellation().cancel)).toBe(0);
			return JSON.parse(readFileSync(env.OUT, "utf8"));
		};
		const expected = await argv(direct, "direct");
		if (process.platform !== "win32") expect(expected).toEqual(args);
		expect(await argv(job, "job")).toEqual(expected);
	});

	test("reports a command that cannot start as a shell would", async () => {
		expect(await job([join(tempDir(), "missing")], process.env, cancellation().cancel)).toBe(127);
	});

	test("hands the command the caller's environment, not the working directory's .env files", async () => {
		// The stub runs as Bun in the command's directory, where Bun would load `.env` files by default.
		const dir = tempDir();
		for (const file of [".env", ".env.development", ".env.local"]) writeFileSync(join(dir, file), "LEAK=1\n");
		const out = join(dir, "env.json");
		const script = "require('node:fs').writeFileSync(process.env.OUT, JSON.stringify(process.env))";
		const env = { ...process.env, OUT: out, CALLER: "kept" };
		const cwd = process.cwd();
		process.chdir(dir);
		try {
			// The command is Bun too, so it must not load them either.
			const command = [process.execPath, "--no-env-file", "-e", script];
			expect(await job(command, env, cancellation().cancel)).toBe(0);
		} finally {
			process.chdir(cwd);
		}
		const seen = JSON.parse(readFileSync(out, "utf8"));
		expect(seen.CALLER).toBe("kept");
		expect(seen).not.toHaveProperty("LEAK");
	});
});

test("the checkout's Bun config hands a gated command no .env files from its directory", () => {
	// `bun run quest` reads bunfig.toml, which turns Bun's `.env` loading off. The built CLIs opt out
	// in their shebang and compile flags, which scripts/lifecycle-check.sh covers.
	const dir = tempDir();
	for (const file of [".env", ".env.development", ".env.local"]) writeFileSync(join(dir, file), "LEAK=1\n");
	const script = "process.stdout.write(JSON.stringify(process.env))";
	const result = spawnSync(process.execPath, [config, bin, "gate", process.execPath, "--no-env-file", "-e", script], {
		cwd: dir,
		encoding: "utf8",
		env: { ...process.env, QUEST_GATE_ADMITTED: "1", CALLER: "kept" },
	});
	expect(result.status, result.stderr).toBe(0);
	const seen = JSON.parse(result.stdout);
	expect(seen.CALLER).toBe("kept");
	expect(seen).not.toHaveProperty("LEAK");
});

describe.runIf(process.platform === "win32")("a job object", () => {
	test("is the gate's owner outside an admitted command", () => {
		expect(owner({})).toEqual({ run: job });
	});

	test("keeps the exact exit status and stops a detached descendant", { timeout: 30_000 }, async () => {
		const { command, pid } = detached(tempDir(), "process.exit(7);");
		expect(await job(command, process.env, cancellation().cancel)).toBe(7);
		await until(() => !running(pid()), "the detached descendant to stop");
	});

	test("killing stops the command and a detached descendant", { timeout: 30_000 }, async () => {
		const dir = tempDir();
		const ready = join(dir, "ready");
		const { command, pid } = detached(
			dir,
			`require('node:fs').writeFileSync(${JSON.stringify(ready)}, ''); setInterval(() => {}, 1000);`,
		);
		const { kill, cancel } = cancellation();
		const result = job(command, process.env, cancel);
		await until(() => existsSync(ready), "the command to start");
		kill.abort();
		expect(await result).not.toBe(0);
		await until(() => !running(pid()), "the detached descendant to stop");
	});
});

describe.skipIf(process.platform === "win32")("a process group", () => {
	test("delivers SIGINT once to a command under a nested gate", { timeout: 30_000 }, async () => {
		const dir = tempDir();
		const ready = join(dir, "ready");
		const count = join(dir, "count");
		const child = join(dir, "child.js");
		writeFileSync(
			child,
			`const { writeFileSync } = require("node:fs");
			let interrupts = 0;
			process.on("SIGINT", () => interrupts++);
			writeFileSync(${JSON.stringify(ready)}, "");
			setTimeout(() => writeFileSync(${JSON.stringify(count)}, String(interrupts)), 1000);`,
		);
		const { stop, cancel } = cancellation();
		const env = { ...process.env, QUEST_GATE_ADMITTED: "1" };
		const result = group([process.execPath, bin, "gate", process.execPath, child], env, cancel);
		await until(() => existsSync(ready), "the command to start");
		stop.abort("SIGINT");
		expect(await result).toBe(128 + constants.signals.SIGINT);
		expect(readFileSync(count, "utf8")).toBe("1");
	});

	test("leaves a descendant that started its own session", { timeout: 30_000 }, async () => {
		const { command, pid } = descendant(tempDir(), "exit 3", { leave: true });
		expect(await group(command, process.env, cancellation().cancel)).toBe(3);
		try {
			expect(stopped(pid())).toBe(false);
		} finally {
			process.kill(pid(), "SIGKILL");
		}
	});
});

test("a cancellation without a signal's name always passes, even on Windows", () => {
	expect(forwards(AbortSignal.abort())).toBe(true);
	expect(forwards(AbortSignal.abort(), true)).toBe(true);
});

test.skipIf(process.platform === "win32")("a signal is left to reach the child wherever it already did", () => {
	// Signals that may be sent to Quest alone pass.
	expect(forwards(AbortSignal.abort("SIGHUP"), false)).toBe(true);
	expect(forwards(AbortSignal.abort("SIGTERM"), false)).toBe(true);
	// The group owner, and a Quest scope's owner, deliver each to everything they hold.
	for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) expect(forwards(AbortSignal.abort(name), true)).toBe(false);
	vi.stubEnv("QUEST_GATE_GROUP", "1");
	expect(forwards(AbortSignal.abort("SIGTERM"))).toBe(false);
	// pid (comm with spaces) state ppid pgrp session tty_nr tpgid ...
	expect(foregroundStat("42 (a ) b) S 1 42 42 34816 42 4194560")).toBe(true);
	expect(foregroundStat("42 (a ) b) S 1 42 42 34816 77 4194560")).toBe(false);
	// No controlling terminal.
	expect(foregroundStat("42 (quest) S 1 42 42 0 -1 4194560")).toBe(false);
	expect(statProcess("42 (a ) b) S 1 7 42 34816 42 4194560")).toEqual({ name: "a ) b", group: "7" });
});

test.runIf(process.platform === "linux")("a terminal Ctrl-C reaches the gated command once", async () => {
	const child = join(tempDir(), "child.js");
	writeFileSync(
		child,
		`let interrupts = 0;
		process.on("SIGINT", () => interrupts++);
		console.log("ready");
		setTimeout(() => console.log("interrupts=" + interrupts), 1000);`,
	);
	const result = await onTerminal([process.execPath, bin, "gate", process.execPath, child], "\x03", {
		...process.env,
		QUEST_GATE_ADMITTED: "1",
	});
	expect(result.output).toContain("interrupts=1");
	expect(result.code).toBe(128 + constants.signals.SIGINT);
});

test("the gated command keeps its own flags, even ones Quest also parses", () => {
	expect(gateBoundary(["gate", "bun", "--help", "--root", "x"])).toEqual([
		"gate",
		"--",
		"bun",
		"--help",
		"--root",
		"x",
	]);
	expect(gateBoundary(["--root", "r", "gate", "ls"])).toEqual(["--root", "r", "gate", "--", "ls"]);
	expect(gateBoundary(["gate", "--help"])).toEqual(["gate", "--help"]);
	expect(gateBoundary(["check"])).toEqual(["check"]);
	// Quest's own global options may also follow the subcommand.
	expect(gateBoundary(["gate", "--root", "r", "ls"])).toEqual(["gate", "--root", "r", "--", "ls"]);
	expect(gateBoundary(["gate", "--root=r", "ls"])).toEqual(["gate", "--root=r", "--", "ls"]);
	expect(gateBoundary(["gate", "--version"])).toEqual(["gate", "--version"]);
	// Gate's own option stays Quest's; the same flag after the executable is the command's.
	expect(gateBoundary(["gate", "--quick", "ls", "--quick"])).toEqual(["gate", "--quick", "--", "ls", "--quick"]);
	expect(gateBoundary(["gate", "ls", "--host"])).toEqual(["gate", "--", "ls", "--host"]);
	expect(gateBoundary(["gate", "--root", "r", "--quick", "ls"])).toEqual([
		"gate",
		"--root",
		"r",
		"--quick",
		"--",
		"ls",
	]);
	expect(gateBoundary(["--quick", "gate", "ls"])).toEqual(["--quick", "gate", "ls"]);
});

test("gate parses --quick before its command", async () => {
	vi.stubEnv("QUEST_GATE_ADMITTED", "1");
	const out = { stdout: () => {}, stderr: () => {} };
	expect(await main(["gate", "--quick", process.execPath, "-e", "process.exit(4)"], out)).toBe(4);
});

test("global options after gate keep working", async () => {
	expect(run("gate", "--version").stdout).toMatch(/^quest /);
	vi.stubEnv("QUEST_GATE_ADMITTED", "1");
	const out = { stdout: () => {}, stderr: () => {} };
	expect(await main(["gate", "--root", ".", process.execPath, "-e", "process.exit(5)"], out)).toBe(5);
});

test("gate has command help and requires an executable", () => {
	expect(run("gate", "--help").stdout).toContain("Arguments forwarded verbatim");
	expect(run("gate").code).toBe(2);
});

test("gate rejects unknown options before the executable and forwards flags after it", () => {
	const result = run("gate", "--host", process.execPath, "-e", "process.exit(0)");
	expect(result.code).toBe(2);
	expect(result.stderr).toContain("unknown option '--host'");
	expect(gateBoundary(["gate", "--unknown", "ls"])).toEqual(["gate", "--unknown", "ls"]);
	expect(gateBoundary(["gate", "--", "-command"])).toEqual(["gate", "--", "-command"]);
});
