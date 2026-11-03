// The opencode sandbox's boundary, with the real opencode and sandbox-runtime
// (`srt`): a scripted model drives one runner job through `Opencode.launch` in
// a checkout that tries to escape, and each attempt is refused.
//
// `test/runner.test.ts` checks only the settings the runner hands opencode and
// srt; whether they confine anything is those programs' behavior, which can
// change in any release. The scripted model needs no login and spends no
// usage, so this runs in `just test` and CI. srt runs on Linux here; its macOS
// Seatbelt run waits on /quest/m1/kix/sandbox/README.md.
//
// Each attempt first runs unconfined with the same paths, so an attempt that
// would no longer escape anyway fails as a broken control instead of passing
// as refused.
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { requireProgram } from "../../src/cli/program";
import { accountDirectories, Opencode, PROJECT_CONFIG, projectConfig } from "../../src/runner/opencode";
import { binaryPath } from "../../src/runner/cli";
import { closeSandbox, openSandbox, quote, type Sandbox } from "../../src/runner/sandbox";

/** What the scripted provider's key is, which no command may read. */
const KEY = "quest-boundary-provider-key";
/** The kix tools' bearer token, which no command may see. */
const TOOLS_TOKEN = "quest-boundary-tools-token";

interface Paths {
	/** The job's checkout: a worktree of `repository`. */
	checkout: string;
	/** The bare clone, which commands read but must not write, such as a hook git would run on the host. */
	repository: string;
	/** The runner's state, which commands can neither read nor write. */
	runner: string;
	/** The account's home under it, holding its opencode credentials. */
	account: string;
	/** A shared temporary directory, outside both the checkout and the attempt's directory. */
	outside: string;
	/** The scripted model's server, which commands must not reach. */
	url: string;
}

/** One escape the checkout tries, as a command for opencode's bash tool, and how to tell it worked. */
interface Attempt {
	name: string;
	command(paths: Paths): string;
	/** Whether the attempt got through, from its output and the host's state. */
	escaped(paths: Paths, output: string): boolean;
	/** Undo what a successful control left behind. */
	clean?(paths: Paths): void;
}

const auth = (paths: Paths) => join(accountDirectories(paths.account).XDG_DATA_HOME, "opencode", "auth.json");

/** Commands avoid `cat`, `touch`, `mkdir`, and the like, which opencode's own path check refuses before srt sees them. */
const ATTEMPTS: Attempt[] = [
	{
		name: "reads the account's credentials by absolute path",
		command: (paths) => `head -c 4096 ${quote(auth(paths))}`,
		escaped: (_paths, output) => output.includes(KEY),
	},
	{
		name: "reads them through a symlink the checkout commits",
		command: () => "head -c 4096 leak",
		escaped: (_paths, output) => output.includes(KEY),
	},
	{
		name: "writes the runner's state",
		command: (paths) => `printf x > ${quote(join(paths.runner, "escaped"))}`,
		escaped: (paths) => existsSync(join(paths.runner, "escaped")),
		clean: (paths) => rmSync(join(paths.runner, "escaped"), { force: true }),
	},
	{
		name: "writes a shared temporary directory",
		command: (paths) => `printf x > ${quote(join(paths.outside, "escaped"))}`,
		escaped: (paths) => existsSync(join(paths.outside, "escaped")),
		clean: (paths) => rmSync(join(paths.outside, "escaped"), { force: true }),
	},
	{
		name: "plants a hook in the bare clone, which git would run on the host",
		command: (paths) => `printf '#!/bin/sh\\n' > ${quote(join(paths.repository, "hooks", "pre-commit"))}`,
		escaped: (paths) => existsSync(join(paths.repository, "hooks", "pre-commit")),
		clean: (paths) => rmSync(join(paths.repository, "hooks", "pre-commit"), { force: true }),
	},
	{
		name: "creates .opencode/plugin, which the server would import",
		command: () => "install -d .opencode/plugin && printf 'export default {}\\n' > .opencode/plugin/p.js",
		escaped: (paths) => existsSync(join(paths.checkout, ".opencode", "plugin")),
		clean: (paths) => rmSync(join(paths.checkout, ".opencode"), { recursive: true, force: true }),
	},
	{
		name: "writes opencode.json",
		command: () => `printf '{"plugin":["./p.js"]}' > opencode.json`,
		escaped: (paths) => projectConfig(paths.checkout).includes("opencode.json"),
		clean: (paths) => rmSync(join(paths.checkout, "opencode.json"), { force: true }),
	},
	{
		name: "links opencode.jsonc to a file it can write",
		command: () => "ln -s allowed.txt opencode.jsonc",
		escaped: (paths) => projectConfig(paths.checkout).includes("opencode.jsonc"),
		clean: (paths) => rmSync(join(paths.checkout, "opencode.jsonc"), { force: true }),
	},
	{
		// srt exempts loopback from its proxy, so this one asks the proxy for it.
		name: "reaches a host off the allowlist through srt's proxy",
		command: (paths) => `env -u NO_PROXY -u no_proxy ${fetchCommand(paths, "proxy")}`,
		escaped: () => escapes.includes("/escape/proxy"),
		clean: () => (escapes.length = 0),
	},
	{
		name: "reaches it directly, bypassing the proxy",
		command: (paths) =>
			`env ${PROXIES.map((name) => `-u ${name} -u ${name.toLowerCase()}`).join(" ")} ${fetchCommand(paths, "direct")}`,
		escaped: () => escapes.includes("/escape/direct"),
		clean: () => (escapes.length = 0),
	},
];

const PROXIES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"];

/** A command fetching the scripted model's `/escape/<path>`, printing how it went. */
function fetchCommand(paths: Paths, path: string): string {
	const script = `console.log(await fetch(${JSON.stringify(`${paths.url}/escape/${path}`)}).then((r) => r.status, String))`;
	return `${quote(bun)} -e ${quote(script)}`;
}

/**
 * An escape through opencode's own file tools, which run in the unconfined
 * server: the runner's plugin must refuse them, so a release that stops
 * calling its hook fails here.
 */
interface FileAttempt {
	name: string;
	call: Call;
	escaped(paths: Paths, output: string): boolean;
}

const FILE_ATTEMPTS: FileAttempt[] = [
	{
		name: "the read tool follows the committed symlink to the credentials",
		call: { tool: "read", args: { filePath: "leak" } },
		escaped: (_paths, output) => output.includes(KEY),
	},
	{
		name: "the write tool writes .opencode/opencode.json",
		call: { tool: "write", args: { filePath: ".opencode/opencode.json", content: `{"plugin":["./p.js"]}` } },
		escaped: (paths) => existsSync(join(paths.checkout, ".opencode", "opencode.json")),
	},
];

/** One tool call the scripted model makes. */
interface Call {
	tool: string;
	args: Record<string, unknown>;
}

const bash = (command: string): Call => ({ tool: "bash", args: { command, description: "Run a step" } });

/** A command inside the sandbox that must work, so the refusals above are not every command failing. */
const ALLOWED = bash(`printf allowed > allowed.txt && printf ok > "$TMPDIR/allowed" && echo ALLOWED-$((6 * 7))`);
/** The command's environment, which must hold none of the server's secrets. */
const ENVIRONMENT = bash("env");

let scratch: string;
let paths: Paths;
let server: Server;
let bun: string;
/** The paths commands fetched from the scripted model's server. */
const escapes: string[] = [];
/** Every request the agent sent the model, which carries each command's output back. */
const requests: ChatRequest[] = [];
/** The tool calls the scripted model makes, one per step, in order. */
let script: Call[] = [];
/** Tools the script calls that opencode did not offer. */
const missing = new Set<string>();

const linux = process.platform === "linux";

describe.skipIf(!linux)("opencode's sandbox", () => {
	beforeAll(async () => {
		bun = requireProgram("bun", process.env);
		scratch = realpathSync(mkdtempSync(join(tmpdir(), "quest-boundary-")));
		const runner = join(scratch, "runner");
		const account = join(runner, "accounts", "scripted");
		const outside = join(scratch, "outside");
		mkdirSync(outside, { recursive: true });
		mkdirSync(account, { recursive: true });

		const repository = join(runner, "repos", "fixture.git");
		const seed = join(scratch, "seed");
		git(scratch, "init", "-q", "-b", "main", seed);
		symlinkSync(join(accountDirectories(account).XDG_DATA_HOME, "opencode", "auth.json"), join(seed, "leak"));
		writeFileSync(join(seed, "README.md"), "fixture\n");
		git(seed, "add", ".");
		git(seed, "commit", "-qm", "base");
		git(scratch, "clone", "-q", "--bare", seed, repository);
		const checkout = join(runner, "checkouts", "job");
		git(repository, "worktree", "add", "-q", "--detach", checkout, "main");

		server = await listen(model);
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("the scripted model has no port");
		paths = {
			checkout,
			repository,
			runner,
			account,
			outside,
			url: `http://127.0.0.1:${address.port}`,
		};
		signIn(account, `${paths.url}/v1`);
	});

	afterAll(async () => {
		if (server) await new Promise((resolve) => server.close(resolve));
		if (scratch) rmSync(scratch, { recursive: true, force: true });
	});

	// Each attempt with the same paths and no sandbox, so a refusal below means the sandbox refused it.
	test("each attempt escapes when run unconfined", async () => {
		for (const attempt of ATTEMPTS) {
			// Not spawnSync: the network attempt needs this process to answer it.
			const output = await shell(attempt.command(paths), paths.checkout);
			expect(attempt.escaped(paths, output), `${attempt.name}: the control did not escape\n${output}`).toBe(true);
			attempt.clean?.(paths);
		}
		expect(projectConfig(paths.checkout)).toEqual([]);
	});

	test("an opencode job's commands cannot escape", { timeout: 5 * 60_000 }, async () => {
		const srt = binaryPath("srt", process.env);
		const opencode = binaryPath("opencode", process.env);
		const sandbox = openSandbox({
			cwd: paths.checkout,
			repository: paths.repository,
			runnerHome: paths.runner,
			devShell: null,
			trusted: false,
		});
		script = [
			ALLOWED,
			ENVIRONMENT,
			...ATTEMPTS.map((attempt) => bash(attempt.command(paths))),
			...FILE_ATTEMPTS.map((attempt) => attempt.call),
		];
		let output = "";
		let exit: Awaited<ReturnType<typeof run>>;
		try {
			exit = await run(new Opencode(opencode, srt, process.env), sandbox, (line) => (output += line));
		} finally {
			closeSandbox(sandbox);
		}
		const results = toolResults();
		const context = `exit ${JSON.stringify(exit)}\n${output.slice(-4000)}`;
		expect([...missing], "opencode no longer offers a tool the script calls").toEqual([]);
		expect(exit.failed, context).toBe(false);
		expect(exit.reply).toBe("done");
		expect(results, `the model saw ${results.length} of ${script.length} results\n${context}`).toHaveLength(
			script.length,
		);

		const [allowed, environment, ...rest] = results;
		const attempts = rest.slice(0, ATTEMPTS.length);
		const files = rest.slice(ATTEMPTS.length);
		expect(allowed, "a permitted command failed, so every refusal would pass vacuously").toContain("ALLOWED-42");
		expect(readFileSync(join(paths.checkout, "allowed.txt"), "utf8")).toBe("allowed");
		for (const secret of [KEY, TOOLS_TOKEN, "OPENCODE_", "XDG_DATA_HOME"])
			expect(environment, `a command's environment holds ${secret}`).not.toContain(secret);
		expect(environment).toContain(`HOME=${join(sandbox.tmp, "home")}`);
		expect(environment, "srt replaced the attempt's TMPDIR").toContain(`TMPDIR=${sandbox.tmp}\n`);
		ATTEMPTS.forEach((attempt, index) =>
			expect(attempt.escaped(paths, attempts[index]!), `${attempt.name}\n${attempts[index]}`).toBe(false),
		);
		FILE_ATTEMPTS.forEach((attempt, index) => {
			expect(attempt.escaped(paths, files[index]!), `${attempt.name}\n${files[index]}`).toBe(false);
			expect(files[index], `${attempt.name}: not the runner's plugin refusing it`).toMatch(
				/outside the checkout|opencode's own config/,
			);
		});

		for (const secret of [KEY, TOOLS_TOKEN])
			expect(JSON.stringify(requests), `${secret} reached the model`).not.toContain(secret);
		// Nothing left behind: no opencode config, not even srt's empty mount points, and no stray file.
		for (const name of PROJECT_CONFIG) expect(existsSync(join(paths.checkout, name)), name).toBe(false);
		expect(git(paths.checkout, "status", "--porcelain", "--ignored")).toBe("?? allowed.txt\n");
	});
});

/** How long the job may run before it is stopped, within the test's timeout and the stop's grace. */
const RUN_BOUND = 4 * 60_000;

/**
 * One turn of a job on the account, with the kix tools at a port nothing
 * listens on. A turn that runs past `RUN_BOUND` is stopped and awaited, so a
 * hung opencode or srt never outlives the test.
 */
async function run(adapter: Opencode, sandbox: Sandbox, output: (line: string) => void) {
	const running = adapter.launch({
		cwd: paths.checkout,
		home: paths.account,
		session: "boundary",
		resume: false,
		prompt: "Run the commands you are given.",
		system: "",
		tools: { url: "http://127.0.0.1:9/mcp", token: TOOLS_TOKEN },
		sandbox,
		env: process.env,
		output,
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		running.stop();
	}, RUN_BOUND);
	const exit = await running.done.finally(() => clearTimeout(timer));
	if (timedOut) throw new Error(`the job ran past ${RUN_BOUND / 60_000} minutes, so it was stopped`);
	return exit;
}

/**
 * Sign the account in to the scripted provider: an OpenAI-compatible API on
 * localhost, with an API key no command may read, picked as the account's model.
 */
function signIn(account: string, baseURL: string) {
	const dirs = accountDirectories(account);
	mkdirSync(join(dirs.XDG_DATA_HOME, "opencode"), { recursive: true });
	writeFileSync(
		join(dirs.XDG_DATA_HOME, "opencode", "auth.json"),
		JSON.stringify({ scripted: { type: "api", key: KEY } }),
	);
	mkdirSync(join(dirs.XDG_CONFIG_HOME, "opencode"), { recursive: true });
	writeFileSync(
		join(dirs.XDG_CONFIG_HOME, "opencode", "opencode.json"),
		JSON.stringify({
			model: "scripted/boundary",
			provider: {
				scripted: {
					npm: "@ai-sdk/openai-compatible",
					name: "Scripted",
					options: { baseURL },
					models: { boundary: { name: "Boundary", tool_call: true } },
				},
			},
		}),
	);
}

interface ChatMessage {
	role: string;
	content?: unknown;
	tool_calls?: unknown[];
}

interface ChatRequest {
	messages: ChatMessage[];
	tools?: { function: { name: string } }[];
}

/** The output of each command, in order, as the agent reported it back to the model. */
function toolResults(): string[] {
	const last = requests.filter((request) => request.tools?.length).at(-1);
	return (last?.messages ?? []).filter((m) => m.role === "tool").map((m) => text(m.content));
}

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content.map((part) => (part as { text?: string }).text ?? JSON.stringify(part)).join("");
	return JSON.stringify(content);
}

/**
 * The scripted model: a request whose conversation holds k tool results makes
 * the script's call k, then replies "done". A request without tools,
 * such as opencode's title, gets a plain reply. Anything else the server sees
 * is a command reaching it.
 */
function model(req: IncomingMessage, res: ServerResponse) {
	if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
		escapes.push(req.url ?? "");
		res.writeHead(200).end("reached");
		return;
	}
	let body = "";
	req.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
	req.on("end", () => {
		const request = JSON.parse(body) as ChatRequest;
		requests.push(request);
		res.writeHead(200, { "content-type": "text/event-stream" });
		const send = (delta: object, finish: string | null = null) =>
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-boundary",
					object: "chat.completion.chunk",
					created: Math.floor(Date.now() / 1000),
					model: "boundary",
					choices: [{ index: 0, delta, finish_reason: finish }],
				})}\n\n`,
			);
		const step = request.messages.filter((m) => m.role === "tool").length;
		// opencode's title request offers no tools.
		const call = request.tools?.length ? script[step] : undefined;
		if (call && !request.tools?.some((t) => t.function.name === call.tool)) missing.add(call.tool);
		if (call === undefined || missing.size) {
			send({ role: "assistant", content: request.tools?.length ? "done" : "Boundary test" });
			send({}, "stop");
		} else {
			send({
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: `call_${step}`,
						type: "function",
						function: { name: call.tool, arguments: JSON.stringify(call.args) },
					},
				],
			});
			send({}, "tool_calls");
		}
		res.end("data: [DONE]\n\n");
	});
}

/** A command's stdout and stderr, run unconfined with `sh -c` in `cwd`. */
function shell(command: string, cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("/bin/sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
		child.once("error", reject);
		child.once("close", () => resolve(output));
	});
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Server> {
	return new Promise((resolve, reject) => {
		const created = createServer(handler);
		created.once("error", reject);
		created.listen(0, "127.0.0.1", () => resolve(created));
	});
}

function git(cwd: string, ...args: string[]): string {
	const run = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", ...args], {
		cwd,
		encoding: "utf8",
	});
	if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr}`);
	return run.stdout;
}
