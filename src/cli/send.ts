// Sending each session's record, and the breakages its PRs name, to the Kixel Code endpoint its checkout names. The stop hook only queues the session;
// one sender per user, run by its service manager, rebuilds each queued session's record, with its sub-agents', and
// posts them, keeping what failed for the next pass. A record replaces its earlier copy, so a resend never doubles.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, setPriority } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { type BreakageRecord, type Finder, type RecordUpload, parseUpload } from "../core";
import { culpritOf } from "./breakage";
import { CLOCK_SKEW, type GitHubDependencies, GitHub } from "../github/client";
import { baseRepository } from "./claims";
import { discoveryEnv } from "./git";
import { readRemote, remoteRepository } from "./github";
import { eachLine } from "./messages";
import { questRoot } from "./rules";
import { type Pull, type Session, fixBreakages, fold, key, readPull, sessionRecords, updatedPulls } from "./usage";
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
	now(): number;
	sleep(ms: number): Promise<unknown>;
	/** The time between passes, and a failing group's first wait. */
	interval: number;
}

/** How long the sender waits between passes, so a busy host's stops cannot spend its GitHub quota. */
export const SEND_INTERVAL = 60_000;

/** The outcome of one upload. */
export interface Sent {
	endpoint: string;
	repository: string;
	records: number;
	breakages: number;
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
						: `sent ${each.records} records and ${each.breakages} breakages of ${each.repository} to ${each.endpoint}`,
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
			`session records were not sent and stay queued, retried with backoff: ${error instanceof Error ? error.message : String(error)}`,
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
	const groups = new Map<string, typeof queued>();
	for (const q of queued) {
		const id = JSON.stringify([q.pending.endpoint, q.pending.origin, q.pending.prefix]);
		groups.set(id, [...(groups.get(id) ?? []), q]);
	}
	// A group backing off sits the pass out, so it neither reruns token-max nor widens the others' window.
	for (const id of [...groups.keys()]) if ((readBackoff(deps.env, id)?.next ?? 0) > deps.now()) groups.delete(id);
	const active = [...groups.values()].flat();
	if (active.length === 0) return [];
	const since = Math.min(...active.map((q) => q.pending.start));
	const exported = deps.sessions(new Date(since));
	if (exported === null)
		throw new Error(
			"token-max is not installed, so no record can be priced; install it with `cargo install --locked --git https://github.com/kixel-ai/token-max`",
		);
	const { kept } = fold(exported);
	const byId = new Map(kept.flatMap((s) => (s.id === null ? [] : [[`${s.harness}\0${s.id}`, s] as const])));
	const waits = deps.waits(since);
	const client = new GitHub(deps.github());
	const sent: Sent[] = [];
	const failures: string[] = [];
	const notes: string[] = [];
	for (const [id, group] of groups) {
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
			// PRs are read from the last upload's read, if earlier, so a fix that merged after its sessions were sent,
			// as through the merge queue, still reaches the store with the next session.
			const read = deps.now() - CLOCK_SKEW;
			const pulls: Pull[] = await updatedPulls(
				client,
				repository,
				Math.min(since, readCursor(deps.env, id) ?? since),
			);
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
				// Repositories token-max resolved that are none of this group's, as for a deleted nested clone of
				// another, rule it out whatever checkout now holds its folder.
				if (
					s.repositories !== null &&
					s.repositories.length > 0 &&
					!s.repositories.some((r) => repositories.has(r))
				)
					return false;
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
			const upload: RecordUpload = {
				records: [...records.values()],
				breakages: await fixBreakages({ client, repository, pulls }),
			};
			const response = await post(deps.fetch, endpoint, token, upload);
			if (response.status === 401 || response.status === 403) {
				refuse(deps.env, endpoint, token);
				clearBackoff(deps.env, id);
				for (const q of group) settle(q);
				notes.push(
					`${endpoint} refused this host's token (${response.status}), so it is sent no more session records until the token changes`,
				);
				sent.push({
					endpoint,
					repository: key(repository),
					records: upload.records.length,
					breakages: upload.breakages.length,
					refused: true,
				});
				continue;
			}
			if (!response.ok)
				throw new Error(`${endpoint} answered ${response.status}: ${(await response.text()).slice(0, 500)}`);
			clearBackoff(deps.env, id);
			writeCursor(deps.env, id, read);
			for (const q of group) settle(q);
			sent.push({
				endpoint,
				repository: key(repository),
				records: upload.records.length,
				breakages: upload.breakages.length,
				refused: false,
			});
		} catch (error) {
			const wait = backOff(deps, id);
			failures.push(
				`${origin} to ${endpoint}: ${error instanceof Error ? error.message : String(error)} (tried again in ${Math.round(wait / 60_000)} minutes)`,
			);
		}
	}
	if (failures.length) throw new Error([...notes, ...failures].join("; "));
	if (notes.length) writeFailure(deps.env, notes.join("; "));
	else rmSync(join(dir, "failure"), { force: true });
	return sent;
}

/**
 * `text` as epoch ms when it is an ISO 8601 date and time with an explicit `Z` or offset on a real calendar day, else
 * null: `Date.parse` alone takes a bare date as UTC midnight, a time without an offset as this host's, and rolls an
 * impossible day such as February 30 into the next month.
 */
export function parseInstant(text: string): number | null {
	const match =
		/^(\d{4})-(\d\d)-(\d\d)T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/.exec(text);
	if (!match) return null;
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
	const at = Date.parse(text);
	return Number.isNaN(at) ? null : at;
}

/** An incident to report, as a deploy or alert hands it to `quest records incident`. */
export interface Incident {
	/** A directory in the checkout whose endpoint and repository it is reported for. */
	cwd: string;
	/** The reporter's stable ID for it, such as the alert's URL; reporting the same ID again replaces it. */
	id: string;
	found: Finder;
	/** The PR that caused it, or null while unknown, which leaves it open. */
	pull: number | null;
	/** When it was found, epoch ms. */
	at: number;
}

/**
 * Post `incident` as a breakage to the endpoint the checkout's `${CHECKOUT_CONFIG}` names, with the token the user
 * paired with it, and return it. Unlike the sender, it posts at once and fails loud on anything the endpoint does not
 * take, refusal included, since a deploy or alert calls it once and nothing retries.
 */
export async function reportIncident(
	incident: Incident,
	deps: Pick<SendDependencies, "env" | "github" | "fetch">,
): Promise<BreakageRecord> {
	const root = questRoot(resolve(incident.cwd));
	if (root === null) throw new Error(`${incident.cwd} is not in a checkout that uses Quest`);
	const endpoint = checkoutEndpoint(root);
	if (endpoint === null) throw new Error(`${join(root, CHECKOUT_CONFIG)} names no record endpoint`);
	const token = tokenFor(endpoint, deps.env);
	if (token === null) throw new Error(`${tokensPath(deps.env)} holds no token for ${endpoint}`);
	const remote = readRemote(root, "origin");
	const origin = remote === null ? null : remoteRepository(remote).repository;
	if (origin === null) throw new Error("origin is not on GitHub");
	const client = new GitHub(deps.github());
	const prefix = spawnSync("git", ["-C", root, "rev-parse", "--show-prefix"], {
		encoding: "utf8",
		env: discoveryEnv(),
	}).stdout.trim();
	const repository = await baseRepository(client, origin, prefix);
	let culprit: BreakageRecord["culprit"] = null;
	if (incident.pull !== null) {
		const found = await readPull(client, repository, incident.pull);
		if (found === null) throw new Error(`${key(repository)} has no PR #${incident.pull}`);
		culprit = culpritOf(found);
	}
	const breakage: BreakageRecord = {
		repository: key(repository),
		culprit,
		fix: null,
		incident: incident.id,
		found: incident.found,
		at: new Date(incident.at).toISOString(),
	};
	const response = await post(deps.fetch, endpoint, token, { records: [], breakages: [breakage] });
	if (!response.ok)
		throw new Error(`${endpoint} answered ${response.status}: ${(await response.text()).slice(0, 500)}`);
	return breakage;
}

/** POST `upload` to `endpoint` with `token`, after checking it is one the store's own `parseUpload` takes. */
async function post(
	fetch: typeof globalThis.fetch,
	endpoint: string,
	token: string,
	upload: RecordUpload,
): Promise<Response> {
	try {
		parseUpload(upload);
	} catch (error) {
		throw new Error(`this quest built an upload its own parseUpload refuses: ${(error as Error).message}`);
	}
	return fetch(endpoint, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(upload),
	});
}

/** The longest a failing group waits between tries. */
const MAX_BACKOFF = 6 * 3_600_000;

/** A failing group's consecutive failures and the instant it may next be tried. */
interface Backoff {
	failures: number;
	next: number;
}

const cursorPath = (env: NodeJS.ProcessEnv, id: string) => join(stateDirectory(env), "read", digest(id));

/** When group `id`'s last successful upload read its PRs, epoch ms, or null; an unreadable file reads as none. */
function readCursor(env: NodeJS.ProcessEnv, id: string): number | null {
	try {
		const at = Number(readFileSync(cursorPath(env, id), "utf8"));
		return Number.isFinite(at) && at > 0 ? at : null;
	} catch {
		return null;
	}
}

function writeCursor(env: NodeJS.ProcessEnv, id: string, at: number): void {
	mkdirSync(join(stateDirectory(env), "read"), { recursive: true, mode: 0o700 });
	const path = cursorPath(env, id);
	writeFileSync(`${path}.new`, String(at));
	renameSync(`${path}.new`, path);
}

const backoffPath = (env: NodeJS.ProcessEnv, id: string) => join(stateDirectory(env), "backoff", digest(id));

/** A group's backoff, or null without one; an unreadable file reads as none, so it can never block every group. */
function readBackoff(env: NodeJS.ProcessEnv, id: string): Backoff | null {
	try {
		const value = JSON.parse(readFileSync(backoffPath(env, id), "utf8")) as Partial<Backoff> | null;
		return Number.isSafeInteger(value?.failures) && Number.isFinite(value?.next) ? (value as Backoff) : null;
	} catch {
		return null;
	}
}

/**
 * Record another failure of group `id`, doubling its wait from one interval up to `MAX_BACKOFF`, so a rejection that
 * resending cannot fix, such as a store refusing a newer record, costs a pass a few times a day while its records
 * stay queued. Returns the wait.
 */
function backOff(deps: SendDependencies, id: string): number {
	const failures = (readBackoff(deps.env, id)?.failures ?? 0) + 1;
	const wait = Math.min(deps.interval * 2 ** Math.min(failures - 1, 30), MAX_BACKOFF);
	mkdirSync(join(stateDirectory(deps.env), "backoff"), { recursive: true, mode: 0o700 });
	// Written whole, then renamed, as queue files are, so a crash mid-write leaves the old file or none.
	const path = backoffPath(deps.env, id);
	writeFileSync(`${path}.new`, JSON.stringify({ failures, next: deps.now() + wait } satisfies Backoff));
	renameSync(`${path}.new`, path);
	return wait;
}

function clearBackoff(env: NodeJS.ProcessEnv, id: string): void {
	rmSync(backoffPath(env, id), { force: true });
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
