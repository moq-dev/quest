// `quest agent`: start, resume, and stop headless agents billed to API keys.
//
// One command owns what a spawn would otherwise script again each time: it
// resolves `QUEST_API_KEYS` once into a user-only store, gives each agent only
// the key its position names, strips the coordinating session's harness
// variables, and reads the agent's session, reply, and cost. Its own arguments
// name the harness, worktree, key, model, effort, and permission mode, so a
// permission classifier reading the call sees the whole launch.
import { type ChildProcess, type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { systemdScopes } from "./supervise";
import { Worktrees, save } from "./worktree";

export const HARNESSES = ["claude", "codex"] as const;
export type HarnessName = (typeof HARNESSES)[number];

/** Everything a launch names on its command line. */
export interface Launch {
	harness: HarnessName;
	/** The key's 1-based position in `QUEST_API_KEYS`. */
	key: number;
	model: string;
	effort: string;
	/** Claude Code's `--permission-mode`, or Codex's sandbox mode. */
	permissionMode: string;
	worktree: string;
}

/** What an agent run reports when its process exits. */
export interface Result {
	session?: string;
	reply?: string;
	/** Dollars, when the agent reports them. */
	cost?: number;
	/** The provider refused the key for lack of credit. */
	exhausted: boolean;
	/** The agent reported an error, whatever its exit status. */
	failed: boolean;
}

export type Outcome = "finished" | "failed" | "exhausted" | "stopped";

/** Exit statuses: a finished agent exits 0, an exhausted key 3, and anything else 1. */
const EXIT: Record<Outcome, number> = { finished: 0, failed: 1, exhausted: 3, stopped: 1 };

/** How one agent CLI is launched and read. The prompt always arrives on stdin. */
interface Harness {
	/** The variable the agent CLI reads its API key from. */
	keyVariable: string;
	/** Argv for a new session, given a session id to assign where the CLI accepts one. */
	start(launch: Launch, session: string): string[];
	resume(launch: Launch, session: string): string[];
	/** A reader for one run's stdout, fed line by line so a long run is never held in memory. */
	reader(): Reader;
}

interface Reader {
	/** Read one line of stdout, returning the session id if the line announces it. */
	line(line: string): string | undefined;
	/** The run's result, given the tail of its stderr. */
	result(stderr: string): Result;
}

/** Provider messages for a key whose balance cannot pay for the request. */
const EXHAUSTED = /credit balance is too low|insufficient_quota|exceeded your current quota/i;

function json(line: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/** `claude -p --output-format json` prints one result object when the turn ends. */
const claude: Harness = {
	keyVariable: "ANTHROPIC_API_KEY",
	start: (launch, session) => [...claudeFlags(launch), "--session-id", session],
	resume: (launch, session) => [...claudeFlags(launch), "--resume", session],
	reader() {
		let result: Record<string, unknown> | undefined;
		return {
			// The session id is assigned at start, so it is known before any output.
			line(line) {
				const value = json(line);
				if (value?.type === "result") result = value;
				return undefined;
			},
			result(stderr) {
				const reply = text(result?.result);
				const cost = result?.total_cost_usd;
				return {
					session: text(result?.session_id),
					reply,
					cost: typeof cost === "number" ? cost : undefined,
					exhausted: EXHAUSTED.test(`${reply ?? ""}\n${stderr}`),
					failed: result === undefined || result.is_error === true,
				};
			},
		};
	},
};

function claudeFlags(launch: Launch): string[] {
	return [
		"claude",
		"-p",
		"--output-format",
		"json",
		"--model",
		launch.model,
		"--effort",
		launch.effort,
		"--permission-mode",
		launch.permissionMode,
	];
}

/** `codex exec --json` streams JSONL events: the thread id first, the reply in the last agent message. */
const codex: Harness = {
	keyVariable: "CODEX_API_KEY",
	start: (launch) => ["codex", "exec", "--json", ...codexFlags(launch), "-"],
	resume: (launch, session) => ["codex", "exec", "resume", "--json", ...codexFlags(launch), session, "-"],
	reader() {
		let session: string | undefined;
		let reply: string | undefined;
		let error: string | undefined;
		let turnFailed = false;
		let exhausted = false;
		return {
			line(line) {
				const event = json(line);
				if (event === undefined) return undefined;
				const item = event.item as Record<string, unknown> | undefined;
				if (event.type === "item.completed" && item?.type === "agent_message") reply = text(item.text) ?? reply;
				// Codex also reports retryable stream errors, such as reconnects, as `error`
				// events and keeps the turn going, so only `turn.failed` fails it.
				if (event.type === "turn.failed" || event.type === "error") {
					const failure = event.error as Record<string, unknown> | undefined;
					error = text(failure?.message) ?? text(event.message) ?? "";
					exhausted ||= EXHAUSTED.test(error);
					turnFailed ||= event.type === "turn.failed";
				}
				if (event.type !== "thread.started") return undefined;
				session = text(event.thread_id) ?? session;
				return session;
			},
			result: (stderr) => ({
				session,
				// A turn that failed before replying reports why, as `claude -p` does.
				reply: reply ?? error,
				exhausted: exhausted || EXHAUSTED.test(stderr),
				failed: turnFailed || reply === undefined,
			}),
		};
	},
};

/** Codex takes effort and sandbox as TOML config values, so only plain words pass. */
function codexFlags(launch: Launch): string[] {
	for (const [name, value] of [
		["effort", launch.effort],
		["permission mode", launch.permissionMode],
	]) {
		if (!/^[\w.-]+$/.test(value)) throw new AgentInputError(`${name} must be a plain word for codex`);
	}
	return [
		"-m",
		launch.model,
		"-c",
		`model_reasoning_effort="${launch.effort}"`,
		"-c",
		`sandbox_mode="${launch.permissionMode}"`,
		"-c",
		'approval_policy="never"',
	];
}

const HARNESS: Record<HarnessName, Harness> = { claude, codex };

/** A mistake in the arguments or environment, reported as a usage error. */
export class AgentInputError extends Error {}

/**
 * Variables an agent must not inherit: the coordinating session's harness
 * state and credentials, other keys, and secret-manager tokens. Without them
 * the agent neither reuses the session's account nor acts as its sub-session.
 * A launch from inside a `quest gate` command does not admit the agent's own
 * expensive commands or give them a land check's priority, so the gate's marks
 * are dropped too, as is the base a land check runs against. Each CLI keeps the
 * user's configuration directory.
 */
const STRIPPED = [
	/^CLAUDE(?!_CONFIG_DIR$)/,
	/^ANTHROPIC/,
	/^CODEX_(?!HOME$)/,
	/^OPENAI_API_KEY$/,
	/^OP_/,
	/^QUEST_API_KEYS$/,
	/^QUEST_GATE_(ADMITTED|PRIORITY)$/,
	/^QUEST_LAND_BASE$/,
];

/** The agent's environment: the user's, minus `STRIPPED`, plus its one key. */
export function launchEnvironment(env: NodeJS.ProcessEnv, variable: string, key: string): NodeJS.ProcessEnv {
	return { ...strippedEnvironment(env), [variable]: key };
}

/** The user's environment minus `STRIPPED`, for an agent that brings its own credentials. */
export function strippedEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([name]) => !STRIPPED.some((pattern) => pattern.test(name))));
}

/**
 * Per-user state that should not outlive the login: the runtime directory
 * where one exists, otherwise a user-only directory in the per-user (macOS,
 * Windows) or shared (Linux) temporary directory.
 */
export function agentDirectory(env = process.env): string {
	if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, "quest", "agent");
	const uid = process.getuid?.();
	return join(tmpdir(), uid === undefined ? "quest-agent" : `quest-agent-${uid}`);
}

/**
 * Create `dir` readable only by this user, refusing a symlink or a directory
 * someone else owns, either of which another user could control.
 */
export function privateDirectory(dir: string): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stat = lstatSync(dir);
	if (!stat.isDirectory()) throw new Error(`${dir} is a symlink or not a directory`);
	const uid = process.getuid?.();
	if (uid !== undefined) {
		if (stat.uid !== uid) throw new Error(`${dir} belongs to another user`);
		if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700);
	}
	return dir;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

/**
 * One spawn's state: every worktree of a repository shares its key store and
 * agent records. Every command reaches it through here, so each one checks
 * that the state is private before trusting the records in it.
 */
export function spawnDirectory(base: string, worktree: string): string {
	let common: string;
	try {
		common = execFileSync("git", ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch {
		throw new AgentInputError(`${worktree} is not inside a Git repository`);
	}
	const dir = privateDirectory(join(privateDirectory(base), digest(realpathSync(common))));
	privateDirectory(join(dir, "agents"));
	return dir;
}

function load<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

interface KeyStore {
	/** Which `QUEST_API_KEYS` value the keys were resolved from. */
	fingerprint: string;
	keys: string[];
}

/** Resolves secret references to keys in order, in one secret-manager invocation. */
export type Resolver = (references: string[], env: NodeJS.ProcessEnv) => string[];

/**
 * 1Password resolves every `op://` reference in one `op inject`, so the user
 * approves at most one prompt; a service account token makes it promptless.
 */
export const onePassword: Resolver = (references, env) => {
	const template = references.map((reference) => `{{ ${reference} }}`).join("\n");
	let output: string;
	try {
		output = execFileSync("op", ["inject"], {
			encoding: "utf8",
			env,
			input: `${template}\n`,
			stdio: ["pipe", "pipe", "inherit"],
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("op is not installed");
		throw new Error("op inject failed to resolve QUEST_API_KEYS");
	}
	const keys = output.split("\n").slice(0, references.length);
	if (keys.length !== references.length || keys.some((key) => !/^\S+$/.test(key))) {
		throw new Error("op inject did not resolve every QUEST_API_KEYS reference to one key");
	}
	return keys;
};

/**
 * The keys `QUEST_API_KEYS` names, resolved on first use and kept in the
 * spawn's store until `stop --all`. Concurrent launches wait for one resolver.
 */
export async function spawnKeys(dir: string, env: NodeJS.ProcessEnv, resolve: Resolver): Promise<string[]> {
	const entries = (env.QUEST_API_KEYS ?? "").split(/\s+/).filter((entry) => entry !== "");
	if (entries.length === 0) throw new AgentInputError("QUEST_API_KEYS is unset or empty");
	for (const entry of entries) {
		const scheme = /^([a-z][\w+.-]*):\/\//i.exec(entry)?.[1];
		if (scheme !== undefined && scheme !== "op") {
			throw new AgentInputError(`QUEST_API_KEYS has a ${scheme}:// reference; only op:// is supported`);
		}
	}
	const fingerprint = createHash("sha256").update(entries.join("\n")).digest("hex");
	const file = join(dir, "keys.json");
	const lock = join(dir, "resolving");
	for (;;) {
		const stored = load<KeyStore>(file);
		if (stored?.fingerprint === fingerprint) return stored.keys;
		if (!(await lockWithPid(lock))) continue;
		try {
			const references = entries.filter((entry) => entry.startsWith("op://"));
			const resolved = references.length > 0 ? resolve(references, env) : [];
			const keys = entries.map((entry) => (entry.startsWith("op://") ? resolved.shift()! : entry));
			save(file, { fingerprint, keys } satisfies KeyStore);
			return keys;
		} finally {
			rmSync(lock, { force: true });
		}
	}
}

/**
 * Take `lock`, a file holding its owner's pid. Linking a staged file creates
 * it with that pid in one step, so no lock ever lacks an owner. Returns false
 * after waiting on a live owner or clearing a dead one's lock, to recheck.
 * Clearing is not atomic: at worst two launches both resolve, and each writes
 * the same keys.
 */
async function lockWithPid(lock: string): Promise<boolean> {
	const staged = `${lock}.${randomUUID()}.tmp`;
	writeFileSync(staged, String(process.pid), { mode: 0o600 });
	try {
		linkSync(staged, lock);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	} finally {
		rmSync(staged, { force: true });
	}
	// Another launch is resolving; its secret-manager prompt may take a while.
	const owner = load<number>(lock);
	if (owner !== undefined && !alive(owner)) rmSync(lock, { force: true });
	else if (owner !== undefined) await sleep(250);
	return false;
}

/** A live agent, recorded so `stop` can find it by worktree. */
interface Running {
	/** The `quest agent` process that reports the agent's result. */
	pid: number;
	/** The agent CLI process; unset until it spawns. */
	child?: number;
	worktree: string;
	session?: string;
}

/**
 * Each launch writes only its own record, named for its worktree and run, so
 * no two processes update one file. `stop` asks a run to report itself stopped
 * by creating the record's stop file.
 */
const stopPath = (record: string) => record.replace(/\.json$/, ".stop");

/** The records in `dir`, or only those for `worktree`. */
function records(dir: string, worktree?: string): string[] {
	const agents = join(dir, "agents");
	const prefix = worktree === undefined ? "" : `${digest(worktree)}.`;
	try {
		return readdirSync(agents)
			.filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
			.map((name) => join(agents, name));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

/** Whether `record` belongs to a live launch; a dead launch's record and stop file are removed. */
function live(record: string): Running | undefined {
	const running = load<Running>(record);
	if (running !== undefined && alive(running.pid)) return running;
	rmSync(stopPath(record), { force: true });
	rmSync(record, { force: true });
	return undefined;
}

/**
 * Claim `worktree` for this launch. It records itself before looking for
 * other launches, so of two concurrent launches at least one sees the other
 * and refuses; neither ever runs alongside the other.
 */
function claim(dir: string, worktree: string): string {
	const record = join(dir, "agents", `${digest(worktree)}.${randomUUID()}.json`);
	save(record, { pid: process.pid, worktree } satisfies Running);
	// `stop --all` marks the spawn as ending before it lists the records, so a
	// launch it does not list sees the mark here and never starts.
	const ending = load<number>(endingPath(dir));
	if (ending !== undefined && alive(ending)) {
		rmSync(record, { force: true });
		throw new Error("the spawn is ending; `quest agent stop --all` is running");
	}
	if (records(dir, worktree).some((other) => other !== record && live(other) !== undefined)) {
		rmSync(record, { force: true });
		throw new Error(`an agent is already running in ${worktree}; stop it with \`quest agent stop\``);
	}
	return record;
}

/** Holds the pid of a running `stop --all`. */
const endingPath = (dir: string) => join(dir, "ending");

export interface AgentDependencies {
	env: NodeJS.ProcessEnv;
	/** The state directory, normally `agentDirectory()`. */
	base: string;
	resolve: Resolver;
	stdout(text: string): void;
	stderr(text: string): void;
}

export const processDependencies = (out: Pick<AgentDependencies, "stdout" | "stderr">): AgentDependencies => ({
	env: process.env,
	base: agentDirectory(),
	resolve: onePassword,
	...out,
});

/** How much of an agent's output is kept for diagnostics; the rest is read as it streams. */
const TAIL = 64 * 1024;
const tail = (value: string) => (value.length > TAIL ? value.slice(-TAIL) : value);

/**
 * Forward a stream redacted, by whole lines: a key never spans a newline, so
 * one split across chunks is still redacted. A line longer than `TAIL` is
 * forwarded early, keeping only `overlap` characters to finish a split key.
 */
export function redactedLines(redact: (value: string) => string, overlap: number, write: (text: string) => void) {
	let partial = "";
	return {
		data(chunk: string) {
			const buffered = partial + chunk;
			const end = buffered.lastIndexOf("\n") + 1;
			if (end > 0) write(redact(buffered.slice(0, end)));
			partial = buffered.slice(end);
			if (partial.length > TAIL) {
				// Whole keys are redacted first, so only a key's unfinished start can remain raw.
				const redacted = redact(partial);
				const cut = redacted.length - overlap;
				write(redacted.slice(0, cut));
				partial = redacted.slice(cut);
			}
		},
		end() {
			if (partial !== "") write(redact(partial));
		},
	};
}

/** The longest line of agent output read; a longer one is dropped rather than held. */
export const LINE_LIMIT = 16 * 1024 * 1024;

/**
 * Split a stream into lines for `read`, dropping any line longer than `limit`
 * instead of holding it. `end` returns how many lines were dropped.
 */
export function boundedLines(limit: number, read: (line: string) => void) {
	let line = "";
	let dropping = false;
	let dropped = 0;
	return {
		data(chunk: string) {
			const lines = (line + chunk).split("\n");
			line = lines.pop()!;
			for (const complete of lines) {
				if (dropping) dropping = false;
				else if (complete.length > limit) dropped++;
				else read(complete);
			}
			if (line.length > limit) {
				if (!dropping) dropped++;
				dropping = true;
				line = "";
			}
		},
		end(): number {
			if (!dropping) read(line);
			return dropped;
		},
	};
}

/**
 * Native Windows is refused until the agent CLI is resolved to an absolute
 * path: its program search looks in the worktree before PATH, so a worktree
 * could supply its own `claude.exe` and receive the key.
 */
export function refuseUnsupported(platform: NodeJS.Platform = process.platform): void {
	if (platform === "win32") throw new AgentInputError("quest agent does not support native Windows yet; use WSL");
}

/**
 * Run one agent turn in the foreground: a new session with `prompt`, or
 * `session` resumed with it. Prints the session id as soon as it is known,
 * then the cost, outcome, and final reply. Returns the exit status.
 */
export async function runAgent(
	launch: Launch,
	prompt: string,
	session: string | undefined,
	deps: AgentDependencies,
): Promise<number> {
	refuseUnsupported();
	let worktree: string;
	try {
		worktree = realpathSync(launch.worktree);
		if (!statSync(worktree).isDirectory()) throw new Error();
	} catch {
		throw new AgentInputError(`${launch.worktree} is not a directory`);
	}
	// Validate ownership and supervision before any secret-manager or key-store access.
	const checkouts = launch.harness === "codex" ? new Worktrees() : undefined;
	let checkout: string | undefined;
	if (checkouts) {
		systemdScopes.check();
		checkout = checkouts.registered(worktree)?.id;
		if (checkout === undefined)
			throw new AgentInputError(
				`Codex requires a registered Quest checkout; create it with \`quest worktree create\`: ${worktree}`,
			);
	}
	const dir = spawnDirectory(deps.base, worktree);
	const keys = await spawnKeys(dir, deps.env, deps.resolve);
	const key = keys[launch.key - 1];
	if (key === undefined) {
		throw new AgentInputError(`--key ${launch.key} is past the ${keys.length} entries in QUEST_API_KEYS`);
	}
	// Agent output never repeats a key; any that leaks is shown by position.
	const redact = (value: string) =>
		keys.reduce((result, k, index) => result.replaceAll(k, `<key ${index + 1}>`), value);

	const harness = HARNESS[launch.harness];
	const reader = harness.reader();
	const id = session ?? randomUUID();
	const argv = session === undefined ? harness.start(launch, id) : harness.resume(launch, id);
	// Claude Code takes the id this command assigns; Codex announces its own.
	const known = launch.harness === "claude" ? id : session;
	const record = claim(dir, worktree);
	const state: Running = { pid: process.pid, worktree };

	let child: ChildProcess | undefined;
	// An agent whose record cannot be saved, for example because `stop --all`
	// deleted the state, could not be stopped, so it is killed.
	let lost: unknown;
	let dropped = 0;
	const update = () => {
		try {
			save(record, state);
		} catch (error) {
			lost ??= error;
			child?.kill("SIGKILL");
		}
	};
	const announce = (value: string | undefined) => {
		if (value === undefined || value === state.session) return;
		state.session = value;
		update();
		deps.stdout(`session ${value}\n`);
	};

	const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
	let interrupted = 0;
	const forward = (name: (typeof signals)[number]) => {
		interrupted ||= 128 + constants.signals[name];
		child?.kill(name);
	};
	const handlers = signals.map((name) => [name, () => forward(name)] as const);
	for (const [name, handler] of handlers) process.on(name, handler);
	try {
		let supervised: Promise<{ code: number; failure?: string }> | undefined;
		const { code, stdout, stderr } = await new Promise<{ code: number; stdout: string; stderr: string }>(
			(resolve, reject) => {
				const connect = (agent: ChildProcessWithoutNullStreams) => {
					child = agent;
					state.child = agent.pid;
					update();
					announce(known);
					// The kept tails are redacted before they are cut, so a cut never splits a key.
					let out = "";
					let err = "";
					const lines = boundedLines(LINE_LIMIT, (line) => announce(reader.line(line)));
					const forwarded = redactedLines(redact, Math.max(...keys.map((k) => k.length)) - 1, deps.stderr);
					agent.stdout.setEncoding("utf8").on("data", (chunk: string) => {
						out = tail(redact(out + chunk));
						lines.data(chunk);
					});
					agent.stdout.once("end", () => {
						dropped = lines.end();
					});
					agent.stderr.setEncoding("utf8").on("data", (chunk: string) => {
						err = tail(redact(err + chunk));
						forwarded.data(chunk);
					});
					agent.stderr.once("end", () => forwarded.end());
					agent.stdin.on("error", () => {}); // An agent that exits early closes its stdin.
					agent.stdin.end(prompt);
					agent.once("error", (error: NodeJS.ErrnoException) =>
						reject(error.code === "ENOENT" ? new Error(`${argv[0]} is not installed`) : error),
					);
					agent.once("close", (status, signal) =>
						resolve({
							code: status ?? (signal ? 128 + constants.signals[signal] : 1),
							stdout: out,
							stderr: err,
						}),
					);
				};
				const env = launchEnvironment(deps.env, harness.keyVariable, key);
				if (checkouts) {
					supervised = checkouts.run(checkout!, argv, { env, spawned: connect });
					supervised.catch(reject);
				} else connect(spawn(argv[0], argv.slice(1), { cwd: worktree, env, stdio: ["pipe", "pipe", "pipe"] }));
			},
		);
		const released = await supervised;
		if (released?.failure) throw new Error(released.failure);
		if (lost !== undefined) throw lost;
		const exitCode = released?.code ?? code;
		const result = reader.result(stderr);
		announce(result.session);
		// A finished turn is never exhausted, even if its reply mentions credit.
		const outcome: Outcome =
			interrupted || existsSync(stopPath(record))
				? "stopped"
				: exitCode === 0 && !result.failed
					? "finished"
					: result.exhausted
						? "exhausted"
						: "failed";
		if (dropped > 0) {
			deps.stderr(`quest: dropped ${dropped} line(s) of ${argv[0]} output over ${LINE_LIMIT} characters\n`);
		}
		if (outcome === "failed" && result.reply === undefined && stdout.trim() !== "") {
			deps.stderr(`quest: ${argv[0]} printed no result; its output ended with:\n${stdout}\n`);
		}
		if (result.cost !== undefined) deps.stdout(`cost ${result.cost}\n`);
		deps.stdout(`outcome ${outcome}\n`);
		if (result.reply !== undefined) deps.stdout(`\n${redact(result.reply)}\n`);
		return interrupted || EXIT[outcome];
	} finally {
		for (const [name, handler] of handlers) process.off(name, handler);
		rmSync(stopPath(record), { force: true });
		rmSync(record, { force: true });
	}
}

/** How long a stopped agent has to exit before it is killed. */
export const STOP_GRACE_MS = 10_000;

/** Stop the agent running in `worktree`, waiting until its `quest agent` process has reported. */
export async function stopAgent(worktree: string, deps: AgentDependencies): Promise<void> {
	let path: string;
	try {
		path = realpathSync(worktree);
	} catch {
		throw new AgentInputError(`${worktree} is not a directory`);
	}
	let stopped = false;
	for (const record of records(spawnDirectory(deps.base, path), path))
		stopped = (await stopRecord(record, deps)) || stopped;
	if (!stopped) deps.stdout("no agent running\n");
}

/** Stop the launch that wrote `record`, returning false if it is no longer running. */
async function stopRecord(record: string, deps: AgentDependencies): Promise<boolean> {
	let running = live(record);
	// A launch records its agent's pid just after claiming the worktree.
	while (running !== undefined && running.child === undefined) {
		await sleep(100);
		running = live(record);
	}
	if (running?.child === undefined) return false;
	writeFileSync(stopPath(record), "");
	const { pid, worktree } = running;
	const child = running.child;
	// Signal the agent CLI, never the reporting process, which then prints the
	// stopped outcome and removes its record.
	const signal = (name: NodeJS.Signals) => {
		try {
			process.kill(child, name);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	};
	signal("SIGTERM");
	const deadline = Date.now() + STOP_GRACE_MS;
	let killed = false;
	let session = running.session;
	for (let current: Running | undefined = running; current !== undefined && alive(pid); current = load(record)) {
		session = current.session ?? session;
		if (!killed && Date.now() > deadline) {
			signal("SIGKILL");
			killed = true;
		}
		await sleep(100);
	}
	live(record);
	deps.stdout(`stopped ${worktree}${session ? ` session ${session}` : ""}\n`);
	return true;
}

/** End the spawn for the repository holding `root`: stop every agent, then delete the resolved keys. */
export async function stopAll(root: string, deps: AgentDependencies): Promise<void> {
	const dir = spawnDirectory(deps.base, root);
	save(endingPath(dir), process.pid);
	for (const record of records(dir)) await stopRecord(record, deps);
	rmSync(dir, { recursive: true, force: true });
	deps.stdout("deleted the resolved keys\n");
}
