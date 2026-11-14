// Sending each session's record to the Kixel Code endpoint its checkout names. The stop hook queues the session and
// starts a sender in the background; the sender rebuilds each queued session's record, with its sub-agents', and
// posts them, keeping what failed for the next run. A record replaces its earlier copy, so a resend never doubles.
import { spawn, spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir, setPriority } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { type SessionRecord } from "../core";
import { type GitHubDependencies, GitHub } from "../github/client";
import { baseRepository } from "./claims";
import { discoveryEnv } from "./git";
import { githubRepository } from "./github";
import { eachLine } from "./messages";
import { questRoot } from "./rules";
import { type Pull, type Session, fold, key, sessionRecords, updatedPulls } from "./usage";
import { type LoggedWait } from "./waits";

/** The checkout's file naming its record endpoint, as `{"records": "https://..."}`. */
export const CHECKOUT_CONFIG = ".quest.json";

/** One session the stop hook queued. */
export interface Pending {
	harness: string;
	session: string;
	/** Its transcript's first instant, epoch ms, so token-max reads all of it. */
	start: number;
	/** The checkout's `origin` on GitHub, as `owner/repo`, and where its quest tree sits below the top level. */
	origin: string;
	prefix: string;
	endpoint: string;
}

/** Where the sender keeps its queue and what it has said. */
function stateDirectory(env: NodeJS.ProcessEnv): string {
	return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "quest", "records");
}

/** The user's tokens, by the endpoint each may be sent to: `{"https://...": "token"}`. */
export function tokensPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "quest", "records.json");
}

/** The endpoint `root`'s checkout names, or null; a malformed file or endpoint throws. */
export function checkoutEndpoint(root: string): string | null {
	const path = join(root, CHECKOUT_CONFIG);
	if (!existsSync(path)) return null;
	let config: unknown;
	try {
		config = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`${path} is not JSON: ${(error as Error).message}`);
	}
	const endpoint = (config as { records?: unknown } | null)?.records;
	if (endpoint === undefined) return null;
	if (typeof endpoint !== "string") throw new Error(`${path}: records is not a URL`);
	return checkedEndpoint(endpoint, path);
}

/** `endpoint` when it is HTTPS, or HTTP to this host for a local store; anything else would send records in clear. */
function checkedEndpoint(endpoint: string, where: string): string {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new Error(`${where}: ${endpoint} is not a URL`);
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
		throw new Error(`${where}: ${endpoint} is not an HTTPS URL`);
	return endpoint;
}

/**
 * The token the user paired with `endpoint`, or null. The token is bound to its endpoint in the user's own file, so
 * a checkout naming another endpoint, as a hostile branch might, never receives it.
 */
export function tokenFor(endpoint: string, env: NodeJS.ProcessEnv = process.env): string | null {
	const path = tokensPath(env);
	if (!existsSync(path)) return null;
	let tokens: unknown;
	try {
		tokens = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`${path} is not JSON: ${(error as Error).message}`);
	}
	if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens))
		throw new Error(`${path} does not hold an object of tokens by endpoint`);
	const token = (tokens as Record<string, unknown>)[endpoint];
	if (token === undefined) return null;
	if (typeof token !== "string" || token === "")
		throw new Error(`${path}: the token for ${endpoint} is not a string`);
	return token;
}

/** The marker of an endpoint that refused a token, which a new token clears. */
const refusal = (env: NodeJS.ProcessEnv, endpoint: string, token: string) =>
	join(stateDirectory(env), "refused", digest(`${endpoint}\0${token}`));

function refuse(env: NodeJS.ProcessEnv, endpoint: string, token: string): void {
	mkdirSync(join(stateDirectory(env), "refused"), { recursive: true, mode: 0o700 });
	writeFileSync(refusal(env, endpoint, token), "");
}

/** Say `notice` the first time only, by `key`, returning it then and null after. */
function once(env: NodeJS.ProcessEnv, key: string, notice: string): string | null {
	const dir = join(stateDirectory(env), "said");
	const marker = join(dir, digest(key));
	if (existsSync(marker)) return null;
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(marker, `${key}\n`);
	return notice;
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);

/** The first instant a transcript records, epoch ms, or null when it records none. */
function transcriptStart(path: string): number | null {
	let found: number | null = null;
	eachLine(path, (line) => {
		const at = /"timestamp"\s*:\s*"([^"]+)"/.exec(line)?.[1];
		const ms = at === undefined ? NaN : Date.parse(at);
		if (Number.isNaN(ms)) return true;
		found = ms;
		return false;
	});
	return found;
}

/** A stop hook's input, as Claude Code and Codex send it. */
export interface Stopped {
	harness: string;
	session: string;
	transcript: string;
	cwd: string;
}

/** What `queue` did, for the hook to say. */
export interface Queued {
	/** Each notice the person has not seen yet. */
	notices: string[];
	/** Whether a sender should run. */
	send: boolean;
}

/**
 * Queue the stopped session's record for its checkout's endpoint, in a checkout that uses Quest. A checkout naming
 * no endpoint, or one the user holds no token for, queues nothing and says so once. A sender's last failure, if the
 * person has not seen it, is said too.
 */
export function queue(stopped: Stopped, env: NodeJS.ProcessEnv = process.env): Queued {
	const notices: string[] = [];
	const failure = unseenFailure(env);
	if (failure) notices.push(failure);
	const root = questRoot(stopped.cwd);
	if (root === null) return { notices, send: false };
	const said = (key: string, notice: string) => {
		const text = once(env, key, notice);
		if (text) notices.push(text);
		return { notices, send: false };
	};
	const run = (args: string[]) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: discoveryEnv() });
	const url = run(["remote", "get-url", "origin"]);
	const origin = url.status === 0 ? githubRepository(url.stdout.trim()) : null;
	// A checkout off GitHub has no PRs for a record to name.
	if (origin === null) return { notices, send: false };
	const repository = `${origin.owner}/${origin.repo}`.toLowerCase();
	const endpoint = checkoutEndpoint(root);
	if (endpoint === null)
		return said(
			`none:${repository}`,
			`quest: ${repository} names no Kixel Code endpoint in ${CHECKOUT_CONFIG}, so its sessions' records stay on this host.`,
		);
	const token = tokenFor(endpoint, env);
	if (token === null)
		return said(
			`token:${endpoint}`,
			`quest: ${tokensPath(env)} holds no token for ${endpoint}, so this host sends it no session records.`,
		);
	if (existsSync(refusal(env, endpoint, token))) return { notices, send: false };
	const dir = join(stateDirectory(env), "pending");
	const path = join(dir, `${digest(`${stopped.harness}\0${stopped.session}`)}.json`);
	const earlier = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Pending) : null;
	const start = earlier?.start ?? transcriptStart(stopped.transcript);
	if (start === null) throw new Error(`${stopped.transcript} records no instant, so its session cannot be read`);
	const pending: Pending = {
		harness: stopped.harness,
		session: stopped.session,
		start,
		origin: repository,
		prefix: run(["rev-parse", "--show-prefix"]).stdout.trim(),
		endpoint,
	};
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	// Written whole, then renamed, so the sender never reads half a file.
	writeFileSync(`${path}.new`, JSON.stringify(pending));
	renameSync(`${path}.new`, path);
	return { notices, send: true };
}

/**
 * Start `quest records send` detached, at low priority, outside the session's environment, so the session's own
 * waits never include its gate. Its output goes to a log beside the queue.
 */
export function startSender(env: NodeJS.ProcessEnv = process.env): void {
	const dir = stateDirectory(env);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const log = openSync(join(dir, "send.log"), "a", 0o600);
	try {
		const clean = { ...env };
		delete clean.CLAUDE_CODE_SESSION_ID;
		delete clean.CODEX_THREAD_ID;
		const child = spawn("quest", ["records", "send", "--background"], {
			detached: true,
			stdio: ["ignore", log, log],
			env: clean,
		});
		child.on("error", (error) => writeFailure(env, `cannot start \`quest records send\`: ${error.message}`));
		child.unref();
	} finally {
		closeSync(log);
	}
}

/** The sender's last failure when the person has not seen it yet, marking it seen. */
function unseenFailure(env: NodeJS.ProcessEnv): string | null {
	const path = join(stateDirectory(env), "failure");
	if (!existsSync(path)) return null;
	const text = readFileSync(path, "utf8");
	const seen = `${path}.seen`;
	if (existsSync(seen) && readFileSync(seen, "utf8") === text) return null;
	writeFileSync(seen, text);
	return `quest: the last session records were not sent and will be resent: ${text.trim()}`;
}

function writeFailure(env: NodeJS.ProcessEnv, text: string): void {
	const dir = stateDirectory(env);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(join(dir, "failure"), `${text}\n`);
}

/** What the sender reads and posts with. */
export interface SendDependencies {
	env: NodeJS.ProcessEnv;
	github(): GitHubDependencies;
	/** token-max's sessions on this host since an instant, or null when it is not installed. */
	sessions(since: Date): Session[] | null;
	waits(since: number): LoggedWait[];
	fetch: typeof globalThis.fetch;
}

/** The outcome of one upload. */
export interface Sent {
	endpoint: string;
	repository: string;
	records: number;
}

/**
 * Send every queued session's record, with those of its sub-agents on this host, one upload per endpoint and
 * repository. A record goes only to the endpoint its token is paired with. An upload refused for access drops its
 * sessions and says so once; any other failure keeps them queued for the next run and throws. A session queued again
 * while an upload ran stays queued. With another sender running, it leaves the queue to that one, which runs again.
 */
export async function sendQueued(deps: SendDependencies): Promise<Sent[] | null> {
	const dir = stateDirectory(deps.env);
	mkdirSync(join(dir, "pending"), { recursive: true, mode: 0o700 });
	const lock = join(dir, "send.lock");
	const again = join(dir, "send.again");
	if (!acquire(lock)) {
		writeFileSync(again, "");
		return null;
	}
	try {
		const sent: Sent[] = [];
		do {
			rmSync(again, { force: true });
			sent.push(...(await sendOnce(deps, dir)));
		} while (existsSync(again));
		return sent;
	} catch (error) {
		writeFailure(deps.env, error instanceof Error ? error.message : String(error));
		throw error;
	} finally {
		rmSync(lock, { force: true });
	}
}

/** Take the lock file, or take it over from a sender that died; false while a live one holds it. */
function acquire(lock: string): boolean {
	for (let tries = 0; tries < 2; tries++) {
		try {
			const fd = openSync(lock, "wx", 0o600);
			writeSync(fd, String(process.pid));
			closeSync(fd);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const pid = Number(readFileSync(lock, "utf8"));
			if (Number.isSafeInteger(pid) && pid > 0 && alive(pid)) return false;
			rmSync(lock, { force: true });
		}
	}
	return false;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function sendOnce(deps: SendDependencies, dir: string): Promise<Sent[]> {
	const queued = readdirSync(join(dir, "pending"))
		.filter((name) => name.endsWith(".json"))
		.map((name) => {
			const path = join(dir, "pending", name);
			const text = readFileSync(path, "utf8");
			return { path, text, pending: JSON.parse(text) as Pending };
		});
	if (queued.length === 0) return [];
	const since = Math.min(...queued.map((q) => q.pending.start));
	const exported = deps.sessions(new Date(since));
	if (exported === null)
		throw new Error(
			"token-max is not installed, so no record can be priced; install it with `cargo install --locked --git https://github.com/kixel-ai/token-max`",
		);
	const { kept } = fold(exported);
	const byId = new Map(kept.flatMap((s) => (s.id === null ? [] : [[`${s.harness}\0${s.id}`, s] as const])));
	const waits = deps.waits(since);
	const client = new GitHub(deps.github());
	const groups = new Map<string, typeof queued>();
	for (const q of queued) {
		const id = JSON.stringify([q.pending.endpoint, q.pending.origin, q.pending.prefix]);
		groups.set(id, [...(groups.get(id) ?? []), q]);
	}
	const sent: Sent[] = [];
	const failures: string[] = [];
	const refused: string[] = [];
	for (const group of groups.values()) {
		const { endpoint, origin, prefix } = group[0]!.pending;
		try {
			const token = tokenFor(endpoint, deps.env);
			if (token === null) {
				// The user removed the token since the session was queued: it sends nothing.
				for (const q of group) settle(q);
				continue;
			}
			const [owner, repo] = origin.split("/") as [string, string];
			const repository = await baseRepository(client, { owner, repo }, prefix);
			const pulls: Pull[] = await updatedPulls(client, repository, since);
			const emit = new Set<Session>();
			for (const q of group) {
				const session = byId.get(`${q.pending.harness}\0${q.pending.session}`);
				if (!session)
					throw new Error(
						`token-max lists no ${q.pending.harness} session ${q.pending.session} on this host`,
					);
				emit.add(session);
			}
			// A sub-agent stops without the stop hook naming it, so each queued session brings its own.
			for (let grew = true; grew;) {
				grew = false;
				for (const s of kept)
					if (
						!emit.has(s) &&
						s.parent !== null &&
						byId.get(`${s.harness}\0${s.parent}`) &&
						emit.has(byId.get(`${s.harness}\0${s.parent}`)!)
					) {
						emit.add(s);
						grew = true;
					}
			}
			const records = sessionRecords({
				repository: key(repository),
				sessions: kept,
				evidence: exported,
				pulls,
				waits,
				emit,
			});
			const upload = [...records.values()];
			const response = await deps.fetch(endpoint, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ records: upload } satisfies { records: SessionRecord[] }),
			});
			if (response.status === 401 || response.status === 403) {
				refuse(deps.env, endpoint, token);
				for (const q of group) settle(q);
				refused.push(
					`${endpoint} refused this host's token (${response.status}), so it is sent no more records until the token changes`,
				);
				continue;
			}
			if (!response.ok)
				throw new Error(`${endpoint} answered ${response.status}: ${(await response.text()).slice(0, 500)}`);
			for (const q of group) settle(q);
			sent.push({ endpoint, repository: key(repository), records: upload.length });
		} catch (error) {
			failures.push(`${origin} to ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (failures.length) throw new Error([...refused, ...failures].join("; "));
	if (refused.length) writeFailure(deps.env, refused.join("; "));
	else rmSync(join(dir, "failure"), { force: true });
	return sent;
}

/** Drop a queued session unless the hook queued it again since it was read. */
function settle(q: { path: string; text: string }): void {
	try {
		if (readFileSync(q.path, "utf8") === q.text) rmSync(q.path, { force: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/** Lower this process's priority, as a background sender should run. */
export function background(): void {
	try {
		setPriority(19);
	} catch {
		// A host that refuses only leaves it at normal priority.
	}
}
