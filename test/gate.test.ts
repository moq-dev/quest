import { spawn, spawnSync } from "node:child_process";
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
import { constants } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	admit,
	COMMAND_MEMORY,
	claimDirectory,
	direct,
	fileHost,
	gate,
	group,
	type Host,
	hostLimits,
	linuxMemory,
	type Owner,
	owner,
	RECENT_MS,
	SETTLE_MS,
	scope,
	scoped,
} from "../src/cli/gate";
import { forwards, foregroundStat } from "../src/cli/interrupt";
import { gateBoundary, main } from "../src/cli/main";
import { onTerminal, run, tempDir } from "./fixture";

const GiB = 2 ** 30;

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
	const sleep = host.sleep;
	host.sleep = async (ms, signal) => {
		await sleep(ms, signal);
		if (state.load > 4) state.load = 3;
		else state.memory = GiB;
	};
	await admit({ load: 4, memory: GiB }, host, signal, (reason) => events.push(reason));
	expect(events).toEqual(["load", `sleep ${SETTLE_MS}`, "memory", `sleep ${SETTLE_MS}`]);
	expect(host.ledger().admissions).toEqual([{ id: expect.any(String), at: 2 * SETTLE_MS }]);
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
	expect(stalled.ledger().admissions).toEqual([{ id: expect.any(String), at: SETTLE_MS }]);
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
	expect(readdirSync(directory).sort()).toEqual(["2", "live.tmp"]);
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
		{ id: expect.any(String), at: RECENT_MS + SETTLE_MS },
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
	const busy: Host = {
		...fileHost(tempDir()),
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
	expect(owner({ QUEST_GATE_ADMITTED: "1" })).toBe(direct);
	const cgroup = join(tempDir(), "cgroup");
	const slice = "0::/user.slice/user-1000.slice/user@1000.service/app.slice";
	writeFileSync(cgroup, `${slice}/quest-worktree-0f18849e-1c60-4b6e-9d2a-7a1c2b3d4e5f.scope\n`);
	expect(scoped(cgroup)).toBe(true);
	writeFileSync(cgroup, `${slice}/quest-gate-0f18849e-1c60-4b6e-9d2a-7a1c2b3d4e5f.scope\n`);
	expect(scoped(cgroup)).toBe(true);
	writeFileSync(cgroup, `${slice}/app-terminal-42.scope\n`);
	expect(scoped(cgroup)).toBe(false);
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

const owners: [string, Owner][] =
	process.platform === "linux"
		? [
				["a systemd scope", scope],
				["a process group", group],
			]
		: process.platform === "win32"
			? []
			: [["a process group", group]];

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

describe.runIf(process.platform === "linux")("a systemd scope", () => {
	test("also stops a descendant that left its process group", { timeout: 30_000 }, async () => {
		const { command, pid } = descendant(tempDir(), "exit 3", { leave: true });
		expect(await scope(command, process.env, cancellation().cancel)).toBe(3);
		await until(() => stopped(pid()), "the daemon to stop");
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
		const bin = fileURLToPath(new URL("../src/cli/bin.ts", import.meta.url));
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
	expect(forwards(AbortSignal.abort(), { QUEST_GATE_GROUP: "1" })).toBe(true);
});

test.skipIf(process.platform === "win32")("only a terminal's own SIGINT is left to reach the child", () => {
	// Signals that may be sent to Quest alone always pass.
	expect(forwards(AbortSignal.abort("SIGHUP"))).toBe(true);
	expect(forwards(AbortSignal.abort("SIGTERM"))).toBe(true);
	// The group owner already delivers a Ctrl-C to everything in its group.
	expect(forwards(AbortSignal.abort("SIGINT"), { QUEST_GATE_GROUP: "1" })).toBe(false);
	expect(forwards(AbortSignal.abort("SIGTERM"), { QUEST_GATE_GROUP: "1" })).toBe(true);
	// pid (comm with spaces) state ppid pgrp session tty_nr tpgid ...
	expect(foregroundStat("42 (a ) b) S 1 42 42 34816 42 4194560")).toBe(true);
	expect(foregroundStat("42 (a ) b) S 1 42 42 34816 77 4194560")).toBe(false);
	// No controlling terminal.
	expect(foregroundStat("42 (quest) S 1 42 42 0 -1 4194560")).toBe(false);
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
	const bin = fileURLToPath(new URL("../src/cli/bin.ts", import.meta.url));
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
