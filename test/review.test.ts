import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { type Output, main } from "../src/cli/main";
import { REVIEWERS } from "../src/cli/models";
import { SIZES } from "../src/core";
import {
	type Finding,
	type Round,
	type Settled,
	type Tally,
	authored,
	baseInstructions,
	nextStep,
	pickReviewer,
	review,
	runningHarness,
	parseState,
	shadowOf,
	sessionFile,
	tallied,
	verdict,
} from "../src/cli/review";
import { withReview } from "../src/cli/review-record";
import { implementer, recorded } from "../src/github/models";
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
 * The findings turn's reply, `reply`: FAKE_REPLY, or one finding. A JSON reply without `earlier` settles
 * each earlier finding the prompt numbers as FAKE_DISPOSITION says, `fixed` by default.
 */
const REPLY = `
const listed = /<earlier-findings>\\n([\\s\\S]*?)\\n<\\/earlier-findings>/.exec(stdin)?.[1] ?? "";
const earlier = [...listed.matchAll(/^(\\d+)\\. /gm)].map((m) => ({
	finding: Number(m[1]),
	disposition: process.env.FAKE_DISPOSITION ?? "fixed",
	reason: "Checked against the head.",
}));
let reply = process.env.FAKE_REPLY ?? JSON.stringify({ score: 8, rationale: "Lands once the off-by-one is fixed.", findings: [${JSON.stringify(FINDING)}] });
try {
	const parsed = JSON.parse(reply);
	if (parsed && typeof parsed === "object" && !("earlier" in parsed)) reply = JSON.stringify({ ...parsed, earlier });
} catch {}
`;

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
	${REPLY}
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
	const message = process.env.FAKE_LIMITED === "retried"
		? "exceeded retry limit, last status: 429 Too Many Requests"
		: process.env.FAKE_LIMITED === "unknown"
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
	${REPLY}
	message(reply);
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
	/** Every logged invocation of the fake Codex and Claude Code. */
	calls(): Call[];
}

interface Call {
	argv: string[];
	stdin: string;
	env: Record<string, string>;
	cwd: string;
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
	for (const name of [
		...unset,
		"FAKE_LOGGED_OUT",
		"FAKE_REJECTED",
		"FAKE_LIMITED",
		"FAKE_HANG",
		"FAKE_DISPOSITION",
	]) {
		vi.stubEnv(name, undefined);
	}
	if (host === "CLAUDECODE") vi.stubEnv("CLAUDECODE", "1");
	if (host === "CODEX_THREAD_ID") vi.stubEnv("CODEX_THREAD_ID", "parent");
	const read = (path: string) =>
		existsSync(path)
			? readFileSync(path, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line))
			: [];
	return { repo, bin, calls: () => read(log) };
}

/** The effort a Codex or Claude Code turn runs at, or null for a status check. */
function effortOf(call: Call): string | null {
	const flag = call.argv.indexOf("--effort");
	if (flag >= 0) return call.argv[flag + 1]!;
	const setting = call.argv.find((arg) => arg.startsWith("model_reasoning_effort="));
	return setting ? JSON.parse(setting.slice("model_reasoning_effort=".length)) : null;
}

/** The turns at `effort`, so the size's pick and its shadow, which run at once on the same CLI, read apart. */
const at = (calls: Call[], effort: string) => calls.filter((call) => effortOf(call) === effort);

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

test("each size's reviewer is the first whose model is not the latest writer's", () => {
	const claude = authored({}, { CLAUDECODE: "1" });
	const codex = authored({}, { CODEX_THREAD_ID: "t" });
	const at = (size: keyof typeof REVIEWERS, wrote: typeof claude) => {
		const { harness, model, effort } = pickReviewer(size, {}, wrote);
		return `${harness} ${model} ${effort}`;
	};
	expect(at("XS", claude)).toBe("codex gpt-6.1-sol medium");
	expect(at("S", claude)).toBe("codex gpt-6.1-sol medium");
	expect(at("M", claude)).toBe("codex gpt-6.1-sol high");
	expect(at("L", claude)).toBe("codex gpt-6.1-sol xhigh");
	expect(at("XL", claude)).toBe("codex gpt-6.1-sol xhigh");
	// Claude reviews what Sol wrote.
	expect(at("XS", codex)).toBe("claude claude-opus-5-5 low");
	expect(at("S", codex)).toBe("claude claude-opus-5-5 low");
	expect(at("M", codex)).toBe("claude claude-opus-5-5 medium");
	expect(at("L", codex)).toBe("claude claude-opus-5-5 high");
	expect(at("XL", codex)).toBe("claude claude-opus-5-5 xhigh");

	// The PR's latest recorded implementer replaces the running harness, and only it is avoided.
	expect(at("S", authored({}, { CLAUDECODE: "1" }, "claude-opus-5-5"))).toBe("codex gpt-6.1-sol medium");
	expect(at("S", authored({}, { CLAUDECODE: "1" }, "gpt-6.1-sol"))).toBe("claude claude-opus-5-5 low");
	// An unknown latest writer is taken to be the running harness, usually the session that just pushed.
	expect(at("M", authored({}, { CODEX_THREAD_ID: "t" }, "unknown"))).toBe("claude claude-opus-5-5 medium");
	// --harness then avoids the named latest writer.
	const opus = authored({ harness: "claude" }, {}, "claude-opus-5-5");
	expect(() => pickReviewer("M", { harness: "claude" }, opus)).toThrow("claude-opus-5-5 is avoided");
	expect(at("S", authored({ exclude: ["claude-opus-5-5"] }, { CLAUDECODE: "1" }))).toBe("codex gpt-6.1-sol medium");
	expect(at("S", authored({ exclude: ["gpt-6.1-sol"] }, { CLAUDECODE: "1" }))).toBe("claude claude-opus-5-5 low");
	// No harness need be detected once the implementers are named.
	expect(at("M", authored({ exclude: ["other-model"] }, {}))).toBe("codex gpt-6.1-sol high");
	const both = authored({ exclude: ["gpt-6.1-sol", "claude-opus-5-5"] }, {});
	expect(() => pickReviewer("M", {}, both)).toThrow("is avoided; pass --harness and --model");

	// --harness names the reviewer at its entry, unless that entry's model is avoided.
	expect(pickReviewer("L", { harness: "claude" }, authored({ harness: "claude" }, { CLAUDECODE: "1" }))).toEqual({
		harness: "claude",
		model: "claude-opus-5-5",
		effort: "high",
	});
	const sol = authored({ harness: "codex", exclude: ["gpt-6.1-sol"] }, {});
	expect(() => pickReviewer("M", { harness: "codex" }, sol)).toThrow("gpt-6.1-sol is avoided; pass --model");
	expect(pickReviewer("M", { harness: "codex", model: "gpt-6-astra" }, sol).model).toBe("gpt-6-astra");
	// Nor does --model bring back an avoided model.
	expect(() => pickReviewer("M", { harness: "codex", model: "gpt-6.1-sol" }, sol)).toThrow("gpt-6.1-sol is avoided");
	const opusWrote = authored({ exclude: ["claude-opus-5-5"] }, {});
	expect(() => pickReviewer("M", { model: "claude-opus-5-5" }, opusWrote)).toThrow("claude-opus-5-5 is avoided");
	// --model and --effort override the picked entry.
	expect(pickReviewer("XS", { effort: "high" }, claude)).toEqual({
		harness: "codex",
		model: "gpt-6.1-sol",
		effort: "high",
	});
});

fakes("a quest branch is reviewed at its quest's size on the base, which its own change cannot lower", async () => {
	const s = setup();
	git(s.repo, "checkout", "-q", "main");
	write(s.repo, "quest/m0/big.md", "# [L] Big\n\n## Goal\n\nBig.\n");
	git(s.repo, "add", ".");
	git(s.repo, "commit", "-qm", "plan");
	git(s.repo, "push", "-q", "origin", "main");
	git(s.repo, "checkout", "-qb", "quest/m0/big");
	write(s.repo, "quest/m0/big.md", "# [XS] Big\n\n## Goal\n\nBig.\n");
	git(s.repo, "commit", "-qam", "shrink");

	const result = await quest("--root", s.repo, "review");
	expect(result.stderr).toBe("");
	expect(result.stdout).toMatch(/^size L quest\/m0\/big.md\n/);
	expect(result.stdout).toContain("\nreviewer codex gpt-6.1-sol xhigh\n");

	// --size overrides the quest's.
	const sized = await quest("--root", s.repo, "review", "--size", "S", "--new");
	expect(sized.stdout).toMatch(/^size S --size\n/);
	expect(sized.stdout).toContain("\nreviewer codex gpt-6.1-sol medium\n");
	// A checkout on another branch, as the runner's review checkout is, takes the size of the branch it names.
	git(s.repo, "checkout", "-qb", "kix-review/job1");
	const {
		rounds: [runner],
	} = await review(
		{ root: s.repo, base: "origin/main", sizeBranch: "quest/m0/big" },
		{ env: { ...process.env, CLAUDECODE: "1" } },
	);
	expect([runner!.size, runner!.sizeFrom, runner!.effort]).toEqual(["L", "quest/m0/big.md", "xhigh"]);
	git(s.repo, "checkout", "-q", "quest/m0/big");
	const invalid = await quest("--root", s.repo, "review", "--size", "XXL", "--new");
	expect(invalid.code).not.toBe(0);
	expect(invalid.stderr).toContain("Allowed choices are XS, S, M, L, XL");

	// A quest branch whose quest the base lacks, such as one planned on the branch, takes the default.
	git(s.repo, "checkout", "-qb", "quest/m0/new", "main");
	write(s.repo, "quest/m0/new.md", "# [XS] New\n\n## Goal\n\nNew.\n");
	git(s.repo, "add", ".");
	git(s.repo, "commit", "-qm", "new");
	expect((await quest("--root", s.repo, "review")).stdout).toContain("size M default\n");
});

fakes("--exclude-model picks the reviewer from the PR's implementers instead of the running harness", async () => {
	const s = setup(null);
	const result = await quest("--root", s.repo, "review", "--exclude-model", "gpt-6.1-sol", "--json");
	expect(result.stderr).toBe("");
	const [round] = JSON.parse(result.stdout).rounds;
	expect([round.reviewer, round.model, round.effort, round.size, round.sizeFrom]).toEqual([
		"claude",
		"claude-opus-5-5",
		"medium",
		"M",
		"default",
	]);

	const both = ["--exclude-model", "gpt-6.1-sol", "--exclude-model", "claude-opus-5-5"];
	const none = await quest("--root", s.repo, "review", ...both, "--new");
	expect(none.code).toBe(2);
	expect(none.stderr).toContain("every M reviewer (gpt-6.1-sol, claude-opus-5-5) is avoided");
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
	// The size's pick and its shadow each check the login, and the first to fail stops the other's; no turn runs.
	expect(t.calls().length).toBeGreaterThanOrEqual(1);
	for (const call of t.calls()) expect(call.argv).toEqual(["login", "status"]);
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
		// The failing seat's status check passed, and the first turn to fail stopped the other seat before it
		// resumed. That seat runs its own status check concurrently, so the abort may stop it before its CLI
		// logs, or before it spawns at all.
		const calls = s.calls();
		const checks = calls.filter((c) => effortOf(c) === null).length;
		expect(checks).toBeGreaterThanOrEqual(1);
		expect(checks).toBeLessThanOrEqual(2);
		const turns = calls.filter((c) => effortOf(c) !== null);
		expect(turns.length).toBeGreaterThanOrEqual(1);
		expect(turns.every((c) => !c.argv.includes("--resume") && !c.argv.includes("resume"))).toBe(true);
	},
);

// Codex prints its reset in the local time zone, which this process shares.
const codexReset = new Date(2026, 10, 5, 15, 15).toISOString().replace(".000Z", "Z");

// One test per case: each runs two full reviews, and all four in one test outran its timeout on loaded runners.
fakes.for([
	["CLAUDECODE", "reset", `codex hit its usage limit; resets ${codexReset}`],
	["CLAUDECODE", "unknown", "codex hit its usage limit; resets unknown"],
	["CODEX_THREAD_ID", "reset", "claude hit its usage limit; resets 2030-03-17T17:46:40Z"],
	["CODEX_THREAD_ID", "unknown", "claude hit its usage limit; resets unknown"],
] as const)(
	"a reviewer's usage limit exits 3 with its reset, and records no round (%s, %s)",
	async ([host, variant, message]) => {
		const s = setup(host);
		vi.stubEnv("FAKE_LIMITED", variant);
		const result = await quest("--root", s.repo, "review");
		expect(result.stderr).toBe(`error: ${message}\n`);
		expect(result.code).toBe(3);
		expect(result.stdout).toBe("");
		vi.stubEnv("FAKE_LIMITED", undefined);
		// No round was recorded, so the next one needs no responses.
		expect((await quest("--root", s.repo, "review")).code).toBe(0);
	},
);

fakes("Codex reaches a gateway at OPENAI_BASE_URL, whose persistent 429 is the pool's usage limit", async () => {
	const s = setup();
	vi.stubEnv("FAKE_LOGGED_OUT", "1");
	vi.stubEnv("CODEX_API_KEY", "proxy-key");
	vi.stubEnv("FAKE_LIMITED", "retried");
	// From the provider itself, giving up on a 429 may be a brief throttle, so it is no limit.
	const direct = await quest("--root", s.repo, "review");
	expect(direct.code).toBe(1);
	expect(direct.stderr).toContain("exceeded retry limit, last status: 429");
	vi.stubEnv("OPENAI_BASE_URL", "http://127.0.0.1:4000/v1");
	const pooled = await quest("--root", s.repo, "review");
	expect(pooled.stderr).toBe("error: codex hit its usage limit; resets unknown\n");
	expect(pooled.code).toBe(3);
	vi.stubEnv("FAKE_LIMITED", undefined);
	expect((await quest("--root", s.repo, "review")).code).toBe(0);
	// Codex reads no OPENAI_BASE_URL itself, so the review sets its openai_base_url.
	for (const call of s
		.calls()
		.filter((c) => c.argv[0] === "exec")
		.slice(-2))
		expect(call.argv.join(" ")).toContain('-c openai_base_url="http://127.0.0.1:4000/v1"');
});

fakes("a reviewer with no stored login reviews with the credential its CLI reads from the environment", async () => {
	const s = setup();
	vi.stubEnv("FAKE_LOGGED_OUT", "1");
	vi.stubEnv("CODEX_API_KEY", "codex-key");
	vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "session-token");
	const codex = await quest("--root", s.repo, "review");
	expect(codex.stderr).toBe("");
	expect(codex.code).toBe(0);
	for (const call of s.calls().filter((c) => effortOf(c) !== null)) {
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
	for (const call of t.calls().filter((c) => effortOf(c) !== null)) {
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
	vi.stubEnv("OP_SERVICE_ACCOUNT_TOKEN", "secret-manager-token");
	vi.stubEnv("FAKE_REPLY", JSON.stringify({ score: 10, rationale: "Lands as is.", findings: [] }));
	const first = await quest("--root", s.repo, "review", "--json");
	expect(first.code, first.stderr).toBe(0);
	write(s.repo, "src/lib.ts", "export const x = 4;\n");
	git(s.repo, "commit", "-qam", "more");
	const resumed = await quest("--root", s.repo, "review", "--json");
	expect(resumed.code, resumed.stderr).toBe(0);
	expect(JSON.parse(resumed.stdout).rounds[0]).toMatchObject({
		round: 2,
		session: JSON.parse(first.stdout).rounds[0].session,
	});
	const calls = s.calls();
	// The shadow found nothing in round 1, so only the size's pick reruns.
	expect(at(calls, "medium").map((c) => c.argv[0])).toEqual(["-p", "-p", "-p"]);
	expect(at(calls, "low").map((c) => c.argv[0])).toEqual(["-p", "-p"]);
	expect(calls.filter((c) => effortOf(c) === null)).toHaveLength(3);
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
	// The size's pick and its shadow each check the login, and the first to fail stops the other's; no turn runs.
	expect(s.calls().length).toBeGreaterThanOrEqual(1);
	for (const call of s.calls()) expect(call.argv).toEqual(["auth", "status"]);
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
	// The size's pick and its shadow each check the login, and the first to fail stops the other's; no turn runs.
	expect(s.calls().length).toBeGreaterThanOrEqual(1);
	for (const call of s.calls()) expect(call.argv).toEqual(["auth", "status"]);
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
	for (const call of t.calls().filter((c) => effortOf(c) !== null)) {
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
	expect(at(s.calls(), "high").filter((c) => c.argv[1] === "review")).toHaveLength(1);
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

fakes("a branch tracking the PR's branch continues its session, and one tracking the base has its own", async () => {
	const s = setup();
	expect((await quest("--root", s.repo, "review")).stdout).toContain("round 1\n");
	write(s.repo, ".tmp/responses.md", "Fixed at src/lib.ts:1.\n");
	const responses = join(s.repo, ".tmp", "responses.md");
	git(s.repo, "checkout", "-qb", "temp");
	git(s.repo, "config", "branch.temp.remote", "origin");
	git(s.repo, "config", "branch.temp.merge", "refs/heads/feature");
	const tracking = await quest("--root", s.repo, "review", "--responses", responses);
	expect(tracking.stderr).toBe("");
	expect(tracking.stdout).toContain("round 2\n");
	git(s.repo, "checkout", "-qb", "other");
	git(s.repo, "config", "branch.other.remote", "origin");
	git(s.repo, "config", "branch.other.merge", "refs/heads/main");
	const base = await quest("--root", s.repo, "review", "--responses", responses);
	expect(base.code).toBe(2);
	expect(base.stderr).toContain("has none to resume");
});

fakes("a detached checkout names the branches at its head to pass as --branch", async () => {
	const s = setup();
	git(s.repo, "checkout", "-q", "--detach");
	const detached = await quest("--root", s.repo, "review");
	expect(detached.code).toBe(2);
	expect(detached.stderr).toContain(
		"pass --branch to name the branch whose review session this continues, such as --branch feature",
	);
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

		const [first, second] = at(s.calls(), host === "CLAUDECODE" ? "high" : "medium");
		if (host === "CLAUDECODE") {
			expect(first.argv.slice(0, 3)).toEqual(["exec", "review", "--json"]);
			expect(first.argv.at(-1)).toBe("-");
		} else {
			expect(first.stdin.startsWith(`/code-review medium ${mergeBase}...HEAD "`)).toBe(true);
			expect(first.argv[first.argv.indexOf("--effort") + 1]).toBe("medium");
		}
		// The review turn names the range itself, and the report turn only shapes its result.
		expect(first.stdin).toContain(`\`git diff ${mergeBase}..${head}\``);
		expect(second.stdin).toContain("Read no files and run no commands");
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
			"size M default",
			`base ${base} origin/main`,
			`head ${head}`,
			"",
			"reviewer codex gpt-6.1-sol high",
			"session thread-1",
			"round 1",
			"usage findings input 100 cached 80 output 7",
			"score 8 Lands once the off-by-one is fixed.",
			"findings 1",
			"",
			"1. high src/lib.ts:2 Off by one",
			"  average([3]) is 0.",
			"",
			// The shadow, the pick one effort lower, reviews it too, in its own session.
			"reviewer codex gpt-6.1-sol medium shadow",
			"session thread-1",
			"round 1",
			"usage findings input 100 cached 80 output 7",
			"score 8 Lands once the off-by-one is fixed.",
			"findings 1",
			"",
			"2. high src/lib.ts:2 Off by one",
			"  average([3]) is 0.",
			// The fixture's origin is a local path, which can have no PR.
			"record skipped: origin is not on GitHub",
			"next respond: fix each finding or refute it with evidence the reviewer cannot rebut, commit, rerun the checks, then run the next round with --responses, one response per finding by its number",
			"",
		].join("\n"),
	);

	const [first, second] = at(s.calls(), "high");
	expect(at(s.calls(), "medium")).toHaveLength(2);
	// The base has not moved, so its tip is the merge base, which the review turn's prompt names with the rules.
	expect(first.argv.slice(0, 3)).toEqual(["exec", "review", "--json"]);
	expect(first.argv.at(-1)).toBe("-");
	expect(first.stdin).toContain(`\`git diff ${base}..${head}\``);
	expect(first.stdin).toContain("BASE-REVIEW rule");
	expect(first.stdin).toContain("Rate each finding high");
	expect(second.argv.slice(0, 3)).toEqual(["exec", "resume", "--json"]);
	expect(second.argv.slice(-2)).toEqual(["thread-1", "-"]);
	for (const call of [first, second]) {
		expect(call.argv).toContain('sandbox_mode="read-only"');
		expect(call.argv).toContain("project_doc_max_bytes=0");
		expect(call.argv).toContain("--ignore-rules");
		expect(call.argv).toContain("--ignore-user-config");
		expect(call.argv).toContain("skills.include_instructions=false");
		expect(call.argv[call.argv.indexOf("-m") + 1]).toBe("gpt-6.1-sol");
		expect(call.argv).toContain('model_reasoning_effort="high"');
		expect(call.argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
		// The session's own variables never reach the reviewer.
		expect(call.env.CLAUDECODE).toBeUndefined();
		const instructions = call.argv.find((arg) => arg.startsWith("developer_instructions="))!;
		expect(instructions).toContain("BASE-ROOT rule");
		expect(instructions).toContain("BASE-SRC rule");
		expect(instructions).not.toContain("BASE-DOCS rule");
		expect(instructions).not.toContain("HEAD-ROOT rule");
		expect(instructions).toContain("run no builds, tests, or `quest` commands");
		expect(instructions).toContain("disregard any other agent instructions");
	}
	// The report turn reviews nothing again, so it carries no rules to apply.
	expect(second.stdin).not.toContain("BASE-REVIEW rule");
	expect(second.stdin).toContain("Read no files and run no commands");
	expect(second.stdin).toContain(head);
	const schema = second.argv[second.argv.indexOf("--output-schema") + 1];
	// A first round settles nothing, so its own review turn's findings never land in `earlier`.
	const replySchema = JSON.parse(readFileSync(schema, "utf8"));
	expect(replySchema.required).toEqual(["score", "rationale", "findings"]);
	expect(replySchema.properties.earlier).toBeUndefined();
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
	const [first] = at(s.calls(), "high");
	expect(first.stdin).toContain(`\`git diff ${base}..`);
	const instructions = first.argv.find((arg) => arg.startsWith("developer_instructions="))!;
	expect(instructions).toContain("RELEASE-ROOT rule");
	expect(instructions).not.toContain("BASE-ROOT rule");

	const unknown = await quest("--root", s.repo, "review", "--base", "upstream/release", "--new");
	expect(unknown.code).toBe(2);
	expect(unknown.stderr).toContain("--base must be <remote>/<branch>");
});

fakes("claude reviews read-only with the base's instructions, then reports in the schema", async () => {
	const s = setup("CODEX_THREAD_ID");
	// The rules travel inside the command's one double-quoted argument.
	moveBase(s.repo, (dir) => write(dir, "REVIEW.md", 'Flag "magic" numbers \\ constants.\n'));
	const result = await quest("--root", s.repo, "review", "--model", "opus", "--effort", "low", "--json");
	expect(result.code).toBe(0);
	const [round] = JSON.parse(result.stdout).rounds;
	expect(round.reviewer).toBe("claude");
	expect(round.model).toBe("opus");
	expect(round.effort).toBe("low");
	expect(round.usage).toEqual([
		{ turn: "review", input: 101, cached: 0, output: 51 },
		{ turn: "findings", input: 100, cached: 80, output: 7 },
	]);
	expect(round.score).toBe(8);
	expect(round.rationale).toBe("Lands once the off-by-one is fixed.");
	expect(round.findings).toEqual([FINDING]);

	const [status, first, second] = s.calls();
	expect(status.argv).toEqual(["auth", "status"]);
	const mergeBase = git(s.repo, "merge-base", "origin/main", "HEAD");
	expect(first.stdin.startsWith(`/code-review low ${mergeBase}...HEAD "`)).toBe(true);
	expect(first.stdin.endsWith('"')).toBe(true);
	expect(first.stdin).toContain('Flag \\"magic\\" numbers \\\\ constants.');
	expect(first.argv).not.toContain("--json-schema");
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
	vi.stubEnv("FAKE_REPLY", JSON.stringify({ score: 10, rationale: "Lands as is.", findings: [] }));
	const later = await quest("--root", s.repo, "review", "--responses", responses);
	expect(later.code, later.stderr).toBe(0);
	expect(later.stdout).toContain("round 2\n");
	expect(later.stdout).toContain("findings 0\n");
	expect(later.stdout).toMatch(/\nnext done: no findings remain on this head\n$/);
	// The round settles the last round's finding, by its number in the prompt.
	const first = git(s.repo, "rev-parse", "HEAD~1");
	expect(later.stdout).toContain(
		`earlier 1 ${first}\n\n1. fixed high src/lib.ts:2 Off by one\n  Checked against the head.\n`,
	);
	// The shadow had a finding to settle, so it reruns, settling its own after the pick's.
	expect(later.stdout).toContain(
		`earlier 1 ${first}\n\n2. fixed high src/lib.ts:2 Off by one\n  Checked against the head.\n`,
	);
	const shadow = at(s.calls(), "medium").at(-1)!;
	expect(shadow.argv.slice(0, 2)).toEqual(["exec", "resume"]);
	expect(shadow.stdin).toContain("<earlier-findings>\n2. high src/lib.ts:2 Off by one\n</earlier-findings>");

	const calls = at(s.calls(), "high");
	const resumed = calls.at(-1)!;
	expect(resumed.argv.slice(0, 2)).toEqual(["exec", "resume"]);
	expect(resumed.argv.at(-2)).toBe("thread-1");
	const bounded = JSON.parse(readFileSync(resumed.argv[resumed.argv.indexOf("--output-schema") + 1], "utf8"));
	expect(bounded.required).toEqual(["score", "rationale", "findings", "earlier"]);
	expect(resumed.stdin).toContain("Fixed at src/lib.ts:1.");
	expect(resumed.stdin).toContain("<earlier-findings>\n1. high src/lib.ts:2 Off by one\n</earlier-findings>");
	// The session was given the rules already, and they have not changed.
	expect(resumed.stdin).not.toContain("BASE-REVIEW rule");
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
	const restarted = await quest("--root", s.repo, "review", "--new", "--json");
	expect(JSON.parse(restarted.stdout).rounds[0].round).toBe(1);
	// The new sessions continue their reviewers' tallies, less the findings the dropped sessions left unsettled.
	expect(
		JSON.parse(restarted.stdout).tallies.map((t: Tally) => [t.reviewer, t.rounds, t.findings.high, t.fixed]),
	).toEqual([
		["codex", 2, 1, 0],
		["codex", 2, 1, 0],
	]);
	expect(JSON.parse(restarted.stdout).tallies.map((t: Tally) => t.shadow)).toEqual([undefined, true]);
});

/** Commit `edit` to origin's `next` branch, leaving the checkout on `feature`; no flags change. */
function moveNext(repo: string, edit: () => void): string[] {
	git(repo, "checkout", "-q", "next");
	edit();
	git(repo, "commit", "-qam", "move next");
	git(repo, "push", "-q", "origin", "next");
	git(repo, "checkout", "-q", "feature");
	return [];
}

fakes.each([
	["another effort", (_: string) => ["--effort", "xhigh"]],
	["a changed REVIEW.md", (repo: string) => moveNext(repo, () => write(repo, "REVIEW.md", "NEW rule\n"))],
	["a removed REVIEW.md", (repo: string) => moveNext(repo, () => git(repo, "rm", "-q", "REVIEW.md"))],
	["an older base", (_: string) => ["--base", "origin/main"]],
] as const)(
	"anything but the head changing, such as %s, starts a new session that reviews it all",
	async (_, change) => {
		const s = setup();
		vi.stubEnv("FAKE_REPLY", JSON.stringify({ score: 10, rationale: "Lands as is.", findings: [] }));
		// The branch merges a base ahead of main, which the first round reviews against.
		git(s.repo, "checkout", "-qb", "next", "main");
		write(s.repo, "notes.md", "next\n");
		git(s.repo, "add", ".");
		git(s.repo, "commit", "-qm", "next");
		git(s.repo, "push", "-q", "origin", "next");
		git(s.repo, "checkout", "-q", "feature");
		git(s.repo, "merge", "-q", "--no-edit", "next");
		const first = await quest("--root", s.repo, "review", "--base", "origin/next");
		expect(first.code, first.stderr).toBe(0);
		const flags = change(s.repo);
		const base = flags.includes("--base") ? [] : ["--base", "origin/next"];
		const round = await quest("--root", s.repo, "review", ...base, ...flags);
		expect(round.code, round.stderr).toBe(0);
		expect(round.stdout).toContain("round 1\n");
		expect(round.stdout).not.toContain("unchanged");
		const effort = flags.includes("--effort") ? "xhigh" : "high";
		expect(at(s.calls(), effort).at(-2)!.argv[1]).toBe("review");
		// A pick at another effort leaves the shadow two steps below it, so the shadow at one step reruns.
		expect(round.stdout.includes("gpt-6.1-sol high shadow\n")).toBe(flags.includes("--effort"));
	},
);

fakes("a base that moved on keeps the session, which checks only what changed", async () => {
	const s = setup();
	vi.stubEnv("FAKE_REPLY", JSON.stringify({ score: 10, rationale: "Lands as is.", findings: [] }));
	expect((await quest("--root", s.repo, "review")).code).toBe(0);
	moveBase(s.repo, (dir) => write(dir, "notes.md", "new\n"));
	git(s.repo, "merge", "-q", "--no-edit", "origin/main");
	const round = await quest("--root", s.repo, "review");
	expect(round.stdout).toContain("round 2\n");
	expect(s.calls().at(-1)!.argv.slice(0, 2)).toEqual(["exec", "resume"]);
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
	const [review, followUp] = at(s.calls(), "high").slice(-2);
	expect(review.argv[1]).toBe("review");
	expect(review.argv.find((arg) => arg.startsWith("developer_instructions="))).toContain("BASE-SRC new rule");
	expect(review.stdin).toContain("Refuted: see src/lib.ts:1.");
	// The new session is told the findings the responses answer, and settles them in its report.
	expect(review.stdin).toContain("1. high src/lib.ts:2 Off by one");
	expect(followUp.stdin).toContain("1. high src/lib.ts:2 Off by one");
});

/**
 * Point the fixture's origin at `acme/widget` on GitHub, still fetched from its local copy, and answer the
 * API with `pulls` as the open PRs from `acme:<branch>` into main. With `fork`, `acme/widget` is a fork of
 * `upstream/widget`, whose root holds the quest tree, and the PRs are upstream's. Returns the PR bodies
 * each PATCH wrote.
 */
type FakePull = { number: number; body: string | null };
function onGitHub(repo: string, pulls: FakePull[], fork = false): { body: string }[] {
	const local = git(repo, "remote", "get-url", "origin");
	git(repo, "remote", "set-url", "origin", "https://github.com/acme/widget.git");
	git(repo, "config", `url.${local}.insteadOf`, "https://github.com/acme/widget.git");
	const owner = fork ? "upstream" : "acme";
	const writes: { body: string }[] = [];
	const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
	const info = (login: string, parent: string | null) => ({
		owner: { login },
		name: "widget",
		fork: parent !== null,
		...(parent === null ? {} : { parent: { owner: { login: parent }, name: "widget" } }),
		default_branch: "main",
		clone_url: `https://github.com/${login}/widget.git`,
		ssh_url: `git@github.com:${login}/widget.git`,
	});
	vi.stubEnv("GH_TOKEN", "token");
	vi.stubGlobal("fetch", async (input: URL, init?: RequestInit) => {
		const url = new URL(input);
		if (url.pathname === "/repos/acme/widget") return json(info("acme", fork ? "upstream" : null));
		if (url.pathname === "/repos/upstream/widget") return json(info("upstream", null));
		if (url.pathname.startsWith("/repos/upstream/widget/contents/"))
			return url.pathname.endsWith("/contents/quest/README.md") ? json({}) : json({}, 404);
		if (url.pathname === `/repos/${owner}/widget/pulls`) {
			expect(url.searchParams.get("state")).toBe("open");
			expect(url.searchParams.get("base")).toBe("main");
			const head = url.searchParams.get("head");
			return json(
				head === "acme:feature"
					? pulls.map((p) => ({ ...p, html_url: `https://github.com/${owner}/widget/pull/${p.number}` }))
					: [],
			);
		}
		const patched = new RegExp(`^/repos/${owner}/widget/pulls/(\\d+)$`).exec(url.pathname);
		if (patched && init?.method === "PATCH") {
			const { body } = JSON.parse(String(init.body)) as { body: string };
			writes.push({ body });
			pulls.find((p) => p.number === Number(patched[1]))!.body = body;
			return json({});
		}
		throw new Error(`unexpected ${init?.method ?? "GET"} ${url.pathname}`);
	});
	return writes;
}

fakes("each round rewrites the Review section of the branch's open PR, keeping the author's prose", async () => {
	const s = setup();
	const pull = {
		number: 7,
		body: [
			"Fixes averaging.",
			"",
			"## Review",
			"",
			"Hand-written record of an older head.",
			"",
			"## Models",
			"",
			"- Size: S",
			"- Implementer: Claude Code, claude-opus-5-5, high effort",
		].join("\r\n"),
	};
	const writes = onGitHub(s.repo, [pull]);
	try {
		const first = await quest("--root", s.repo, "review");
		expect(first.stderr).toBe("");
		expect(first.code).toBe(0);
		expect(first.stdout).toContain("record https://github.com/acme/widget/pull/7\n");
		const head = git(s.repo, "rev-parse", "HEAD");
		const base = git(s.repo, "rev-parse", "origin/main");
		expect(pull.body).toBe(
			[
				// The author's lines keep their line endings.
				"Fixes averaging.\r\n\r\n## Review\r",
				"",
				"Rewritten by `quest review` after each round.",
				"",
				// The land gate counts a full SHA, which a head with an open finding does not earn.
				`- Head: ${head.slice(0, 12)}, named in full once no reviewer reports a finding`,
				`- Base: origin/main at ${base.slice(0, 12)}`,
				"",
				// The body's `## Models` record sizes the PR S.
				"- Reviewer: Codex, gpt-6.1-sol, medium effort",
				"- Session: `thread-1`, round 1",
				"- Score: 8/10, `Lands once the off-by-one is fixed.`",
				"- Rounds: 1; findings 1 (high 1): fixed 0, refuted 0, open 1",
				"- Findings, open until the next round settles them:",
				"  - High, `src/lib.ts:2`: `Off by one`",
				"",
				// The shadow runs the pick one effort lower, and its findings count apart from the pick's.
				"- Reviewer: Codex, gpt-6.1-sol, low effort, shadow",
				"- Session: `thread-1`, round 1",
				"- Score: 8/10, `Lands once the off-by-one is fixed.`",
				"- Rounds: 1; findings 1 (high 1): fixed 0, refuted 0, open 1",
				"- Findings, open until the next round settles them:",
				"  - High, `src/lib.ts:2`: `Off by one`",
				"",
				"## Models\r\n\r\n- Size: S\r\n- Implementer: Claude Code, claude-opus-5-5, high effort",
			].join("\n"),
		);

		// The next round settles that finding from the responses; model text never mentions, links, or names a full SHA.
		write(s.repo, "src/lib.ts", "export const x = 4;\n");
		git(s.repo, "commit", "-qam", "fix");
		write(s.repo, ".tmp/responses.md", "1. Fixed at src/lib.ts:1.\n");
		vi.stubEnv("FAKE_DISPOSITION", "refuted");
		const title = `Ping @someone about \`${base}\` in #12`;
		vi.stubEnv(
			"FAKE_REPLY",
			JSON.stringify({ score: 9, rationale: "Fixes #3.", findings: [{ ...FINDING, line: null, title }] }),
		);
		const second = await quest(
			"--root",
			s.repo,
			"review",
			"--responses",
			join(s.repo, ".tmp", "responses.md"),
			"--json",
		);
		expect(second.code).toBe(0);
		expect(JSON.parse(second.stdout).record).toEqual({ url: "https://github.com/acme/widget/pull/7" });
		const record = pull.body.split("## Review\r\n\n")[1]!.split("\n\n## Models")[0];
		expect(record).toContain(`- Head: ${git(s.repo, "rev-parse", "HEAD").slice(0, 12)},`);
		expect(record).toContain("- Session: `thread-1`, round 2\n");
		expect(record).toContain("- Score: 9/10, `Fixes #3.`\n");
		// The refuted finding counts beside the new one, across both rounds.
		expect(record).toContain("- Rounds: 2; findings 2 (high 2): fixed 0, refuted 1, open 1\n");
		expect(record).toContain(
			`  - High, \`src/lib.ts\`: \`\`Ping @someone about \`${base.slice(0, 12)}\` in #12\`\`\n`,
		);
		expect(record).toContain(
			`- The last round's findings, at ${head.slice(0, 12)}:\n  - Refuted: high, \`src/lib.ts:2\`: \`Off by one\`; \`Checked against the head.\``,
		);
		expect(record).not.toMatch(/\b[0-9a-f]{40}\b/);
		expect(pull.body.startsWith("Fixes averaging.\r\n\r\n## Review\r\n\nRewritten")).toBe(true);
		expect(writes).toHaveLength(2);
	} finally {
		vi.unstubAllGlobals();
	}
});

fakes("a branch with no open PR, or a body without a Review section, is reported as such", async () => {
	const s = setup();
	const pulls: { number: number; body: string | null }[] = [];
	onGitHub(s.repo, pulls);
	try {
		const none = await quest("--root", s.repo, "review");
		expect(none.code).toBe(0);
		expect(none.stdout).toContain("record skipped: no open PR from acme:feature into main\n");

		pulls.push({ number: 8, body: null });
		vi.stubEnv("FAKE_REPLY", JSON.stringify({ score: 10, rationale: "Lands as is.", findings: [] }));
		write(s.repo, ".tmp/responses.md", "Fixed.\n");
		const recorded = await quest("--root", s.repo, "review", "--responses", join(s.repo, ".tmp", "responses.md"));
		expect(recorded.stdout).toContain("record https://github.com/acme/widget/pull/8\n");
		expect(pulls[0]!.body).toMatch(
			/^## Review\n\nRewritten by `quest review` after each round\.\n[\s\S]*- Findings: none\n/,
		);
		// A round with no findings names its head in full, which the land gate counts.
		expect(pulls[0]!.body!.match(/\b[0-9a-f]{40}\b/g)).toEqual([git(s.repo, "rev-parse", "HEAD")]);
	} finally {
		vi.unstubAllGlobals();
	}
});

fakes("a review from a subdirectory of a fork records on the upstream PR", async () => {
	const s = setup();
	const pull = { number: 11, body: "Body." };
	onGitHub(s.repo, [pull], true);
	try {
		const result = await quest("--root", join(s.repo, "src"), "review");
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("record https://github.com/upstream/widget/pull/11\n");
		expect(pull.body).toMatch(/^Body\.\n\n## Review\n\nRewritten by `quest review`/);
	} finally {
		vi.unstubAllGlobals();
	}
});

fakes("a round on the head the last round passed runs no reviewer and repeats that round", async () => {
	const s = setup();
	vi.stubEnv("FAKE_REPLY", JSON.stringify({ score: 10, rationale: "Lands as is.", findings: [] }));
	const first = await quest("--root", s.repo, "review", "--json", "--size", "S");
	expect(first.code, first.stderr).toBe(0);
	const calls = s.calls().length;
	const again = await quest("--root", s.repo, "review", "--json", "--size", "S");
	expect(again.code, again.stderr).toBe(0);
	expect(s.calls()).toHaveLength(calls);
	// The shadow found nothing on the branch's first run, so it never runs again.
	const all: Round[] = JSON.parse(first.stdout).rounds;
	expect(all.map((round) => [round.effort, round.shadow])).toEqual([
		["medium", undefined],
		["low", true],
	]);
	const rounds = all.slice(0, 1);
	expect(JSON.parse(again.stdout).rounds).toEqual(
		rounds.map((round: object) => ({ ...round, usage: [], unchanged: true })),
	);
	// XS picks the same reviewer as S, so its round repeats and reports the size given.
	const resized = await quest("--root", s.repo, "review", "--json", "--size", "XS");
	expect(s.calls()).toHaveLength(calls);
	expect(JSON.parse(resized.stdout).rounds).toMatchObject(rounds.map(() => ({ size: "XS", sizeFrom: "--size" })));
	const repeated = (await quest("--root", s.repo, "review", "--size", "XS")).stdout;
	expect(repeated.split("unchanged round 1 reviewed this head and found nothing; no reviewer ran\n")).toHaveLength(2);

	// A round with findings to settle runs on the same head, since a refutation needs no new commit.
	vi.stubEnv("FAKE_REPLY", undefined);
	const t = setup();
	expect((await quest("--root", t.repo, "review")).code).toBe(0);
	write(t.repo, ".tmp/responses.md", "1. Refuted: src/lib.ts:1 sets it.\n");
	const refuted = await quest("--root", t.repo, "review", "--responses", join(t.repo, ".tmp", "responses.md"));
	expect(refuted.code, refuted.stderr).toBe(0);
	expect(refuted.stdout).toContain("session thread-1\nround 2\n");
	expect(refuted.stdout).not.toContain("unchanged");
	expect(at(t.calls(), "high").at(-1)!.stdin).toContain("Refuted: src/lib.ts:1 sets it.");
});

fakes("a later round checks only what changed since the reviewed head, and the open findings", async () => {
	const s = setup();
	expect((await quest("--root", s.repo, "review")).code).toBe(0);
	const previous = git(s.repo, "rev-parse", "HEAD");
	write(s.repo, "src/lib.ts", "export const x = 4;\n");
	git(s.repo, "commit", "-qam", "fix");
	write(s.repo, ".tmp/responses.md", "1. Fixed at src/lib.ts:1.\n");
	expect((await quest("--root", s.repo, "review", "--responses", join(s.repo, ".tmp", "responses.md"))).code).toBe(0);
	const prompt = at(s.calls(), "high").at(-1)!.stdin;
	const head = git(s.repo, "rev-parse", "HEAD");
	expect(prompt).toContain(`Check only what changed since ${previous} and the findings below`);
	expect(prompt).toContain(`\`git diff ${previous} ${head}\``);
	expect(prompt).toContain("1. high src/lib.ts:2 Off by one");
});

fakes("the PR's Models record sizes the review and names its latest writer", async () => {
	const s = setup();
	const body = (...lines: string[]) => ["Body.", "", "## Models", "", ...lines].join("\n");
	const pull: FakePull = { number: 9, body: body("- Size: L", "- Implementer: Codex, gpt-6.1-sol, high effort") };
	onGitHub(s.repo, [pull]);
	try {
		// Sol wrote it, so Opus reviews it at L's effort, though Claude Code runs the command.
		const sol = await quest("--root", s.repo, "review");
		expect(sol.stderr).toBe("");
		expect(sol.stdout).toMatch(/^size L ## Models\n[\s\S]*\nreviewer claude claude-opus-5-5 high\n/);

		// Flags override the record.
		const flagged = await quest("--root", s.repo, "review", "--new", "--size", "XS", "--exclude-model", "x");
		expect(flagged.stdout).toMatch(/^size XS --size\n[\s\S]*\nreviewer codex gpt-6.1-sol medium\n/);

		// Only the latest implementer is avoided, whoever wrote earlier.
		pull.body = body("- Implementer: Codex, unknown, unknown effort", "- Implementer: Codex, gpt-6.1-sol, high");
		expect((await quest("--root", s.repo, "review", "--new")).stdout).toContain(
			"reviewer claude claude-opus-5-5 medium\n",
		);
		// A display name is avoided as its ID is.
		pull.body = body("- Size: S", "- Implementer: Codex, GPT-6.1 Sol, high effort");
		expect((await quest("--root", s.repo, "review", "--new")).stdout).toContain(
			"reviewer claude claude-opus-5-5 low\n",
		);
		// A latest implementer whose model is unknown may be the running harness's, which the review then skips.
		pull.body = body("- Implementer: Codex, gpt-6.1-sol, high", "- Implementer: Codex, unknown, unknown effort");
		expect((await quest("--root", s.repo, "review", "--new")).stdout).toContain(
			"reviewer codex gpt-6.1-sol high\n",
		);

		// A malformed field fails the round, unless the flag that replaces it is given.
		pull.body = body("- Size: XXL", "- Implementer: Codex");
		const invalid = await quest("--root", s.repo, "review", "--new", "--exclude-model", "gpt-6.1-sol");
		expect(invalid.code).toBe(2);
		expect(invalid.stderr).toContain("the PR's ## Models record names size XXL, not one of XS, S, M, L, XL");
		const nameless = await quest("--root", s.repo, "review", "--new", "--size", "S");
		expect(nameless.code).toBe(2);
		expect(nameless.stderr).toContain("names no model it can read in: Implementer: Codex");
		const both = await quest("--root", s.repo, "review", "--new", "--size", "S", "--exclude-model", "gpt-6.1-sol");
		expect(both.stdout).toMatch(/^size S --size\n[\s\S]*\nreviewer claude claude-opus-5-5 low\n/);
		pull.body = body("- Size: S", "- Size: M");
		expect((await quest("--root", s.repo, "review", "--new")).stderr).toContain("names 2 sizes");

		// A blank, multi-token, or malformed duplicate Size line fails too, rather than falling back to M.
		pull.body = body("- Size:");
		const blank = await quest("--root", s.repo, "review", "--new");
		expect(blank.code).toBe(2);
		expect(blank.stderr).toContain("has a Size: line that names no size");
		pull.body = body("- Size: L extra");
		const extra = await quest("--root", s.repo, "review", "--new");
		expect(extra.code).toBe(2);
		expect(extra.stderr).toContain("names size L extra, not one of");
		pull.body = body("- Size: S", "- Size: S extra");
		const duplicate = await quest("--root", s.repo, "review", "--new");
		expect(duplicate.code).toBe(2);
		expect(duplicate.stderr).toContain("names 2 sizes");
		pull.body = body("- Size:");
		expect((await quest("--root", s.repo, "review", "--new", "--size", "S")).stdout).toContain("size S --size\n");
	} finally {
		vi.unstubAllGlobals();
	}
});

test("a Models record reads its size and every implementing model", () => {
	const body =
		"x\n\n## Models\n\nSize: S\n- Implementer: Claude Code, claude-opus-5-5, high effort\n* Implementer: Codex, unknown, unknown effort\n\n## Review\n\n- Size: XL\n";
	expect(recorded(body)).toEqual({
		sizes: ["S"],
		implementers: [
			{
				item: "Implementer: Claude Code, claude-opus-5-5, high effort",
				fields: { harness: "Claude Code", model: "claude-opus-5-5", effort: "high", size: null },
			},
			{
				item: "Implementer: Codex, unknown, unknown effort",
				fields: { harness: "Codex", model: "unknown", effort: "unknown", size: null },
			},
		],
	});
	expect(recorded("No record.")).toEqual({ sizes: [], implementers: [] });
	expect(recorded("## Models\n\n- Size:\n- Size: L extra\n- Size:  M \n").sizes).toEqual(["", "L extra", "M"]);
	expect(recorded("## Models\n\n- Implementer: Codex\n").implementers).toEqual([
		{ item: "Implementer: Codex", fields: null },
	]);
});

test("an Implementer line reads as agents write it", () => {
	const read = (rest: string) => implementer(`Implementer: ${rest}`);
	const opus = (effort: string, harness = "Claude Code") => ({
		harness,
		model: "claude-opus-5-5",
		effort,
		size: null,
	});
	expect(read("Claude Code, Opus 5.5, high effort")).toEqual(opus("high"));
	expect(read("Claude Code, Claude Opus 5.5, xhigh effort")).toEqual(opus("xhigh"));
	expect(read("Claude Code, Opus 5.5")).toEqual(opus("unknown"));
	expect(read("Claude Code, Opus 5.5, effort not reported")).toEqual(opus("unknown"));
	expect(read("Claude, Haiku 5.5, low effort")).toEqual({
		harness: "Claude Code",
		model: "claude-haiku-5-5",
		effort: "low",
		size: null,
	});
	expect(read("claude-haiku-5-5, effort not reported")).toEqual({
		harness: "unknown",
		model: "claude-haiku-5-5",
		effort: "unknown",
		size: null,
	});
	expect(read("Codex, GPT-6.1 Sol, medium effort (iterate, XS)")).toEqual({
		harness: "Codex",
		model: "gpt-6.1-sol",
		effort: "medium",
		size: "XS",
	});
	expect(read("Claude Code, Opus 5.5, low effort (iterate, flow fix)")).toEqual(opus("low"));
	expect(read("Claude Code, Opus 5.5, high effort (iterate, XS, arm B)")).toEqual({ ...opus("high"), size: "XS" });
	expect(read("unknown, Opus 5.5, high effort")).toEqual(opus("high", "unknown"));
	expect(read("Claude Code, Fable 5.2, medium effort")?.model).toBe("claude-fable-5-2");
	expect(read("Codex, openai/gpt-6.1-sol, high effort")?.model).toBe("gpt-6.1-sol");
	expect(read("Codex, gpt-6.1-sol, high")?.effort).toBe("high");
	expect(read("unknown")).toBeNull();
	// A lone field reads as a listed display name or an ID, keeping the size its notes give.
	expect(read("Opus 5.5")).toEqual(opus("unknown", "unknown"));
	expect(read("Claude Opus 5.5 (iterate, S)")).toEqual({ ...opus("unknown", "unknown"), size: "S" });
	expect(read("claude-opus-5-5")).toEqual(opus("unknown", "unknown"));
	expect(read("claude-opus-5-5 (iterate, XS)")).toEqual({ ...opus("unknown", "unknown"), size: "XS" });
	expect(read("Claude Code")).toBeNull();
	expect(read("claude-opus-5-5, unknown")).toEqual(opus("unknown", "unknown"));
	expect(read("Claude Code, Opus 5.5,")).toEqual(opus("unknown"));
	expect(read("OpenRouter, openrouter/kimi, high effort")?.model).toBe("openrouter/kimi");
	expect(read("openrouter/kimi")).toBeNull();
	expect(read(", claude-opus-5-5, high effort")).toEqual(opus("high", "unknown"));
	// An ID no list names still reads, so a new model is counted before the lists add it.
	expect(read("Codex, gpt-7, high effort")?.model).toBe("gpt-7");
	expect(read("Codex, Some Model, high effort")).toBeNull();
	expect(read("Claude Code, Opus 5.5, high effort, extra")).toBeNull();
	expect(read("Claude Code, Opus 5.5, very high effort")).toBeNull();
});

test("the record replaces only a top-level Review section, never an example of one", () => {
	const fenced = "Example:\n\n```md\n## Review\n\nold\n```\n\nAfter.\n";
	expect(withReview(fenced, "new")).toBe(`${fenced.trimEnd()}\n\n## Review\n\nnew\n`);
	const quoted = "> ## Review\n> quoted\n\n## Review\n\nold\n\n# Notes\n\n## Review\n\nsecond\n";
	expect(withReview(quoted, "new")).toBe(
		"> ## Review\n> quoted\n\n## Review\n\nnew\n\n# Notes\n\n## Review\n\nsecond\n",
	);
	// A level-3 heading stays inside the section, and a rewrite of the same record changes nothing.
	const nested = "## Review\n\nold\n\n### Detail\n\nmore\n\n## Models\n\n- Size: S\n";
	const once = withReview(nested, "new");
	expect(once).toBe("## Review\n\nnew\n\n## Models\n\n- Size: S\n");
	expect(withReview(once, "new")).toBe(once);
	expect(withReview("", "new")).toBe("## Review\n\nnew\n");
	// A heading appended inside an unclosed construct would be no section, which the land gate never reads.
	for (const open of ["```md\nunclosed", "<!-- unclosed"])
		expect(() => withReview(open, "new")).toThrow("unclosed code fence or HTML comment");
});

fakes("a record GitHub refuses fails the command after printing the round", async () => {
	const s = setup();
	onGitHub(s.repo, [{ number: 9, body: "" }]);
	const fetch = globalThis.fetch;
	vi.stubGlobal("fetch", async (input: URL, init?: RequestInit) =>
		init?.method === "PATCH"
			? new Response('{"message":"Must have admin rights"}', { status: 403 })
			: fetch(input, init),
	);
	try {
		const result = await quest("--root", s.repo, "review");
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("findings 1\n");
		expect(result.stderr).toContain("the round finished, but recording it in the PR body failed: GitHub HTTP 403");
	} finally {
		vi.unstubAllGlobals();
	}
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

	vi.stubEnv(
		"FAKE_REPLY",
		JSON.stringify({ score: 8, rationale: "Fix it.", findings: [{ ...FINDING, severity: "critical" }] }),
	);
	const wrong = await quest("--root", s.repo, "review");
	expect(wrong.code).toBe(1);
	expect(wrong.stderr).toContain("finding 1 does not match the schema");

	vi.stubEnv("FAKE_REPLY", JSON.stringify({ findings: [] }));
	const unscored = await quest("--root", s.repo, "review");
	expect(unscored.code).toBe(1);
	expect(unscored.stderr).toContain("no score from 0 to 10");
});

test("the verdict is checked field by field, settling each earlier finding once", () => {
	const scored = { score: 7, rationale: "Fix the finding.", earlier: [] };
	expect(verdict({ structured: { ...scored, findings: [{ ...FINDING, line: null }] } }, 0)).toEqual({
		...scored,
		findings: [{ ...FINDING, line: null }],
	});
	expect(() => verdict({ structured: { ...scored, findings: [{ ...FINDING, line: 0 }] } }, 0)).toThrow(
		"does not match",
	);
	expect(() => verdict({ text: '{"verdict":"approve"}' }, 0)).toThrow("no findings list");
	for (const score of [-1, 11, 7.5, "7", undefined]) {
		expect(() => verdict({ structured: { ...scored, score, findings: [] } }, 0)).toThrow("no score from 0 to 10");
	}
	expect(() => verdict({ structured: { ...scored, rationale: " ", findings: [] } }, 0)).toThrow("no rationale");

	const fixed = { finding: 1, disposition: "fixed", reason: "src/lib.ts:2 divides by the length." };
	const refuted = { finding: 2, disposition: "refuted", reason: "The maintainer decided it." };
	const answered = { ...scored, findings: [], earlier: [refuted, fixed] };
	expect(verdict({ structured: answered }, 2).earlier).toEqual([refuted, fixed]);
	// A first round's schema has no `earlier`; a later one's requires it.
	expect(verdict({ structured: { ...scored, findings: [], earlier: undefined } }, 0).earlier).toEqual([]);
	expect(() => verdict({ structured: { ...scored, findings: [], earlier: undefined } }, 1)).toThrow(
		"no earlier list",
	);
	// A finding kept open is reported again, so a reply cannot keep one open and read as clean.
	const open = { ...fixed, disposition: "open" };
	expect(() => verdict({ structured: { ...scored, findings: [], earlier: [open] } }, 1)).toThrow(
		"keeps 1 earlier finding(s) open but reports 0",
	);
	expect(verdict({ structured: { ...scored, findings: [FINDING], earlier: [open] } }, 1).earlier).toEqual([open]);
	// Each of the last round's findings is settled exactly once, by its number.
	for (const earlier of [[fixed], [fixed, fixed], [fixed, { ...refuted, finding: 3 }]]) {
		expect(() => verdict({ structured: { ...scored, findings: [], earlier } }, 2)).toThrow("settle each");
	}
	for (const bad of [
		{ ...fixed, disposition: "deferred" },
		{ ...fixed, reason: " " },
		{ ...fixed, finding: 1.5 },
	]) {
		expect(() => verdict({ structured: { ...scored, findings: [], earlier: [bad] } }, 1)).toThrow(
			"earlier entry 1",
		);
	}
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

test("the next step stops for the design checkpoint when a reviewer's every third round reports findings", () => {
	const round = (number: number, findings: number, severity = "medium") =>
		({ round: number, findings: Array.from({ length: findings }, () => ({ severity })) }) as unknown as Round;
	expect(nextStep([round(3, 1)])).toMatch(
		/^next checkpoint: .*best long-term approach from first principles, compare it with the current one/,
	);
	expect(nextStep([round(6, 2)])).toMatch(/^next checkpoint: .*best long-term approach from first principles/);
	expect(nextStep([round(4, 1)])).toMatch(/^next respond: /);
	expect(nextStep([round(3, 0)])).toMatch(/^next done: /);
	expect(nextStep([round(3, 2, "low")])).toMatch(/^next finish: /);
	expect(nextStep([round(4, 1, "low")])).toMatch(/^next finish: /);
	// Across reviewers: any finding not low needs another round, and a clean third round is no checkpoint.
	expect(nextStep([round(1, 1, "low"), round(1, 1)])).toMatch(/^next respond: /);
	expect(nextStep([round(3, 0), round(1, 1)])).toMatch(/^next respond: /);
	expect(nextStep([round(1, 1), round(3, 1)])).toMatch(
		/^next checkpoint: .*best long-term approach from first principles/,
	);
	expect(nextStep([round(3, 0), round(1, 0)])).toMatch(/^next done: /);
});

test("the shadow is the size's pick one effort lower, and none below low", () => {
	const shadows = (wrote: ReturnType<typeof authored>) =>
		SIZES.map((size) => {
			const shadow = shadowOf(pickReviewer(size, {}, wrote));
			return shadow && `${shadow.harness} ${shadow.model} ${shadow.effort}`;
		});
	expect(shadows(authored({}, { CLAUDECODE: "1" }))).toEqual([
		"codex gpt-6.1-sol low",
		"codex gpt-6.1-sol low",
		"codex gpt-6.1-sol medium",
		"codex gpt-6.1-sol high",
		"codex gpt-6.1-sol high",
	]);
	expect(shadows(authored({}, { CODEX_THREAD_ID: "t" }))).toEqual([
		null,
		null,
		"claude claude-opus-5-5 low",
		"claude claude-opus-5-5 medium",
		"claude claude-opus-5-5 high",
	]);
	expect(shadowOf({ harness: "claude", model: "m", effort: "max" })!.effort).toBe("xhigh");
	// No step below an effort off the ladder is known, so an --effort such as Codex's minimal runs no shadow.
	expect(shadowOf({ harness: "codex", model: "m", effort: "minimal" })).toBeNull();
});

fakes("no shadow runs below low, though one settles a shadow's findings the pick left behind", async () => {
	const s = setup("CODEX_THREAD_ID");
	const opusLow = await quest("--root", s.repo, "review", "--size", "S", "--json");
	expect(opusLow.code, opusLow.stderr).toBe(0);
	expect(JSON.parse(opusLow.stdout).rounds.map((r: Round) => [r.reviewer, r.effort, r.shadow])).toEqual([
		["claude", "low", undefined],
	]);

	// Sol medium's shadow, Sol low, leaves a finding open, and a --harness run leaves it to the size's pick.
	const t = setup();
	expect((await quest("--root", t.repo, "review", "--size", "S")).code).toBe(0);
	write(t.repo, ".tmp/responses.md", "1. Fixed.\n2. Fixed.\n");
	const responses = join(t.repo, ".tmp", "responses.md");
	const alone = await quest(
		"--root",
		t.repo,
		"review",
		"--harness",
		"codex",
		"--size",
		"S",
		"--responses",
		responses,
	);
	expect(alone.code).toBe(2);
	expect(alone.stderr).toContain(
		"codex (shadow) still has findings to settle on this branch; settle them in a run of the size's pick, or of that reviewer with --harness, with --responses",
	);
	// Opus low then replaces Sol, with no step below it, so a shadow at Opus low settles the old shadow's finding.
	const sol = ["--size", "S", "--exclude-model", "gpt-6.1-sol"];
	const settled = await quest("--root", t.repo, "review", ...sol, "--responses", responses, "--json");
	expect(settled.code, settled.stderr).toBe(0);
	const rounds: Round[] = JSON.parse(settled.stdout).rounds;
	expect(rounds.map((r) => [r.reviewer, r.effort, r.shadow, r.earlier?.findings.map((f) => f.number)])).toEqual([
		["claude", "low", undefined, [1]],
		["claude", "low", true, [2]],
	]);
});

fakes("a reviewer a --harness run left with findings is named for its own run", async () => {
	const s = setup();
	vi.stubEnv("FAKE_REPLY", JSON.stringify({ score: 10, rationale: "Lands as is.", findings: [] }));
	expect((await quest("--root", s.repo, "review")).code).toBe(0);
	vi.stubEnv("FAKE_REPLY", undefined);
	const claude = ["--harness", "claude", "--model", "opus", "--effort", "low"];
	expect((await quest("--root", s.repo, "review", ...claude)).code).toBe(0);
	const held = await quest("--root", s.repo, "review");
	expect(held.code).toBe(2);
	expect(held.stderr).toContain(
		"claude still has findings to settle on this branch; settle them in a run of --harness claude, adding --model or --exclude-model when its size's model is avoided, with --responses",
	);
});

test("saved sessions are read only in the current format, or refused naming --new", () => {
	const finding = { severity: "low", file: "a.ts", line: 1, title: "t", body: "b" };
	const session = {
		reviewer: "codex",
		session: "thread-1",
		rounds: [{ head: "a", mergeBase: "m", findings: [finding] }],
		last: {},
		given: { instructions: "i", rules: null },
	};
	const tally = {
		reviewer: "codex",
		model: "m",
		effort: "e",
		rounds: 1,
		findings: { high: 0, medium: 0, low: 1 },
		fixed: 0,
		refuted: 0,
	};
	const current = { branch: "feature", sessions: [session], tallies: [tally] };
	expect(parseState(current)).toEqual(current);
	// The shadow's session and tally sit beside the pick's of the same harness.
	const shadowed = {
		branch: "feature",
		sessions: [session, { ...session, shadow: true }],
		tallies: [tally, { ...tally, shadow: true }],
	};
	expect(parseState(shadowed)).toEqual(shadowed);
	// A retired reviewer's tally is dropped so the record never names it; its session stays for the run's numbering.
	const retired = { ...session, reviewer: "opencode", session: "ses_1" };
	expect(
		parseState({
			branch: "feature",
			sessions: [session, retired],
			tallies: [tally, { ...tally, reviewer: "opencode" }],
		}),
	).toEqual({ ...current, sessions: [session, retired] });
	for (const older of [
		null,
		// One reviewer's session alone, outside a sessions list.
		{ branch: "feature", ...session },
		{ sessions: [{ ...session, rounds: [{ head: "a", findings: 1 }] }] },
		{ sessions: [{ ...session, rounds: [] }] },
		{ sessions: [{ ...session, last: undefined }] },
		{ sessions: [{ ...session, given: undefined }] },
		{ sessions: [{ ...session, session: undefined }] },
		// Saved before tallies, or with a session no tally counts.
		{ branch: "feature", sessions: [session] },
		{ branch: "feature", sessions: [session], tallies: [] },
		{ branch: "feature", sessions: [session], tallies: [{ ...tally, findings: { high: 0, low: 1 } }] },
		// A shadow session no shadow tally counts, a malformed mark, or two shadows.
		{ branch: "feature", sessions: [{ ...session, shadow: true }], tallies: [tally] },
		{ branch: "feature", sessions: [{ ...session, shadow: false }], tallies: [tally] },
		{ ...shadowed, sessions: [...shadowed.sessions, { ...session, shadow: true }] },
	])
		expect(() => parseState(older)).toThrow(/--new/);
});

fakes("a retired reviewer's open findings are dropped, keeping the numbers of the rest", async () => {
	const s = setup();
	expect((await quest("--root", s.repo, "review")).code).toBe(0);
	// An opencode session from before its removal, numbered between the pick's finding and the shadow's.
	const path = sessionFile(join(s.repo, ".git"), "feature");
	const saved = JSON.parse(readFileSync(path, "utf8"));
	const [pick, shadow] = saved.sessions;
	const opencode = { ...pick, reviewer: "opencode", session: "ses_1" };
	writeFileSync(
		path,
		JSON.stringify({
			...saved,
			sessions: [pick, opencode, shadow],
			tallies: [...saved.tallies, { ...saved.tallies[0], reviewer: "opencode" }],
		}),
	);

	write(s.repo, "src/lib.ts", "export const x = 4;\n");
	git(s.repo, "commit", "-qam", "fix");
	write(s.repo, ".tmp/responses.md", "1. Fixed at src/lib.ts:1.\n2. Refuted.\n3. Fixed at src/lib.ts:1.\n");
	vi.stubEnv("FAKE_REPLY", JSON.stringify({ score: 10, rationale: "Lands as is.", findings: [] }));
	const later = await quest("--root", s.repo, "review", "--responses", join(s.repo, ".tmp", "responses.md"));
	expect(later.code, later.stderr).toBe(0);
	// The shadow settles its finding by the number the author answered, not by #2, the dropped one's.
	expect(at(s.calls(), "medium").at(-1)!.stdin).toContain(
		"<earlier-findings>\n3. high src/lib.ts:2 Off by one\n</earlier-findings>",
	);
	expect(later.stdout).not.toContain("opencode");
	const after = JSON.parse(readFileSync(path, "utf8"));
	expect(after.sessions.map((each: { reviewer: string }) => each.reviewer)).toEqual(["codex", "codex"]);
	expect(after.tallies.map((each: { reviewer: string }) => each.reviewer)).not.toContain("opencode");
});

fakes("a session saved by an older quest is refused before the reviewer runs", async () => {
	const s = setup();
	expect((await quest("--root", s.repo, "review")).code).toBe(0);
	const path = sessionFile(join(s.repo, ".git"), "feature");
	const saved = JSON.parse(readFileSync(path, "utf8"));
	writeFileSync(path, JSON.stringify({ branch: saved.branch, ...saved.sessions[0] }));
	const calls = s.calls().length;
	const refused = await quest("--root", s.repo, "review", "--responses", path);
	expect(refused.code).not.toBe(0);
	expect(refused.stderr).toMatch(/--new/);
	expect(s.calls().length).toBe(calls);
	writeFileSync(path, "{");
	const truncated = await quest("--root", s.repo, "review");
	expect(truncated.code).toBe(2);
	expect(truncated.stderr).toContain("not JSON; pass --new");
	expect((await quest("--root", s.repo, "review", "--new")).code).toBe(0);
});

fakes("--harness reviews alone, keeping the size pick's session for its next run", async () => {
	const s = setup();
	vi.stubEnv("FAKE_REPLY", JSON.stringify({ score: 10, rationale: "Lands as is.", findings: [] }));
	expect((await quest("--root", s.repo, "review")).code).toBe(0);
	write(s.repo, "src/lib.ts", "export const x = 4;\n");
	git(s.repo, "commit", "-qam", "more");
	const claude = ["--harness", "claude", "--model", "opus", "--effort", "low"];
	const alone = await quest("--root", s.repo, "review", ...claude, "--json");
	expect(alone.code, alone.stderr).toBe(0);
	expect(JSON.parse(alone.stdout).rounds.map((r: Round) => r.reviewer)).toEqual(["claude"]);
	// The size pick's next run resumes its kept session on the new head.
	const picked = await quest("--root", s.repo, "review", "--json");
	expect(picked.code, picked.stderr).toBe(0);
	expect(JSON.parse(picked.stdout).rounds.map((r: Round) => [r.reviewer, r.round])).toEqual([["codex", 2]]);
});

fakes("a new size pick, and its shadow, settle the open findings of the reviewers they replace", async () => {
	const s = setup();
	expect((await quest("--root", s.repo, "review")).code).toBe(0);
	// Sol wrote the fix, so Opus replaces it as the size's pick.
	write(s.repo, "src/lib.ts", "export const x = 4;\n");
	git(s.repo, "commit", "-qam", "fix");
	const sol = ["--exclude-model", "gpt-6.1-sol"];
	const unanswered = await quest("--root", s.repo, "review", ...sol);
	expect(unanswered.code).toBe(2);
	expect(unanswered.stderr).toContain("the last round reported 2 finding(s)");
	write(s.repo, ".tmp/responses.md", "1. Fixed at src/lib.ts:1.\n2. Fixed at src/lib.ts:1 too.\n");
	const responses = join(s.repo, ".tmp", "responses.md");
	const round = await quest("--root", s.repo, "review", ...sol, "--responses", responses, "--json");
	expect(round.code, round.stderr).toBe(0);
	const [opus, shadow] = JSON.parse(round.stdout).rounds;
	const settled = (r: Round) => [r.reviewer, r.effort, r.shadow, r.round, r.earlier!.findings.map((f) => f.number)];
	expect(settled(opus)).toEqual(["claude", "medium", undefined, 1, [1]]);
	// Sol's shadow had a finding open, so Opus's shadow, one effort below Opus medium, settles it.
	expect(settled(shadow)).toEqual(["claude", "low", true, 1, [2]]);
	const review = at(s.calls(), "medium").find((call) => call.argv.includes("--session-id"))!;
	expect(review.stdin).toContain("Fixed at src/lib.ts:1.");
	expect(at(s.calls(), "low").find((call) => call.argv.includes("--session-id"))!.stdin).toContain(
		"2. high src/lib.ts:2 Off by one",
	);
	// Sol's findings stay Sol's, fixed, while the picks that replaced them count their own.
	expect(
		JSON.parse(round.stdout).tallies.map((t: Tally) => [t.reviewer, t.shadow, t.rounds, t.findings.high, t.fixed]),
	).toEqual([
		["claude", undefined, 1, 1, 0],
		["claude", true, 1, 1, 0],
		["codex", undefined, 1, 1, 1],
		["codex", true, 1, 1, 1],
	]);
});

test("a tally counts each finding once, by who raised it, through every round", () => {
	const finding = (severity: Finding["severity"], title: string): Finding => ({
		file: "a.ts",
		line: 1,
		severity,
		title,
		body: "b",
	});
	const settled = (f: Finding, disposition: Settled["disposition"], number: number): Settled => ({
		...f,
		number,
		disposition,
		reason: "r",
	});
	const base = {
		model: "m",
		effort: "high",
		branch: "feature",
		size: "M",
		sizeFrom: "default",
		session: "s",
		base: { ref: "origin/main", sha: "a".repeat(40) },
		head: "b".repeat(40),
		usage: [],
		score: 8,
		rationale: "r",
		earlier: null,
		unchanged: false,
	} satisfies Omit<Round, "reviewer" | "round" | "findings">;
	const [a, b, c] = [finding("high", "a"), finding("medium", "b"), finding("low", "c")];
	const first = tallied([], [{ round: { ...base, reviewer: "codex", round: 1, findings: [a, b, c] } }]);
	// A kept-open finding is reported again, and its new severity replaces its old one.
	const second = tallied(first, [
		{
			round: {
				...base,
				reviewer: "codex",
				round: 2,
				findings: [{ ...b, severity: "high" }],
				earlier: {
					head: base.head,
					findings: [settled(a, "fixed", 1), settled(b, "open", 2), settled(c, "refuted", 3)],
				},
			},
			settles: { reviewer: "codex" },
		},
	]);
	expect(second).toEqual([
		{
			reviewer: "codex",
			model: "m",
			effort: "high",
			session: "s",
			rounds: 2,
			findings: { high: 2, medium: 0, low: 1 },
			fixed: 1,
			refuted: 1,
		},
	]);
	expect(first[0]!.rounds).toBe(1);
	// A round that repeats the last one counts nothing; a replacing reviewer takes over what it keeps open.
	const third = tallied(second, [
		{ round: { ...base, reviewer: "codex", round: 2, findings: [], unchanged: true } },
		{
			round: {
				...base,
				reviewer: "claude",
				round: 1,
				findings: [{ ...b, severity: "high" }],
				earlier: { head: base.head, findings: [settled({ ...b, severity: "high" }, "open", 1)] },
			},
			settles: { reviewer: "codex" },
		},
	]);
	expect(third.map((t) => [t.reviewer, t.rounds, t.findings, t.fixed, t.refuted])).toEqual([
		["codex", 2, { high: 1, medium: 0, low: 1 }, 1, 1],
		["claude", 1, { high: 1, medium: 0, low: 0 }, 0, 0],
	]);
	expect(() =>
		tallied(
			[],
			[
				{
					round: {
						...base,
						reviewer: "claude",
						round: 1,
						findings: [],
						earlier: { head: base.head, findings: [settled(a, "fixed", 1)] },
					},
				},
			],
		),
	).toThrow(/no tally/);
});
