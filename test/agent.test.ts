import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { admission } from "../src/cli/admission";
import { boundedLines, spawnDirectory, strippedEnvironment } from "../src/cli/agent";
import { batchArgument, programCommand, programEnvironment, signalProcess, which } from "../src/cli/program";
import { type Output, main } from "../src/cli/main";
import { tempDir } from "./fixture";
import { systemdScopes } from "../src/cli/supervise";
import { Worktrees } from "../src/cli/worktree";

// Launches here are admitted at once, whatever the host running the tests carries.
beforeEach(() => {
	vi.spyOn(admission, "admit").mockResolvedValue();
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

const windows = process.platform === "win32";
/**
 * Codex runs only under Linux supervision, and Windows lacks POSIX modes and
 * unprivileged symlinks, so tests of those run on POSIX alone.
 */
const posix = test.skipIf(windows);

/** The variables a fake agent CLI logs, so a test can compare the environment it was launched with. */
const LOGGED = /^(CLAUDE|ANTHROPIC|QUEST|OP_|CODEX)/;

/**
 * Fake agent CLIs. Each logs its argv, stdin, and the variables it was given,
 * then behaves as FAKE_MODE says.
 */
const FAKES: Record<string, string> = {
	claude: `
const fs = require("node:fs");
const argv = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ${LOGGED}.test(k)));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, stdin, env, cwd: process.cwd() }) + "\\n");
const at = (flag) => argv[argv.indexOf(flag) + 1];
const session = argv.includes("--resume") ? at("--resume") : at("--session-id");
const result = (fields) => console.log(JSON.stringify({ type: "result", session_id: session, ...fields }));
if (process.env.FAKE_MODE === "limited") {
	result({ is_error: true, result: "You've hit your weekly limit · resets 3pm (UTC)" });
	process.exit(1);
}
if (process.env.FAKE_MODE === "free-limited") {
	result({ is_error: true, result: "Free usage exceeded" });
	process.exit(1);
}
if (process.env.FAKE_MODE === "logged-out") {
	result({ is_error: true, result: "Not logged in · Please run /login" });
	process.exit(1);
}
if (process.env.FAKE_MODE === "limit-reply") {
	result({ is_error: false, result: "fixed the usage limit check" });
} else if (process.env.FAKE_MODE === "noisy") {
	process.stdout.write("not json\\n");
	process.stderr.write("warning\\n");
	process.exitCode = 1;
} else if (process.env.FAKE_MODE === "sleep") {
	process.on("SIGTERM", () => {
		fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ terminated: true }) + "\\n");
		process.exit(143);
	});
	setInterval(() => {}, 1000);
} else {
	result({ is_error: false, result: "done", total_cost_usd: 0.25 });
}
`,
	codex: `
const fs = require("node:fs");
const argv = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ${LOGGED}.test(k)));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, stdin, env, cwd: process.cwd() }) + "\\n");
const event = (value) => console.log(JSON.stringify(value));
const resume = argv[1] === "resume";
if (process.env.FAKE_MODE === "late-thread") {
	// Announce the thread only after a while, then keep running.
	setTimeout(() => event({ type: "thread.started", thread_id: "thread-late" }), 500);
	setInterval(() => {}, 1000);
	return;
}
event({ type: "thread.started", thread_id: resume ? argv[argv.length - 2] : "thread-1" });
event({ type: "turn.started" });
if (process.env.FAKE_MODE === "crash") process.kill(process.pid, "SIGKILL");
if (process.env.FAKE_MODE === "decision") {
	event({ type: "item.completed", item: { type: "agent_message", text: "Which option?" } });
	return;
}
if (process.env.FAKE_MODE === "limited") {
	event({ type: "error", message: "You've hit your usage limit. Try again at 3:15 PM." });
	event({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again at 3:15 PM." } });
	process.exit(1);
}
if (process.env.FAKE_MODE === "logged-out") {
	const message = "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header";
	event({ type: "error", message: "Reconnecting... 1/5 (" + message + ")" });
	event({ type: "turn.failed", error: { message } });
	process.exit(1);
}
if (process.env.FAKE_MODE === "reconnect") event({ type: "error", message: "Reconnecting... 1/5" });
event({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "first" } });
event({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "final reply" } });
event({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
`,
};

/**
 * A script on PATH: a shebang script on POSIX, and on Windows a `.cmd` shim
 * running it, as npm installs the agent CLIs there.
 */
function fake(dir: string, name: string, body: string): void {
	if (windows) {
		writeFileSync(join(dir, `${name}.js`), body);
		writeFileSync(join(dir, `${name}.cmd`), `@"${process.execPath}" "%~dp0${name}.js" %*\r\n`);
		return;
	}
	const path = join(dir, name);
	writeFileSync(path, `#!${process.execPath}\n${body}`);
	chmodSync(path, 0o755);
}

interface Setup {
	worktree: string;
	runtime: string;
	log: string;
	/** Every logged invocation of a fake agent CLI. */
	calls(): Record<string, unknown>[];
}

function setup(): Setup {
	const dir = tempDir();
	const bin = join(dir, "bin");
	mkdirSync(bin);
	for (const [name, body] of Object.entries(FAKES)) fake(bin, name, body);
	const worktree = join(dir, "repo");
	mkdirSync(worktree);
	execFileSync("git", ["-C", worktree, "init", "-q"]);
	const runtime = join(dir, "runtime");
	mkdirSync(runtime, { mode: 0o700 });
	const log = join(dir, "agent.log");
	// Only what the test sets: the caller may itself run in an agent session.
	for (const name of Object.keys(process.env)) if (LOGGED.test(name)) vi.stubEnv(name, undefined);
	vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
	vi.stubEnv("XDG_RUNTIME_DIR", runtime);
	vi.stubEnv("FAKE_LOG", log);
	// The coordinating session's own harness state and credentials.
	vi.stubEnv("CLAUDECODE", "1");
	vi.stubEnv("CLAUDE_CODE_ENTRYPOINT", "cli");
	vi.stubEnv("ANTHROPIC_API_KEY", "sk-session");
	vi.stubEnv("OP_SERVICE_ACCOUNT_TOKEN", "ops-token");
	vi.stubEnv("CODEX_THREAD_ID", "parent");
	vi.stubEnv("CODEX_HOME", join(dir, "codex"));
	return {
		worktree,
		runtime,
		log,
		calls: () =>
			existsSync(log)
				? readFileSync(log, "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line) as Record<string, unknown>)
				: [],
	};
}

/** Real registry and release/restore lifecycle; only the process-ownership backend and CLI are fake. */
async function managed() {
	const s = setup();
	const home = join(s.runtime, "worktrees");
	vi.stubEnv("QUEST_WORKTREE_HOME", home);
	vi.spyOn(systemdScopes, "check").mockImplementation(() => {});
	vi.spyOn(systemdScopes, "run").mockImplementation(
		(_unit, cwd, command, options) =>
			new Promise((resolve, reject) => {
				const child = spawn(command[0], command.slice(1), {
					cwd,
					env: options?.env,
					stdio: ["pipe", "pipe", "pipe"],
				});
				options!.spawned!(child);
				child.once("error", reject);
				child.once("close", (code) => resolve(code ?? 1));
			}),
	);
	writeFileSync(join(s.worktree, ".gitignore"), "cache/\n.worktrees/\n");
	writeFileSync(join(s.worktree, "source"), "original");
	execFileSync("git", ["-C", s.worktree, "add", "."]);
	execFileSync("git", [
		"-C",
		s.worktree,
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@localhost",
		"commit",
		"-qm",
		"initial",
	]);
	const worktrees = new Worktrees(home);
	worktrees.configure(100_000_000);
	const record = await worktrees.create(s.worktree, "agent", 10_000_000, "HEAD", ["cache"]);
	s.worktree = record.path;
	return { ...s, worktrees, record };
}

async function quest(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const out: Output = {
		stdout: (text) => {
			stdout += text;
		},
		stderr: (text) => {
			stderr += text;
		},
	};
	const code = await main(args, out);
	return { code, stdout, stderr };
}

const launch = (harness: string) => [
	"--harness",
	harness,
	"--model",
	"opus",
	"--effort",
	"high",
	"--permission-mode",
	"auto",
];

test("the agent environment holds no session credentials or harness state", () => {
	const env = strippedEnvironment({
		PATH: "/bin",
		HOME: "/home/me",
		CLAUDECODE: "1",
		CLAUDE_CODE_SSE_PORT: "1",
		ANTHROPIC_API_KEY: "sk-session",
		ANTHROPIC_BASE_URL: "https://proxy",
		QUEST_GATE_ADMITTED: "1",
		QUEST_GATE_PRIORITY: "1",
		MBX_SCHEDULER_PRIORITY: "normal",
		OP_SERVICE_ACCOUNT_TOKEN: "t",
		OP_SESSION_me: "s",
		OPENAI_API_KEY: "o",
		CODEX_API_KEY: "c",
		CODEX_SANDBOX: "seatbelt",
		CODEX_HOME: "/home/me/.codex",
		CLAUDE_CONFIG_DIR: "/home/me/.claude-work",
	});
	expect(env).toEqual({
		PATH: "/bin",
		HOME: "/home/me",
		CODEX_HOME: "/home/me/.codex",
		CLAUDE_CONFIG_DIR: "/home/me/.claude-work",
	});
});

test("outside a priority gate, the agent keeps its mbx priority", () => {
	expect(strippedEnvironment({ PATH: "/bin", MBX_SCHEDULER_PRIORITY: "low" })).toEqual({
		PATH: "/bin",
		MBX_SCHEDULER_PRIORITY: "low",
	});
});

test("on Windows, the agent environment drops credentials whatever their case", () => {
	const env = strippedEnvironment(
		{
			Path: "C:\\bin",
			op_service_account_token: "t",
			Anthropic_Auth_Token: "a",
			Claude_Config_Dir: "C:\\claude",
			Codex_Home: "C:\\codex",
		},
		"win32",
	);
	expect(env).toEqual({ Path: "C:\\bin", Claude_Config_Dir: "C:\\claude", Codex_Home: "C:\\codex" });
	// POSIX names are case-sensitive, so only the exact names are credentials there.
	expect(strippedEnvironment({ op_token: "t" }, "linux")).toEqual({ op_token: "t" });
});

test("start refuses max effort before launching anything", async () => {
	const args = launch("claude").map((arg) => (arg === "high" ? "max" : arg));
	const result = await quest("agent", "start", ...args, ".", "go");
	expect(result.code).toBe(2);
	expect(result.stderr).toContain("max is never run");
});

test("start runs claude with every launch setting on its own login", async () => {
	const s = setup();
	const result = await quest("agent", "start", ...launch("claude"), s.worktree, "/quest-start quest/m0/a.md");
	expect(result.code).toBe(0);
	const [call] = s.calls();
	const argv = call.argv as string[];
	const session = argv[argv.indexOf("--session-id") + 1];
	expect(argv).toEqual([
		"-p",
		"--output-format",
		"json",
		"--model",
		"opus",
		"--effort",
		"high",
		"--permission-mode",
		"auto",
		"--session-id",
		session,
	]);
	expect(call.stdin).toBe("/quest-start quest/m0/a.md");
	// Windows may spell the same directory with a short (8.3) name or either slash.
	expect(realpathSync.native(call.cwd as string)).toBe(
		realpathSync.native(
			execFileSync("git", ["-C", s.worktree, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(),
		),
	);
	// No session credentials, harness markers, or secret-manager token, so the CLI uses its stored login.
	expect(call.env).toEqual({
		CODEX_HOME: process.env.CODEX_HOME,
		QUEST_WORKTREE_HOME: process.env.QUEST_WORKTREE_HOME,
	});
	expect(result.stdout).toBe(`session ${session}\noutcome finished\n\ndone\n`);
});

test("a launch that died leaves no record that blocks the next launch", async () => {
	const s = setup();
	const dir = spawnDirectory(join(s.runtime, "quest", "agent"), s.worktree);
	mkdirSync(join(dir, "agents"), { recursive: true });
	const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
	// A record named as a launch names it: the worktree's digest, then the run.
	const records = join(dir, "agents");
	const worktree = createHash("sha256").update(realpathSync(s.worktree)).digest("hex").slice(0, 16);
	writeFileSync(
		join(records, `${worktree}.stale.json`),
		JSON.stringify({ pid: dead, child: dead, worktree: s.worktree }),
	);
	expect((await quest("agent", "start", ...launch("claude"), s.worktree, "go")).code).toBe(0);
	expect(readdirSync(records)).toEqual([]);
});

test("an account at its usage limit exits 3, and the session resumes once it resets", async () => {
	const s = setup();
	vi.stubEnv("FAKE_MODE", "limited");
	const started = await quest("agent", "start", ...launch("claude"), s.worktree, "go");
	expect(started.code).toBe(3);
	const session = /^session (\S+)$/m.exec(started.stdout)![1];
	expect(started.stdout).toBe(
		`session ${session}\noutcome limited\n\nYou've hit your weekly limit · resets 3pm (UTC)\n`,
	);

	vi.stubEnv("FAKE_MODE", "");
	const resumed = await quest("agent", "resume", ...launch("claude"), s.worktree, session, "continue");
	expect(resumed.code).toBe(0);
	const call = s.calls()[1];
	expect(call.argv).toContain("--resume");
	expect(call.argv).toContain(session);
	expect(call.argv).not.toContain("--session-id");
	expect(call.stdin).toBe("continue");
});

test("a launch waits for admission before it claims the worktree", async () => {
	const s = setup();
	vi.spyOn(admission, "admit").mockImplementation(async (deps, signal, held) => {
		expect([held, signal.aborted]).toEqual([process.pid, false]);
		// Nothing holds the worktree while the launch waits.
		const state = join(s.runtime, "quest", "agent");
		expect(readdirSync(join(state, readdirSync(state)[0], "agents"))).toEqual([]);
		deps.notice("waiting for the load average to fall before starting an agent");
	});
	const started = await quest("agent", "start", ...launch("claude"), s.worktree, "go");
	expect(started).toMatchObject({
		code: 0,
		stderr: "quest: waiting for the load average to fall before starting an agent\n",
	});
});

test("agent admit exits 0 once admitted", async () => {
	const admit = vi.spyOn(admission, "admit").mockResolvedValue();
	expect(await quest("agent", "admit")).toEqual({ code: 0, stdout: "", stderr: "" });
	// No process runs a coordinator's own sub-agent, so nothing holds its admission.
	expect(admit.mock.calls[0][2]).toBeUndefined();
});

test("a spent free usage allowance exits 3 as limited", async () => {
	const s = setup();
	vi.stubEnv("FAKE_MODE", "free-limited");
	const result = await quest("agent", "start", ...launch("claude"), s.worktree, "go");
	expect(result.code).toBe(3);
	expect(result.stdout).toMatch(/^session \S+\noutcome limited\n\nFree usage exceeded\n$/);
});

test("a logged-out claude exits 4 and names its login command", async () => {
	const s = setup();
	vi.stubEnv("FAKE_MODE", "logged-out");
	const result = await quest("agent", "start", ...launch("claude"), s.worktree, "go");
	expect(result.code).toBe(4);
	expect(result.stdout).toMatch(/^session \S+\noutcome logged-out\n\nNot logged in · Please run \/login\n$/);
	expect(result.stderr).toBe("quest: claude is logged out; run `claude auth login`\n");
});

posix("codex runs on its own login and reports its thread, last message, limit, and logout", async () => {
	const s = await managed();
	const started = await quest("agent", "start", ...launch("codex"), s.worktree, "go");
	expect(started).toEqual({ code: 0, stdout: "session thread-1\noutcome finished\n\nfinal reply\n", stderr: "" });
	expect(s.calls()[0].argv).toEqual([
		"exec",
		"--json",
		"-m",
		"opus",
		"-c",
		'model_reasoning_effort="high"',
		"-c",
		'sandbox_mode="auto"',
		"-c",
		'approval_policy="never"',
		"-",
	]);
	expect(s.calls()[0].env).toEqual({
		CODEX_HOME: process.env.CODEX_HOME,
		QUEST_WORKTREE_HOME: process.env.QUEST_WORKTREE_HOME,
	});

	const resumed = await quest("agent", "resume", ...launch("codex"), s.worktree, "thread-1", "answer");
	expect(resumed.code).toBe(0);
	expect((s.calls()[1].argv as string[]).slice(0, 3)).toEqual(["exec", "resume", "--json"]);
	expect((s.calls()[1].argv as string[]).slice(-2)).toEqual(["thread-1", "-"]);

	vi.stubEnv("FAKE_MODE", "limited");
	const limited = await quest("agent", "start", ...launch("codex"), s.worktree, "go");
	expect(limited).toEqual({
		code: 3,
		stdout: "session thread-1\noutcome limited\n\nYou've hit your usage limit. Try again at 3:15 PM.\n",
		stderr: "",
	});

	vi.stubEnv("FAKE_MODE", "logged-out");
	const loggedOut = await quest("agent", "start", ...launch("codex"), s.worktree, "go");
	expect(loggedOut.code).toBe(4);
	expect(loggedOut.stdout).toContain("outcome logged-out\n");
	expect(loggedOut.stderr).toBe("quest: codex is logged out; run `codex login`\n");
});

test("stop ends a live agent, which reports it as stopped", async () => {
	const s = setup();
	vi.stubEnv("FAKE_MODE", "sleep");
	const running = quest("agent", "start", ...launch("claude"), s.worktree, "go");
	const records = join(spawnDirectory(join(s.runtime, "quest", "agent"), s.worktree), "agents");
	await vi.waitFor(() => {
		expect(readdirSync(records)).toHaveLength(1);
		expect(s.calls()).toHaveLength(1);
	});

	// A second agent in the same worktree is refused while the first runs.
	const second = await quest("agent", "start", ...launch("claude"), s.worktree, "again");
	expect(second.code).toBe(1);
	expect(second.stderr).toContain("an agent is already running");

	const stopped = await quest("agent", "stop", s.worktree);
	expect(stopped.code).toBe(0);
	expect(stopped.stdout).toMatch(/^stopped .* session \S+\n$/);
	const started = await running;
	expect(started.code).toBe(1);
	expect(started.stdout).toMatch(/^session \S+\noutcome stopped\n$/);
	// Windows has no SIGTERM: there the agent's process tree is terminated at once.
	expect(s.calls().slice(1)).toEqual(windows ? [] : [{ terminated: true }]);
	expect(readdirSync(records)).toEqual([]);

	expect((await quest("agent", "stop", s.worktree)).stdout).toBe("no agent running\n");
});

test("stop --all ends every agent in the repository and deletes the spawn's state", async () => {
	const s = setup();
	vi.stubEnv("FAKE_MODE", "sleep");
	const running = quest("agent", "start", ...launch("claude"), s.worktree, "go");
	const dir = spawnDirectory(join(s.runtime, "quest", "agent"), s.worktree);
	await vi.waitFor(() => expect(s.calls()).toHaveLength(1));
	const stopped = await quest("--root", s.worktree, "agent", "stop", "--all");
	expect(stopped.code).toBe(0);
	expect(stopped.stdout).toMatch(/^stopped .* session \S+\n$/);
	expect((await running).stdout).toMatch(/outcome stopped\n$/);
	expect(existsSync(dir)).toBe(false);

	expect(await quest("--root", s.worktree, "agent", "stop", "--all")).toEqual({
		code: 0,
		stdout: "no agent running\n",
		stderr: "",
	});
	// It takes a worktree or --all, never both or neither.
	expect((await quest("agent", "stop")).code).toBe(2);
});

test("concurrent launches in one worktree run only one agent", async () => {
	const s = setup();
	vi.stubEnv("FAKE_MODE", "sleep");
	const first = quest("agent", "start", ...launch("claude"), s.worktree, "one");
	const second = quest("agent", "start", ...launch("claude"), s.worktree, "two");
	// The refused launch returns first; the other runs until stopped.
	const refused = await Promise.race([first, second]);
	expect(refused.code).toBe(1);
	expect(refused.stderr).toContain("an agent is already running");
	await vi.waitFor(() => expect(s.calls()).toHaveLength(1));
	expect((await quest("agent", "stop", s.worktree)).code).toBe(0);
	const results = await Promise.all([first, second]);
	expect(results.filter((result) => result.stdout.endsWith("outcome stopped\n"))).toHaveLength(1);
	expect(s.calls().filter((call) => "argv" in call)).toHaveLength(1);
});

test("a finished turn whose reply mentions a usage limit is not limited", async () => {
	const s = setup();
	vi.stubEnv("FAKE_MODE", "limit-reply");
	const result = await quest("agent", "start", ...launch("claude"), s.worktree, "go");
	expect(result.code).toBe(0);
	expect(result.stdout).toContain("outcome finished\n");
});

posix("a retried codex stream error does not fail a completed turn", async () => {
	const s = await managed();
	vi.stubEnv("FAKE_MODE", "reconnect");
	const result = await quest("agent", "start", ...launch("codex"), s.worktree, "go");
	expect(result).toEqual({ code: 0, stdout: "session thread-1\noutcome finished\n\nfinal reply\n", stderr: "" });
});

test("an agent that prints no result fails, showing its stderr and the end of its output", async () => {
	const s = setup();
	vi.stubEnv("FAKE_MODE", "noisy");
	const result = await quest("agent", "start", ...launch("claude"), s.worktree, "go");
	expect(result.code).toBe(1);
	expect(result.stdout).toMatch(/^session \S+\noutcome failed\n$/);
	expect(result.stderr).toBe("warning\nquest: claude printed no result; its output ended with:\nnot json\n\n");
});

test("a prompt starting with a dash is the prompt, not an option", async () => {
	const s = setup();
	const result = await quest("agent", "start", ...launch("claude"), s.worktree, "- A: yes");
	expect(result.code).toBe(0);
	expect(s.calls()[0].stdin).toBe("- A: yes");
});

test("a launch refuses while stop --all is ending the spawn", async () => {
	const s = setup();
	const dir = spawnDirectory(join(s.runtime, "quest", "agent"), s.worktree);
	// A live `stop --all` marks the spawn before listing its records.
	writeFileSync(join(dir, "ending"), String(process.pid));
	const refused = await quest("agent", "start", ...launch("claude"), s.worktree, "go");
	expect(refused.code).toBe(1);
	expect(refused.stderr).toContain("the spawn is ending");
	expect(s.calls()).toEqual([]);
	expect(readdirSync(join(dir, "agents"))).toEqual([]);

	// A mark left by a `stop --all` that died does not block the next spawn.
	writeFileSync(join(dir, "ending"), String(spawnSync(process.execPath, ["-e", ""]).pid));
	expect((await quest("agent", "start", ...launch("claude"), s.worktree, "go")).code).toBe(0);
});

posix("an agent whose record is lost is killed rather than left running untracked", async () => {
	const s = await managed();
	vi.stubEnv("FAKE_MODE", "late-thread");
	const running = quest("agent", "start", ...launch("codex"), s.worktree, "go");
	await vi.waitFor(() => expect(s.calls()).toHaveLength(1));
	// The state disappears before the agent announces its thread.
	rmSync(spawnDirectory(join(s.runtime, "quest", "agent"), s.worktree), { recursive: true, force: true });
	const result = await running;
	expect(result.code).toBe(1);
	expect(result.stderr).toContain("ENOENT");
});

posix("every command refuses a state directory that is a symlink", async () => {
	const s = setup();
	const elsewhere = join(s.runtime, "elsewhere");
	mkdirSync(elsewhere, { mode: 0o700 });
	mkdirSync(join(s.runtime, "quest"));
	symlinkSync(elsewhere, join(s.runtime, "quest", "agent"));
	for (const args of [
		["agent", "start", ...launch("claude"), s.worktree, "go"],
		["agent", "stop", s.worktree],
		["--root", s.worktree, "agent", "stop", "--all"],
	]) {
		const result = await quest(...args);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("is a symlink or not a directory");
	}
	expect(s.calls()).toEqual([]);
	expect(readdirSync(elsewhere)).toEqual([]);
});

test("lines longer than the limit are dropped, not held", () => {
	const read: string[] = [];
	const lines = boundedLines(10, (line) => read.push(line));
	lines.data(`short\n${"x".repeat(15)}`);
	lines.data("yyy\nafter\n");
	lines.data(`${"z".repeat(20)}\nlast`);
	expect(lines.end()).toBe(2);
	expect(read).toEqual(["short", "after", "last"]);
});

test("the agent CLI is found on PATH, never in the worktree it runs in", async () => {
	const s = setup();
	// The worktree supplies its own CLI, and PATH names the worktree relatively.
	const planted = join(s.worktree, "planted.log");
	fake(s.worktree, "claude", `require("node:fs").writeFileSync(${JSON.stringify(planted)}, "ran");`);
	vi.stubEnv("PATH", `.${delimiter}${process.env.PATH}`);
	const result = await quest("agent", "start", ...launch("claude"), s.worktree, "go");
	expect(result.code).toBe(0);
	expect(existsSync(planted)).toBe(false);
	expect(s.calls()).toHaveLength(1);
});

test("a missing agent CLI fails before any agent state is written", async () => {
	const s = setup();
	vi.stubEnv("PATH", join(s.runtime, "empty"));
	const result = await quest("agent", "start", ...launch("claude"), s.worktree, "go");
	expect(result.code).toBe(1);
	expect(result.stderr).toContain("claude is not installed");
	expect(existsSync(join(s.runtime, "quest", "agent"))).toBe(false);
});

test("launch settings reach the agent unchanged, whatever characters they hold", async () => {
	const s = setup();
	// Through a Windows batch shim, each of these is special to cmd.exe or the C runtime.
	const model = 'a&b|c<d>e^f "g" (h) !i! \\"j\\ k,l;m=n [o]';
	const args = launch("claude");
	args[args.indexOf("--model") + 1] = model;
	const result = await quest("agent", "start", ...args, s.worktree, "go");
	expect(result.code).toBe(0);
	const argv = s.calls()[0].argv as string[];
	expect(argv[argv.indexOf("--model") + 1]).toBe(model);
});

test.runIf(windows)("a batch shim's own program search never reaches the worktree", async () => {
	const s = setup();
	const bin = join(s.worktree, "..", "bin");
	const shim = join(s.runtime, "shim");
	mkdirSync(shim);
	// As npm's shim does without a node.exe beside it, this one runs its interpreter by name.
	writeFileSync(join(shim, "claude.cmd"), `@interpreter "${join(bin, "claude.js")}" %*\r\n`);
	writeFileSync(join(shim, "interpreter.cmd"), `@"${process.execPath}" %*\r\n`);
	const planted = join(s.runtime, "planted.log");
	writeFileSync(join(s.worktree, "interpreter.cmd"), `@echo ran> "${planted}"\r\n`);
	// PATH names the worktree relatively, too.
	vi.stubEnv("PATH", `.${delimiter}${shim}${delimiter}${process.env.PATH}`);
	const result = await quest("agent", "start", ...launch("claude"), s.worktree, "go");
	expect(result.code).toBe(0);
	expect(existsSync(planted)).toBe(false);
	expect(s.calls()).toHaveLength(1);
});

test("PATH lookup skips relative entries and, on Windows, tries PATHEXT", () => {
	const bin = join(tempDir(), "bin");
	mkdirSync(bin);
	if (windows) {
		for (const name of ["tool.CMD", "tool.ps1", "tool"]) writeFileSync(join(bin, name), "");
		const env = { Path: `.;relative;"${bin}"`, PATHEXT: ".PS1;.COM;.EXE;.BAT;.CMD" };
		// A PowerShell script is not launchable, and an extensionless file is never tried.
		expect(which("tool", env)).toBe(realpathSync(join(bin, "tool.CMD")));
		expect(which("missing", env)).toBeUndefined();
		return;
	}
	writeFileSync(join(bin, "tool"), "");
	chmodSync(join(bin, "tool"), 0o755);
	writeFileSync(join(bin, "plain"), "");
	expect(which("tool", { PATH: `.:relative::${bin}` })).toBe(realpathSync(join(bin, "tool")));
	expect(which("plain", { PATH: bin })).toBeUndefined();
	expect(which("tool", { PATH: "." })).toBeUndefined();
});

test("a Windows batch file runs through System32's cmd.exe with each argument escaped", () => {
	const env = { SystemRoot: "C:\\Windows" };
	expect(programCommand("C:\\npm\\claude.cmd", ["-p", "a b&c"], env, "win32")).toEqual({
		file: "C:\\Windows\\System32\\cmd.exe",
		args: ["/d", "/v:off", "/s", "/c", '""C:\\npm\\claude.cmd" ^^^"-p^^^" ^^^"a^^^ b^^^&c^^^""'],
		windowsVerbatimArguments: true,
	});
	expect(programCommand("C:\\bin\\claude.exe", ["-p"], env, "win32")).toEqual({
		file: "C:\\bin\\claude.exe",
		args: ["-p"],
		windowsVerbatimArguments: false,
	});
	expect(programCommand("/bin/claude.cmd", ["-p"], env, "linux").windowsVerbatimArguments).toBe(false);
	// Quotes and trailing backslashes follow the C runtime's rules before cmd.exe's escapes.
	expect(batchArgument('a\\"b\\')).toBe('^^^"a\\\\\\^^^"b\\\\^^^"');
	expect(() => batchArgument("%PATH%")).toThrow("cannot pass");
	expect(() => batchArgument("a\nb")).toThrow("cannot pass");
	// A launched program keeps only PATH's absolute directories and, on Windows, skips its working directory.
	expect(programEnvironment({ Path: '.;C:\\bin;relative;;"C:\\x y"', HOME: "h" }, "win32")).toEqual({
		Path: 'C:\\bin;"C:\\x y"',
		HOME: "h",
		NoDefaultCurrentDirectoryInExePath: "1",
	});
	expect(programEnvironment({ PATH: ".:/bin::relative", HOME: "h" }, "linux")).toEqual({ PATH: "/bin", HOME: "h" });
});

test("signalling a process that already exited is not an error", () => {
	// Past Linux's and macOS's pid limits, and not a multiple of 4 as Windows pids are.
	expect(() => signalProcess(0x3ffffffe, "SIGTERM")).not.toThrow();
});

for (const mode of ["finished", "decision", "crash"]) {
	posix(`Codex ${mode} releases scratch and resume restores the registered checkout`, async () => {
		const s = await managed();
		vi.stubEnv("FAKE_MODE", mode);
		mkdirSync(join(s.worktree, "cache"));
		writeFileSync(join(s.worktree, "cache", "build"), "scratch");
		writeFileSync(join(s.worktree, "source"), "local source survives");
		writeFileSync(join(s.worktree, "untracked"), "new source survives");
		const run = await quest("agent", "start", ...launch("codex"), s.worktree, "go");
		expect(run.code).toBe(mode === "crash" ? 1 : 0);
		if (mode === "decision") expect(run.stdout).toContain("Which option?");
		expect(s.worktrees.status().records[0]).toMatchObject({ phase: "released", runs: [] });
		expect(existsSync(join(s.worktree, "cache"))).toBe(false);
		expect(readFileSync(join(s.worktree, "source"), "utf8")).toBe("local source survives");
		expect(readFileSync(join(s.worktree, "untracked"), "utf8")).toBe("new source survives");
		const runScope = vi.mocked(systemdScopes.run).getMockImplementation()!;
		vi.mocked(systemdScopes.run).mockImplementation((...args) => {
			expect(s.worktrees.status().records[0]).toMatchObject({ phase: "active" });
			expect(s.worktrees.status().records[0].runs).toHaveLength(1);
			return runScope(...args);
		});
		vi.stubEnv("FAKE_MODE", "finished");
		const resumed = await quest("agent", "resume", ...launch("codex"), s.worktree, "thread-1", "answer");
		expect(resumed.code).toBe(0);
		expect(s.worktrees.status().records[0]).toMatchObject({ phase: "released", runs: [] });
		expect(s.calls()[1].stdin).toBe("answer");
	});
}

posix("Codex refuses an unmanaged checkout before writing agent state", async () => {
	const s = setup();
	vi.stubEnv("QUEST_WORKTREE_HOME", join(s.runtime, "worktrees"));
	vi.spyOn(systemdScopes, "check").mockImplementation(() => {});
	const result = await quest("agent", "start", ...launch("codex"), s.worktree, "go");
	expect(result.code).toBe(2);
	expect(result.stderr).toContain("registered Quest checkout");
	expect(s.calls()).toEqual([]);
	expect(existsSync(join(s.runtime, "quest", "agent"))).toBe(false);
});

posix("Codex refuses unsupported supervision before writing agent state", async () => {
	const s = await managed();
	vi.mocked(systemdScopes.check).mockImplementation(() => {
		throw new Error("unsupported host");
	});
	const result = await quest("agent", "start", ...launch("codex"), s.worktree, "go");
	expect(result.code).toBe(1);
	expect(result.stderr).toContain("unsupported host");
	expect(existsSync(join(s.runtime, "quest", "agent"))).toBe(false);
	expect(s.calls()).toEqual([]);
});

posix("Codex rejects a registered path whose Git ownership was replaced before it runs", async () => {
	const s = await managed();
	rmSync(join(s.worktree, ".git"));
	execFileSync("git", ["-C", s.worktree, "init", "-q"]);
	const result = await quest("agent", "start", ...launch("codex"), s.worktree, "go");
	expect(result.code).toBe(1);
	expect(result.stderr).toContain("checkout ownership/lock changed");
	expect(s.calls()).toEqual([]);
});

posix("a Codex release failure is reported instead of a finished outcome", async () => {
	const s = await managed();
	mkdirSync(join(s.worktree, "cache"));
	writeFileSync(join(s.worktree, "cache", "tracked"), "keep");
	execFileSync("git", ["-C", s.worktree, "add", "-f", "cache/tracked"]);
	const result = await quest("agent", "start", ...launch("codex"), s.worktree, "go");
	expect(result.code).toBe(1);
	expect(result.stderr).toContain("release failed");
	expect(result.stdout).not.toContain("outcome finished");
	expect(existsSync(join(s.worktree, "cache", "tracked"))).toBe(true);
	expect(s.worktrees.status().records[0]).toMatchObject({ phase: "active", runs: [] });
});
