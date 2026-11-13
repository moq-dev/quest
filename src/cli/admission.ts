// Agent admission: a coordinator starts or resumes an agent only while the host's gate would admit
// work at once and the account's reported usage covers the agents in flight. It only delays the next
// start: agents already running are never paused or stopped.
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
	type Admission,
	type Host,
	type Limits,
	SETTLE_MS,
	type Waiting,
	claimDirectory,
	fileHost,
	hostLimits,
	processStart,
	room,
} from "./gate";

/**
 * How long an admitted agent counts against the host's headroom, as one recent admission of the
 * gate's: an agent adds no gated load until its first build. Of 263 sub-agents on one host over three
 * weeks, the 126 that gated anything reached their first gated command in a median of 133 seconds,
 * and three quarters within 265; the rest never gated, so no later event ends the count.
 */
export const PENDING_MS = 5 * 60_000;

/** One usage window an account's harness reports. */
export interface Window {
	/** The percentage of the window spent. */
	used: number;
	/** When the window resets, in epoch milliseconds. */
	resets: number;
	/** The percentage one more agent is expected to spend, from this host's sessions in the window. */
	expected: number;
}

/** What `admit` reads and writes, replaceable in tests. */
export interface AdmissionDependencies {
	limits: Limits;
	/** The gate's ledger and the host's load and memory. */
	gate: Host;
	/** The agents' ledger; only its clock, ledger, liveness, and sleep are used. */
	agents: Host;
	/** The usage windows `harness` reports for its account, or null when it reports none. */
	account(harness: string): Window[] | null;
	/** A line for the user. */
	notice(text: string): void;
}

/** The account cannot cover one more agent until `resets`, in epoch milliseconds. */
export interface Refusal {
	resets: number;
}

const waits: Record<Waiting, string> = {
	load: "the load average to fall",
	memory: "free memory",
	queue: "gated commands queued on this host to start",
};

/**
 * Wait until the host can carry one more agent of `harness`, then record it. The host has room while
 * the gate would admit a command at once (see `room`), counting each agent admitted in the last
 * PENDING_MS whose launcher, if it has one, still runs. The account has room while, in every window
 * its harness reports, the usage spent plus what this agent and the harness's agents in flight are
 * expected to spend stays within the window; in flight are the agents whose launcher still runs, and
 * those without one admitted in the last PENDING_MS. Returns null once admitted, or why the account
 * cannot cover it, which no wait here clears. A harness that reports no usage is admitted on the
 * host alone, saying so.
 *
 * `held` is the process that runs the agent, as `quest agent start` does; without it, as for a
 * coordinator's own sub-agent, nothing reports the agent's end.
 */
export async function admit(
	harness: string,
	deps: AdmissionDependencies,
	signal: AbortSignal,
	held?: number,
): Promise<Refusal | null> {
	// Decided once, at the start: a setup either reports its usage or does not.
	const windows = deps.account(harness);
	if (windows === null) deps.notice(`${harness} reports no account usage here, so only the host is checked`);
	const holder = held === undefined ? {} : { pid: held, start: processStart(held) };
	const shown = new Set<Waiting>();
	for (;;) {
		signal.throwIfAborted();
		const ledger = deps.agents.ledger();
		const now = deps.agents.now();
		const kept = ledger.admissions
			.filter((entry) => (entry.pid === undefined ? entry.at > now - PENDING_MS : deps.agents.running(entry)))
			// A clock stepped backward dates an entry in the future; count it from now instead.
			.map((entry) => (entry.at > now ? { ...entry, at: now } : entry));
		const flying = kept.filter((entry) => entry.agent === harness).length;
		const short = (windows ?? [])
			.filter((window) => window.resets > now && window.used + (flying + 1) * window.expected > 100)
			.map((window) => window.resets);
		if (short.length > 0) return { resets: Math.max(...short) };
		const pending = kept.filter((entry) => entry.at > now - PENDING_MS).length;
		const reason = room(deps.limits, deps.gate, pending);
		if (reason === null) {
			const entry: Admission = { id: randomUUID(), at: now, ...holder, agent: harness };
			if (deps.agents.publish(ledger, [...kept, entry])) return null;
			continue;
		}
		if (!shown.has(reason)) {
			shown.add(reason);
			deps.notice(`waiting for ${waits[reason]} before starting an agent`);
		}
		await deps.agents.sleep(SETTLE_MS, signal);
	}
}

/** How much of a rollout's end is read for its last usage report: a report is about a kilobyte. */
const TAIL = 256 * 1024;

/** The last `token_count` event in the last TAIL bytes of the Codex rollout at `path`, if any. */
function lastCount(path: string): { tokens: number; limits: Record<string, unknown> | null } | undefined {
	const fd = openSync(path, "r");
	let text: string;
	try {
		const size = fstatSync(fd).size;
		const buffer = Buffer.alloc(Math.min(size, TAIL));
		readSync(fd, buffer, 0, buffer.length, size - buffer.length);
		text = buffer.toString("utf8");
	} finally {
		closeSync(fd);
	}
	const lines = text.split("\n");
	for (let index = lines.length - 1; index >= 0; index--) {
		if (!lines[index].includes('"token_count"')) continue;
		let payload: Record<string, unknown> | undefined;
		try {
			payload = (JSON.parse(lines[index]) as { payload?: Record<string, unknown> }).payload;
		} catch {
			continue; // The tail's first line is cut, and a session still writing leaves its last one open.
		}
		if (payload?.type !== "token_count") continue;
		const total = (payload.info as { total_token_usage?: { total_tokens?: unknown } } | null)?.total_token_usage;
		const limits = payload.rate_limits;
		return {
			tokens: typeof total?.total_tokens === "number" ? total.total_tokens : 0,
			limits: typeof limits === "object" && limits !== null ? (limits as Record<string, unknown>) : null,
		};
	}
	return undefined;
}

/**
 * The usage windows Codex last reported for its account, from the `rate_limits` of the newest
 * session rollout in `home` that holds one, or null when none does. A window's capacity in tokens is
 * not reported, so an agent's expected share comes from the account's own history: the sessions this
 * host wrote since the window opened spent `used` between them, and an agent is expected to spend
 * the share of the session a token most likely belongs to, their token-weighted mean, since most
 * spend comes from the long sessions an agent's is. Other hosts' spend on the account raises `used`
 * without adding sessions here, which only makes the estimate more careful.
 */
export function codexAccount(home: string, now: number): Window[] | null {
	const rollouts: { path: string; modified: number }[] = [];
	const walk = (dir: string) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith(".jsonl")) rollouts.push({ path, modified: statSync(path).mtimeMs });
		}
	};
	walk(join(home, "sessions"));
	rollouts.sort((a, b) => b.modified - a.modified);
	const counts = new Map<string, ReturnType<typeof lastCount>>();
	const count = (path: string) => {
		if (!counts.has(path)) counts.set(path, lastCount(path));
		return counts.get(path);
	};
	let reported: Record<string, unknown> | undefined;
	for (const { path } of rollouts) {
		reported = count(path)?.limits ?? undefined;
		if (reported !== undefined) break;
	}
	if (reported === undefined) return null;
	const windows: Window[] = [];
	for (const name of ["primary", "secondary"]) {
		const window = reported[name] as {
			used_percent?: unknown;
			window_minutes?: unknown;
			resets_at?: unknown;
		} | null;
		if (window == null) continue;
		const { used_percent: used, window_minutes: minutes, resets_at: resets } = window;
		if (typeof used !== "number" || typeof minutes !== "number" || typeof resets !== "number")
			throw new Error(`Codex reported a ${name} usage window quest cannot read: ${JSON.stringify(window)}`);
		// A window that has reset since the report holds usage nothing here has read yet.
		if (resets * 1000 <= now) continue;
		const opened = resets * 1000 - minutes * 60_000;
		const spent = rollouts.filter(({ modified }) => modified >= opened).map(({ path }) => count(path)?.tokens ?? 0);
		const total = spent.reduce((sum, tokens) => sum + tokens, 0);
		const squares = spent.reduce((sum, tokens) => sum + tokens * tokens, 0);
		windows.push({ used, resets: resets * 1000, expected: total > 0 ? (used * squares) / (total * total) : 0 });
	}
	return windows;
}

/** The agents' ledger of this host, beside the gate's. */
const agentsDirectory = (gate: string) => join(dirname(dirname(gate)), "agents", basename(gate));

/**
 * The admission `quest agent` runs with: the host's own limits and ledgers, and each harness's own
 * report. Claude Code reports its usage windows only to an interactive session's status line, and a
 * headless turn prints none, so it has no signal to read.
 */
export function processAdmission(notice: (text: string) => void, env = process.env): AdmissionDependencies {
	const gate = claimDirectory();
	return {
		limits: hostLimits(),
		gate: fileHost(gate),
		agents: fileHost(agentsDirectory(gate)),
		account: (harness) =>
			harness === "codex" ? codexAccount(env.CODEX_HOME || join(homedir(), ".codex"), Date.now()) : null,
		notice,
	};
}

/** The admission every `quest agent` command runs, held in an object so a test can replace it. */
export const admission = { admit };
