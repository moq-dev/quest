// Sending each session's record to the Kixel Code endpoint its checkout names. The stop hook only queues the session;
// one sender per user, run by its service manager, rebuilds each queued session's record, with its sub-agents', and
// posts them, keeping what failed for the next pass. A record replaces its earlier copy, so a resend never doubles.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, setPriority } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { type SessionRecord } from "../core";
import { type GitHubDependencies, GitHub } from "../github/client";
import { baseRepository } from "./claims";
import { discoveryEnv } from "./git";
import { readRemote, remoteRepository } from "./github";
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
	/** A fresh ID per stop, naming its own queue file, so a sender removes only the stops it sent. */
	queued: string;
	/** The checkout's quest root, its `origin` on GitHub as `owner/repo`, and where its quest tree sits below the top level. */
	root: string;
	origin: string;
	prefix: string;
	endpoint: string;
}

/** Where the sender keeps its queue and what it has said. */
export function stateDirectory(env: NodeJS.ProcessEnv): string {
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
	/** Whether the session was queued. */
	queued: boolean;
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
	if (root === null) return { notices, queued: false };
	const said = (key: string, notice: string) => {
		const text = once(env, key, notice);
		if (text) notices.push(text);
		return { notices, queued: false };
	};
	const run = (args: string[]) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: discoveryEnv() });
	const remote = readRemote(root, "origin");
	const origin = remote === null ? null : remoteRepository(remote).repository;
	// A checkout off GitHub has no PRs for a record to name.
	if (origin === null) return { notices, queued: false };
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
	if (existsSync(refusal(env, endpoint, token))) return { notices, queued: false };
	const dir = join(stateDirectory(env), "pending");
	const start = transcriptStart(stopped.transcript);
	if (start === null) throw new Error(`${stopped.transcript} records no instant, so its session cannot be read`);
	const queued = randomUUID();
	const pending: Pending = {
		harness: stopped.harness,
		session: stopped.session,
		start,
		queued,
		root,
		origin: repository,
		prefix: run(["rev-parse", "--show-prefix"]).stdout.trim(),
		endpoint,
	};
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	// Each stop gets a file of its own, never rewritten, so a sender removes only the stops it read. Written whole,
	// then renamed, so the sender never reads half a file.
	const path = join(dir, `${queued}.json`);
	writeFileSync(`${path}.new`, JSON.stringify(pending));
	renameSync(`${path}.new`, path);
	const sender = senderRuns(env);
	if (!sender.runs)
		// Said once per outage: the PID of the sender that stopped names it, or none for a host that never ran one.
		said(
			`down:${sender.pid}`,
			`quest: no session record sender runs on this host, so this session's record waits in ${dir} with any others; start it with \`quest records install\`.`,
		);
	return { notices, queued: true };
}

/** The sender's last failure when the person has not seen it yet, marking it seen. */
function unseenFailure(env: NodeJS.ProcessEnv): string | null {
	const path = join(stateDirectory(env), "failure");
	if (!existsSync(path)) return null;
	const text = readFileSync(path, "utf8");
	const seen = `${path}.seen`;
	if (existsSync(seen) && readFileSync(seen, "utf8") === text) return null;
	writeFileSync(seen, text);
	return `quest: ${text.trim()}`;
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
	sleep(ms: number): Promise<unknown>;
	/** The time between passes. */
	interval: number;
}

/** How long the sender waits between passes, so a busy host's stops cannot spend its GitHub quota. */
export const SEND_INTERVAL = 60_000;

/** The outcome of one upload. */
export interface Sent {
	endpoint: string;
	repository: string;
	records: number;
	/** The endpoint refused the token, so the records were dropped. */
	refused: boolean;
}

/** Where the running sender records its process ID, for the stop hook to check. */
const pidPath = (env: NodeJS.ProcessEnv) => join(stateDirectory(env), "sender.pid");

/**
 * Whether a sender runs: the process the sender's PID file names is alive. A reused PID reads as running, which only
 * delays the notice; the queue keeps every record meanwhile.
 */
function senderRuns(env: NodeJS.ProcessEnv): { runs: boolean; pid: string } {
	const path = pidPath(env);
	const pid = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
	const owner = Number(pid);
	return { runs: Number.isSafeInteger(owner) && owner > 0 && alive(owner), pid };
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Run the sender until stopped: each `interval`, send every queued session's record, keeping what failed for the
 * next pass and leaving the failure for the stop hook to say. The user's service manager runs exactly one, so no two
 * passes ever overlap and uploads of a session reach the store in order.
 */
export async function runSender(deps: SendDependencies, log: (line: string) => void): Promise<never> {
	const dir = stateDirectory(deps.env);
	mkdirSync(join(dir, "pending"), { recursive: true, mode: 0o700 });
	writeFileSync(pidPath(deps.env), String(process.pid));
	for (;;) {
		try {
			for (const each of await sendPass(deps))
				log(
					each.refused
						? `${each.endpoint} refused the token for ${each.repository}; ${each.records} records dropped`
						: `sent ${each.records} records of ${each.repository} to ${each.endpoint}`,
				);
		} catch (error) {
			log(error instanceof Error ? error.message : String(error));
		}
		await deps.sleep(deps.interval);
	}
}

/**
 * Send every queued session's record once, with those of its sub-agents on this host, one upload per endpoint and
 * repository. A record goes only to the endpoint its token is paired with. An upload refused for access drops its
 * sessions and says so once; any other failure keeps them queued for the next pass, records it for the stop hook,
 * and throws. A session queued again while an upload ran stays queued.
 */
export async function sendPass(deps: SendDependencies): Promise<Sent[]> {
	const dir = stateDirectory(deps.env);
	try {
		return await sendOnce(deps, dir);
	} catch (error) {
		writeFailure(
			deps.env,
			`session records were not sent and stay queued for the next pass: ${error instanceof Error ? error.message : String(error)}`,
		);
		throw error;
	}
}

async function sendOnce(deps: SendDependencies, dir: string): Promise<Sent[]> {
	const queued = readdirSync(join(dir, "pending"))
		.filter((name) => name.endsWith(".json"))
		.map((name) => {
			const path = join(dir, "pending", name);
			return { path, pending: JSON.parse(readFileSync(path, "utf8")) as Pending };
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
	const notes: string[] = [];
	for (const group of groups.values()) {
		const { endpoint, origin, prefix } = group[0]!.pending;
		const roots = new Set(group.map((q) => q.pending.root));
		try {
			const token = tokenFor(endpoint, deps.env);
			// The user removed the token since the session was queued, or the endpoint refused it: it sends nothing.
			if (token === null || existsSync(refusal(deps.env, endpoint, token))) {
				for (const q of group) settle(q);
				continue;
			}
			const [owner, repo] = origin.split("/") as [string, string];
			const repository = await baseRepository(client, { owner, repo }, prefix);
			const pulls: Pull[] = await updatedPulls(client, repository, since);
			const emit = new Set<Session>();
			const missing: typeof group = [];
			for (const q of group) {
				const session = byId.get(`${q.pending.harness}\0${q.pending.session}`);
				if (session) emit.add(session);
				else missing.push(q);
			}
			// A session token-max no longer lists, as when its transcript was deleted, can never be built: it is
			// dropped and said, so it does not hold back the rest of its group forever.
			for (const q of missing) {
				settle(q);
				notes.push(
					`token-max lists no ${q.pending.harness} session ${q.pending.session} on this host, so its record was dropped`,
				);
			}
			const repositories = new Set([origin, key(repository)]);
			// A sub-agent stops without the stop hook naming it, so each queued session brings its own, routed as its
			// own checkout routes it, found from the nearest folder still there: a checkout must be a queued one's, or
			// name the same origin and endpoint. With no checkout left, every repository token-max resolved for it
			// must be this group's.
			const routed = (s: Session): boolean => {
				if (s.cwd !== null && insideCheckout(s.cwd)) {
					const own = questRoot(s.cwd);
					if (own === null) return false;
					if (roots.has(own)) return true;
					const remote = readRemote(own, "origin");
					const named = remote === null ? null : remoteRepository(remote).repository;
					try {
						return named !== null && key(named) === origin && checkoutEndpoint(own) === endpoint;
					} catch {
						// A malformed .quest.json routes nowhere, as its own stop would say.
						return false;
					}
				}
				return (
					s.repositories !== null &&
					s.repositories.length > 0 &&
					s.repositories.every((r) => repositories.has(r))
				);
			};
			for (let grew = true; grew;) {
				grew = false;
				for (const s of kept) {
					const parent = s.parent === null ? undefined : byId.get(`${s.harness}\0${s.parent}`);
					if (s.id !== null && !emit.has(s) && parent !== undefined && emit.has(parent) && routed(s)) {
						emit.add(s);
						grew = true;
					}
				}
			}
			if (emit.size === 0) continue;
			const records = sessionRecords({
				repository: key(repository),
				sessions: kept,
				evidence: exported,
				pulls,
				waits,
				emit,
				since,
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
				notes.push(
					`${endpoint} refused this host's token (${response.status}), so it is sent no more session records until the token changes`,
				);
				sent.push({ endpoint, repository: key(repository), records: upload.length, refused: true });
				continue;
			}
			if (!response.ok)
				throw new Error(`${endpoint} answered ${response.status}: ${(await response.text()).slice(0, 500)}`);
			for (const q of group) settle(q);
			sent.push({ endpoint, repository: key(repository), records: upload.length, refused: false });
		} catch (error) {
			failures.push(`${origin} to ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (failures.length) throw new Error([...notes, ...failures].join("; "));
	if (notes.length) writeFailure(deps.env, notes.join("; "));
	else rmSync(join(dir, "failure"), { force: true });
	return sent;
}

/** Whether a checkout still holds `dir` or the nearest of its parents that exists, as `questRoot` finds it. */
function insideCheckout(dir: string): boolean {
	for (let at = dir; ; at = dirname(at)) {
		if (existsSync(join(at, ".git"))) return true;
		if (dirname(at) === at) return false;
	}
}

/** Drop a stop the sender read; a later stop of the same session has a file of its own and stays queued. */
function settle(q: { path: string }): void {
	rmSync(q.path, { force: true });
}

/** Lower this process's priority, since the sender works in the background. */
export function background(): void {
	try {
		setPriority(19);
	} catch {
		// A host that refuses only leaves it at normal priority.
	}
}
