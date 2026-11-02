// The `quest runner` commands: sign the machine in to kix, sign agent
// accounts in with their own CLIs, and run jobs in the foreground.
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
import { type Account, type Login, RunnerHome, defaultHome } from "./home";
import type { Job } from "./protocol";
import { Runner } from "./runner";
import { which } from "../cli/program";

export const DEFAULT_URL = "https://kix.quest";

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

const CLIS: Record<AdapterName, { binary: string; variable: string; product: string }> = {
	claude: { binary: "claude", variable: "QUEST_RUNNER_CLAUDE", product: "Claude Code" },
	opencode: { binary: "opencode", variable: "QUEST_RUNNER_OPENCODE", product: "opencode" },
};

/**
 * An agent CLI's binary: its `QUEST_RUNNER_*` variable, or the CLI on PATH.
 * It is resolved before any devShell is entered, so a project cannot
 * substitute its own CLI for the one the account signed in with.
 */
export function cliBinary(name: AdapterName, env: NodeJS.ProcessEnv): string {
	const { binary, variable, product } = CLIS[name];
	const configured = env[variable];
	if (configured) {
		if (!isAbsolute(configured)) throw new RunnerInputError(`${variable} must be an absolute path`);
		return configured;
	}
	const found = which(binary, env);
	if (!found) throw new RunnerInputError(`${binary} is not installed; install ${product} or set ${variable}`);
	return found;
}

export function adapterFor(name: AdapterName, env: NodeJS.ProcessEnv): Adapter {
	const binary = cliBinary(name, env);
	return name === "opencode" ? new Opencode(binary, env) : new Claude(binary, env);
}

/**
 * The adapters a running runner launches jobs with, each resolved once, the
 * first time an account needs it. Claude Code sandboxes its jobs' commands,
 * which on Linux needs bubblewrap and socat, so they are checked then; macOS
 * has Seatbelt built in. opencode runs unsandboxed, so it needs neither.
 */
export function runnerAdapters(env: NodeJS.ProcessEnv): (name: AdapterName) => Adapter {
	const adapters = new Map<AdapterName, Adapter>();
	return (name) => {
		let adapter = adapters.get(name);
		if (adapter) return adapter;
		const missing =
			name === "claude" && process.platform === "linux"
				? ["bwrap", "socat"].filter((tool) => !which(tool, env))
				: [];
		if (missing.length)
			throw new RunnerInputError(
				`${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not installed; Claude Code jobs run in an OS sandbox (install bubblewrap and socat, or use the flake's runner package)`,
			);
		adapters.set(name, (adapter = adapterFor(name, env)));
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
		throw new RunnerInputError("--url must be an origin such as https://kix.quest");
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

/** Sign a new account in with its CLI's own flow, in its own home. */
export async function addAccount(
	io: RunnerIO,
	options: { cli: AdapterName; console: boolean; label?: string; model?: string },
): Promise<number> {
	platform();
	const label = options.label?.trim();
	if (label !== undefined && (!label || label.length > 100))
		throw new RunnerInputError("--label must be 1 to 100 characters");
	if (options.console && options.cli !== "claude")
		throw new RunnerInputError("--console is for Claude Code; opencode asks how to sign in");
	const model = options.model?.trim();
	if (model !== undefined && options.cli !== "opencode")
		throw new RunnerInputError("--model is for opencode; Claude Code picks its own");
	if (model !== undefined && !/^[^/\s]+\/\S+$/.test(model))
		throw new RunnerInputError("--model must be provider/model, such as openai/gpt-5.5");
	const state = home(io);
	const adapter = adapterFor(options.cli, io.env);
	const { id, home: dir } = state.newAccount();
	try {
		await adapter.login(dir, { console: options.console });
		const signedIn = await adapter.status(dir);
		if (!signedIn) throw new Error("the account did not finish signing in");
		if (model) Opencode.setModel(dir, model);
		const account: Account = {
			id,
			adapter: adapter.name,
			provider: signedIn.provider,
			kind: signedIn.kind,
			label: label ?? signedIn.label.slice(0, 100),
		};
		state.saveAccounts([...state.accounts(), account]);
		io.stdout(`Added ${account.label} (${account.kind}) as ${id}.\n`);
		return 0;
	} catch (error) {
		rmSync(dir, { recursive: true, force: true });
		throw error;
	}
}

export function listAccounts(io: RunnerIO): number {
	const accounts = home(io).accounts();
	if (!accounts.length) io.stdout("No accounts; add one with `quest runner account add`.\n");
	for (const account of accounts) {
		const limited = account.limitedUntil && account.limitedUntil > Date.now();
		io.stdout(
			`${account.id}\t${account.kind}\t${account.label}${limited ? `\tlimited until ${new Date(account.limitedUntil!).toISOString()}` : ""}\n`,
		);
	}
	return 0;
}

export function removeAccount(io: RunnerIO, id: string): number {
	const removed = home(io).removeAccount(id);
	if (!removed) throw new RunnerInputError(`no account ${id}; \`quest runner account list\` shows them`);
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

/** Run jobs in the foreground until interrupted. */
export async function runRunner(io: RunnerIO, options: { slots: number }): Promise<number> {
	platform();
	const state = home(io);
	const current = state.login();
	if (!current) throw new RunnerInputError("this machine is not signed in; run `quest runner login` first");
	const accounts = state.accounts();
	if (!accounts.length) throw new RunnerInputError("no accounts; add one with `quest runner account add`");
	// Only the CLIs some account uses, resolved before any job enters a devShell.
	const adapter = runnerAdapters(io.env);
	for (const account of accounts) adapter(account.adapter);
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
	const runner = new Runner({
		home: state,
		login: current,
		slots: options.slots,
		// An account added while the runner runs uses a CLI resolved, and a sandbox checked, then.
		adapter: (account) => adapter(account.adapter),
		devShell: (job, repository, signal) => devShell(job, repository, io.env, signal),
		remote: (job) => `https://github.com/${job.owner}/${job.name}.git`,
		env: io.env,
		fetch: fetcher,
		log,
	});
	const held = state.hold();
	const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
	const stop = () => {
		log("stopping: publishing running work so it moves to another runner");
		void runner.shutdown();
	};
	for (const signal of signals) process.on(signal, stop);
	log(`${current.name} running up to ${options.slots} job${options.slots === 1 ? "" : "s"} for ${current.url}`);
	runner.start();
	try {
		const end = await runner.done;
		if (end === "replaced") {
			io.stderr("quest: another `quest runner` took over this runner's connection\n");
			return 1;
		}
		return 0;
	} finally {
		for (const signal of signals) process.off(signal, stop);
		held.release();
	}
}
