// The runner's own CLIProxyAPI, which pools its Claude and Codex accounts: Claude
// Code jobs and reviews and Codex reviews reach their models through it, and it
// rotates between the pooled accounts, cooling one down when its provider
// refuses it. It listens on loopback with a client key only the runner's CLIs
// get, never a subscription's own token. Its config, client key, credentials,
// and logs live in the runner's home, which job commands cannot read.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import { baseEnvironment, signalGroup, STOP_GRACE_MS } from "./adapter";
import type { Account, Pool, RunnerHome } from "./home";

/** How the runner's CLIs reach the proxy. */
export interface Endpoint {
	/** The proxy's origin, Anthropic's API there; OpenAI's is under `/v1`. */
	origin: string;
	/** The client key the proxy accepts. */
	key: string;
	/** The file holding `key`, for Claude Code's `apiKeyHelper`, so the key stays out of its commands' environment. */
	keyFile: string;
}

export interface RunningProxy extends Endpoint {
	/** Settles with the reason once the proxy exits, whether stopped or not. */
	exited: Promise<string>;
	/** Whether `stop` was called, so its exit is expected. */
	readonly stopping: boolean;
	/** When `pool` can serve `model` again, from the proxy's own cooldown, or null when it serves it now or does not say. */
	reset(pool: Pool, model: string): Promise<number | null>;
	stop(): Promise<void>;
}

/** What the proxy prints once it listens. */
const READY = /^API server started successfully on: /m;

/** How long the proxy has to start listening. */
const START_LIMIT_MS = 60_000;

const configPath = (home: RunnerHome) => join(home.proxyDir(), "config.yaml");
const authDir = (home: RunnerHome) => join(home.proxyDir(), "auth");

/** The proxy's client key, made once and kept user-only in the runner's home. */
export function clientKey(home: RunnerHome): { key: string; keyFile: string } {
	const keyFile = join(home.proxyDir(), "client-key");
	try {
		return { key: readFileSync(keyFile, "utf8").trim(), keyFile };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const key = randomBytes(32).toString("base64url");
	writeFileSync(keyFile, key, { mode: 0o600, flag: "wx" });
	return { key, keyFile };
}

/**
 * The proxy's config, in JSON, which it reads as YAML: loopback only, the
 * management API and its downloaded panel off, round-robin routing that keeps
 * a session on one credential for its prompt cache, cooldowns kept across
 * restarts, and the pooled Console API keys.
 */
export function proxyConfig(home: RunnerHome, accounts: Account[], port: number): Record<string, unknown> {
	const keys = accounts.filter((account) => account.cli === "claude" && account.key);
	return {
		"config-version": 8,
		server: { host: "127.0.0.1", port },
		management: { "secret-key": "", "disable-control-panel": true, "disable-auto-update-panel": true },
		access: { "api-keys": [clientKey(home).key] },
		oauth: { "auth-dir": authDir(home) },
		routing: {
			strategy: "round-robin",
			"session-affinity": true,
			retry: { "request-retry": 3, "max-retry-interval": 30 },
			cooldown: { "save-cooldown-status": true },
		},
		...(keys.length && {
			"api-keys": { claude: keys.map((account) => ({ name: account.id, keys: [{ "api-key": account.key }] })) },
		}),
		observability: {
			logs: { "logging-to-file": true, "logs-max-total-size-mb": 64, "request-log": false },
			usage: { "usage-statistics-enabled": false },
		},
	};
}

/**
 * Write the proxy's config for the runner's current accounts, on `port` or the
 * one it already names. A running proxy reloads it, so an account added or
 * removed while the runner runs joins or leaves the pool at once.
 */
export function writeProxyConfig(home: RunnerHome, port?: number): string {
	const path = configPath(home);
	let current = 0;
	try {
		const server = (JSON.parse(readFileSync(path, "utf8")) as { server?: { port?: unknown } }).server;
		if (typeof server?.port === "number") current = server.port;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	home.proxyDir();
	// In place rather than renamed over, so the proxy's watcher on the file keeps seeing it.
	writeFileSync(path, `${JSON.stringify(proxyConfig(home, home.accounts(), port ?? current), null, 2)}\n`, {
		mode: 0o600,
	});
	return path;
}

/** A free loopback port for the proxy. */
async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const { port } = server.address() as { port: number };
	await new Promise((resolve) => server.close(resolve));
	return port;
}

/** Start the runner's proxy on a free loopback port, and wait until it listens. */
export async function startProxy(binary: string, home: RunnerHome, env: NodeJS.ProcessEnv): Promise<RunningProxy> {
	const { key, keyFile } = clientKey(home);
	const port = await freePort();
	const config = writeProxyConfig(home, port);
	const child: ChildProcess = spawn(binary, ["-config", config], {
		cwd: home.proxyDir(),
		env: baseEnvironment(env),
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	let output = "";
	const tail = () => output.trim().split("\n").slice(-10).join("\n");
	let ready!: () => void;
	const listening = new Promise<void>((resolve) => (ready = resolve));
	const read = (chunk: string) => {
		output = (output + chunk).slice(-16 * 1024);
		if (READY.test(output)) ready();
	};
	child.stdout!.setEncoding("utf8").on("data", read);
	child.stderr!.setEncoding("utf8").on("data", read);
	const exited = new Promise<string>((resolve) => {
		child.once("error", (error) => resolve(`could not start ${binary}: ${error.message}`));
		child.once("close", (code, signal) =>
			resolve(`CLIProxyAPI exited ${signal ?? code}${tail() ? `:\n${tail()}` : ""}`),
		);
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const failed = await Promise.race([
		listening.then(() => null),
		exited,
		new Promise<string>((resolve) => {
			timer = setTimeout(
				() => resolve(`CLIProxyAPI did not listen within ${START_LIMIT_MS / 1000}s:\n${tail()}`),
				START_LIMIT_MS,
			);
		}),
	]).finally(() => clearTimeout(timer));
	let stopping = false;
	const stop = async () => {
		stopping = true;
		signalGroup(child.pid, "SIGTERM");
		const killer = setTimeout(() => signalGroup(child.pid, "SIGKILL"), STOP_GRACE_MS);
		await exited;
		clearTimeout(killer);
	};
	if (failed !== null) {
		await stop();
		throw new Error(failed);
	}
	const origin = `http://127.0.0.1:${port}`;
	return {
		origin,
		key,
		keyFile,
		exited,
		get stopping() {
			return stopping;
		},
		stop,
		reset: (pool, model) => reset({ origin, key }, pool, model),
	};
}

/**
 * Ask the proxy when `pool` serves `model` again. The CLIs show its cooldown
 * without the reset, which the proxy gives a request it refuses in
 * `Retry-After`, without asking any provider. A pool that serves it again
 * answers the smallest request instead.
 */
export async function reset(
	endpoint: Pick<Endpoint, "origin" | "key">,
	pool: Pool,
	model: string,
	now = Date.now(),
): Promise<number | null> {
	const claude = pool === "claude";
	const response = await fetch(`${endpoint.origin}/v1/${claude ? "messages" : "responses"}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${endpoint.key}`,
			"Content-Type": "application/json",
			...(claude && { "anthropic-version": "2023-06-01" }),
		},
		body: JSON.stringify(
			claude
				? { model, max_tokens: 1, messages: [{ role: "user", content: "." }] }
				: { model, input: ".", max_output_tokens: 16 },
		),
		signal: AbortSignal.timeout(60_000),
	});
	await response.body?.cancel();
	if (response.status !== 429) return null;
	const seconds = Number(response.headers.get("retry-after"));
	return Number.isFinite(seconds) && seconds > 0 ? now + seconds * 1000 : null;
}

/** The email and pool of a credential the proxy saved. */
export function readCredential(home: RunnerHome, file: string): { pool: string; email: string } {
	const stored = JSON.parse(readFileSync(join(authDir(home), file), "utf8")) as Record<string, unknown>;
	return {
		pool: typeof stored.type === "string" ? stored.type : "",
		email: typeof stored.email === "string" ? stored.email : "",
	};
}

/** Each credential file in the proxy's auth directory, with its content, which a sign-in rewrites with new tokens. */
function credentials(home: RunnerHome): Map<string, string> {
	const dir = authDir(home);
	const files = new Map<string, string>();
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return files;
	}
	for (const name of names) if (name.endsWith(".json")) files.set(name, readFileSync(join(dir, name), "utf8"));
	return files;
}

/**
 * Sign a subscription into the pool through the proxy's own flow, and return
 * the credential file it saved. `remote` picks the flows for a machine reached
 * over SSH: Claude's prints its link without opening a browser and takes the
 * pasted callback URL, and Codex's takes a device code instead.
 */
export async function poolLogin(
	binary: string,
	home: RunnerHome,
	pool: Pool,
	options: { remote: boolean; env: NodeJS.ProcessEnv },
): Promise<string> {
	const config = writeProxyConfig(home);
	const before = credentials(home);
	const flags =
		pool === "claude"
			? ["-claude-login", ...(options.remote ? ["-no-browser"] : [])]
			: [options.remote ? "-codex-device-login" : "-codex-login"];
	await new Promise<void>((resolve, reject) => {
		const child = spawn(binary, ["-config", config, ...flags], {
			cwd: home.proxyDir(),
			env: baseEnvironment(options.env),
			stdio: "inherit",
		});
		child.once("error", reject);
		child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`the sign-in exited ${code}`))));
	});
	// The proxy exits 0 after a failed sign-in too, so only a saved credential counts.
	const saved = [...credentials(home)].filter(([name, content]) => before.get(name) !== content);
	if (saved.length !== 1) throw new Error("the account did not finish signing in");
	return saved[0]![0];
}
