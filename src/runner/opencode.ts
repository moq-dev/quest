// The opencode adapter. It runs the unmodified `opencode` binary as a headless
// `opencode serve --stdio` on localhost behind a per-launch password and drives
// one session through `@opencode/client`: each turn is one prompt, and the
// session's events stream as raw output. Each account signs in with opencode's
// own `auth login` in its own XDG home and may use only the providers it signed
// in to then; the runner reads which those are, never the credentials. The kix
// tools attach as a remote MCP server, and opencode's question tool is denied so
// every question goes through kix's `ask` instead.
//
// As with Claude Code, the sandbox confines the agent's commands, not the CLI:
// the server, which holds the account's credentials, the server password, and
// the tools' token, runs outside it, and its own file tools follow permission
// rules and a plugin instead. opencode runs every command through its
// configured shell, which here is a script that clears the server's
// environment and runs the command under sandbox-runtime (`srt`) with the
// policy Claude Code's sandbox gets, the devShell sourced inside. Nothing the
// checkout holds runs in the server: no project config, plugins, tools, or MCP
// servers, and no language servers or formatters. Before each turn the runner
// checks that opencode loaded no config but its own and the account's, and that
// its plugin is active, since opencode would only log a plugin it could not load.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import {
	type LocationRef,
	OpenCode,
	type OpenCodeClient,
	type OpenCodeEvent,
	type SessionMessageAssistant,
	type SessionStructuredError,
} from "@opencode/client";

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
import { keptEnvironment, quote, runtimeSettings, type Sandbox } from "./sandbox";

/** The XDG base directories opencode keeps its config, credentials, sessions, and caches in, with their defaults. */
const XDG = {
	XDG_CONFIG_HOME: ".config",
	XDG_DATA_HOME: join(".local", "share"),
	XDG_CACHE_HOME: ".cache",
	XDG_STATE_HOME: join(".local", "state"),
} as const;

/** An account's own XDG directories, under its home. */
export function accountDirectories(home: string): Record<keyof typeof XDG, string> {
	return {
		XDG_CONFIG_HOME: join(home, "config"),
		XDG_DATA_HOME: join(home, "data"),
		XDG_CACHE_HOME: join(home, "cache"),
		XDG_STATE_HOME: join(home, "state"),
	};
}

/**
 * Variables opencode would read in place of the account's own sign-in: the
 * user's opencode settings, and provider credentials, which some providers
 * prefer over a stored key. Matched by name, since every provider names its own.
 */
const UNSET = [
	/^OPENCODE_/,
	/_(API_KEY|API_TOKEN|AUTH_TOKEN|ACCESS_KEY(_ID)?|SECRET_ACCESS_KEY|SESSION_TOKEN)$/,
	/BEARER_TOKEN/,
];

/** The user's environment for opencode, so only the account's sign-in pays for its jobs. */
export function environment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(baseEnvironment(env)).filter(([name]) => !UNSET.some((pattern) => pattern.test(name))),
	);
}

/** opencode's environment in an account's home, as `HOME` too, since opencode loads plugins and skills from it. */
function accountEnvironment(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
	return { ...environment(env), ...accountDirectories(home), HOME: home };
}

/** The account's own opencode config: which providers it may use, and the model it picked. */
function accountConfig(home: string): string {
	return join(accountDirectories(home).XDG_CONFIG_HOME, "opencode", "opencode.json");
}

interface AccountSettings {
	/** opencode's provider IDs the account signed in to, the only ones its jobs may use. */
	providers: string[];
	/** The model the account picked with `--model`, or opencode's default. */
	model?: string;
}

function readAccountSettings(home: string): Partial<AccountSettings> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(accountConfig(home), "utf8"));
	} catch {
		return {};
	}
	const { model, policies } = (parsed ?? {}) as { model?: unknown; policies?: unknown };
	const allowed = Array.isArray(policies)
		? policies.flatMap((p: { action?: unknown; resource?: unknown; effect?: unknown }) =>
				p.action === "provider.use" && p.effect === "allow" && typeof p.resource === "string"
					? [p.resource]
					: [],
			)
		: undefined;
	return { ...(allowed && { providers: allowed }), ...(typeof model === "string" && { model }) };
}

/**
 * Write the account's opencode config: a policy that denies every provider but
 * the ones it signed in to, so a key the runner's environment happens to hold
 * never pays for its jobs, and the model it picked.
 */
function writeAccountSettings(home: string, settings: AccountSettings): void {
	const file = accountConfig(home);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const policies = [
		{ action: "provider.use", resource: "*", effect: "deny" },
		...settings.providers.map((resource) => ({ action: "provider.use", resource, effect: "allow" })),
	];
	const config = { ...(settings.model && { model: settings.model }), policies };
	writeFileSync(file, `${JSON.stringify(config, null, "\t")}\n`, { mode: 0o600 });
}

/**
 * opencode's config in a checkout. `OPENCODE_DISABLE_PROJECT_CONFIG` keeps
 * opencode from loading any of it, and the runner checks that it did not
 * before each turn, but the agent still cannot create or change these, and a
 * launch refuses a checkout that holds them. An empty file there is harmless:
 * opencode ignores an empty config, and finds no plugins in a file named
 * `.opencode`. It is also what sandbox-runtime leaves behind as a mount point
 * when a command is killed.
 */
export const PROJECT_CONFIG = [".opencode", "opencode.json", "opencode.jsonc"];

/** The opencode config a checkout holds, other than empty files. */
export function projectConfig(cwd: string): string[] {
	return PROJECT_CONFIG.filter((name) => {
		try {
			const stat = lstatSync(join(cwd, name));
			return !stat.isFile() || stat.size > 0;
		} catch {
			return false;
		}
	});
}

/** The runner's plugin's ID, which the runner checks is active before each turn. */
const PLUGIN_ID = "quest-runner";

/**
 * An opencode plugin that keeps the file tools inside the checkout and the
 * attempt's private directory, and lets the read-only ones also read
 * opencode's own saved tool output. opencode's `external_directory` check is
 * lexical, so a symlink committed to the checkout would otherwise lead them to
 * any file this user can read: the server, unlike the commands, runs
 * unconfined. Each path is resolved as the tool resolves it, then through
 * every symlink, and a path that does not exist yet through its nearest
 * existing directory. A dangling symlink is refused, since a write would
 * follow it. `patch` names its files in the patch's headers. Nothing writes
 * the checkout's own opencode config. A tool's input may arrive as a JSON
 * string, which opencode repairs into its object. The tool opens the path
 * after this check, so a command running alongside it could still swap the
 * path for a symlink in between: the check narrows that window rather than
 * closing it.
 */
export const PLUGIN = `import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

// Each file tool, and whether it only reads.
const TOOLS = { read: true, glob: true, grep: true, write: false, edit: false, patch: false };
const HEADER = /^\\s*\\*\\*\\* (?:Add File|Update File|Delete File|Move to):(.*)$/;

function real(path) {
	try {
		return realpathSync(path);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		let exists = true;
		try {
			lstatSync(path);
		} catch {
			exists = false;
		}
		const parent = dirname(path);
		if (exists || parent === path) throw new Error(\`\${path} is a symlink to nothing\`);
		return join(real(parent), basename(path));
	}
}

function inside(path, roots) {
	return roots.some((root) => {
		const rel = relative(root, path);
		return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
	});
}

function parsed(input) {
	if (typeof input !== "string") return input;
	try {
		return JSON.parse(input);
	} catch {
		return undefined;
	}
}

export default {
	id: ${JSON.stringify(PLUGIN_ID)},
	setup: async (ctx) => {
		const options = ctx.options;
		const writes = options.writes.map(real);
		const reads = [...writes, ...options.reads.map(real)];
		const config = options.config.map(real);
		await ctx.tool.hook("execute.before", ({ tool, input }) => {
			if (!Object.hasOwn(TOOLS, tool)) return;
			const args = parsed(input);
			const paths =
				tool === "patch"
					? String(args?.patchText ?? "")
							.split(/\\r\\n|\\r|\\n/)
							.flatMap((line) => HEADER.exec(line)?.[1]?.trim() || [])
					: [args?.path].filter((path) => typeof path === "string" && path);
			for (const path of paths) {
				const target = real(resolve(options.cwd, path));
				if (!inside(target, TOOLS[tool] ? reads : writes))
					throw new Error(\`\${path} is outside the checkout, where the runner keeps the file tools\`);
				if (!TOOLS[tool] && inside(target, config))
					throw new Error(\`\${path} is opencode's own config, which would run outside the sandbox\`);
			}
		});
	},
};
`;

/**
 * The shell opencode runs every command through, as `<shell> -c <command>`:
 * the shell tool, and commands in templates. It starts the command from the
 * runner's kept variables rather than the server's environment, which holds
 * the tools' token in `OPENCODE_CONFIG_CONTENT` and any provider key opencode
 * exported, then sources the private HOME and the devShell inside the sandbox
 * before the command, as Claude Code does with `CLAUDE_ENV_FILE`. srt replaces
 * the command's TMPDIR with its own `CLAUDE_CODE_TMPDIR`, or `/tmp/claude`
 * without it, so that names the attempt's directory too.
 */
export function shellScript(srt: string, settings: string, sandbox: Sandbox, env: NodeJS.ProcessEnv): string {
	const kept = Object.entries({
		...keptEnvironment(env),
		TMPDIR: sandbox.tmp,
		CLAUDE_CODE_TMPDIR: sandbox.tmp,
	}).map(([name, value]) => quote(`${name}=${value}`));
	const inner = `. ${quote(sandbox.env)} && quest_command=$QUEST_COMMAND && unset QUEST_COMMAND && eval "$quest_command"`;
	return `#!/bin/sh
if [ "$#" -ne 2 ] || [ "$1" != -c ]; then
	echo "usage: $0 -c <command>" >&2
	exit 2
fi
exec /usr/bin/env -i ${kept.join(" ")} "QUEST_COMMAND=$2" ${quote(srt)} --settings ${quote(settings)} -c ${quote(inner)}
`;
}

/**
 * Where opencode saves the full output it truncates: a tool's, and a shell
 * command's, under a directory per project. The read-only file tools may read them.
 */
function savedOutput(home: string): string[] {
	const data = join(accountDirectories(home).XDG_DATA_HOME, "opencode");
	return [join(data, "tool-output"), join(data, "shell")];
}

/**
 * opencode's config for a job. Every tool is allowed, as Claude Code's
 * permission mode allows its own, except: questions, which go through kix;
 * WebFetch, web search, and the desktop browser, which would run in the
 * unconfined server; Code Mode's `execute`, which carries opencode's own
 * tools, such as moving the session to another directory; and the file tools'
 * paths outside the checkout, the attempt's directory, and opencode's saved
 * output, which the plugin keeps read-only. A tool whose last matching rule denies it
 * everywhere is not offered at all. The kix tools stay direct tools rather than
 * Code Mode's. `instructions` is the file holding the launch's system prompt.
 */
export function jobConfig(options: {
	launch: Launch;
	shell: string;
	plugin: string;
	instructions: string;
}): Record<string, unknown> {
	const { launch } = options;
	const deny = (action: string, resource = "*") => ({ action, resource, effect: "deny" });
	return {
		update: "disable",
		share: "disabled",
		shell: options.shell,
		permissions: [
			{ action: "*", resource: "*", effect: "allow" },
			deny("question"),
			deny("webfetch"),
			deny("websearch"),
			deny("execute"),
			deny("browser"),
			deny("external_directory"),
			...[launch.sandbox.tmp, ...savedOutput(launch.home)].map((dir) => ({
				action: "external_directory",
				resource: join(dir, "*"),
				effect: "allow",
			})),
		],
		// Both would run the repository's own tools in the server.
		lsp: false,
		formatter: false,
		instructions: [options.instructions],
		mcp: {
			servers: {
				kix: {
					type: "remote",
					url: launch.tools.url,
					headers: { Authorization: `Bearer ${launch.tools.token}` },
					oauth: false,
					codemode: false,
				},
			},
		},
		plugins: [
			{
				package: options.plugin,
				options: {
					cwd: launch.cwd,
					writes: [launch.cwd, launch.sandbox.tmp],
					reads: savedOutput(launch.home),
					config: PROJECT_CONFIG.map((name) => join(launch.cwd, name)),
				},
			},
		],
	};
}

export interface Credential {
	/** opencode's integration ID, such as openai or opencode-go. */
	provider: string;
	/** How it signed in: oauth for a plan login, key for an API key, external for a credential managed elsewhere. */
	type: string;
}

/** The credentials stored among opencode's integrations, without the credentials themselves. */
export function credentials(list: unknown): Credential[] {
	if (!Array.isArray(list)) throw new Error("opencode listed no integrations");
	return list.flatMap((integration: { id?: unknown; connections?: unknown }) =>
		typeof integration?.id === "string" && Array.isArray(integration.connections)
			? integration.connections.flatMap((connection: { type?: unknown; method?: unknown }) =>
					connection?.type === "credential" && typeof connection.method === "string"
						? [{ provider: integration.id as string, type: connection.method }]
						: [],
				)
			: [],
	);
}

/**
 * The providers an account's stored credentials enable, which are all its jobs
 * may use. An integration may enable providers of other IDs, as OpenCode
 * Console does, and providers that need no sign-in belong to no stored credential.
 */
export function signedInProviders(
	integrations: unknown,
	providers: { id: string; integrationID?: string }[],
): string[] {
	const stored = new Set(credentials(integrations).map((c) => c.provider));
	return providers.flatMap((p) => (stored.has(p.integrationID ?? p.id) ? [p.id] : []));
}

/** What kix shows for a credential, and whether it is a plan rather than a metered key. */
function describe({ provider, type }: Credential): { name: string; plan: boolean } {
	if (provider === "openai" && type === "oauth") return { name: "ChatGPT", plan: true };
	if (provider === "opencode-go") return { name: "OpenCode Go", plan: true };
	if (type === "oauth") return { name: provider, plan: true };
	return { name: `${provider} API key`, plan: false };
}

/** An account that signed in to any provider, labelled by them all. */
export function signedIn(found: Credential[]): SignedIn | null {
	if (!found.length) return null;
	const described = found.map(describe);
	return {
		// kix accepts letters, digits, `-`, and `_`; custom provider IDs may hold more.
		provider: found[0]!.provider.replace(/[^\w-]/g, "-").slice(0, 64),
		kind: described.some((d) => d.plan) ? "subscription" : "api-key",
		label: `${described.map((d) => d.name).join(", ")} (opencode)`,
	};
}

/** Messages a provider sends when the plan or key cannot pay for more, as opposed to a brief rate limit. */
const LIMIT =
	/usage limit|usage_limit_reached|insufficient_quota|quota exceeded|exceeded your current quota|free usage exceeded/i;

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** When a limit resets, from a ChatGPT-style error body. */
function resets(body: string | undefined, now: number): number | null {
	let error: Record<string, unknown> | undefined;
	try {
		error = object(object(JSON.parse(body ?? ""))?.error);
	} catch {}
	if (typeof error?.resets_at === "number") return error.resets_at * 1000;
	if (typeof error?.resets_in_seconds === "number") return now + error.resets_in_seconds * 1000;
	return null;
}

/**
 * Whether a provider error is the account's limit: opencode's quota error,
 * which it never retries, or a limit only the message names, which it would
 * retry until the reset, however far off.
 */
export function accountLimit(error: SessionStructuredError, now = Date.now()): Exit["limited"] {
	const body = error.response?.body;
	if (error.type !== "provider.quota" && !LIMIT.test(`${error.message}\n${body ?? ""}`)) return null;
	return { until: resets(body, now) };
}

/**
 * How a turn ended, from its last assistant message, the error its run failed
 * with if it never answered, and any limit seen while it ran.
 */
export function turnExit(
	info: SessionMessageAssistant | undefined,
	failed: SessionStructuredError | undefined,
	limited: Exit["limited"],
	now = Date.now(),
): Exit {
	const error = info?.error ?? failed;
	if (!limited && error) limited = accountLimit(error, now);
	const text = (info?.content ?? [])
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n")
		.trim();
	return { limited, failed: !info || error !== undefined, reply: text || error?.message };
}

/**
 * Why a turn must not run, or null: opencode loaded config the runner did not
 * write, which could outrank its sandbox settings, such as a machine's managed
 * `/etc/opencode`, or the runner's plugin is not active.
 */
async function refusal(client: OpenCodeClient, location: LocationRef, home: string): Promise<string | null> {
	// opencode loads its plugins before it can name a model.
	await client.model.default({ location });
	const own = join(accountDirectories(home).XDG_CONFIG_HOME, "opencode");
	const entries = await client.config.get({ location });
	const foreign = entries.flatMap((entry) =>
		entry.path && relative(own, entry.path).startsWith("..") ? [entry.path] : [],
	);
	// Only the runner's own config arrives without a path.
	const unnamed = entries.filter((entry) => !entry.path).length;
	if (foreign.length || unnamed !== 1)
		return `opencode loaded config the runner did not write (${foreign.join(", ") || `${unnamed} documents without a path`}), which could outrank its sandbox settings`;
	const plugin = (await client.plugin.list({ location })).data.find((p) => p.id === PLUGIN_ID);
	if (plugin?.state.status !== "active")
		return `opencode did not load the runner's plugin, which keeps its file tools in the checkout${plugin?.state.status === "failed" ? `: ${plugin.state.error}` : ""}`;
	return null;
}

/** The last assistant message after `user`, the turn's prompt, newest first through the session's messages. */
async function reply(
	client: OpenCodeClient,
	session: string,
	user: string,
): Promise<SessionMessageAssistant | undefined> {
	let cursor: string | undefined;
	let last: SessionMessageAssistant | undefined;
	do {
		const page = await client.message.list(
			cursor ? { sessionID: session, limit: 200, cursor } : { sessionID: session, limit: 200, order: "desc" },
		);
		for (const message of page.data) {
			if (message.id === user) return last;
			if (message.type === "assistant") last ??= message;
		}
		cursor = page.cursor.next ?? undefined;
	} while (cursor);
	throw new Error(`opencode lost the turn's prompt ${user}`);
}

/** Bun's fetch gives up on a request after about five minutes, which a turn's wait and event stream outlast. */
const unbounded = ((request: Parameters<typeof fetch>[0], init?: RequestInit) =>
	fetch(request, { ...init, timeout: false } as RequestInit)) as typeof fetch;

/** A client for the server at `url` behind `password`. */
function connect(url: string, password: string): OpenCodeClient {
	return OpenCode.make({
		baseUrl: url,
		headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
		fetch: unbounded,
	});
}

/** A running `opencode serve --stdio`. */
interface Server {
	child: ReturnType<typeof spawn>;
	/** Its address, or null if it exited first. */
	url: Promise<string | null>;
	closed: Promise<void>;
	/** The end of its stderr, which explains a failure. */
	tail(): string;
	/** Stop it, its process group, and every tool it started, killing them after a grace period. */
	stop(): void;
}

/**
 * Start opencode's server on localhost in `cwd`, passing each chunk of its
 * output to `output`. With --stdio it prints its address as JSON, drops the
 * password from its environment, and exits when its stdin closes, so it ends
 * with the runner however the runner ends. `env` carries the password, which
 * stays out of the command line other users can read.
 */
function serve(binary: string, cwd: string, env: NodeJS.ProcessEnv, output: (chunk: string) => void): Server {
	const child = spawn(binary, ["serve", "--stdio", "--hostname=127.0.0.1", "--port=0"], {
		cwd,
		env,
		stdio: ["pipe", "pipe", "pipe"],
		// Its own process group, so stopping it also stops every tool it started.
		detached: true,
	});
	let stderr = "";
	let listening: (url: string | null) => void = () => {};
	const url = new Promise<string | null>((resolve) => (listening = resolve));
	const lines = boundedLines(LINE_LIMIT, (line) => {
		try {
			const { url } = JSON.parse(line) as { url?: unknown };
			if (typeof url === "string") listening(url);
		} catch {}
	});
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		lines.data(chunk);
		output(chunk);
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-64 * 1024);
		output(chunk);
	});
	let killer: ReturnType<typeof setTimeout> | undefined;
	const closed = new Promise<void>((resolve) => {
		child.once("error", (error) => {
			stderr += `could not start ${binary}: ${error.message}\n`;
			resolve();
		});
		child.once("close", () => resolve());
	}).then(() => {
		clearTimeout(killer);
		lines.end();
		listening(null);
	});
	return {
		child,
		url,
		closed,
		tail: () => stderr.trim().split("\n").slice(-20).join("\n"),
		stop() {
			child.stdin.end();
			signalGroup(child.pid, "SIGTERM");
			killer ??= setTimeout(() => signalGroup(child.pid, "SIGKILL"), STOP_GRACE_MS);
		},
	};
}

export class Opencode implements Adapter {
	readonly name = "opencode";

	/** `binary` and `srt`, sandbox-runtime's CLI, are absolute paths, so a devShell cannot substitute its own. */
	constructor(
		readonly binary: string,
		readonly srt: string,
		readonly env: NodeJS.ProcessEnv = process.env,
	) {}

	/**
	 * opencode's own sign-in, which asks for the provider and how to sign in to
	 * it, in a private server rather than opencode's background service. The
	 * account's jobs may then use only the providers it signed in to.
	 */
	async login(home: string): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const child = spawn(this.binary, ["auth", "login", "--standalone"], {
				env: accountEnvironment(this.env, home),
				// Not the caller's directory, whose own opencode config the server would load.
				cwd: home,
				stdio: "inherit",
			});
			child.once("error", reject);
			child.once("close", (code) =>
				code === 0 ? resolve() : reject(new Error(`opencode auth login exited ${code}`)),
			);
		});
		const providers = await this.ask(home, async (client, location) =>
			signedInProviders(
				(await client.integration.list({ location })).data,
				(await client.provider.list({ location })).data,
			),
		);
		if (!providers.length) throw new Error("the sign-in enabled no opencode provider");
		writeAccountSettings(home, { ...readAccountSettings(home), providers });
	}

	async status(home: string): Promise<SignedIn | null> {
		return signedIn(
			credentials(
				await this.ask(home, async (client, location) => (await client.integration.list({ location })).data),
			),
		);
	}

	/** Ask a private server in the account's home, as opencode's own CLI commands do, once it has loaded. */
	private async ask<T>(
		home: string,
		question: (client: OpenCodeClient, location: LocationRef) => Promise<T>,
	): Promise<T> {
		const password = randomBytes(32).toString("base64url");
		const env = { ...accountEnvironment(this.env, home), OPENCODE_SERVER_PASSWORD: password };
		const server = serve(this.binary, home, env, () => {});
		try {
			const url = await server.url;
			if (!url) throw new Error(`opencode serve failed: ${server.tail()}`);
			const client = connect(url, password);
			const location = { directory: home };
			await client.model.default({ location });
			return await question(client, location);
		} finally {
			server.stop();
			await server.closed;
		}
	}

	/** Pick the account's model in its own opencode config, which applies to every job it runs. */
	static setModel(home: string, model: string): void {
		const { providers } = readAccountSettings(home);
		if (!providers) throw new Error("the account has not signed in");
		writeAccountSettings(home, { providers, model });
	}

	launch(launch: Launch): Running {
		const found = projectConfig(launch.cwd);
		if (found.length)
			throw new Error(
				`the checkout holds ${found.join(" and ")}, which opencode would load outside the sandbox; run this job on a Claude Code account`,
			);
		if (!readAccountSettings(launch.home).providers)
			throw new Error(
				"this opencode account was added before opencode 2 and does not record its providers; remove it and add it again with `quest runner account add opencode`",
			);
		const password = randomBytes(32).toString("base64url");
		// Kept in the account's private home, which commands cannot read or write:
		// a session ID per kix session, and this launch's plugin, shell, sandbox
		// settings, system prompt, and opencode's own temporary files.
		const sessions = join(launch.home, "kix-sessions");
		const dir = join(launch.home, `kix-${launch.session}`);
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(join(dir, "tmp"), { recursive: true, mode: 0o700 });
		// opencode loads a configured local plugin from a directory.
		const plugin = join(dir, "plugin");
		mkdirSync(plugin);
		writeFileSync(join(plugin, "package.json"), `{"type":"module"}\n`, { mode: 0o600 });
		writeFileSync(join(plugin, "server.js"), PLUGIN, { mode: 0o600 });
		const settings = join(dir, "srt.json");
		const denied = PROJECT_CONFIG.map((name) => join(launch.cwd, name));
		writeFileSync(settings, JSON.stringify(runtimeSettings(launch.sandbox, denied)), { mode: 0o600 });
		const instructions = join(dir, "instructions.md");
		writeFileSync(instructions, launch.system, { mode: 0o600 });
		// opencode names the shell in the shell tool's description.
		const shell = join(dir, "sandboxed-bash");
		writeFileSync(shell, shellScript(this.srt, settings, launch.sandbox, launch.env), { mode: 0o700 });
		const config = jobConfig({ launch, shell, plugin, instructions });
		// The server runs outside the devShell, whose shellHook the job's revision controls, and with a
		// HOME commands cannot write, since opencode loads plugins and instructions from it.
		const server = serve(
			this.binary,
			launch.cwd,
			{
				...accountEnvironment(launch.env, launch.home),
				TMPDIR: join(dir, "tmp"),
				OPENCODE_DISABLE_PROJECT_CONFIG: "1",
				OPENCODE_SERVER_PASSWORD: password,
				OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
			},
			launch.output,
		);

		let stopping = false;
		let abort: () => Promise<unknown> = async () => {};
		const events = new AbortController();
		let watched: Promise<void> = Promise.resolve();
		const failure = (reply: string): Exit => ({ limited: null, failed: true, reply: reply || undefined });

		const turn = async (): Promise<Exit> => {
			const url = await server.url;
			if (!url) return failure(server.tail());
			const client = connect(url, password);
			const location = { directory: launch.cwd };
			const refused = await refusal(client, location, launch.home);
			if (refused) return failure(refused);
			let session: string;
			if (launch.resume) {
				try {
					session = readFileSync(join(sessions, launch.session), "utf8").trim();
				} catch {
					return failure(`opencode has no session for ${launch.session} in this account`);
				}
			} else {
				session = (await client.session.create({ location })).id;
				mkdirSync(sessions, { recursive: true, mode: 0o700 });
				writeFileSync(join(sessions, launch.session), session, { mode: 0o600 });
			}
			abort = () => client.session.interrupt({ sessionID: session });
			if (stopping) return failure("stopped");

			let limited: Exit["limited"] = null;
			let executionError: SessionStructuredError | undefined;
			const ignore = () => {};
			// Every event this server sends is this job's: its session's, its subagents', and its own.
			const stream = client.event.subscribe({ signal: events.signal })[Symbol.asyncIterator]();
			// The first event confirms the subscription, so nothing the prompt causes is missed.
			const connected = await stream.next();
			if (connected.done) return failure(server.tail() || "opencode's event stream closed");
			watched = (async () => {
				for (let next = await stream.next(); !next.done; next = await stream.next()) {
					const event: OpenCodeEvent = next.value;
					if (event.type === "permission.asked") {
						// Every rule allows or denies, so nothing should ask; a stray ask must not hang the turn.
						client.permission
							.reply({ sessionID: event.data.sessionID, requestID: event.data.id, decision: "once" })
							.catch(ignore);
					} else if (event.type === "form.created") {
						client.session.form
							.cancel({ sessionID: event.data.form.sessionID, formID: event.data.form.id })
							.catch(ignore);
					}
					const data = event.data as { sessionID?: unknown };
					// Token deltas repeat what the finished parts carry; other sessions' events are not this turn's.
					if (data?.sessionID !== session || event.type.endsWith(".delta")) continue;
					launch.output(`${JSON.stringify(event)}\n`);
					if (event.type === "session.retry.scheduled") {
						const hit = accountLimit(event.data.error);
						if (hit && !limited) {
							limited = hit;
							abort().catch(ignore);
						}
					} else if (event.type === "session.execution.failed") executionError = event.data.error;
				}
			})().catch(ignore);
			const prompt = await client.session.prompt({ sessionID: session, text: launch.prompt });
			await client.session.wait({ sessionID: session });
			return turnExit(await reply(client, session, prompt.id), executionError, limited);
		};

		const done = turn()
			// The server's own last words explain a lost connection better than the client's error.
			.catch((error: unknown) =>
				failure(server.tail() || (error instanceof Error ? error.message : String(error))),
			)
			.then(async (exit) => {
				events.abort();
				server.stop();
				await server.closed;
				await watched;
				rmSync(dir, { recursive: true, force: true });
				return exit;
			});
		return {
			done,
			stop() {
				stopping = true;
				// Interrupt the turn so opencode records it, then stop the server whether or not it answered.
				abort()
					.catch(() => {})
					.finally(() => server.stop());
				// A server too stuck to answer is stopped anyway.
				const stuck = setTimeout(() => server.stop(), STOP_GRACE_MS);
				void server.closed.then(() => clearTimeout(stuck));
			},
		};
	}
}
