import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { type Output, main } from "../src/cli/main";
import { baseInstructions, findings, runningHarness } from "../src/cli/review";
import { tempDir } from "./fixture";

afterEach(() => {
	vi.unstubAllEnvs();
});

/** The fake CLIs are shebang scripts found on a POSIX PATH, which Windows cannot run. */
const fakes = test.skipIf(process.platform === "win32");

const FINDING = { file: "src/lib.ts", line: 2, severity: "high", title: "Off by one", body: "average([3]) is 0." };

/**
 * Fake reviewer CLIs. Each logs its argv, stdin, and the variables it was
 * given, then answers as the FAKE_* variables say. FAKE_LOGGED_OUT removes the
 * stored login, so only a credential variable the real CLI reads
 * authenticates; like the real ones, `claude auth status` counts such a
 * variable and `codex login status` does not. FAKE_REJECTED has the API
 * reject the login in each turn with the real CLI's error, in the style it
 * names. FAKE_REPLY replaces the findings reply.
 */
const FAKES: Record<string, string> = {
	claude: `
const fs = require("node:fs");
const argv = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CLAUDE|CODEX|ANTHROPIC|FAKE_HOST|PATH$)/.test(k)));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, stdin, env, cwd: process.cwd() }) + "\\n");
const credential = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"].some((k) => process.env[k]);
const loggedIn = !process.env.FAKE_LOGGED_OUT || credential;
if (argv[0] === "auth") process.exit(loggedIn ? 0 : 1);
const at = (flag) => argv[argv.indexOf(flag) + 1];
const result = (fields) => console.log(JSON.stringify({ type: "result", is_error: false, ...fields }));
const rejected = process.env.FAKE_REJECTED ?? (loggedIn ? undefined : "status");
if (rejected) {
	const session_id = at("--session-id") ?? at("--resume");
	if (rejected === "status") {
		result({ session_id, is_error: true, api_error_status: 401, result: "Failed to authenticate. API Error: 401 Invalid bearer token" });
	} else if (rejected === "stderr") {
		console.error("Login expired · Please run /login");
	} else {
		result({ session_id, is_error: true, result: "OAuth token revoked · Please run /login" });
	}
	process.exit(1);
}
const usage = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
if (argv.includes("--session-id")) {
	result({
		session_id: at("--session-id"),
		result: "Found an off-by-one.",
		usage,
		modelUsage: {
			"claude-small": { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
			"claude-big": { inputTokens: 10, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 90 },
		},
	});
} else {
	const reply = process.env.FAKE_REPLY ?? JSON.stringify({ findings: [${JSON.stringify(FINDING)}] });
	result({
		session_id: at("--resume"),
		result: reply,
		structured_output: process.env.FAKE_REPLY ? undefined : JSON.parse(reply),
		usage: { ...usage, input_tokens: 5, cache_read_input_tokens: 80, cache_creation_input_tokens: 15, output_tokens: 7 },
		modelUsage: { "claude-big": { inputTokens: 15, outputTokens: 57 } },
	});
}
`,
	codex: `
const fs = require("node:fs");
const argv = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CLAUDE|CODEX|ANTHROPIC|FAKE_HOST|PATH$)/.test(k)));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, stdin, env, cwd: process.cwd() }) + "\\n");
if (argv[0] === "login") process.exit(process.env.FAKE_LOGGED_OUT ? 1 : 0);
const event = (value) => console.log(JSON.stringify(value));
const loggedIn = !process.env.FAKE_LOGGED_OUT || process.env.CODEX_API_KEY;
const rejected = process.env.FAKE_REJECTED ?? (loggedIn ? undefined : "turn");
if (rejected === "turn") {
	const message = "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses";
	event({ type: "thread.started", thread_id: "thread-1" });
	event({ type: "error", message: "Reconnecting... 1/5 (" + message + ")" });
	event({ type: "turn.failed", error: { message } });
	process.exit(1);
}
if (rejected) {
	console.error("Error: Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.");
	process.exit(1);
}
const message = (text) => event({ type: "item.completed", item: { type: "agent_message", text } });
const zero = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
if (argv[1] === "review") {
	event({ type: "thread.started", thread_id: "thread-1" });
	message("Found an off-by-one.");
	event({ type: "turn.completed", usage: zero });
} else {
	event({ type: "thread.started", thread_id: argv[argv.length - 2] });
	message("Checking the findings.");
	message(process.env.FAKE_REPLY ?? JSON.stringify({ findings: [${JSON.stringify(FINDING)}] }));
	event({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 7 } });
}
`,
};

const git = (dir: string, ...args: string[]) =>
	execFileSync("git", ["-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", ...args], {
		encoding: "utf8",
	}).trim();

function write(dir: string, path: string, text: string) {
	mkdirSync(join(dir, path, ".."), { recursive: true });
	writeFileSync(join(dir, path), text);
}

interface Setup {
	repo: string;
	bin: string;
	/** Every logged invocation of a fake CLI. */
	calls(): { argv: string[]; stdin: string; env: Record<string, string>; cwd: string }[];
}

/** Credentials and reroutes the running session may hold, cleared so each test sets its own. */
const HOST_CREDENTIALS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CODEX_API_KEY",
];

/**
 * A clone whose origin's main holds instructions and review rules, checked out
 * on a branch that edits its own AGENTS.md and a file in `src/`.
 */
function setup(host: "CLAUDECODE" | "CODEX_THREAD_ID" | null = "CLAUDECODE"): Setup {
	const dir = tempDir();
	const bin = join(dir, "bin");
	mkdirSync(bin);
	for (const [name, body] of Object.entries(FAKES)) {
		writeFileSync(join(bin, name), `#!${process.execPath}\n${body}`);
		chmodSync(join(bin, name), 0o755);
	}
	const origin = join(dir, "origin.git");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
	const repo = join(dir, "repo");
	execFileSync("git", ["init", "-q", "-b", "main", repo]);
	write(repo, "AGENTS.md", "BASE-ROOT rule\n");
	write(repo, "src/AGENTS.md", "BASE-SRC rule\n");
	write(repo, "docs/AGENTS.md", "BASE-DOCS rule\n");
	write(repo, "REVIEW.md", "BASE-REVIEW rule\n");
	write(repo, "src/lib.ts", "export const x = 1;\n");
	write(repo, ".gitignore", ".tmp/\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "base");
	git(repo, "remote", "add", "origin", origin);
	git(repo, "push", "-q", "origin", "main");
	git(repo, "checkout", "-qb", "feature");
	write(repo, "AGENTS.md", "HEAD-ROOT rule\n");
	write(repo, "src/lib.ts", "export const x = 2;\n");
	git(repo, "commit", "-qam", "change");

	const log = join(dir, "calls.log");
	vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
	vi.stubEnv("FAKE_LOG", log);
	for (const name of [...HOST_CREDENTIALS, "CLAUDECODE", "CODEX_THREAD_ID", "FAKE_LOGGED_OUT", "FAKE_REJECTED"]) {
		vi.stubEnv(name, undefined);
	}
	if (host === "CLAUDECODE") vi.stubEnv("CLAUDECODE", "1");
	if (host === "CODEX_THREAD_ID") vi.stubEnv("CODEX_THREAD_ID", "parent");
	return {
		repo,
		bin,
		calls: () =>
			existsSync(log)
				? readFileSync(log, "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line))
				: [],
	};
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

test("the reviewer is the harness this command is not running under", () => {
	expect(runningHarness({ CLAUDECODE: "1" })).toBe("claude");
	expect(runningHarness({ CODEX_THREAD_ID: "t" })).toBe("codex");
	expect(() => runningHarness({})).toThrow("pass --harness");
	expect(() => runningHarness({ CLAUDECODE: "1", CODEX_THREAD_ID: "t" })).toThrow("both");
});

fakes("an unknown harness is an error, never a same-model review", async () => {
	const s = setup(null);
	const result = await quest("--root", s.repo, "review");
	expect(result.code).toBe(2);
	expect(result.stderr).toContain("pass --harness");
	expect(s.calls()).toEqual([]);
});

fakes("a missing or logged-out reviewer CLI is a usage error", async () => {
	const s = setup();
	// Only git is on PATH, so no codex install outside the fakes is found either.
	const only = join(s.bin, "..", "git-only");
	mkdirSync(only);
	symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), join(only, "git"));
	vi.stubEnv("PATH", only);
	const missing = await quest("--root", s.repo, "review");
	expect(missing.code).toBe(2);
	expect(missing.stderr).toContain("codex is not installed");

	const t = setup();
	vi.stubEnv("FAKE_LOGGED_OUT", "1");
	const out = await quest("--root", t.repo, "review");
	expect(out.code).toBe(2);
	expect(out.stderr).toContain("codex is not logged in; run `codex login`");
	expect(t.calls().map((c) => c.argv)).toEqual([["login", "status"]]);
});

fakes("a login the API rejects fails as logged out, whatever the status check said", async () => {
	for (const [host, variant, message] of [
		["CLAUDECODE", "turn", "codex is not logged in; run `codex login`"],
		["CLAUDECODE", "stderr", "codex is not logged in; run `codex login`"],
		["CODEX_THREAD_ID", "status", "claude is not logged in; run `claude auth login`"],
		["CODEX_THREAD_ID", "text", "claude is not logged in; run `claude auth login`"],
		["CODEX_THREAD_ID", "stderr", "claude is not logged in; run `claude auth login`"],
	] as const) {
		const s = setup(host);
		vi.stubEnv("FAKE_REJECTED", variant);
		const result = await quest("--root", s.repo, "review");
		expect(result.stderr, variant).toContain(message);
		expect(result.code, variant).toBe(2);
		// The status check passed, and the first turn failed.
		expect(s.calls(), variant).toHaveLength(2);
	}
});

fakes("a reviewer with no stored login reviews with the credential its CLI reads from the environment", async () => {
	const s = setup();
	vi.stubEnv("FAKE_LOGGED_OUT", "1");
	vi.stubEnv("CODEX_API_KEY", "codex-key");
	vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "session-token");
	const codex = await quest("--root", s.repo, "review");
	expect(codex.stderr).toBe("");
	expect(codex.code).toBe(0);
	for (const call of s.calls().slice(1)) {
		expect(call.env.CODEX_API_KEY).toBe("codex-key");
		// The other harness's credentials and the session's own variables still never reach it.
		expect(call.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		expect(call.env.CLAUDECODE).toBeUndefined();
	}

	const t = setup("CODEX_THREAD_ID");
	vi.stubEnv("FAKE_LOGGED_OUT", "1");
	vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-key");
	vi.stubEnv("CODEX_API_KEY", "codex-key");
	vi.stubEnv("CLAUDE_CODE_ENTRYPOINT", "sdk-ts");
	const claude = await quest("--root", t.repo, "review");
	expect(claude.stderr).toBe("");
	expect(claude.code).toBe(0);
	for (const call of t.calls().slice(1)) {
		expect(call.env.ANTHROPIC_API_KEY).toBe("anthropic-key");
		expect(call.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
		expect(call.env.CODEX_API_KEY).toBeUndefined();
		expect(call.env.CODEX_THREAD_ID).toBeUndefined();
	}
});

fakes("a stored login wins over an environment credential, so a shell's key never changes the billing", async () => {
	const s = setup("CODEX_THREAD_ID");
	vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-key");
	expect((await quest("--root", s.repo, "review")).code).toBe(0);
	for (const call of s.calls()) expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
});

fakes("an environment credential the API rejects is named in the error", async () => {
	const s = setup();
	vi.stubEnv("FAKE_LOGGED_OUT", "1");
	vi.stubEnv("CODEX_API_KEY", "codex-key");
	vi.stubEnv("FAKE_REJECTED", "turn");
	const result = await quest("--root", s.repo, "review");
	expect(result.code).toBe(2);
	expect(result.stderr).toContain("codex rejected CODEX_API_KEY; replace it, or run `codex login`");
});

fakes("a credential meant for another endpoint stays stripped, and the error names what reroutes it", async () => {
	const s = setup("CODEX_THREAD_ID");
	vi.stubEnv("FAKE_LOGGED_OUT", "1");
	vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "gateway-token");
	vi.stubEnv("ANTHROPIC_BASE_URL", "https://gateway.example");
	const result = await quest("--root", s.repo, "review");
	expect(result.code).toBe(2);
	expect(result.stderr).toContain(
		"claude is not logged in, and quest review strips ANTHROPIC_BASE_URL, which would reroute it; run `claude auth login`",
	);
	expect(s.calls().map((c) => c.argv)).toEqual([["auth", "status"]]);
});

fakes.each(["0", "false", ""])("a provider switch set to %j reroutes nothing", async (value) => {
	const s = setup("CODEX_THREAD_ID");
	vi.stubEnv("FAKE_LOGGED_OUT", "1");
	vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-key");
	vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", value);
	vi.stubEnv("CLAUDE_CODE_USE_VERTEX", value);
	const result = await quest("--root", s.repo, "review");
	expect(result.code, result.stderr).toBe(0);
	const turns = s.calls().filter((c) => c.argv[0] !== "auth");
	expect(turns.length).toBeGreaterThan(0);
	for (const call of turns) {
		expect(call.env.ANTHROPIC_API_KEY).toBe("anthropic-key");
		expect(call.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
	}
});

fakes("an enabled provider switch withholds the credential, and the error names it", async () => {
	const s = setup("CODEX_THREAD_ID");
	vi.stubEnv("FAKE_LOGGED_OUT", "1");
	vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-key");
	vi.stubEnv("CLAUDE_CODE_USE_VERTEX", "True");
	const result = await quest("--root", s.repo, "review");
	expect(result.code).toBe(2);
	expect(result.stderr).toContain("quest review strips CLAUDE_CODE_USE_VERTEX, which would reroute it");
	expect(s.calls().map((c) => c.argv)).toEqual([["auth", "status"]]);
});

fakes("the reviewer CLI is found on PATH, never in the checkout it reviews", async () => {
	for (const host of ["CLAUDECODE", "CODEX_THREAD_ID"] as const) {
		const s = setup(host);
		// The change under review supplies its own CLIs, and PATH names the checkout relatively.
		const planted = join(s.bin, "..", "planted.log");
		for (const name of ["claude", "codex"]) {
			write(s.repo, name, `#!/bin/sh\necho "$0" >> "${planted}"\nexit 1\n`);
			chmodSync(join(s.repo, name), 0o755);
		}
		git(s.repo, "add", ".");
		git(s.repo, "commit", "-qm", "plant");
		vi.stubEnv("PATH", `.::relative:${s.bin}:${process.env.PATH}:`);
		const result = await quest("--root", s.repo, "review");
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(existsSync(planted)).toBe(false);
		// Nor can the reviewer's own commands find one there.
		for (const call of s.calls())
			expect(call.env.PATH.split(":").every((entry) => entry.startsWith("/"))).toBe(true);
	}
});

fakes("only a clean, attached checkout is reviewed", async () => {
	const s = setup();
	write(s.repo, "src/lib.ts", "export const x = 3;\n");
	expect((await quest("--root", s.repo, "review")).stderr).toContain("uncommitted changes");
	git(s.repo, "checkout", "-q", "--", ".");
	git(s.repo, "checkout", "-q", "--detach");
	expect((await quest("--root", s.repo, "review")).stderr).toContain("detached");
	expect(s.calls()).toEqual([]);
});

fakes("codex reviews read-only with the base's instructions, then reports in the schema", async () => {
	const s = setup();
	const result = await quest("--root", s.repo, "review");
	expect(result.stderr).toBe("");
	expect(result.code).toBe(0);
	const head = git(s.repo, "rev-parse", "HEAD");
	const base = git(s.repo, "rev-parse", "origin/main");
	expect(result.stdout).toBe(
		[
			"reviewer codex gpt-6.1-sol medium",
			"session thread-1",
			"round 1",
			`base ${base} origin/main`,
			`head ${head}`,
			"usage findings input 100 cached 80 output 7",
			"findings 1",
			"",
			"high src/lib.ts:2 Off by one",
			"  average([3]) is 0.",
			"",
		].join("\n"),
	);

	const [, first, second] = s.calls();
	expect(first.argv.slice(0, 5)).toEqual(["exec", "review", "--base", "origin/main", "--json"]);
	expect(second.argv.slice(0, 3)).toEqual(["exec", "resume", "--json"]);
	expect(second.argv.slice(-2)).toEqual(["thread-1", "-"]);
	for (const call of [first, second]) {
		expect(call.argv).toContain('sandbox_mode="read-only"');
		expect(call.argv).toContain("project_doc_max_bytes=0");
		expect(call.argv).toContain("--ignore-rules");
		expect(call.argv).toContain("--ignore-user-config");
		expect(call.argv[call.argv.indexOf("-m") + 1]).toBe("gpt-6.1-sol");
		expect(call.argv).toContain('model_reasoning_effort="medium"');
		expect(call.argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
		// The session's own variables never reach the reviewer.
		expect(call.env.CLAUDECODE).toBeUndefined();
		const instructions = call.argv.find((arg) => arg.startsWith("developer_instructions="))!;
		expect(instructions).toContain("BASE-ROOT rule");
		expect(instructions).toContain("BASE-SRC rule");
		expect(instructions).not.toContain("BASE-DOCS rule");
		expect(instructions).not.toContain("HEAD-ROOT rule");
	}
	expect(second.stdin).toContain("BASE-REVIEW rule");
	expect(second.stdin).toContain(head);
	const schema = second.argv[second.argv.indexOf("--output-schema") + 1];
	expect(JSON.parse(readFileSync(schema, "utf8")).required).toEqual(["findings"]);
});

fakes("--base reviews against another branch, fetched first, with that branch's instructions", async () => {
	const s = setup();
	git(s.repo, "checkout", "-qb", "release", "main");
	write(s.repo, "AGENTS.md", "RELEASE-ROOT rule\n");
	git(s.repo, "commit", "-qam", "release");
	git(s.repo, "push", "-q", "origin", "release");
	const base = git(s.repo, "rev-parse", "HEAD");
	git(s.repo, "update-ref", "-d", "refs/remotes/origin/release");
	git(s.repo, "checkout", "-qb", "backport");
	write(s.repo, "src/lib.ts", "export const x = 5;\n");
	git(s.repo, "commit", "-qam", "backport");

	const result = await quest("--root", s.repo, "review", "--base", "origin/release");
	expect(result.code).toBe(0);
	expect(result.stdout).toContain(`base ${base} origin/release\n`);
	const [, first] = s.calls();
	expect(first.argv.slice(0, 4)).toEqual(["exec", "review", "--base", "origin/release"]);
	const instructions = first.argv.find((arg) => arg.startsWith("developer_instructions="))!;
	expect(instructions).toContain("RELEASE-ROOT rule");
	expect(instructions).not.toContain("BASE-ROOT rule");

	const unknown = await quest("--root", s.repo, "review", "--base", "upstream/release", "--new");
	expect(unknown.code).toBe(2);
	expect(unknown.stderr).toContain("--base must be <remote>/<branch>");
});

fakes("claude reviews read-only with the base's instructions, then reports in the schema", async () => {
	const s = setup("CODEX_THREAD_ID");
	const result = await quest("--root", s.repo, "review", "--model", "opus", "--effort", "low", "--json");
	expect(result.code).toBe(0);
	const round = JSON.parse(result.stdout);
	expect(round.reviewer).toBe("claude");
	expect(round.model).toBe("opus");
	expect(round.effort).toBe("low");
	expect(round.usage).toEqual([
		{ turn: "review", input: 101, cached: 0, output: 51 },
		{ turn: "findings", input: 100, cached: 80, output: 7 },
	]);
	expect(round.findings).toEqual([FINDING]);

	const [status, first, second] = s.calls();
	expect(status.argv).toEqual(["auth", "status"]);
	expect(first.stdin).toBe("/code-review low origin/main...HEAD");
	expect(second.argv).toContain("--json-schema");
	expect(second.argv[second.argv.indexOf("--resume") + 1]).toBe(first.argv[first.argv.indexOf("--session-id") + 1]);
	for (const call of [first, second]) {
		const at = (flag: string) => call.argv[call.argv.indexOf(flag) + 1];
		expect(at("--permission-mode")).toBe("dontAsk");
		// No settings file, so not even the user's own allow rules apply.
		expect(at("--setting-sources")).toBe("");
		expect(at("--tools")).toBe("Read,Grep,Glob,Bash,Agent");
		expect(at("--model")).toBe("opus");
		expect(at("--effort")).toBe("low");
		expect(at("--append-system-prompt")).toContain("BASE-ROOT rule");
		expect(at("--append-system-prompt")).not.toContain("HEAD-ROOT rule");
		expect(call.env.CODEX_THREAD_ID).toBeUndefined();
		expect(call.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe("1h");
	}
});

fakes("a later round resumes the session with the new head and the author's responses", async () => {
	const s = setup();
	expect((await quest("--root", s.repo, "review")).code).toBe(0);
	const missing = await quest("--root", s.repo, "review");
	expect(missing.code).toBe(2);
	expect(missing.stderr).toContain("pass --responses");

	write(s.repo, "src/lib.ts", "export const x = 4;\n");
	git(s.repo, "commit", "-qam", "fix");
	const responses = join(s.repo, ".tmp", "responses.md");
	write(s.repo, ".tmp/responses.md", "Fixed at src/lib.ts:1.\n");
	vi.stubEnv("FAKE_REPLY", JSON.stringify({ findings: [] }));
	const later = await quest("--root", s.repo, "review", "--responses", responses);
	expect(later.code).toBe(0);
	expect(later.stdout).toContain("round 2\n");
	expect(later.stdout).toContain("findings 0\n");

	const calls = s.calls();
	const resumed = calls.at(-1)!;
	expect(resumed.argv.slice(0, 2)).toEqual(["exec", "resume"]);
	expect(resumed.argv.at(-2)).toBe("thread-1");
	expect(resumed.stdin).toContain("Fixed at src/lib.ts:1.");
	expect(resumed.stdin).toContain("BASE-REVIEW rule");
	expect(resumed.stdin).not.toContain("differ from those you were given");
	expect(resumed.stdin).toContain(git(s.repo, "rev-parse", "HEAD"));
	expect(calls.filter((c) => c.argv[1] === "review")).toHaveLength(1);

	// --new starts over, and a first round takes no responses.
	const fresh = await quest("--root", s.repo, "review", "--new", "--responses", responses);
	expect(fresh.code).toBe(2);
	expect(fresh.stderr).toContain("has none to resume");
	expect((await quest("--root", s.repo, "review", "--new")).stdout).toContain("round 1\n");
});

fakes("a later round revokes REVIEW.md rules the base removed", async () => {
	const s = setup();
	vi.stubEnv("FAKE_REPLY", JSON.stringify({ findings: [] }));
	expect((await quest("--root", s.repo, "review")).code).toBe(0);
	const base = moveBase(s.repo, (dir) => git(dir, "rm", "-q", "REVIEW.md"));

	expect((await quest("--root", s.repo, "review")).stdout).toContain(`round 2\nbase ${base}`);
	const prompt = s.calls().at(-1)!.stdin;
	expect(prompt).toContain("no longer has a REVIEW.md");
	expect(prompt).not.toContain("BASE-REVIEW rule");
});

fakes("a change to the applicable instructions starts a new session that weighs the responses", async () => {
	const s = setup();
	expect((await quest("--root", s.repo, "review")).code).toBe(0);
	moveBase(s.repo, (dir) => write(dir, "src/AGENTS.md", "BASE-SRC new rule\n"));

	const responses = join(s.repo, ".tmp", "responses.md");
	write(s.repo, ".tmp/responses.md", "Refuted: see src/lib.ts:1.\n");
	const round = await quest("--root", s.repo, "review", "--responses", responses);
	expect(round.code).toBe(0);
	expect(round.stdout).toContain("round 1\n");
	const [review, followUp] = s.calls().slice(-2);
	expect(review.argv[1]).toBe("review");
	expect(review.argv.find((arg) => arg.startsWith("developer_instructions="))).toContain("BASE-SRC new rule");
	expect(followUp.stdin).toContain("Refuted: see src/lib.ts:1.");
});

/** Push a commit that `change` makes to origin's main, returning its SHA. */
function moveBase(repo: string, change: (dir: string) => void): string {
	const base = join(repo, "..", "base");
	git(repo, "worktree", "add", "-q", base, "origin/main");
	change(base);
	git(base, "add", "-A");
	git(base, "commit", "-qm", "move the base");
	git(base, "push", "-q", "origin", "HEAD:main");
	return git(base, "rev-parse", "HEAD");
}

fakes("a reply that does not match the schema fails rather than reads as clean", async () => {
	const s = setup();
	vi.stubEnv("FAKE_REPLY", "Looks good to me.");
	const prose = await quest("--root", s.repo, "review");
	expect(prose.code).toBe(1);
	expect(prose.stderr).toContain("not JSON");

	vi.stubEnv("FAKE_REPLY", JSON.stringify({ findings: [{ ...FINDING, severity: "critical" }] }));
	const wrong = await quest("--root", s.repo, "review");
	expect(wrong.code).toBe(1);
	expect(wrong.stderr).toContain("finding 1 does not match the schema");
});

test("findings are checked field by field", () => {
	expect(findings({ structured: { findings: [{ ...FINDING, line: null }] } })).toEqual([{ ...FINDING, line: null }]);
	expect(() => findings({ structured: { findings: [{ ...FINDING, line: 0 }] } })).toThrow("does not match");
	expect(() => findings({ text: '{"verdict":"approve"}' })).toThrow("no findings list");
});

test("each changed directory keeps its own instructions, and a directory's symlink is given once", () => {
	const repo = tempDir();
	execFileSync("git", ["init", "-q", "-b", "main", repo]);
	write(repo, "AGENTS.md", "root\n");
	write(repo, "a/AGENTS.md", "same\n");
	write(repo, "b/AGENTS.md", "same\n");
	write(repo, "c/AGENTS.md", "c rules\n");
	symlinkSync("AGENTS.md", join(repo, "c", "CLAUDE.md"));
	write(repo, "d/AGENTS.md", "untouched\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "base");
	const files = baseInstructions(repo, "HEAD", ["a/x.ts", "b/y.ts", "c/z.ts"]);
	expect(files).toEqual([
		{ path: "AGENTS.md", text: "root" },
		{ path: "a/AGENTS.md", text: "same" },
		{ path: "b/AGENTS.md", text: "same" },
		{ path: "c/AGENTS.md", text: "c rules" },
	]);
});
