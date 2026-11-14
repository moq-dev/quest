// The waits `quest gate` and `quest wait` time for the agent session that ran them, kept on this host so a session's
// record can add them up. The harness names its session in each command's environment; nothing is logged outside one.
import { closeSync, constants, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { type SessionWait, WAIT_KINDS } from "../core";

/** A session a harness names in a command's environment. */
export interface EnvSession {
	harness: string;
	session: string;
}

/** One logged wait, with every session its environment named and the directory it ran in. */
export interface LoggedWait extends SessionWait {
	sessions: EnvSession[];
	directory: string;
}

/** Days of waits kept, beyond the longest session a record is expected to span. */
const KEEP_DAYS = 90;
const DAY = 86_400_000;

/**
 * Every session the environment names. A Claude Code sub-agent's commands carry its parent's ID, and an agent one
 * harness starts inherits the other's variable, so a wait may name several; the record builder picks among them.
 */
export function envSessions(env: NodeJS.ProcessEnv = process.env): EnvSession[] {
	const found: EnvSession[] = [];
	if (env.CLAUDE_CODE_SESSION_ID) found.push({ harness: "claude", session: env.CLAUDE_CODE_SESSION_ID });
	if (env.CODEX_THREAD_ID) found.push({ harness: "codex", session: env.CODEX_THREAD_ID });
	return found;
}

/** Where the waits are logged, one file per UTC day. */
export function waitsDirectory(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "quest", "waits");
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Append `wait` to today's log in one write, so concurrent writers leave only whole lines, when the environment
 * names a session; drop days past `KEEP_DAYS`. Throws when it cannot write.
 */
export function logWait(
	wait: SessionWait,
	options: { env?: NodeJS.ProcessEnv; cwd?: string; now?: number } = {},
): void {
	const env = options.env ?? process.env;
	const sessions = envSessions(env);
	if (sessions.length === 0) return;
	const now = options.now ?? Date.now();
	const dir = waitsDirectory(env);
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const line = Buffer.from(
			`${JSON.stringify({ ...wait, sessions, directory: options.cwd ?? process.cwd() } satisfies LoggedWait)}\n`,
		);
		const fd = openSync(
			join(dir, `${day(now)}.jsonl`),
			constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			const written = writeSync(fd, line);
			if (written !== line.length) throw new Error(`wrote ${written} of ${line.length} bytes`);
		} finally {
			closeSync(fd);
		}
		const oldest = day(now - KEEP_DAYS * DAY);
		for (const name of readdirSync(dir))
			if (/^\d{4}-\d\d-\d\d\.jsonl$/.test(name) && name.slice(0, 10) < oldest)
				rmSync(join(dir, name), { force: true });
	} catch (error) {
		throw new Error(`cannot log the wait in ${dir}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** The waits logged on this host that ended at or after `since`, failing on a line it cannot read. */
export function readWaits(since: number, env: NodeJS.ProcessEnv = process.env): LoggedWait[] {
	const dir = waitsDirectory(env);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const first = day(since);
	const waits: LoggedWait[] = [];
	for (const name of names.sort()) {
		if (!/^\d{4}-\d\d-\d\d\.jsonl$/.test(name) || name.slice(0, 10) < first) continue;
		const path = join(dir, name);
		const lines = readFileSync(path, "utf8").split("\n");
		lines.forEach((line, i) => {
			if (line === "") return;
			const wait = parseLogged(line);
			if (wait === null) {
				// A writer appends whole lines, so only a last line still being written may be cut short.
				if (i === lines.length - 1) return;
				throw new Error(`${path}:${i + 1} is not a wait quest logged`);
			}
			if (Date.parse(wait.end) >= since) waits.push(wait);
		});
	}
	return waits;
}

function parseLogged(line: string): LoggedWait | null {
	let value: Record<string, unknown>;
	try {
		value = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return null;
	}
	const iso = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v));
	const sessions = value?.sessions;
	if (
		!WAIT_KINDS.includes(value?.kind as SessionWait["kind"]) ||
		!iso(value.start) ||
		!iso(value.end) ||
		!(value.until === null || typeof value.until === "string") ||
		typeof value.directory !== "string" ||
		!Array.isArray(sessions) ||
		!sessions.every((s) => typeof s?.harness === "string" && typeof s?.session === "string")
	)
		return null;
	return value as unknown as LoggedWait;
}

/** The kind of a `quest wait` that ended on `event`: the merge queue's when the PR merged or left the queue. */
export function pullWaitKind(event: string | null): SessionWait["kind"] {
	return event === "merged" || event === "removed_from_merge_queue" ? "merge-queue" : "pull";
}
