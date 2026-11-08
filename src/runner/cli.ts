// The `quest runner` commands: sign the machine in to kix, sign agent
// accounts in (Claude and Codex subscriptions into the runner's CLIProxyAPI
// pool, opencode accounts with opencode's own flow), and run jobs in the
// foreground.
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import type { Adapter, AdapterName } from "./adapter";
import { Claude } from "./claude";
import { Opencode } from "./opencode";
import { type Account, type Cli, type Login, POOL_PROVIDER, RunnerHome, defaultHome } from "./home";
import type { Job } from "./protocol";
import { type Endpoint, poolLogin, readCredential, startProxy, writeProxyConfig } from "./proxy";
import { Runner } from "./runner";
import { sandboxRefusal, unixSocketRefusal } from "./sandbox";
import { which } from "../cli/program";

export const DEFAULT_URL = "https://quest.moq.dev";

const run = promisify(execFile);

/** A runner command's mistake in its arguments or setup, reported as a usage error. */
export class RunnerInputError extends Error {}

export interface RunnerIO {
	stdout(text: string): void;
	stderr(text: string): void;
	env: NodeJS.ProcessEnv;
	fetch?: typeof fetch;
}

/** Linux and macOS only: there are no Windows runners. */
function platform(): "linux" | "darwin" {
	if (process.platform === "linux" || process.platform === "darwin") return process.platform;
	throw new RunnerInputError("quest runner runs on Linux and macOS only");
}

/**
 * The programs a runner runs: each agent CLI, sandbox-runtime, which runs
 * opencode's commands, and CLIProxyAPI, which pools Claude and Codex accounts.
 */
const BINARIES: Record<AdapterName | "srt" | "cliproxy", { binary: string; variable: string; product: string }> = {
	claude: { binary: "claude", variable: "QUEST_RUNNER_CLAUDE", product: "Claude Code" },
	opencode: { binary: "opencode", variable: "QUEST_RUNNER_OPENCODE", product: "opencode" },
	srt: { binary: "srt", variable: "QUEST_RUNNER_SRT", product: "sandbox-runtime (@anthropic-ai/sandbox-runtime)" },
	cliproxy: { binary: "cliproxyapi", variable: "QUEST_RUNNER_CLIPROXY", product: "CLIProxyAPI" },
};

/**
 * A program's binary: its `QUEST_RUNNER_*` variable, or the program on PATH.
 * It is resolved before any devShell is entered, so a project cannot
 * substitute its own for the one the runner trusts.
 */
export function binaryPath(name: keyof typeof BINARIES, env: NodeJS.ProcessEnv): string {
	const { binary, variable, product } = BINARIES[name];
	const configured = env[variable];
	if (configured) {
		if (!isAbsolute(configured)) throw new RunnerInputError(`${variable} must be an absolute path`);
		return configured;
	}
	const found = which(binary, env);
	if (!found) throw new RunnerInputError(`${binary} is not installed; install ${product} or set ${variable}`);
	return found;
}

/**
 * opencode's adapter needs sandbox-runtime too, since that runs its jobs'
 * commands, and Claude Code's the proxy its pool is behind.
 */
export function adapterFor(
	name: AdapterName,
	env: NodeJS.ProcessEnv,
	proxy: Pick<Endpoint, "origin" | "keyFile">,
): Adapter {
	const binary = binaryPath(name, env);
	return name === "opencode" ? new Opencode(binary, binaryPath("srt", env), env) : new Claude(binary, proxy, env);
}

/**
 * The adapters a running runner launches jobs with, each resolved once, the
 * first time an account needs it. On Linux the sandbox needs bubblewrap and
 * socat, and bubblewrap must be able to make its namespaces, so they are
 * checked then; macOS has Seatbelt built in. Claude Code runs them itself, and
 * sandbox-runtime for opencode, which on Linux must also refuse Unix sockets.
 */
export function runnerAdapters(
	env: NodeJS.ProcessEnv,
	proxy: Pick<Endpoint, "origin" | "keyFile">,
): (name: AdapterName) => Adapter {
	const adapters = new Map<AdapterName, Adapter>();
	let sandboxed = process.platform !== "linux";
	return (name) => {
		let adapter = adapters.get(name);
		if (adapter) return adapter;
		if (!sandboxed) {
			const [bwrap, socat] = [which("bwrap", env), which("socat", env)];
			const missing = [bwrap ? null : "bwrap", socat ? null : "socat"].filter((tool) => tool !== null);
			if (missing.length)
				throw new RunnerInputError(
					`${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not installed; jobs run their commands in an OS sandbox (install bubblewrap and socat, or use the flake's runner package)`,
				);
			const refusal = sandboxRefusal(bwrap!);
			if (refusal) throw new RunnerInputError(refusal);
			sandboxed = true;
		}
		adapter = adapterFor(name, env, proxy);
		if (adapter instanceof Opencode && process.platform === "linux") {
			const refusal = unixSocketRefusal(adapter.srt, env);
			if (refusal) throw new RunnerInputError(refusal);
		}
		adapters.set(name, adapter);
		return adapter;
	};
}

function home(io: RunnerIO): RunnerHome {
	return new RunnerHome(defaultHome(io.env));
}

async function whoami(login: Pick<Login, "url" | "token">, fetcher: typeof fetch) {
	const response = await fetcher(`${login.url}/api/runner`, { headers: { Authorization: `Bearer ${login.token}` } });
	if (response.status === 401) return null;
	if (!response.ok) throw new Error(`kix answered ${response.status}`);
	return (await response.json()) as { id: string; name: string };
}

/**
 * Sign this machine in: make a token, show a link carrying only its hash,
 * and wait until the signed-in owner approves it on kix.
 */
export async function login(
	io: RunnerIO,
	options: { url: string; name?: string; timeoutMs?: number; intervalMs?: number },
): Promise<number> {
	const url = options.url.replace(/\/$/, "");
	if (!/^https?:\/\/[^/]+$/.test(url))
		throw new RunnerInputError("--url must be an origin such as https://quest.moq.dev");
	const name = (options.name ?? hostname()).trim();
	if (!name || name.length > 100) throw new RunnerInputError("--name must be 1 to 100 characters");
	const state = home(io);
	const token = randomBytes(32).toString("base64url");
	const key = createHash("sha256").update(token).digest("hex");
	const link = `${url}/runners?${new URLSearchParams({ name, platform: platform(), key })}`;
	io.stdout(`Open this link, signed in to kix, and connect ${name}:\n\n  ${link}\n\nWaiting for approval...\n`);
	const fetcher = io.fetch ?? fetch;
	const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
	while (Date.now() < deadline) {
		const runner = await whoami({ url, token }, fetcher).catch(() => null);
		if (runner) {
			state.saveLogin({ url, token, id: runner.id, name: runner.name });
			io.stdout(
				`Connected ${runner.name}. Add an account with \`quest runner account add\`, then run \`quest runner\`.\n`,
			);
			return 0;
		}
		await sleep(options.intervalMs ?? 2000);
	}
	io.stderr("quest: the link was not approved in time; run `quest runner login` again\n");
	return 1;
}

/**
 * Add an account: a Claude or Codex subscription signs in to the pool through
 * the proxy's own flow, a Console API key from ANTHROPIC_API_KEY joins the
 * Claude pool, and an opencode account signs in with opencode's flow in its
 * own home.
 */
export async function addAccount(
	io: RunnerIO,
	options: { cli: Cli; console: boolean; label?: string; model?: string },
): Promise<number> {
	platform();
	const label = options.label?.trim();
	if (label !== undefined && (!label || label.length > 100))
		throw new RunnerInputError("--label must be 1 to 100 characters");
	if (options.console && options.cli !== "claude")
		throw new RunnerInputError("--console adds an Anthropic Console API key to the Claude pool");
	const model = options.model?.trim();
	if (model !== undefined && options.cli !== "opencode")
		throw new RunnerInputError("--model is for opencode; the pool serves the model each CLI asks for");
	if (model !== undefined && !/^[^/\s]+\/\S+$/.test(model))
		throw new RunnerInputError("--model must be provider/model, such as openai/gpt-5.5");
	const state = home(io);
	const accounts = state.accounts();
	const id = state.newId();
	const added = (account: Account) => {
		state.saveAccounts([...accounts, account]);
		io.stdout(`Added ${account.label} (${account.kind}) as ${id}.\n`);
		return 0;
	};
	if (options.cli === "opencode") {
		const adapter = new Opencode(binaryPath("opencode", io.env), binaryPath("srt", io.env), io.env);
		const dir = state.accountHome(id);
		try {
			await adapter.login(dir);
			const signedIn = await adapter.status(dir);
			if (!signedIn) throw new Error("the account did not finish signing in");
			if (model) Opencode.setModel(dir, model);
			const { provider, kind } = signedIn;
			return added({ id, cli: "opencode", provider, kind, label: label ?? signedIn.label.slice(0, 100) });
		} catch (error) {
			rmSync(dir, { recursive: true, force: true });
			throw error;
		}
	}
	if (options.console) {
		const key = io.env.ANTHROPIC_API_KEY?.trim();
		if (!key) throw new RunnerInputError("--console reads the Console API key from ANTHROPIC_API_KEY");
		if (!/^sk-ant-[\w-]+$/.test(key))
			throw new RunnerInputError("ANTHROPIC_API_KEY is not an Anthropic API key (sk-ant-...)");
		if (accounts.some((account) => account.key === key))
			throw new RunnerInputError("this Console API key is already in the Claude pool");
		added({
			id,
			cli: "claude",
			provider: POOL_PROVIDER.claude,
			kind: "api-key",
			label: label ?? `Console API key ...${key.slice(-4)}`,
			key,
		});
		writeProxyConfig(state);
		return 0;
	}
	const pool = options.cli;
	// Over SSH the browser is elsewhere: Claude's link is pasted back, and Codex takes a device code.
	const credential = await poolLogin(binaryPath("cliproxy", io.env), state, pool, {
		remote: Boolean(io.env.SSH_CONNECTION),
		env: io.env,
	});
	const signedIn = readCredential(state, credential);
	if (signedIn.pool !== pool || !signedIn.email)
		throw new Error(`the sign-in saved ${credential}, which is not a ${pool} login`);
	const existing = accounts.find((account) => account.credential === credential);
	if (existing) {
		if (label) existing.label = label;
		state.saveAccounts(accounts);
		io.stdout(`Signed ${existing.label} in again as ${existing.id}.\n`);
		return 0;
	}
	return added({
		id,
		cli: pool,
		provider: POOL_PROVIDER[pool],
		kind: "subscription",
		label: label ?? signedIn.email.slice(0, 100),
		credential,
	});
}

export function listAccounts(io: RunnerIO): number {
	const state = home(io);
	const accounts = state.accounts();
	const limits = state.limits();
	if (!accounts.length) io.stdout("No accounts; add one with `quest runner account add`.\n");
	for (const account of accounts) {
		// A pooled account sits out with its pool.
		const until = limits[account.cli === "opencode" ? account.id : account.cli] ?? 0;
		const limited = until > Date.now() ? `\tlimited until ${new Date(until).toISOString()}` : "";
		io.stdout(`${account.id}\t${account.cli}\t${account.kind}\t${account.label}${limited}\n`);
	}
	return 0;
}

export function removeAccount(io: RunnerIO, id: string): number {
	const state = home(io);
	const removed = state.removeAccount(id);
	if (!removed) throw new RunnerInputError(`no account ${id}; \`quest runner account list\` shows them`);
	if (removed.cli !== "opencode") {
		writeProxyConfig(state);
		if (!state.accounts().some((account) => account.cli === removed.cli)) state.limit(removed.cli, null);
	}
	io.stdout(`Removed ${removed.label}.\n`);
	return 0;
}

/**
 * The job's devShell environment, which its sandboxed commands source: the
 * script `nix print-dev-env` prints for the flake at the job's revision. The
 * runner evaluates and builds it through the host's Nix, so it reads the
 * committed revision rather than a checkout the agent may have edited, and
 * runs nothing from it; the shellHook runs inside the sandbox. A project
 * without a flake is bootstrapped in the runner's own environment.
 */
export async function devShell(
	job: Job,
	repository: string,
	env: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<string | null> {
	if (job.workflow === "bootstrap") return null;
	const url = `git+file://${repository.split("/").map(encodeURIComponent).join("/")}?rev=${job.revision}`;
	try {
		// Trusted revisions only: their flake's nixConfig, such as its substituters, is honored.
		const { stdout } = await run("nix", ["print-dev-env", "--accept-flake-config", "--no-write-lock-file", url], {
			env,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			signal,
		});
		return stdout;
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr?.trim().split("\n").slice(-20).join("\n");
		throw new Error(`could not build the devShell at ${job.revision}${stderr ? `:\n${stderr}` : ""}`);
	}
}

/** Run jobs in the foreground, with the runner's CLIProxyAPI, until interrupted. */
export async function runRunner(io: RunnerIO, options: { slots: number }): Promise<number> {
	platform();
	const state = home(io);
	const current = state.login();
	if (!current) throw new RunnerInputError("this machine is not signed in; run `quest runner login` first");
	const seats = state.seats();
	if (!seats.length)
		throw new RunnerInputError(
			"no account runs jobs; add a Claude or opencode account with `quest runner account add`",
		);
	const cliproxy = binaryPath("cliproxy", io.env);
	if (!which("nix", io.env))
		throw new RunnerInputError("nix is not installed; every job runs in its project's devShell");
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
	} catch {
		throw new RunnerInputError("git is not installed");
	}
	const fetcher = io.fetch ?? fetch;
	if ((await whoami(current, fetcher)) === null)
		throw new RunnerInputError("kix no longer accepts this runner's token; run `quest runner login` again");
	const log = (line: string) => io.stderr(`${new Date().toISOString()} ${line}\n`);
	const held = state.hold();
	let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
	const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
	let stop = () => {};
	try {
		proxy = await startProxy(cliproxy, state, io.env);
		log(`CLIProxyAPI pools this runner's Claude and Codex accounts at ${proxy.origin}`);
		// Only the CLIs some seat uses, resolved before any job enters a devShell.
		const adapter = runnerAdapters(io.env, proxy);
		for (const seat of seats) adapter(seat.adapter);
		const runner = new Runner({
			home: state,
			login: current,
			slots: options.slots,
			// An account added while the runner runs uses a CLI resolved, and a sandbox checked, then.
			adapter: (seat) => adapter(seat.adapter),
			proxy,
			devShell: (job, repository, signal) => devShell(job, repository, io.env, signal),
			remote: (job) => `https://github.com/${job.owner}/${job.name}.git`,
			env: io.env,
			fetch: fetcher,
			log,
		});
		stop = () => {
			log("stopping: publishing running work so it moves to another runner");
			void runner.shutdown();
		};
		for (const signal of signals) process.on(signal, stop);
		// Without its proxy no Claude job or review can run, so the runner hands its jobs on and exits.
		let lost: string | undefined;
		void proxy.exited.then((reason) => {
			if (proxy?.stopping) return;
			lost = reason;
			log(reason);
			stop();
		});
		log(`${current.name} running up to ${options.slots} job${options.slots === 1 ? "" : "s"} for ${current.url}`);
		runner.start();
		const end = await runner.done;
		if (end === "replaced") {
			io.stderr("quest: another `quest runner` took over this runner's connection\n");
			return 1;
		}
		if (lost !== undefined) {
			io.stderr("quest: the runner's CLIProxyAPI exited, so the runner stopped\n");
			return 1;
		}
		return 0;
	} finally {
		for (const signal of signals) process.off(signal, stop);
		await proxy?.stop();
		held.release();
	}
}
