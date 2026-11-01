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
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { launchEnvironment, boundedLines, redactedLines, spawnDirectory } from "../src/cli/agent";
import { batchArgument, programCommand, which } from "../src/cli/program";
import { type Output, main } from "../src/cli/main";
import { tempDir } from "./fixture";
import { systemdScopes } from "../src/cli/supervise";
import { Worktrees } from "../src/cli/worktree";

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

/**
 * Fake agent CLIs and secret manager. Each logs its argv, stdin, and the
 * variables it was given, then behaves as FAKE_MODE says.
 */
const FAKES: Record<string, string> = {
	claude: `
const fs = require("node:fs");
const argv = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CLAUDE|ANTHROPIC|QUEST|OP_|CODEX)/.test(k)));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, stdin, env, cwd: process.cwd() }) + "\\n");
const at = (flag) => argv[argv.indexOf(flag) + 1];
const session = argv.includes("--resume") ? at("--resume") : at("--session-id");
const key = process.env.ANTHROPIC_API_KEY;
const result = (fields) => console.log(JSON.stringify({ type: "result", session_id: session, ...fields }));
if (process.env.FAKE_MODE === "exhausted") {
	result({ is_error: true, result: "Credit balance is too low" });
	process.exit(1);
}
if (process.env.FAKE_MODE === "quota-reply") {
	result({ is_error: false, result: "fixed the insufficient_quota check" });
} else if (process.env.FAKE_MODE === "noisy") {
	// No result, and a key just before the last 64 KiB of output.
	process.stdout.write("x".repeat(1000) + key + "y".repeat(64 * 1024 - 5) + "\\n");
	process.exitCode = 1;
} else if (process.env.FAKE_MODE === "leak") {
	// The key arrives on stderr in two separate writes.
	process.stderr.write("using " + key.slice(0, 4));
	setTimeout(() => {
		process.stderr.write(key.slice(4) + "\\nunterminated " + key);
		result({ is_error: false, result: "leaked" });
	}, 100);
} else if (process.env.FAKE_MODE === "sleep") {
	process.on("SIGTERM", () => {
		fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ terminated: true }) + "\\n");
		process.exit(143);
	});
	setInterval(() => {}, 1000);
} else {
	result({ is_error: false, result: "done with " + key, total_cost_usd: 0.25 });
}
`,
	codex: `
const fs = require("node:fs");
const argv = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CLAUDE|ANTHROPIC|QUEST|OP_|CODEX)/.test(k)));
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
if (process.env.FAKE_MODE === "exhausted") {
	event({ type: "error", message: "insufficient_quota: You exceeded your current quota" });
	event({ type: "turn.failed", error: { message: "insufficient_quota" } });
	process.exit(1);
}
if (process.env.FAKE_MODE === "reconnect") event({ type: "error", message: "Reconnecting... 1/5" });
event({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "first" } });
event({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "final reply" } });
event({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
`,
	op: `
const fs = require("node:fs");
const template = fs.readFileSync(0, "utf8");
fs.appendFileSync(process.env.FAKE_OP_LOG, template + "--\\n");
process.stdout.write(template.replace(/\\{\\{ op:\\/\\/[^/]+\\/[^/]+\\/([^ ]+) \\}\\}/g, "resolved-$1"));
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
	opLog: string;
	/** Every logged invocation of a fake agent CLI. */
	calls(): Record<string, unknown>[];
}

function setup(keys = "sk-literal op://vault/item/second"): Setup {
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
	const opLog = join(dir, "op.log");
	vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
	vi.stubEnv("XDG_RUNTIME_DIR", runtime);
	vi.stubEnv("QUEST_API_KEYS", keys);
	vi.stubEnv("FAKE_LOG", log);
	vi.stubEnv("FAKE_OP_LOG", opLog);
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
		opLog,
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
function managed() {
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
	const record = worktrees.create(s.worktree, "agent", 10_000_000, "HEAD", ["cache"]);
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

const launch = (harness: string, key: string) => [
	"--harness",
	harness,
	"--key",
	key,
	"--model",
	"opus",
	"--effort",
	"high",
	"--permission-mode",
	"auto",
];

test("the agent environment holds only its own key", () => {
	const env = launchEnvironment(
		{
			PATH: "/bin",
			HOME: "/home/me",
			CLAUDECODE: "1",
			CLAUDE_CODE_SSE_PORT: "1",
			ANTHROPIC_API_KEY: "sk-session",
			ANTHROPIC_BASE_URL: "https://proxy",
			QUEST_API_KEYS: "a b",
			QUEST_GATE_ADMITTED: "1",
			QUEST_LAND_BASE: "0123456789abcdef0123456789abcdef01234567",
			OP_SERVICE_ACCOUNT_TOKEN: "t",
			OP_SESSION_me: "s",
			OPENAI_API_KEY: "o",
			CODEX_SANDBOX: "seatbelt",
			CODEX_HOME: "/home/me/.codex",
			CLAUDE_CONFIG_DIR: "/home/me/.claude-work",
		},
		"ANTHROPIC_API_KEY",
		"sk-agent",
	);
	expect(env).toEqual({
		PATH: "/bin",
		HOME: "/home/me",
		CODEX_HOME: "/home/me/.codex",
		CLAUDE_CONFIG_DIR: "/home/me/.claude-work",
		ANTHROPIC_API_KEY: "sk-agent",
	});
});

test("start runs claude with every launch setting, one resolved key, and no key in its output", async () => {
	const s = setup();
	const result = await quest("agent", "start", ...launch("claude", "2"), s.worktree, "/quest-start quest/m0/a.md");
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
	expect(call.cwd).toBe(
		execFileSync("git", ["-C", s.worktree, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(),
	);
	// Only its own key: no session credentials, harness markers, other keys, or secret-manager token.
	expect(call.env).toEqual({
		ANTHROPIC_API_KEY: "resolved-second",
		CODEX_HOME: process.env.CODEX_HOME,
		QUEST_WORKTREE_HOME: process.env.QUEST_WORKTREE_HOME,
	});
	expect(result.stdout).toBe(`session ${session}\ncost 0.25\noutcome finished\n\ndone with <key 2>\n`);
	expect(result.stdout + result.stderr).not.toContain("resolved-second");
	// The op:// entry resolved in one invocation; the literal key never reached op.
	expect(readFileSync(s.opLog, "utf8")).toBe("{{ op://vault/item/second }}\n--\n");
});

test("keys resolve once per spawn into a user-only store, and stop --all deletes them", async () => {
	const s = setup();
	expect((await quest("agent", "start", ...launch("claude", "1"), s.worktree, "one")).code).toBe(0);
	expect((await quest("agent", "start", ...launch("claude", "2"), s.worktree, "two")).code).toBe(0);
	expect(readFileSync(s.opLog, "utf8").split("--\n").filter(Boolean)).toHaveLength(1);
	expect(s.calls().map((call) => (call.env as Record<string, string>).ANTHROPIC_API_KEY)).toEqual([
		"sk-literal",
		"resolved-second",
	]);
	const dir = spawnDirectory(join(s.runtime, "quest", "agent"), s.worktree);
	const keys = join(dir, "keys.json");
	if (!windows) {
		expect(statSync(keys).mode & 0o777).toBe(0o600);
		expect(statSync(dir).mode & 0o077).toBe(0);
	}

	// A different QUEST_API_KEYS resolves again rather than reusing stale keys.
	vi.stubEnv("QUEST_API_KEYS", "op://vault/item/third");
	expect((await quest("agent", "start", ...launch("claude", "1"), s.worktree, "three")).code).toBe(0);
	expect(readFileSync(s.opLog, "utf8").split("--\n").filter(Boolean)).toHaveLength(2);

	const stop = await quest("--root", s.worktree, "agent", "stop", "--all");
	expect(stop).toEqual({ code: 0, stdout: "deleted the resolved keys\n", stderr: "" });
	expect(existsSync(dir)).toBe(false);
});

test("a launch that died leaves no lock or record that blocks the next launch", async () => {
	const s = setup();
	const dir = spawnDirectory(join(s.runtime, "quest", "agent"), s.worktree);
	mkdirSync(join(dir, "agents"), { recursive: true });
	const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
	const lock = join(dir, "resolving");
	writeFileSync(lock, String(dead));
	// A record named as a launch names it: the worktree's digest, then the run.
	const records = join(dir, "agents");
	const worktree = createHash("sha256").update(realpathSync(s.worktree)).digest("hex").slice(0, 16);
	writeFileSync(
		join(records, `${worktree}.stale.json`),
		JSON.stringify({ pid: dead, child: dead, worktree: s.worktree }),
	);
	expect((await quest("agent", "start", ...launch("claude", "2"), s.worktree, "go")).code).toBe(0);
	expect(existsSync(lock)).toBe(false);
	expect(readdirSync(records)).toEqual([]);
});

test("a key with no credit exits 3 so the spawn resumes on the next key", async () => {
	const s = setup();
	vi.stubEnv("FAKE_MODE", "exhausted");
	const started = await quest("agent", "start", ...launch("claude", "1"), s.worktree, "go");
	expect(started.code).toBe(3);
	const session = /^session (\S+)$/m.exec(started.stdout)![1];
	expect(started.stdout).toBe(`session ${session}\noutcome exhausted\n\nCredit balance is too low\n`);

	vi.stubEnv("FAKE_MODE", "");
	const resumed = await quest("agent", "resume", ...launch("claude", "2"), s.worktree, session, "continue");
	expect(resumed.code).toBe(0);
	const call = s.calls()[1];
	expect(call.argv).toContain("--resume");
	expect(call.argv).toContain(session);
	expect(call.argv).not.toContain("--session-id");
	expect(call.stdin).toBe("continue");
	expect((call.env as Record<string, string>).ANTHROPIC_API_KEY).toBe("resolved-second");
});

posix("codex runs with its key variable and reports its thread and last message", async () => {
	const s = managed();
	const started = await quest("agent", "start", ...launch("codex", "1"), s.worktree, "go");
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
		CODEX_API_KEY: "sk-literal",
		CODEX_HOME: process.env.CODEX_HOME,
		QUEST_WORKTREE_HOME: process.env.QUEST_WORKTREE_HOME,
	});

	const resumed = await quest("agent", "resume", ...launch("codex", "2"), s.worktree, "thread-1", "answer");
	expect(resumed.code).toBe(0);
	expect((s.calls()[1].argv as string[]).slice(0, 3)).toEqual(["exec", "resume", "--json"]);
	expect((s.calls()[1].argv as string[]).slice(-2)).toEqual(["thread-1", "-"]);

	vi.stubEnv("FAKE_MODE", "exhausted");
	const exhausted = await quest("agent", "start", ...launch("codex", "1"), s.worktree, "go");
	expect(exhausted).toEqual({
		code: 3,
		stdout: "session thread-1\noutcome exhausted\n\ninsufficient_quota\n",
		stderr: "",
	});
});

test("stop ends a live agent, which reports it as stopped", async () => {
	const s = setup();
	vi.stubEnv("FAKE_MODE", "sleep");
	const running = quest("agent", "start", ...launch("claude", "1"), s.worktree, "go");
	const records = join(spawnDirectory(join(s.runtime, "quest", "agent"), s.worktree), "agents");
	await vi.waitFor(() => {
		expect(readdirSync(records)).toHaveLength(1);
		expect(s.calls()).toHaveLength(1);
	});

	// A second agent in the same worktree is refused while the first runs.
	const second = await quest("agent", "start", ...launch("claude", "1"), s.worktree, "again");
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

test("stderr is redacted even when a key spans two writes", async () => {
	const s = setup();
	vi.stubEnv("FAKE_MODE", "leak");
	const result = await quest("agent", "start", ...launch("claude", "2"), s.worktree, "go");
	expect(result.code).toBe(0);
	expect(result.stderr).toBe("using <key 2>\nunterminated <key 2>");
});

test("concurrent launches in one worktree run only one agent", async () => {
	const s = setup();
	vi.stubEnv("FAKE_MODE", "sleep");
	const first = quest("agent", "start", ...launch("claude", "1"), s.worktree, "one");
	const second = quest("agent", "start", ...launch("claude", "2"), s.worktree, "two");
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

test("a finished turn whose reply mentions credit is not an exhausted key", async () => {
	const s = setup();
	vi.stubEnv("FAKE_MODE", "quota-reply");
	const result = await quest("agent", "start", ...launch("claude", "1"), s.worktree, "go");
	expect(result.code).toBe(0);
	expect(result.stdout).toContain("outcome finished\n");
});

posix("a retried codex stream error does not fail a completed turn", async () => {
	const s = managed();
	vi.stubEnv("FAKE_MODE", "reconnect");
	const result = await quest("agent", "start", ...launch("codex", "1"), s.worktree, "go");
	expect(result).toEqual({ code: 0, stdout: "session thread-1\noutcome finished\n\nfinal reply\n", stderr: "" });
});

test("the no-result diagnostic never shows part of a key", async () => {
	const s = setup();
	vi.stubEnv("FAKE_MODE", "noisy");
	const result = await quest("agent", "start", ...launch("claude", "2"), s.worktree, "go");
	expect(result.code).toBe(1);
	expect(result.stderr).toContain("printed no result");
	// The kept tail starts inside the key; no fragment of it may precede the filler.
	for (let length = 2; length <= "resolved-second".length; length++) {
		expect(result.stderr).not.toContain(`${"resolved-second".slice(-length)}y`);
	}
});

test("a prompt starting with a dash is the prompt, not an option", async () => {
	const s = setup();
	const result = await quest("agent", "start", ...launch("claude", "1"), s.worktree, "- A: yes");
	expect(result.code).toBe(0);
	expect(s.calls()[0].stdin).toBe("- A: yes");
});

test("a launch refuses while stop --all is ending the spawn", async () => {
	const s = setup();
	const dir = spawnDirectory(join(s.runtime, "quest", "agent"), s.worktree);
	// A live `stop --all` marks the spawn before listing its records.
	writeFileSync(join(dir, "ending"), String(process.pid));
	const refused = await quest("agent", "start", ...launch("claude", "1"), s.worktree, "go");
	expect(refused.code).toBe(1);
	expect(refused.stderr).toContain("the spawn is ending");
	expect(s.calls()).toEqual([]);
	expect(readdirSync(join(dir, "agents"))).toEqual([]);

	// A mark left by a `stop --all` that died does not block the next spawn.
	writeFileSync(join(dir, "ending"), String(spawnSync(process.execPath, ["-e", ""]).pid));
	expect((await quest("agent", "start", ...launch("claude", "1"), s.worktree, "go")).code).toBe(0);
});

posix("an agent whose record is lost is killed rather than left running untracked", async () => {
	const s = managed();
	vi.stubEnv("FAKE_MODE", "late-thread");
	const running = quest("agent", "start", ...launch("codex", "1"), s.worktree, "go");
	await vi.waitFor(() => expect(s.calls()).toHaveLength(1));
	// The state disappears before the agent announces its thread.
	rmSync(spawnDirectory(join(s.runtime, "quest", "agent"), s.worktree), { recursive: true, force: true });
	const result = await running;
	expect(result.code).toBe(1);
	expect(result.stderr).toContain("ENOENT");
});

test("a long line without a newline is forwarded early, still redacted", () => {
	const written: string[] = [];
	const lines = redactedLines(
		(value) => value.replaceAll("SECRETKEY", "<key 1>"),
		8,
		(text) => written.push(text),
	);
	lines.data(`${"a".repeat(70_000)}SECRE`);
	lines.data(`TKEY${"b".repeat(10)}`);
	// Most of the line is out before it ends, so the buffer stays bounded.
	expect(written.join("").length).toBeGreaterThan(60_000);
	lines.end();
	expect(written.join("")).toBe(`${"a".repeat(70_000)}<key 1>${"b".repeat(10)}`);
});

posix("every command refuses a state directory that is a symlink", async () => {
	const s = setup();
	const elsewhere = join(s.runtime, "elsewhere");
	mkdirSync(elsewhere, { mode: 0o700 });
	mkdirSync(join(s.runtime, "quest"));
	symlinkSync(elsewhere, join(s.runtime, "quest", "agent"));
	for (const args of [
		["agent", "start", ...launch("claude", "1"), s.worktree, "go"],
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
	const result = await quest("agent", "start", ...launch("claude", "1"), s.worktree, "go");
	expect(result.code).toBe(0);
	expect(existsSync(planted)).toBe(false);
	expect(s.calls()).toHaveLength(1);
});

test("a missing agent CLI fails before any key is resolved", async () => {
	const s = setup("op://vault/item/secret");
	vi.stubEnv("PATH", join(s.runtime, "empty"));
	const result = await quest("agent", "start", ...launch("claude", "1"), s.worktree, "go");
	expect(result.code).toBe(1);
	expect(result.stderr).toContain("claude is not installed");
	expect(existsSync(s.opLog)).toBe(false);
});

test("launch settings reach the agent unchanged, whatever characters they hold", async () => {
	const s = setup();
	// Through a Windows batch shim, each of these is special to cmd.exe or the C runtime.
	const model = 'a&b|c<d>e^f "g" (h) !i! \\"j\\ k,l;m=n [o]';
	const args = launch("claude", "1");
	args[args.indexOf("--model") + 1] = model;
	const result = await quest("agent", "start", ...args, s.worktree, "go");
	expect(result.code).toBe(0);
	const argv = s.calls()[0].argv as string[];
	expect(argv[argv.indexOf("--model") + 1]).toBe(model);
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
});

test("missing keys, positions past the list, and unknown references are usage errors", async () => {
	const s = setup("sk-one vault://x");
	const unknown = await quest("agent", "start", ...launch("claude", "1"), s.worktree, "go");
	expect(unknown).toMatchObject({
		code: 2,
		stderr: "error: QUEST_API_KEYS has a vault:// reference; only op:// is supported\n",
	});

	vi.stubEnv("QUEST_API_KEYS", "sk-one");
	const past = await quest("agent", "start", ...launch("claude", "2"), s.worktree, "go");
	expect(past).toMatchObject({ code: 2, stderr: "error: --key 2 is past the 1 entries in QUEST_API_KEYS\n" });

	vi.stubEnv("QUEST_API_KEYS", "");
	expect((await quest("agent", "start", ...launch("claude", "1"), s.worktree, "go")).code).toBe(2);
	expect((await quest("agent", "stop")).code).toBe(2);
	expect(s.calls()).toEqual([]);
});

for (const mode of ["finished", "decision", "crash"]) {
	posix(`Codex ${mode} releases scratch and resume restores the registered checkout`, async () => {
		const s = managed();
		vi.stubEnv("FAKE_MODE", mode);
		mkdirSync(join(s.worktree, "cache"));
		writeFileSync(join(s.worktree, "cache", "build"), "scratch");
		writeFileSync(join(s.worktree, "source"), "local source survives");
		writeFileSync(join(s.worktree, "untracked"), "new source survives");
		const run = await quest("agent", "start", ...launch("codex", "1"), s.worktree, "go");
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
		const resumed = await quest("agent", "resume", ...launch("codex", "1"), s.worktree, "thread-1", "answer");
		expect(resumed.code).toBe(0);
		expect(s.worktrees.status().records[0]).toMatchObject({ phase: "released", runs: [] });
		expect(s.calls()[1].stdin).toBe("answer");
	});
}

posix("Codex refuses an unmanaged checkout before resolving credentials or writing key state", async () => {
	const s = setup("op://vault/item/secret");
	vi.stubEnv("QUEST_WORKTREE_HOME", join(s.runtime, "worktrees"));
	vi.spyOn(systemdScopes, "check").mockImplementation(() => {});
	const result = await quest("agent", "start", ...launch("codex", "1"), s.worktree, "go");
	expect(result.code).toBe(2);
	expect(result.stderr).toContain("registered Quest checkout");
	expect(s.calls()).toEqual([]);
	expect(existsSync(s.opLog)).toBe(false);
	expect(existsSync(join(s.runtime, "quest", "agent"))).toBe(false);
});

posix("Codex refuses unsupported supervision before resolving credentials", async () => {
	const s = managed();
	vi.mocked(systemdScopes.check).mockImplementation(() => {
		throw new Error("unsupported host");
	});
	const result = await quest("agent", "start", ...launch("codex", "1"), s.worktree, "go");
	expect(result.code).toBe(1);
	expect(result.stderr).toContain("unsupported host");
	expect(existsSync(s.opLog)).toBe(false);
	expect(existsSync(join(s.runtime, "quest", "agent"))).toBe(false);
	expect(s.calls()).toEqual([]);
});

posix("Codex rejects a registered path whose Git ownership was replaced before credentials", async () => {
	const s = managed();
	rmSync(join(s.worktree, ".git"));
	execFileSync("git", ["-C", s.worktree, "init", "-q"]);
	const result = await quest("agent", "start", ...launch("codex", "1"), s.worktree, "go");
	expect(result.code).toBe(1);
	expect(result.stderr).toContain("checkout ownership/lock changed");
	expect(existsSync(s.opLog)).toBe(false);
	expect(s.calls()).toEqual([]);
});

test("a Codex release failure is reported instead of a finished outcome", async () => {
	const s = managed();
	mkdirSync(join(s.worktree, "cache"));
	writeFileSync(join(s.worktree, "cache", "tracked"), "keep");
	execFileSync("git", ["-C", s.worktree, "add", "-f", "cache/tracked"]);
	const result = await quest("agent", "start", ...launch("codex", "1"), s.worktree, "go");
	expect(result.code).toBe(1);
	expect(result.stderr).toContain("release failed");
	expect(result.stdout).not.toContain("outcome finished");
	expect(existsSync(join(s.worktree, "cache", "tracked"))).toBe(true);
	expect(s.worktrees.status().records[0]).toMatchObject({ phase: "active", runs: [] });
});

test("a land check's base never reaches a launched agent", () => {
	const env = launchEnvironment({ PATH: "/bin", QUEST_LAND_BASE: "0".repeat(40) }, "ANTHROPIC_API_KEY", "sk-agent");
	expect(env).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-agent" });
});
