// Live: `quest review` with the real Codex and Claude Code CLIs runs nothing a
// reviewed head plants, and trusts nothing new. It spends the logins' usage, so
// only `just review-sandbox` runs it, never `just test` or CI.
//
// The fake-CLI tests in `test/review.test.ts` check only that quest passes the
// isolating flags; whether those flags isolate is the CLIs' behavior, which can
// change in any release (openai/codex#49333). Each CLI first runs once without
// quest's flags in the same checkout, so a plant that no longer fires fails as
// a broken control instead of passing as a clean review.
import { spawn, spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { type HarnessName, strippedEnvironment } from "../../src/cli/agent";
import { MODELS, review } from "../../src/cli/review";

/** The cheapest effort both CLIs accept; the isolation under test does not depend on it. */
const EFFORT = "low";

interface Fixture {
	/**
	 * The reviewed checkout: a clone the config homes trust, on the head. It is
	 * not a linked worktree, since Codex reads a worktree's hooks from its main
	 * checkout, which would not hold the head's.
	 */
	clone: string;
	/** Where every plant records that it ran. */
	markers: string;
}

let fixture: Fixture;
/** Holds the fixture and every config home, removed once all tests ran. */
let scratch: string;

const newHome = () => mkdtempSync(join(scratch, "home-"));

beforeAll(() => {
	scratch = realpathSync(mkdtempSync(join(tmpdir(), "quest-live-")));
	const markers = join(scratch, "markers");
	mkdirSync(markers);
	const origin = join(scratch, "origin.git");
	git(scratch, "init", "-q", "--bare", "-b", "main", origin);
	const clone = join(scratch, "clone");
	git(scratch, "init", "-q", "-b", "main", clone);
	write(clone, "src/lib.ts", "export const average = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;\n");
	git(clone, "add", ".");
	git(clone, "commit", "-qm", "base");
	git(clone, "remote", "add", "origin", origin);
	git(clone, "push", "-q", "origin", "main");

	git(clone, "checkout", "-qb", "feature");
	for (const [path, text] of Object.entries(plants(markers))) write(clone, path, text);
	write(
		clone,
		"src/lib.ts",
		"export const average = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length - 1);\n",
	);
	git(clone, "add", ".");
	git(clone, "commit", "-qm", "change");
	fixture = { clone, markers };
});

afterAll(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/**
 * The configuration a head plants, each item touching a marker named for it
 * when it runs: Codex's project MCP servers and hooks, and Claude Code's
 * project MCP servers and hooks, its settings enabling every project MCP
 * server.
 */
function plants(markers: string): Record<string, string> {
	const touch = (name: string) => `touch ${JSON.stringify(join(markers, name))}`;
	const hooks = (prefix: string) =>
		JSON.stringify({
			hooks: Object.fromEntries(
				["SessionStart", "UserPromptSubmit"].map((event) => [
					event,
					[{ hooks: [{ type: "command", command: touch(`${prefix}-${event}`) }] }],
				]),
			),
		});
	const server = (name: string) => ({ command: "/bin/sh", args: ["-c", touch(name)] });
	return {
		".codex/config.toml": [
			"[mcp_servers.plant]",
			`command = ${JSON.stringify(server("codex-config-mcp").command)}`,
			`args = ${JSON.stringify(server("codex-config-mcp").args)}`,
			"",
		].join("\n"),
		".codex/hooks.json": hooks("codex-hooks"),
		".mcp.json": JSON.stringify({ mcpServers: { plant: server("mcp-json") } }),
		".claude/settings.json": JSON.stringify({
			enableAllProjectMcpServers: true,
			...JSON.parse(hooks("claude-settings")),
		}),
	};
}

/** What each harness's own plants record when its CLI loads the head's configuration. */
const CONTROL: Record<HarnessName, string[]> = {
	codex: ["codex-config-mcp", "codex-hooks-SessionStart", "codex-hooks-UserPromptSubmit"],
	claude: ["claude-settings-SessionStart", "claude-settings-UserPromptSubmit", "mcp-json"],
};

/**
 * A config home that holds a copy of the user's login and, with `trust`, trusts
 * the clone, and for Codex the planted hooks too, which it otherwise skips
 * until a user trusts them. Each run gets a new one, so one run's writes cannot
 * hide another's.
 */
interface Home {
	harness: HarnessName;
	/** The variables pointing the CLI at it. */
	env: Record<string, string>;
	/** The directories the home trusts. */
	trusted(): string[];
	/** Hand a login the CLI refreshed during the run back to the user's home. */
	release(): void;
}

async function home(harness: HarnessName, trust = true): Promise<Home> {
	const { clone } = fixture;
	const path = newHome();
	if (harness === "codex") {
		const source = process.env.CODEX_HOME || join(homedir(), ".codex");
		const config = join(path, "config.toml");
		writeFileSync(config, trust ? `[projects.${JSON.stringify(clone)}]\ntrust_level = "trusted"\n` : "");
		if (trust) {
			const listed = await codexHooks(path, clone);
			const hooks = listed.hooks.filter((hook) => hook.source === "project");
			if (hooks.length === 0) throw new Error(`codex lists none of the planted hooks: ${listed.response}`);
			const state = hooks.map(
				(hook) =>
					`\n[hooks.state.${JSON.stringify(hook.key)}]\ntrusted_hash = ${JSON.stringify(hook.currentHash)}\n`,
			);
			appendFileSync(config, state.join(""));
		}
		return {
			harness,
			env: { CODEX_HOME: path },
			trusted: () =>
				[...readFileSync(config, "utf8").matchAll(/^\[projects\.("(?:[^"\\]|\\.)*")\]/gm)].map((m) =>
					JSON.parse(m[1]),
				),
			release: borrow(join(source, "auth.json"), join(path, "auth.json"), "CODEX_HOME"),
		};
	}
	const source = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
	const config = join(path, ".claude.json");
	writeFileSync(config, JSON.stringify({ projects: trust ? { [clone]: { hasTrustDialogAccepted: true } } : {} }));
	return {
		harness,
		env: { CLAUDE_CONFIG_DIR: path },
		trusted() {
			const projects = (
				JSON.parse(readFileSync(config, "utf8")) as {
					projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
				}
			).projects;
			return Object.entries(projects ?? {})
				.filter(([, project]) => project.hasTrustDialogAccepted === true)
				.map(([dir]) => dir);
		},
		release: borrow(join(source, ".credentials.json"), join(path, ".credentials.json"), "CLAUDE_CONFIG_DIR"),
	};
}

interface CodexHook {
	key: string;
	source: string;
	currentHash: string;
}

/** The hooks Codex finds for `cwd`, from its app server, which needs no login for this. */
function codexHooks(codexHome: string, cwd: string): Promise<{ hooks: CodexHook[]; response: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("codex", ["app-server"], {
			env: { ...strippedEnvironment(process.env), CODEX_HOME: codexHome },
			stdio: ["pipe", "pipe", "inherit"],
		});
		const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
		const lines = createInterface({ input: child.stdout });
		lines.on("line", (line) => {
			const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
			if (message.id === 1) {
				send({ method: "initialized" });
				send({ id: 2, method: "hooks/list", params: { cwds: [cwd] } });
			} else if (message.id === 2) {
				child.kill();
				const result = message.result as { data?: { hooks?: CodexHook[] }[] } | undefined;
				if (result?.data === undefined) reject(new Error(`codex hooks/list failed: ${line}`));
				else resolve({ hooks: result.data.flatMap((entry) => entry.hooks ?? []), response: line });
			}
		});
		child.once("error", reject);
		child.once("exit", (code) => reject(new Error(`codex app-server exited with ${code} before listing hooks`)));
		send({ id: 1, method: "initialize", params: { clientInfo: { name: "quest-live-test", version: "0" } } });
	});
}

/**
 * Copy the login file at `source` to `copy`, returning what writes a refreshed
 * login back. A refresh may rotate the refresh token, which would sign the
 * user's own home out; the write-back is skipped if that home has itself
 * changed since. It replaces the file by rename, so an interrupted write
 * never leaves the user's login truncated.
 */
function borrow(source: string, copy: string, variable: string): () => void {
	if (!existsSync(source)) {
		throw new Error(`no login file at ${source}; log in, or set ${variable} to a config home that holds one`);
	}
	const original = readFileSync(source);
	writeFileSync(copy, original, { mode: 0o600 });
	return () => {
		if (!existsSync(copy)) return;
		const now = readFileSync(copy);
		if (now.equals(original)) return;
		if (!readFileSync(source).equals(original)) {
			console.warn(
				`${source} and its copy were both refreshed; log in again if the CLI reports an expired token`,
			);
			return;
		}
		const staged = `${source}.quest-live-${process.pid}`;
		writeFileSync(staged, now, { mode: 0o600 });
		renameSync(staged, source);
	};
}

/** The environment `quest review` gives a reviewer, pointed at `home`. */
function environment(home: Home): NodeJS.ProcessEnv {
	return { ...strippedEnvironment(process.env), ...home.env };
}

function recorded(): string[] {
	return readdirSync(fixture.markers).sort();
}

function clearMarkers() {
	rmSync(fixture.markers, { recursive: true });
	mkdirSync(fixture.markers);
}

/**
 * One plain turn with the CLI's defaults, which load the user's config and the
 * checkout's. It blocks, so it carries its own bound for a hung CLI.
 */
function control(home: Home) {
	const { model } = MODELS[home.harness];
	const argv =
		home.harness === "codex"
			? ["exec", "--json", "-m", model, "-c", `model_reasoning_effort="${EFFORT}"`, "-"]
			: ["-p", "--output-format", "json", "--model", model, "--effort", EFFORT];
	return spawnSync(home.harness, argv, {
		cwd: fixture.clone,
		env: environment(home),
		input: "Reply with the single word OK.",
		encoding: "utf8",
		timeout: 10 * 60_000,
	});
}

const tail = (text: string | null) => (text ?? "").trim().split("\n").slice(-10).join("\n");

describe.each(["codex", "claude"] as const)("%s", (harness) => {
	test("loads the planted configuration without quest's flags", async () => {
		clearMarkers();
		const dir = await home(harness);
		let run: ReturnType<typeof control>;
		try {
			run = control(dir);
		} finally {
			dir.release();
		}
		const output = `exit ${run.status}\nstdout:\n${tail(run.stdout)}\nstderr:\n${tail(run.stderr)}`;
		expect(recorded(), `a plant did not fire, so the review check would pass vacuously\n${output}`).toEqual(
			expect.arrayContaining(CONTROL[harness]),
		);
	});

	test("quest review runs none of it and trusts nothing new", async () => {
		const dir = await home(harness);
		const trusted = dir.trusted();
		await reviewIn(dir, () => {
			expect(recorded(), "planted configuration ran during the review").toEqual([]);
			expect(dir.trusted(), "the review trusted a new directory").toEqual(trusted);
		});
	});

	// A home that already trusts the clone would not show the review trusting it.
	test("quest review of an untrusted checkout trusts nothing", async () => {
		const dir = await home(harness, false);
		await reviewIn(dir, () => {
			expect(recorded(), "planted configuration ran during the review").toEqual([]);
			expect(dir.trusted(), "the review trusted a directory").toEqual([]);
		});
	});
});

/** How long a review may run before its reviewer CLI is terminated, within the test timeout. */
const REVIEW_BOUND = 20 * 60_000;

/**
 * Review the clone with `dir`, then run `verify` before rethrowing the
 * review's error, so a failed review still checks what ran. A review that runs
 * past `REVIEW_BOUND` has the reviewer CLI it spawned terminated and awaited,
 * so a hung CLI never outlives its test or its config home.
 */
async function reviewIn(dir: Home, verify: () => void) {
	clearMarkers();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		spawnSync("pkill", ["-TERM", "-P", String(process.pid)]);
	}, REVIEW_BOUND);
	let outcome: unknown;
	try {
		outcome = await review(
			{ root: fixture.clone, base: "origin/main", harness: dir.harness, effort: EFFORT, fresh: true },
			{ env: environment(dir) },
		).catch((error: unknown) => error);
	} finally {
		clearTimeout(timer);
		dir.release();
	}
	verify();
	if (timedOut)
		throw new Error(`the review ran past ${REVIEW_BOUND / 60_000} minutes, so its reviewer was terminated`);
	if (outcome instanceof Error) throw outcome;
}

function git(cwd: string, ...args: string[]) {
	const run = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", ...args], {
		cwd,
		encoding: "utf8",
	});
	if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr}`);
}

function write(dir: string, path: string, text: string) {
	mkdirSync(join(dir, path, ".."), { recursive: true });
	writeFileSync(join(dir, path), text);
}
