// The Claude Code sandbox's boundary, with the pinned Claude Code: a scripted
// model, set as the account's endpoint in its home, drives one runner job
// through `Claude.launch` in a checkout that tries to escape, and each
// attempt is refused.
//
// `test/runner.test.ts` checks only the settings the runner hands Claude Code;
// whether they confine anything is Claude Code's behavior, which can change in
// any release. The scripted model needs no login and spends no usage, so
// `just runner-sandbox` runs it beside opencode's test
// (`runner-sandbox.test.ts`), and CI does nightly, outside `just test`.
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
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { requireProgram } from "../../src/cli/program";
import { Claude } from "../../src/runner/claude";
import { binaryPath } from "../../src/runner/cli";
import { closeSandbox, openSandbox, quote, type Sandbox } from "../../src/runner/sandbox";

/**
 * A credential planted in the account's home, which no command may read. The
 * scripted model's API key is no secret: Claude Code passes its settings'
 * `env` to commands.
 */
const SECRET = "quest-boundary-account-credential";
/** A pattern matching the credential without holding it, since a command's own text reaches the model. */
const SECRET_PATTERN = quote(`${SECRET.slice(0, -1)}[${SECRET.at(-1)}]`);
/** The kix tools' bearer token, which no command may see. */
const TOOLS_TOKEN = "quest-boundary-tools-token";
/** What the checkout's committed CLAUDE.md says, which must not reach the model. */
const PROJECT_MEMORY = "quest-boundary-project-memory";

interface Paths {
	/** The job's checkout: a worktree of `repository`. */
	checkout: string;
	/** The bare clone, which commands read but must not write, such as a hook git would run on the host. */
	repository: string;
	/** The runner's state, which commands can neither read nor write. */
	runner: string;
	/** The account's home under it: its `CLAUDE_CONFIG_DIR`. */
	account: string;
	/** A shared temporary directory, outside both the checkout and the attempt's directory. */
	outside: string;
	/** The scripted model's server, which commands must not reach. */
	url: string;
	/** A Unix socket this process listens on where commands can read, so only the seccomp filter stops them reaching it. */
	socket: string;
}

/** One escape the checkout tries, as a command for Claude Code's Bash tool, and how to tell it worked. */
interface Attempt {
	name: string;
	command(paths: Paths): string;
	/** Whether the attempt got through, from its output and the host's state. */
	escaped(paths: Paths, output: string): boolean;
	/** Undo what a successful control left behind. */
	clean?(paths: Paths): void;
}

/** The credential file planted in the account's home, where Claude Code keeps its own login. */
const credentialStore = (paths: Paths) => join(paths.account, ".credentials.json");
/** Where the hook the checkout commits would write, outside the sandbox. */
const hookMark = (runner: string) => join(runner, "hooked");
/** The hook's command, which the checkout's `.claude/settings.json` runs before every tool. */
const hookCommand = (runner: string) => `printf x > ${quote(hookMark(runner))}`;

const ATTEMPTS: Attempt[] = [
	{
		name: "reads the account's credentials by absolute path",
		command: (paths) => `grep -o ${SECRET_PATTERN} ${quote(credentialStore(paths))}`,
		escaped: (_paths, output) => output.includes(SECRET),
	},
	{
		name: "reads them through a symlink the checkout commits",
		command: () => `grep -o ${SECRET_PATTERN} leak`,
		escaped: (_paths, output) => output.includes(SECRET),
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
		// The command the checkout's settings would run as a hook, outside the sandbox.
		name: "runs the committed hook's command",
		command: (paths) => hookCommand(paths.runner),
		escaped: (paths) => existsSync(hookMark(paths.runner)),
		clean: (paths) => rmSync(hookMark(paths.runner), { force: true }),
	},
	{
		// A trusted Nix user's commands could pass the daemon root-level options.
		name: "connects to the Nix daemon",
		command: () => connectCommand(process.env.NIX_DAEMON_SOCKET_PATH ?? "/nix/var/nix/daemon-socket/socket"),
		escaped: (_paths, output) => output.includes("CONNECTED"),
	},
	{
		name: "connects to a Unix socket on the host",
		command: (paths) => connectCommand(paths.socket),
		escaped: (_paths, output) => output.includes("CONNECTED"),
	},
	{
		// The sandbox exempts loopback from its proxy, so this one asks the proxy for it.
		name: "reaches a host off the allowlist through the sandbox's proxy",
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

/** A command connecting to the Unix socket at `path`, printing whether it did. */
function connectCommand(path: string): string {
	const script = `const s = require("node:net").connect(${JSON.stringify(path)}).on("connect", () => (console.log("CONNECTED"), s.end())).on("error", (e) => console.log(String(e)))`;
	return `${quote(bun)} -e ${quote(script)}`;
}

/** A command fetching the scripted model's `/escape/<path>`, printing how it went. */
function fetchCommand(paths: Paths, path: string): string {
	const script = `console.log(await fetch(${JSON.stringify(`${paths.url}/escape/${path}`)}).then((r) => r.status, String))`;
	return `${quote(bun)} -e ${quote(script)}`;
}

/**
 * An escape through Claude Code's own file tools, which run outside the
 * sandbox: the runner's permission rules must refuse them.
 */
interface FileAttempt {
	name: string;
	call: (paths: Paths) => Call;
	escaped(paths: Paths, output: string): boolean;
}

const FILE_ATTEMPTS: FileAttempt[] = [
	{
		name: "the Read tool follows the committed symlink to the credentials",
		call: (paths) => ({ tool: "Read", args: { file_path: join(paths.checkout, "leak") } }),
		escaped: (_paths, output) => output.includes(SECRET),
	},
	{
		name: "the Read tool reads the credentials by absolute path",
		call: (paths) => ({ tool: "Read", args: { file_path: credentialStore(paths) } }),
		escaped: (_paths, output) => output.includes(SECRET),
	},
	{
		name: "the Write tool writes the runner's state",
		call: (paths) => ({ tool: "Write", args: { file_path: join(paths.runner, "written"), content: "x" } }),
		escaped: (paths) => existsSync(join(paths.runner, "written")),
	},
	{
		name: "the Write tool plants a hook in the bare clone",
		call: (paths) => ({
			tool: "Write",
			args: { file_path: join(paths.repository, "hooks", "post-checkout"), content: "#!/bin/sh\n" },
		}),
		escaped: (paths) => existsSync(join(paths.repository, "hooks", "post-checkout")),
	},
];

/** One tool call the scripted model makes. */
interface Call {
	tool: string;
	args: Record<string, unknown>;
}

const bash = (command: string): Call => ({ tool: "Bash", args: { command, description: "Run a command" } });

/** A command inside the sandbox that must work, so the refusals above are not every command failing. */
const ALLOWED = bash(`printf allowed > allowed.txt && printf ok > "$TMPDIR/allowed" && echo ALLOWED-$((6 * 7))`);
/** The command's environment, which must hold none of the runner's secrets. */
const ENVIRONMENT = bash("env");
/**
 * The descriptors a command inherits, as `ls` lists its own. The filter refuses
 * making a Unix socket, not using one a command inherits, so none may reach it
 * beyond its stdio. Not the shell's own: it keeps a copy of its stdin on a
 * higher descriptor, closed on exec, while Claude Code reads a command's stdin
 * from /dev/null.
 */
const DESCRIPTORS = bash("ls -l /proc/self/fd/");

let scratch: string;
let paths: Paths;
let server: Server;
let host: NetServer;
let bun: string;
/** The paths commands fetched from the scripted model's server. */
const escapes: string[] = [];
/** Every request Claude Code sent the model, which carries each command's output back. */
const requests: MessagesRequest[] = [];
/** The tool calls the scripted model makes, one per step, in order. */
let script: Call[] = [];
/** Tools the script calls that Claude Code did not offer. */
const missing = new Set<string>();

/** Standing instructions for the job, which must reach the model. */
const SYSTEM = "Quest boundary instructions.";

const linux = process.platform === "linux";

describe.skipIf(!linux)("Claude Code's sandbox", () => {
	beforeAll(async () => {
		bun = requireProgram("bun", process.env);
		scratch = realpathSync(mkdtempSync(join(tmpdir(), "quest-boundary-")));
		const runner = join(scratch, "runner");
		const account = join(runner, "accounts", "scripted");
		const outside = join(scratch, "outside");
		mkdirSync(outside, { recursive: true });
		mkdirSync(account, { recursive: true });

		server = await listen(model);
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("the scripted model has no port");
		const url = `http://127.0.0.1:${address.port}`;

		const repository = join(runner, "repos", "fixture.git");
		const seed = join(scratch, "seed");
		git(scratch, "init", "-q", "-b", "main", seed);
		symlinkSync(join(account, ".credentials.json"), join(seed, "leak"));
		writeFileSync(join(seed, "README.md"), "fixture\n");
		writeFileSync(join(seed, "CLAUDE.md"), `${PROJECT_MEMORY}\n`);
		// Project settings whose hook would run outside the sandbox before every tool call.
		mkdirSync(join(seed, ".claude"));
		writeFileSync(
			join(seed, ".claude", "settings.json"),
			JSON.stringify({
				hooks: {
					SessionStart: [{ hooks: [{ type: "command", command: hookCommand(runner) }] }],
					PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: hookCommand(runner) }] }],
				},
				sandbox: { enabled: false },
				permissions: { allow: ["Read", "Write", "Edit"] },
			}),
		);
		git(seed, "add", ".");
		git(seed, "commit", "-qm", "base");
		git(scratch, "clone", "-q", "--bare", seed, repository);
		const checkout = join(runner, "checkouts", "job");
		git(repository, "worktree", "add", "-q", "--detach", checkout, "main");

		const socket = join(repository, "host.sock");
		host = await listenUnix(socket);
		paths = { checkout, repository, runner, account, outside, url, socket };
		signIn(account, url);
	});

	afterAll(async () => {
		if (server) await new Promise((resolve) => server.close(resolve));
		if (host) await new Promise((resolve) => host.close(resolve));
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
	});

	test("a Claude Code job's commands and file tools cannot escape", { timeout: 5 * 60_000 }, async () => {
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
			DESCRIPTORS,
			...ATTEMPTS.map((attempt) => bash(attempt.command(paths))),
			...FILE_ATTEMPTS.map((attempt) => attempt.call(paths)),
		];
		let output = "";
		let exit: Awaited<ReturnType<typeof run>>;
		try {
			exit = await run(
				new Claude(binaryPath("claude", process.env), process.env),
				sandbox,
				(line) => (output += line),
			);
		} finally {
			closeSandbox(sandbox);
		}
		const results = toolResults();
		const context = `exit ${JSON.stringify(exit)}\n${output.slice(-4000)}`;
		expect([...missing], "Claude Code no longer offers a tool the script calls").toEqual([]);
		const first = requests.find((request) => request.tools?.length);
		expect(JSON.stringify(first?.system), "the job's instructions did not reach the model").toContain(SYSTEM);
		expect(JSON.stringify(requests), "the checkout's CLAUDE.md reached the model").not.toContain(PROJECT_MEMORY);
		expect(exit.failed, context).toBe(false);
		expect(exit.reply).toBe("done");
		expect(results, `the model saw ${results.length} of ${script.length} results\n${context}`).toHaveLength(
			script.length,
		);

		const [allowed, environment, descriptors, ...rest] = results;
		const attempts = rest.slice(0, ATTEMPTS.length);
		const files = rest.slice(ATTEMPTS.length);
		expect(allowed, "a permitted command failed, so every refusal would pass vacuously").toContain("ALLOWED-42");
		expect(readFileSync(join(paths.checkout, "allowed.txt"), "utf8")).toBe("allowed");
		for (const secret of [SECRET, TOOLS_TOKEN])
			expect(environment, `a command's environment holds ${secret}`).not.toContain(secret);
		expect(environment).toContain(`HOME=${join(sandbox.tmp, "home")}\n`);
		// Claude Code's sandbox exports its own TMPDIR inside the one the runner gives it, and ALLOWED wrote there.
		const tmp = /^TMPDIR=(.*)$/m.exec(environment!)?.[1] ?? "";
		expect(tmp === sandbox.tmp || tmp.startsWith(`${sandbox.tmp}/`), `TMPDIR=${tmp} is not the attempt's`).toBe(
			true,
		);
		const open = [...descriptors!.matchAll(/ (\d+) -> (.*)$/gm)].map(([, fd, target]) => ({
			fd: Number(fd),
			target,
		}));
		expect(
			open.map(({ fd }) => fd),
			`no descriptors listed\n${descriptors}`,
		).toEqual(expect.arrayContaining([0, 1, 2]));
		expect(
			open.filter(({ fd, target }) => fd > 2 && target!.startsWith("socket:")),
			`a command inherits a socket\n${descriptors}`,
		).toEqual([]);
		ATTEMPTS.forEach((attempt, index) => {
			const result = attempts[index]!;
			expect(attempt.escaped(paths, result), `${attempt.name}\n${result}`).toBe(false);
			// A refusal by Claude Code's permission check would leave the sandbox untested.
			expect(result, `${attempt.name}: the command never reached the sandbox`).not.toMatch(
				/permission to use Bash|requires approval/i,
			);
		});
		FILE_ATTEMPTS.forEach((attempt, index) =>
			expect(attempt.escaped(paths, files[index]!), `${attempt.name}\n${files[index]}`).toBe(false),
		);
		expect(existsSync(hookMark(paths.runner)), "the checkout's hook ran").toBe(false);

		for (const secret of [SECRET, TOOLS_TOKEN])
			expect(JSON.stringify(requests), `${secret} reached the model`).not.toContain(secret);
		// Nothing left behind: not even the sandbox's empty mount points, and no stray file.
		expect(git(paths.checkout, "status", "--porcelain", "--ignored")).toBe("?? allowed.txt\n");
	});
});

/** How long the job may run before it is stopped, within the test's timeout and the stop's grace. */
const RUN_BOUND = 4 * 60_000;

/**
 * One turn of a job on the account, with the kix tools at a port nothing
 * listens on. A turn that runs past `RUN_BOUND` is stopped and awaited, so a
 * hung Claude Code never outlives the test.
 */
async function run(adapter: Claude, sandbox: Sandbox, output: (line: string) => void) {
	const running = adapter.launch({
		cwd: paths.checkout,
		home: paths.account,
		session: crypto.randomUUID(),
		resume: false,
		prompt: "Run the commands you are given.",
		system: SYSTEM,
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
 * Point the account at the scripted model in its home, as a maintainer would
 * set a custom endpoint: `ANTHROPIC_BASE_URL` and a key in its settings' `env`,
 * which `--setting-sources user` loads. The environment the runner passes
 * keeps only its allowlist, so an ambient endpoint would never reach Claude
 * Code. The planted credentials stand in for its login.
 */
function signIn(account: string, url: string) {
	writeFileSync(
		join(account, "settings.json"),
		JSON.stringify({ env: { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: "quest-boundary-api-key" } }),
	);
	writeFileSync(join(account, ".credentials.json"), JSON.stringify({ secret: SECRET }), { mode: 0o600 });
}

interface ContentBlock {
	type: string;
	text?: string;
	content?: unknown;
}

interface MessagesRequest {
	system?: unknown;
	messages: { role: string; content: string | ContentBlock[] }[];
	tools?: { name: string }[];
}

/** Each tool result in a request's conversation, in order. */
function resultBlocks(request: MessagesRequest): ContentBlock[] {
	return request.messages.flatMap((m) =>
		m.role === "user" && Array.isArray(m.content) ? m.content.filter((block) => block.type === "tool_result") : [],
	);
}

/** The output of each tool call, in order, as Claude Code reported it back to the model. */
function toolResults(): string[] {
	const last = requests.filter((request) => request.tools?.length).at(-1);
	return last ? resultBlocks(last).map((block) => text(block.content)) : [];
}

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content.map((part) => (part as { text?: string }).text ?? JSON.stringify(part)).join("");
	return JSON.stringify(content);
}

/**
 * The scripted model, speaking Anthropic's Messages API: a request whose
 * conversation holds k tool results makes the script's call k, then replies
 * "done". A request offering no tools, such as a title, gets a plain reply.
 * Anything else the server sees is a command reaching it.
 */
function model(req: IncomingMessage, res: ServerResponse) {
	const path = req.url?.split("?")[0] ?? "";
	if (req.method !== "POST" || !path.startsWith("/v1/messages")) {
		escapes.push(req.url ?? "");
		res.writeHead(200).end("reached");
		return;
	}
	let body = "";
	req.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
	req.on("end", () => {
		if (path !== "/v1/messages") {
			// Such as token counting, which a turn may ask for.
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 1 }));
			return;
		}
		const request = JSON.parse(body) as MessagesRequest & { model: string };
		requests.push(request);
		res.writeHead(200, { "content-type": "text/event-stream" });
		const send = (type: string, data: object) =>
			res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
		const step = resultBlocks(request).length;
		const call = request.tools?.length ? script[step] : undefined;
		if (call && !request.tools?.some((t) => t.name === call.tool)) missing.add(call.tool);
		const usage = { input_tokens: 1, output_tokens: 1 };
		send("message_start", {
			message: {
				id: `msg_${step}`,
				type: "message",
				role: "assistant",
				model: request.model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage,
			},
		});
		if (call === undefined || missing.size) {
			send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
			send("content_block_delta", {
				index: 0,
				delta: { type: "text_delta", text: request.tools?.length ? "done" : "Boundary test" },
			});
			send("content_block_stop", { index: 0 });
			send("message_delta", {
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 1 },
			});
		} else {
			send("content_block_start", {
				index: 0,
				content_block: { type: "tool_use", id: `toolu_${step}`, name: call.tool, input: {} },
			});
			send("content_block_delta", {
				index: 0,
				delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args) },
			});
			send("content_block_stop", { index: 0 });
			send("message_delta", {
				delta: { stop_reason: "tool_use", stop_sequence: null },
				usage: { output_tokens: 1 },
			});
		}
		send("message_stop", {});
		res.end();
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

/** A Unix socket server at `path` that accepts each connection and ends it once the client does. */
function listenUnix(path: string): Promise<NetServer> {
	return new Promise((resolve, reject) => {
		const created = createNetServer(() => {});
		created.once("error", reject);
		created.listen(path, () => resolve(created));
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
