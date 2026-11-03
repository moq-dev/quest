// The Claude Code adapter. It runs the unmodified `claude` binary headless
// (`claude -p` with stream-json output), signed in by Claude Code's own flow
// in an isolated `CLAUDE_CONFIG_DIR` per account; the runner never reads its
// tokens. The kix tools attach as an HTTP MCP server, and AskUserQuestion is
// disabled so every question goes through kix's `ask` tool instead.
//
// Claude Code's own sandbox confines every shell command, and permission
// rules confine its file tools, which the sandbox does not cover. Only the
// runner's settings apply: the checkout's own settings could add hooks that
// run outside the sandbox, so neither they nor its CLAUDE.md are loaded.
import { execFile, spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { boundedLines, LINE_LIMIT } from "../cli/agent";
import {
	type Adapter,
	baseEnvironment,
	type Exit,
	type Launch,
	type Running,
	type SignedIn,
	signalGroup,
	STOP_GRACE_MS,
} from "./adapter";
import { keptEnvironment, type Sandbox } from "./sandbox";
import { WAIT_LIMIT } from "./wait";

const run = promisify(execFile);

/** How long Claude Code waits on one kix tool call: the longest `wait`, with margin. */
export const TOOL_TIMEOUT_MS = WAIT_LIMIT + 5 * 60_000;

/** The environment for an account's Claude Code, with the account's own home. */
export function accountEnvironment(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
	return { ...baseEnvironment(env), CLAUDE_CONFIG_DIR: home };
}

/**
 * A job's environment: the account's home, the sandbox's temporary directory
 * and per-command script, and little else. Not CLAUDE_CODE_SUBPROCESS_ENV_SCRUB:
 * it covers files such as `.env` and `package.json` with mount points that stay
 * behind in the checkout as empty files, which kix would then publish.
 */
export function jobEnvironment(env: NodeJS.ProcessEnv, home: string, sandbox: Sandbox): NodeJS.ProcessEnv {
	return {
		...keptEnvironment(env),
		CLAUDE_CONFIG_DIR: home,
		TMPDIR: sandbox.tmp,
		CLAUDE_ENV_FILE: sandbox.env,
	};
}

/**
 * Claude Code settings for a job. In `dontAsk` mode anything not allowed is
 * refused: shell commands run only inside the sandbox, the file tools edit
 * only the checkout and read only the checkout (outside it Claude Code would
 * ask), and WebFetch, which would run outside the sandbox, is off.
 */
export function claudeSettings(sandbox: Sandbox): Record<string, unknown> {
	return {
		sandbox: {
			enabled: true,
			failIfUnavailable: true,
			allowUnsandboxedCommands: false,
			// Added in 2.1.305; enabling this lets commands escape filesystem isolation.
			allowNestedUserNamespaces: false,
			autoAllowBashIfSandboxed: true,
			filesystem: {
				denyRead: sandbox.deny,
				allowRead: [sandbox.cwd, sandbox.repository, sandbox.tmp],
				allowWrite: [sandbox.tmp],
			},
			network: { allowedDomains: sandbox.domains, strictAllowlist: true },
		},
		// A leading `//` makes a rule's path absolute.
		permissions: { allow: ["Bash", `Edit(/${sandbox.cwd}/**)`, "WebSearch", "mcp__kix"] },
	};
}

function json(line: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Messages Claude Code ends a turn with when the plan or key cannot pay for it. */
const LIMIT = /usage limit|limit reached|hit your (?:usage )?limit|out of extra usage|credit balance is too low/i;

/**
 * Reads one session's stream-json output. Limits show up as a rejected
 * `rate_limit_event`, an assistant message flagged `rate_limit` or
 * `billing_error`, or a limit message in the result.
 */
export function streamReader() {
	let result: Record<string, unknown> | undefined;
	let limited: { until: number | null } | null = null;
	return {
		line(line: string) {
			const event = json(line);
			if (!event) return;
			if (event.type === "result") result = event;
			if (event.type === "rate_limit_event") {
				const info = event.rate_limit_info as Record<string, unknown> | undefined;
				const resets = typeof info?.resetsAt === "number" ? info.resetsAt * 1000 : null;
				if (info?.status === "rejected") limited = { until: resets };
			}
			if (event.type === "assistant" && (event.error === "rate_limit" || event.error === "billing_error"))
				limited ??= { until: null };
		},
		exit(code: number, stderr: string): Exit {
			const reply = typeof result?.result === "string" ? result.result : undefined;
			const failed = code !== 0 || result === undefined || result.is_error === true;
			if (failed && !limited && LIMIT.test(`${reply ?? ""}\n${stderr}`)) {
				// Older releases end the message with `|<epoch seconds>` of the reset.
				const epoch = /\|(\d{10})\b/.exec(reply ?? "")?.[1];
				limited = { until: epoch ? Number(epoch) * 1000 : null };
			}
			const error = failed && !reply ? stderr.trim().split("\n").slice(-20).join("\n") : undefined;
			return { limited, failed, reply: reply ?? (error || undefined) };
		},
	};
}

export class Claude implements Adapter {
	readonly name = "claude";

	/** `binary` is an absolute path, so a devShell's PATH cannot substitute another `claude`. */
	constructor(
		readonly binary: string,
		readonly env: NodeJS.ProcessEnv = process.env,
	) {}

	async login(home: string, options: { console: boolean }): Promise<void> {
		const args = ["auth", "login", options.console ? "--console" : "--claudeai"];
		await new Promise<void>((resolve, reject) => {
			const child = spawn(this.binary, args, { env: accountEnvironment(this.env, home), stdio: "inherit" });
			child.once("error", reject);
			child.once("close", (code) =>
				code === 0 ? resolve() : reject(new Error(`claude auth login exited ${code}`)),
			);
		});
	}

	async status(home: string): Promise<SignedIn | null> {
		let stdout: string;
		try {
			({ stdout } = await run(this.binary, ["auth", "status", "--json"], {
				env: accountEnvironment(this.env, home),
				encoding: "utf8",
			}));
		} catch (error) {
			// Signed out exits non-zero with the same JSON.
			stdout = (error as { stdout?: string }).stdout ?? "";
		}
		const status = json(stdout.trim());
		if (status?.loggedIn !== true) return null;
		const kind = status.authMethod === "claude.ai" ? "subscription" : "api-key";
		const email = typeof status.email === "string" ? status.email : undefined;
		const plan = typeof status.subscriptionType === "string" ? status.subscriptionType : undefined;
		const label = [email ?? "Claude Code", plan && `(${plan})`].filter(Boolean).join(" ");
		return { provider: "anthropic", kind, label };
	}

	launch(launch: Launch): Running {
		const mcp = {
			mcpServers: {
				kix: {
					type: "http",
					url: launch.tools.url,
					headers: { Authorization: `Bearer ${launch.tools.token}` },
					// HTTP tool calls otherwise fail after 60s without a first response byte
					// (and 5 minutes idle), but a merge job's `wait` replies only after up to WAIT_LIMIT.
					timeout: TOOL_TIMEOUT_MS,
				},
			},
		};
		// The bearer token stays out of the command line, which other users can read, in the account's private home.
		const config = join(launch.home, `kix-tools-${launch.session}.json`);
		writeFileSync(config, JSON.stringify(mcp), { mode: 0o600 });
		const settings = join(launch.home, `kix-settings-${launch.session}.json`);
		writeFileSync(settings, JSON.stringify(claudeSettings(launch.sandbox)), { mode: 0o600 });
		const cleanup = () => {
			rmSync(config, { force: true });
			rmSync(settings, { force: true });
		};
		const argv = [
			"-p",
			"--output-format",
			"stream-json",
			"--verbose",
			...(launch.resume ? ["--resume", launch.session] : ["--session-id", launch.session]),
			"--permission-mode",
			"dontAsk",
			"--settings",
			settings,
			"--setting-sources",
			"user",
			"--mcp-config",
			config,
			"--strict-mcp-config",
			"--append-system-prompt",
			launch.system,
			"--disallowedTools",
			"AskUserQuestion,WebFetch",
		];
		const child = spawn(this.binary, argv, {
			cwd: launch.cwd,
			env: jobEnvironment(launch.env, launch.home, launch.sandbox),
			stdio: ["pipe", "pipe", "pipe"],
			// Its own process group, so stopping it also stops every tool it started.
			detached: true,
		});
		const reader = streamReader();
		let stderr = "";
		const lines = boundedLines(LINE_LIMIT, (line) => {
			if (line === "") return;
			reader.line(line);
			launch.output(`${line}\n`);
		});
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => lines.data(chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-64 * 1024);
			launch.output(chunk);
		});
		child.stdin.on("error", () => {});
		child.stdin.end(launch.prompt);
		const signal = (name: NodeJS.Signals) => signalGroup(child.pid, name);
		let killer: ReturnType<typeof setTimeout> | undefined;
		const done = new Promise<Exit>((resolve) => {
			child.once("error", (error: NodeJS.ErrnoException) => {
				cleanup();
				resolve({ limited: null, failed: true, reply: `could not start ${this.binary}: ${error.message}` });
			});
			child.once("close", (code, name) => {
				cleanup();
				clearTimeout(killer);
				lines.end();
				resolve(reader.exit(code ?? (name ? 128 + constants.signals[name] : 1), stderr));
			});
		});
		return {
			done,
			stop() {
				signal("SIGTERM");
				killer ??= setTimeout(() => signal("SIGKILL"), STOP_GRACE_MS);
			},
		};
	}
}
