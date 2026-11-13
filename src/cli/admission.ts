// Agent admission: a coordinator starts or resumes an agent only while the host's gate would admit
// work at once and the account's reported usage covers the agents in flight. It only delays the next
// start: agents already running are never paused or stopped.
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
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
import { eachLine } from "./lines";

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

/** An account's usage as its harness last reported it. */
export interface Account {
	/** Names the account among every harness's, so its agents in flight count against it alone. */
	id: string;
	windows: Window[];
}

/** What `admit` reads and writes, replaceable in tests. */
export interface AdmissionDependencies {
	limits: Limits;
	/** The gate's ledger and the host's load and memory. */
	gate: Host;
	/** The agents' ledger; only its clock, ledger, liveness, and sleep are used. */
	agents: Host;
	/** The account `harness` runs on with its usage as of now, or null when the harness reports none. */
	account(harness: string): Account | null;
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
 * its harness reports, the usage spent plus what this agent and the account's agents in flight are
 * expected to spend stays within the window; in flight are the agents whose launcher still runs, and
 * those without one admitted in the last PENDING_MS. The usage is read afresh at every decision,
 * since agents spend it while this one waits for the host. Returns null once admitted, or why the
 * account cannot cover it, which no wait here clears. A harness that reports no usage is admitted
 * on the host alone, saying so.
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
	const first = deps.account(harness);
	if (first === null) deps.notice(`${harness} reports no account usage here, so only the host is checked`);
	const holder = held === undefined ? {} : { pid: held, start: processStart(held) };
	const shown = new Set<Waiting>();
	for (let account = first; ; account = first && deps.account(harness)) {
		signal.throwIfAborted();
		if (first !== null && account?.id !== first.id)
			throw new Error(`${harness} stopped reporting the usage of the account this admission began on`);
		const ledger = deps.agents.ledger();
		const now = deps.agents.now();
		const kept = ledger.admissions
			.filter((entry) => (entry.pid === undefined ? entry.at > now - PENDING_MS : deps.agents.running(entry)))
			// A clock stepped backward dates an entry in the future; count it from now instead.
			.map((entry) => (entry.at > now ? { ...entry, at: now } : entry));
		const id = account?.id ?? harness;
		const flying = kept.filter((entry) => entry.agent === id).length;
		const short = (account?.windows ?? [])
			.filter((window) => window.resets > now && window.used + (flying + 1) * window.expected > 100)
			.map((window) => window.resets);
		if (short.length > 0) return { resets: Math.max(...short) };
		const pending = kept.filter((entry) => entry.at > now - PENDING_MS).length;
		const reason = room(deps.limits, deps.gate, pending);
		if (reason === null) {
			const entry: Admission = { id: randomUUID(), at: now, ...holder, agent: id };
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

/** One `token_count` event of a Codex rollout: when, the session's tokens so far, and the account's windows. */
interface Count {
	at: number;
	tokens: number;
	limits: Record<string, unknown> | null;
}

/** The `token_count` event on a rollout's `line`, if it is one and whole. */
function count(line: string): Count | undefined {
	if (!line.includes('"token_count"')) return undefined;
	let event: { timestamp?: unknown; payload?: Record<string, unknown> };
	try {
		event = JSON.parse(line) as typeof event;
	} catch {
		return undefined; // A tail's first line is cut, and a session still writing leaves its last one open.
	}
	const at = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
	if (event.payload?.type !== "token_count" || Number.isNaN(at)) return undefined;
	const total = (event.payload.info as { total_token_usage?: { total_tokens?: unknown } } | null)?.total_token_usage;
	const limits = event.payload.rate_limits;
	return {
		at,
		tokens: typeof total?.total_tokens === "number" ? total.total_tokens : 0,
		limits: typeof limits === "object" && limits !== null ? (limits as Record<string, unknown>) : null,
	};
}

/** The last `token_count` event in the last TAIL bytes of the Codex rollout at `path`, if any. */
function lastCount(path: string): Count | undefined {
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
		const found = count(lines[index]);
		if (found) return found;
	}
	return undefined;
}

/** The tokens the session in the rollout at `path` had spent by `time`, from its last report before then. */
function tokensBefore(path: string, time: number): number {
	let tokens = 0;
	eachLine(path, (line) => {
		const found = count(line);
		if (found === undefined) return;
		if (found.at >= time) return false;
		tokens = found.tokens;
	});
	return tokens;
}

/**
 * What earlier reads of each rollout found, by path, so an admission that waits reads only what
 * changed: its last report as of `modified`, and its tokens before each window's opening.
 */
export type RolloutCache = Map<string, { modified: number; last: Count | undefined; before: Map<number, number> }>;

/** When a rollout's session started, from the local time its file name carries, or 0 when it has none. */
function started(path: string): number {
	const [, year, month, day, hour, minute, second] =
		/rollout-(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d)-(\d\d)-/.exec(basename(path)) ?? [];
	return year === undefined ? 0 : new Date(+year, +month - 1, +day, +hour, +minute, +second).getTime();
}

/**
 * The usage windows Codex last reported for the account logged in at `home`, from the newest
 * `rate_limits` event among its session rollouts, archived ones included, or null when none holds
 * one. A window's capacity in tokens is not reported, so an agent's expected share comes from the
 * account's own history: the sessions this host wrote since the window opened spent `used` between
 * them, counting only their tokens since then, and an agent is expected to spend the share of the
 * session a token most likely belongs to, their token-weighted mean, since most spend comes from the
 * long sessions an agent's is. Other hosts' spend on the account raises `used` without adding
 * sessions here, which only makes the estimate more careful.
 */
export function codexAccount(home: string, now: number, cache: RolloutCache = new Map()): Account | null {
	const found = new Map<string, { path: string; modified: number }>();
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
			// Archiving moves a rollout, so a scan racing it may see both copies of one session.
			else if (entry.name.endsWith(".jsonl") && !found.has(entry.name))
				found.set(entry.name, { path, modified: statSync(path).mtimeMs });
		}
	};
	walk(join(home, "sessions"));
	walk(join(home, "archived_sessions"));
	const rollouts = [...found.values()].sort((a, b) => b.modified - a.modified);
	const modifiedAt = new Map(rollouts.map(({ path, modified }) => [path, modified]));
	const read = (path: string) => {
		const modified = modifiedAt.get(path)!;
		const known = cache.get(path);
		if (known?.modified === modified) return known;
		const entry = { modified, last: lastCount(path), before: known?.before ?? new Map<number, number>() };
		cache.set(path, entry);
		return entry;
	};
	const lastOf = (path: string) => read(path).last;
	// What a session had spent by a past time never changes, however much it writes later.
	const before = (path: string, time: number) => {
		const known = cache.get(path)?.before.get(time);
		if (known !== undefined) return known;
		const tokens = tokensBefore(path, time);
		read(path).before.set(time, tokens);
		return tokens;
	};
	// A rollout written after its last report can be newer than one holding a later report, but no
	// report is newer than its file, so the search ends at the first file older than the best report.
	let reported: Count | undefined;
	for (const { path, modified } of rollouts) {
		if (reported !== undefined && modified < reported.at) break;
		const each = lastOf(path);
		if (each?.limits && (reported === undefined || each.at > reported.at)) reported = each;
	}
	if (!reported?.limits) return null;
	const windows: Window[] = [];
	for (const name of ["primary", "secondary"]) {
		const window = reported.limits[name] as {
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
		const spent = rollouts
			.filter(({ modified }) => modified >= opened)
			.map(({ path }) => {
				const total = lastOf(path)?.tokens ?? 0;
				// A session resumed across the reset spent part of its tokens in an earlier window.
				return total > 0 && started(path) < opened ? total - before(path, opened) : total;
			});
		const total = spent.reduce((sum, tokens) => sum + tokens, 0);
		const squares = spent.reduce((sum, tokens) => sum + tokens * tokens, 0);
		windows.push({ used, resets: resets * 1000, expected: total > 0 ? (used * squares) / (total * total) : 0 });
	}
	return { id: `codex ${codexIdentity(home)}`, windows };
}

/**
 * What tells one Codex account from another: the account ID its login stores in `home`, which two
 * homes logged into one account share, or the home itself for a login without one, such as an API key.
 */
function codexIdentity(home: string): string {
	let auth: { tokens?: { account_id?: unknown } | null } | null;
	try {
		auth = JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) as typeof auth;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return realpathSync(home);
	}
	const id = auth?.tokens?.account_id;
	return typeof id === "string" && id !== "" ? id : realpathSync(home);
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
	const rollouts: RolloutCache = new Map();
	return {
		limits: hostLimits(),
		gate: fileHost(gate),
		agents: fileHost(agentsDirectory(gate)),
		account: (harness) =>
			harness === "codex"
				? codexAccount(env.CODEX_HOME || join(homedir(), ".codex"), Date.now(), rollouts)
				: null,
		notice,
	};
}

/** The admission every `quest agent` command runs, held in an object so a test can replace it. */
export const admission = { admit };
