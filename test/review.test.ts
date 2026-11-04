import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { type Output, main } from "../src/cli/main";
import { baseInstructions, findings, review, runningHarness, sessionFile } from "../src/cli/review";
import { tempDir } from "./fixture";

afterEach(() => {
	vi.unstubAllEnvs();
});

/** The fake CLIs are shebang scripts found on a POSIX PATH, which Windows cannot run. */
const fakes = test.skipIf(process.platform === "win32");

const FINDING = { file: "src/lib.ts", line: 2, severity: "high", title: "Off by one", body: "average([3]) is 0." };

const CODEX_LOGGED_OUT = "codex is not logged in to its default profile (CODEX_HOME is unset); run `codex login`";
const CLAUDE_LOGGED_OUT =
	"claude is not logged in to its default profile (CLAUDE_CONFIG_DIR is unset); run `claude auth login`";

/**
 * Fake reviewer CLIs. Each logs its argv, stdin, and the variables it was
 * given, then answers as the FAKE_* variables say. FAKE_LOGGED_OUT removes the
 * stored login, so only a credential variable the real CLI reads, or Claude
 * Code's switch to a cloud provider, authenticates; like the real ones,
 * `claude auth status` counts such a variable, and `codex login status` counts
 * CODEX_ACCESS_TOKEN but not CODEX_API_KEY. FAKE_REJECTED has the API
 * reject the login in each turn with the real CLI's error, in the style it
 * names. FAKE_LIMITED fails a turn on the account's usage limit with the real
 * CLI's error, naming its reset unless set to `unknown`. FAKE_REPLY replaces
 * the findings reply.
 */
const FAKES: Record<string, string> = {
	claude: `
const fs = require("node:fs");
const argv = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CLAUDE|CODEX|ANTHROPIC|FAKE_HOST|PATH$)/.test(k)));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, stdin, env, cwd: process.cwd() }) + "\\n");
const credential = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"].some((k) => process.env[k]);
const provider = Object.entries(process.env).some(([k, v]) => k.startsWith("CLAUDE_CODE_USE_") && v === "1");
const loggedIn = !process.env.FAKE_LOGGED_OUT || credential || provider;
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
// The limit hits the findings turn, after the review turn passed.
if (process.env.FAKE_LIMITED && argv.includes("--resume")) {
	if (process.env.FAKE_LIMITED !== "unknown") {
		console.log(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1900000000 } }));
	}
	result({ session_id: at("--resume"), is_error: true, result: "You've hit your weekly limit · resets Nov 5, 3pm (UTC)" });
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
if (argv[0] === "login") process.exit(process.env.FAKE_LOGGED_OUT && !process.env.CODEX_ACCESS_TOKEN ? 1 : 0);
if (process.env.FAKE_HANG) {
	// It takes a while to exit when asked to, as a CLI saving its session does.
	process.on("SIGTERM", () => setTimeout(() => process.exit(143), 300));
	fs.writeFileSync(process.env.FAKE_HANG, String(process.pid));
	setInterval(() => {}, 1000);
	return;
}
const event = (value) => console.log(JSON.stringify(value));
const loggedIn = !process.env.FAKE_LOGGED_OUT || process.env.CODEX_API_KEY || process.env.CODEX_ACCESS_TOKEN;
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
if (process.env.FAKE_LIMITED) {
	const message = process.env.FAKE_LIMITED === "unknown"
		? "You've hit your usage limit."
		: "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 5th, 2026 3:15 PM.";
	event({ type: "thread.started", thread_id: "thread-1" });
	event({ type: "error", message });
	event({ type: "turn.failed", error: { message } });
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

/** Credentials and routes the running session may hold, cleared so each test sets its own. */
const HOST_CREDENTIALS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_AWS_API_KEY",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_CUSTOM_HEADERS",
	"ANTHROPIC_FOUNDRY_API_KEY",
	"ANTHROPIC_FOUNDRY_AUTH_TOKEN",
	"CLAUDE_CODE_OAUTH_TOKEN",
	...["BEDROCK", "VERTEX", "FOUNDRY", "MANTLE", "ANTHROPIC_AWS", "ANTHROPIC_GOOGLE_CLOUD"].map(
		(provider) => `CLAUDE_CODE_USE_${provider}`,
	),
	"CODEX_API_KEY",
	"CODEX_ACCESS_TOKEN",
	"CODEX_CA_CERTIFICATE",
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
	// The session's own profile would change the logged-out errors.
	const unset = [...HOST_CREDENTIALS, "CLAUDECODE", "CODEX_THREAD_ID", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];
	for (const name of [...unset, "FAKE_LOGGED_OUT", "FAKE_REJECTED", "FAKE_LIMITED", "FAKE_HANG"]) {
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
	expect(out.stderr).toContain(CODEX_LOGGED_OUT);
	expect(t.calls().map((c) => c.argv)).toEqual([["login", "status"]]);
});

const CODEX_PROFILE = "codex is not logged in to the profile CODEX_HOME=/work; run `codex login`";
const CLAUDE_PROFILE = "claude is not logged in to the profile CLAUDE_CONFIG_DIR=/work; run `claude auth login`";

// Signed out at the status check, and rejected by the API after it passed.
fakes.each([
	["CLAUDECODE", "CODEX_HOME", "FAKE_LOGGED_OUT", "1", CODEX_PROFILE],
	["CLAUDECODE", "CODEX_HOME", "FAKE_REJECTED", "turn", CODEX_PROFILE],
	["CODEX_THREAD_ID", "CLAUDE_CONFIG_DIR", "FAKE_LOGGED_OUT", "1", CLAUDE_PROFILE],
	["CODEX_THREAD_ID", "CLAUDE_CONFIG_DIR", "FAKE_REJECTED", "status", CLAUDE_PROFILE],
] as const)(
	"a logged-out error names the profile its status check read (host %s, %s, %s=%s)",
	async (host, variable, flag, value, message) => {
		const s = setup(host);
		vi.stubEnv(variable, "/work");
		vi.stubEnv(flag, value);
		const result = await quest("--root", s.repo, "review");
		expect(result.code, result.stderr).toBe(2);
		expect(result.stderr).toContain(message);
	},
);

fakes.each([
	["CLAUDECODE", "turn", CODEX_LOGGED_OUT],
	["CLAUDECODE", "stderr", CODEX_LOGGED_OUT],
	["CODEX_THREAD_ID", "status", CLAUDE_LOGGED_OUT],
	["CODEX_THREAD_ID", "text", CLAUDE_LOGGED_OUT],
	["CODEX_THREAD_ID", "stderr", CLAUDE_LOGGED_OUT],
] as const)(
	"a login the API rejects fails as logged out, whatever the status check said (host %s, rejected in %s)",
	async (host, variant, message) => {
		const s = setup(host);
		vi.stubEnv("FAKE_REJECTED", variant);
		const result = await quest("--root", s.repo, "review");
		expect(result.stderr).toContain(message);
		expect(result.code).toBe(2);
		// The status check passed, and the first turn failed.
		expect(s.calls()).toHaveLength(2);
	},
);

fakes("a reviewer's usage limit exits 3 with its reset, and records no round", async () => {
	// Codex prints its reset in the local time zone, which this process shares.
	const codex = new Date(2026, 10, 5, 15, 15).toISOString().replace(".000Z", "Z");
	for (const [host, variant, message] of [
		["CLAUDECODE", "reset", `codex hit its usage limit; resets ${codex}`],
		["CLAUDECODE", "unknown", "codex hit its usage limit; resets unknown"],
		["CODEX_THREAD_ID", "reset", "claude hit its usage limit; resets 2030-03-17T17:46:40Z"],
		["CODEX_THREAD_ID", "unknown", "claude hit its usage limit; resets unknown"],
	] as const) {
		const s = setup(host);
		vi.stubEnv("FAKE_LIMITED", variant);
		const result = await quest("--root", s.repo, "review");
		expect(result.stderr, `${host} ${variant}`).toBe(`error: ${message}\n`);
		expect(result.code, `${host} ${variant}`).toBe(3);
		expect(result.stdout).toBe("");
		vi.stubEnv("FAKE_LIMITED", undefined);
		// No round was recorded, so the next one needs no responses.
		expect((await quest("--root", s.repo, "review")).code).toBe(0);
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

fakes("an abort stops the reviewer's turn and records no round", async () => {
	const s = setup();
	const pid = join(s.bin, "..", "codex.pid");
	vi.stubEnv("FAKE_HANG", pid);
	const controller = new AbortController();
	const round = review({ root: s.repo, signal: controller.signal }, { env: process.env });
	while (!existsSync(pid)) await new Promise((resolve) => setTimeout(resolve, 20));
	controller.abort();
	await expect(round).rejects.toThrow(/abort/i);
	// The round fails only once the CLI exited, so nothing outlives it in the checkout.
	expect(() => process.kill(Number(readFileSync(pid, "utf8")), 0)).toThrow();
	expect(existsSync(sessionFile(join(s.repo, ".git"), "feature"))).toBe(false);
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

fakes("a stored login the API rejects names the credential quest review strips beside it", async () => {
	const s = setup("CODEX_THREAD_ID");
	vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-key");
	vi.stubEnv("FAKE_REJECTED", "status");
	const result = await quest("--root", s.repo, "review");
	expect(result.code).toBe(2);
	expect(result.stderr).toContain(
		`${CLAUDE_LOGGED_OUT}; quest review strips ANTHROPIC_API_KEY while a stored login exists`,
	);
});

fakes.each([
	["without a stored login", "1"],
	["over a stored login", undefined],
])("Claude keeps a gateway's URL, token, and headers %s, in every round", async (_, loggedOut) => {
	const s = setup("CODEX_THREAD_ID");
	vi.stubEnv("FAKE_LOGGED_OUT", loggedOut);
	vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "gateway-token");
	vi.stubEnv("ANTHROPIC_BASE_URL", "http://127.0.0.1:8317");
	vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "X-Gateway-Tenant: review");
	// Neither routes anything, nor changes the reviewer's plugins, model, or account.
	vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "");
	vi.stubEnv("CLAUDE_CODE_PLUGIN_DIRS", "/untrusted/plugins");
	vi.stubEnv("CLAUDE_CODE_EFFORT_LEVEL", "max");
	vi.stubEnv("ANTHROPIC_MODEL", "parent-model");
	vi.stubEnv("CODEX_API_KEY", "other-provider-key");
	vi.stubEnv("OPENAI_API_KEY", "other-provider-key");
	vi.stubEnv("QUEST_API_KEYS", "other-agent-key");
	vi.stubEnv("OP_SERVICE_ACCOUNT_TOKEN", "secret-manager-token");
	vi.stubEnv("FAKE_REPLY", JSON.stringify({ findings: [] }));
	const first = await quest("--root", s.repo, "review", "--json");
	expect(first.code, first.stderr).toBe(0);
	const resumed = await quest("--root", s.repo, "review", "--json");
	expect(resumed.code, resumed.stderr).toBe(0);
	expect(JSON.parse(resumed.stdout)).toMatchObject({ round: 2, session: JSON.parse(first.stdout).session });
	const calls = s.calls();
	expect(calls.map((c) => c.argv[0])).toEqual(["auth", "-p", "-p", "auth", "-p"]);
	for (const call of calls) {
		expect(call.env).toMatchObject({
			ANTHROPIC_AUTH_TOKEN: "gateway-token",
			ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
			ANTHROPIC_CUSTOM_HEADERS: "X-Gateway-Tenant: review",
			CLAUDE_CODE_USE_BEDROCK: "",
		});
		for (const name of [
			"CODEX_THREAD_ID",
			"CODEX_API_KEY",
			"CLAUDE_CODE_PLUGIN_DIRS",
			"CLAUDE_CODE_EFFORT_LEVEL",
			"ANTHROPIC_MODEL",
		]) {
			expect(call.env[name], name).toBeUndefined();
		}
	}
});

fakes("a gateway with no credential and no stored login names the gateway", async () => {
	const s = setup("CODEX_THREAD_ID");
	vi.stubEnv("FAKE_LOGGED_OUT", "1");
	vi.stubEnv("ANTHROPIC_BASE_URL", "https://gateway.example");
	const result = await quest("--root", s.repo, "review");
	expect(result.code).toBe(2);
	expect(result.stderr).toContain(
		"claude is not logged in to its default profile (CLAUDE_CONFIG_DIR is unset) through ANTHROPIC_BASE_URL; run `claude auth login`",
	);
	expect(s.calls().map((c) => c.argv)).toEqual([["auth", "status"]]);
});

fakes("a gateway credential the API rejects is named with the gateway", async () => {
	const s = setup("CODEX_THREAD_ID");
	vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "gateway-token");
	vi.stubEnv("ANTHROPIC_BASE_URL", "https://gateway.example");
	vi.stubEnv("FAKE_REJECTED", "status");
	const result = await quest("--root", s.repo, "review");
	expect(result.code).toBe(2);
	expect(result.stderr).toContain(
		"claude rejected ANTHROPIC_AUTH_TOKEN through ANTHROPIC_BASE_URL; replace it, or run `claude auth login`",
	);
});

fakes.each(["0", "false", ""])("a provider switch set to %j routes nothing", async (value) => {
	const s = setup("CODEX_THREAD_ID");
	vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-key");
	vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", value);
	vi.stubEnv("CLAUDE_CODE_USE_VERTEX", value);
	const result = await quest("--root", s.repo, "review");
	expect(result.code, result.stderr).toBe(0);
	expect(s.calls().length).toBeGreaterThan(1);
	for (const call of s.calls()) {
		// The stored login still wins over the key, and the switch reaches the CLI as set.
		expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(call.env.CLAUDE_CODE_USE_BEDROCK).toBe(value);
	}
});

fakes.each([
	["BEDROCK", "ANTHROPIC_BEDROCK_BASE_URL"],
	["VERTEX", "ANTHROPIC_VERTEX_BASE_URL"],
	["FOUNDRY", "ANTHROPIC_FOUNDRY_BASE_URL"],
	["MANTLE", "ANTHROPIC_BEDROCK_MANTLE_BASE_URL"],
	["ANTHROPIC_AWS", "ANTHROPIC_AWS_BASE_URL"],
	["ANTHROPIC_GOOGLE_CLOUD", "ANTHROPIC_GOOGLE_CLOUD_BASE_URL"],
	["ANTHROPIC_GOOGLE_CLOUD", "ANTHROPIC_GOOGLE_CLOUD_LOCATION"],
])("Claude keeps the %s provider switch with its %s and skip-auth setting", async (provider, endpoint) => {
	const s = setup("CODEX_THREAD_ID");
	vi.stubEnv("FAKE_LOGGED_OUT", "1");
	vi.stubEnv(`CLAUDE_CODE_USE_${provider}`, "1");
	vi.stubEnv(`CLAUDE_CODE_SKIP_${provider}_AUTH`, "1");
	vi.stubEnv(endpoint, "https://provider.example");
	vi.stubEnv("ANTHROPIC_MODEL", "parent-model");
	const result = await quest("--root", s.repo, "review");
	expect(result.code, result.stderr).toBe(0);
	expect(s.calls().length).toBeGreaterThan(1);
	for (const call of s.calls()) {
		expect(call.env[`CLAUDE_CODE_USE_${provider}`]).toBe("1");
		expect(call.env[`CLAUDE_CODE_SKIP_${provider}_AUTH`]).toBe("1");
		expect(call.env[endpoint]).toBe("https://provider.example");
		expect(call.env.ANTHROPIC_MODEL).toBeUndefined();
	}
});

const PROVIDER_KEYS = ["ANTHROPIC_AWS_API_KEY", "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_AUTH_TOKEN"];

fakes("Claude gets no provider key over a stored login with no gateway or provider set", async () => {
	const s = setup("CODEX_THREAD_ID");
	for (const key of PROVIDER_KEYS) vi.stubEnv(key, "provider-key");
	expect((await quest("--root", s.repo, "review")).code).toBe(0);
	expect(s.calls().length).toBeGreaterThan(1);
	for (const call of s.calls()) for (const key of PROVIDER_KEYS) expect(call.env[key], key).toBeUndefined();
});

fakes("a provider's keys alone are no login, so the review stops before it starts", async () => {
	const s = setup("CODEX_THREAD_ID");
	for (const key of PROVIDER_KEYS) vi.stubEnv(key, "provider-key");
	vi.stubEnv("FAKE_LOGGED_OUT", "1");
	const result = await quest("--root", s.repo, "review");
	expect(result.code).toBe(2);
	expect(result.stderr).toContain("claude is not logged in");
	expect(s.calls().map((c) => c.argv)).toEqual([["auth", "status"]]);
});

fakes("Claude gets a provider's keys while the provider is set", async () => {
	const s = setup("CODEX_THREAD_ID");
	for (const key of PROVIDER_KEYS) vi.stubEnv(key, "provider-key");
	vi.stubEnv("CLAUDE_CODE_USE_FOUNDRY", "1");
	const result = await quest("--root", s.repo, "review");
	expect(result.code, result.stderr).toBe(0);
	for (const call of s.calls()) for (const key of PROVIDER_KEYS) expect(call.env[key], key).toBe("provider-key");
});

fakes("Codex keeps CODEX_CA_CERTIFICATE always, and CODEX_ACCESS_TOKEN without a stored login", async () => {
	const s = setup();
	vi.stubEnv("CODEX_CA_CERTIFICATE", "/etc/gateway-ca.pem");
	vi.stubEnv("CODEX_ACCESS_TOKEN", "agent-identity");
	expect((await quest("--root", s.repo, "review")).code).toBe(0);
	for (const call of s.calls()) {
		expect(call.env.CODEX_CA_CERTIFICATE).toBe("/etc/gateway-ca.pem");
		expect(call.env.CODEX_ACCESS_TOKEN).toBeUndefined();
	}

	const t = setup();
	vi.stubEnv("FAKE_LOGGED_OUT", "1");
	vi.stubEnv("CODEX_CA_CERTIFICATE", "/etc/gateway-ca.pem");
	vi.stubEnv("CODEX_ACCESS_TOKEN", "agent-identity");
	vi.stubEnv("ANTHROPIC_BASE_URL", "https://gateway.example");
	const result = await quest("--root", t.repo, "review");
	expect(result.code, result.stderr).toBe(0);
	expect(t.calls().length).toBeGreaterThan(1);
	for (const call of t.calls().slice(1)) {
		expect(call.env.CODEX_CA_CERTIFICATE).toBe("/etc/gateway-ca.pem");
		expect(call.env.CODEX_ACCESS_TOKEN).toBe("agent-identity");
		expect(call.env.ANTHROPIC_BASE_URL).toBeUndefined();
	}
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

fakes("only a clean checkout is reviewed, and a detached one only for a named branch", async () => {
	const s = setup();
	write(s.repo, "src/lib.ts", "export const x = 3;\n");
	expect((await quest("--root", s.repo, "review")).stderr).toContain("uncommitted changes");
	git(s.repo, "checkout", "-q", "--", ".");
	git(s.repo, "checkout", "-q", "--detach");
	const detached = await quest("--root", s.repo, "review");
	expect(detached.code).toBe(2);
	expect(detached.stderr).toContain("HEAD is detached; pass --branch");
	const invalid = await quest("--root", s.repo, "review", "--branch", "a..b");
	expect(invalid.code).toBe(2);
	expect(invalid.stderr).toContain("--branch is not a valid branch name: a..b");
	expect(s.calls()).toEqual([]);
});

fakes("a detached checkout continues the session of the branch --branch names", async () => {
	const s = setup();
	expect((await quest("--root", s.repo, "review")).stdout).toContain("round 1\n");
	// Another worktree holds the branch, so its fix is reviewed from a detached checkout of its head.
	git(s.repo, "checkout", "-q", "--detach");
	write(s.repo, "src/lib.ts", "export const x = 4;\n");
	git(s.repo, "commit", "-qam", "fix");
	write(s.repo, ".tmp/responses.md", "Fixed at src/lib.ts:1.\n");
	const responses = join(s.repo, ".tmp", "responses.md");
	const round = await quest("--root", s.repo, "review", "--branch", "feature", "--responses", responses);
	expect(round.stderr).toBe("");
	expect(round.stdout).toContain("session thread-1\nround 2\n");
	expect(s.calls().filter((c) => c.argv[1] === "review")).toHaveLength(1);
});

fakes("a differently named branch continues the session --branch names, and without it has its own", async () => {
	const s = setup();
	expect((await quest("--root", s.repo, "review")).stdout).toContain("round 1\n");
	git(s.repo, "checkout", "-qb", "merge-fix");
	write(s.repo, ".tmp/responses.md", "Fixed at src/lib.ts:1.\n");
	const responses = join(s.repo, ".tmp", "responses.md");
	const named = await quest("--root", s.repo, "review", "--branch", "feature", "--responses", responses);
	expect(named.stdout).toContain("round 2\n");
	const own = await quest("--root", s.repo, "review", "--responses", responses);
	expect(own.code).toBe(2);
	expect(own.stderr).toContain("has none to resume");
});

fakes.each(["CLAUDECODE", "CODEX_THREAD_ID"] as const)(
	"a branch behind its base is reviewed from its merge base (host %s)",
	async (host) => {
		const s = setup(host);
		const mergeBase = git(s.repo, "rev-parse", "origin/main");
		// The base gains a docs change the branch lacks, which a diff against its tip shows as reverted.
		const tip = moveBase(s.repo, (dir) => write(dir, "docs/guide.md", "new\n"));
		const head = git(s.repo, "rev-parse", "HEAD");
		const result = await quest("--root", s.repo, "review");
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain(`base ${tip} origin/main\n`);

		const [, first, second] = s.calls();
		if (host === "CLAUDECODE") {
			expect(first.argv.slice(0, 5)).toEqual(["exec", "review", "--base", mergeBase, "--json"]);
		} else {
			expect(first.stdin).toBe(`/code-review high ${mergeBase}...HEAD`);
			expect(first.argv[first.argv.indexOf("--effort") + 1]).toBe("high");
		}
		expect(second.stdin).toContain(`\`git diff ${mergeBase}..${head}\``);
		// Only the change's own directories bring their instructions.
		for (const call of [first, second]) expect(JSON.stringify(call.argv)).not.toContain("BASE-DOCS rule");
	},
);

fakes("codex reviews read-only with the base's instructions, then reports in the schema", async () => {
	const s = setup();
	const result = await quest("--root", s.repo, "review");
	expect(result.stderr).toBe("");
	expect(result.code).toBe(0);
	const head = git(s.repo, "rev-parse", "HEAD");
	const base = git(s.repo, "rev-parse", "origin/main");
	expect(result.stdout).toBe(
		[
			"reviewer codex gpt-6.1-sol xhigh",
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
	// The base has not moved, so its tip is the merge base.
	expect(first.argv.slice(0, 5)).toEqual(["exec", "review", "--base", base, "--json"]);
	expect(second.argv.slice(0, 3)).toEqual(["exec", "resume", "--json"]);
	expect(second.argv.slice(-2)).toEqual(["thread-1", "-"]);
	for (const call of [first, second]) {
		expect(call.argv).toContain('sandbox_mode="read-only"');
		expect(call.argv).toContain("project_doc_max_bytes=0");
		expect(call.argv).toContain("--ignore-rules");
		expect(call.argv).toContain("--ignore-user-config");
		expect(call.argv[call.argv.indexOf("-m") + 1]).toBe("gpt-6.1-sol");
		expect(call.argv).toContain('model_reasoning_effort="xhigh"');
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
	expect(first.argv.slice(0, 4)).toEqual(["exec", "review", "--base", base]);
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
	expect(first.stdin).toBe(`/code-review low ${git(s.repo, "rev-parse", "origin/main")}...HEAD`);
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
	const head = git(s.repo, "rev-parse", "HEAD");
	expect(resumed.stdin).toContain(`\`git diff ${git(s.repo, "rev-parse", "origin/main")}..${head}\``);
	expect(calls.filter((c) => c.argv[1] === "review")).toHaveLength(1);
});

fakes("--new starts over, and a first round takes no responses", async () => {
	const s = setup();
	expect((await quest("--root", s.repo, "review")).code).toBe(0);
	write(s.repo, ".tmp/responses.md", "Fixed at src/lib.ts:1.\n");
	const responses = join(s.repo, ".tmp", "responses.md");
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
