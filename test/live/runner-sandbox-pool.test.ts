// The runner's pool limits, with the pinned CLIProxyAPI, Claude Code, and
// Codex: an upstream that refuses every request with a 429 cools the pool
// down, and what each CLI then prints must read as the pool's limit, and the
// proxy must name its reset, or the runner would miss the limit or sit the pool
// out for the fallback hour.
//
// `test/runner.test.ts` checks the runner against the messages these releases
// print; whether they still print them is the CLIs' and the proxy's behavior,
// which can change in any release. The stub upstream needs no login and spends
// no usage, so `just runner-sandbox` runs it beside the sandbox's boundary
// tests, and CI does nightly and on pin bumps.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { LIMIT } from "../../src/cli/limit";
import { RETRIED_429 } from "../../src/cli/review";
import { streamReader } from "../../src/runner/claude";
import { binaryPath } from "../../src/runner/cli";
import { RunnerHome } from "../../src/runner/home";
import { type RunningProxy, reset, startProxy } from "../../src/runner/proxy";

const linux = process.platform === "linux";

let scratch: string;
let upstream: Server;
let refused = 0;
let home: RunnerHome;
let proxy: RunningProxy;
/** The proxy's models, by provider. */
let models: { claude: string; codex: string };

/** Run `argv` to its end, with `env` and nothing else, bounded so a hung CLI fails the test. */
function run(argv: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(argv[0]!, argv.slice(1), { cwd: scratch, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
		const timer = setTimeout(() => child.kill("SIGKILL"), 8 * 60_000);
		child.once("error", reject);
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? 1, stdout, stderr });
		});
	});
}

describe.skipIf(!linux)("the runner's pool", () => {
	beforeAll(async () => {
		scratch = mkdtempSync(join(tmpdir(), "quest-pool-"));
		// A provider that refuses every request, as one does once a subscription's limit is spent.
		upstream = createServer((req, res) => {
			req.resume();
			req.on("end", () => {
				refused++;
				res.writeHead(429, { "content-type": "application/json", "retry-after": "3600" }).end(
					JSON.stringify({
						type: "error",
						error: {
							type: "rate_limit_error",
							message: "This request would exceed your account's rate limit.",
						},
					}),
				);
			});
		});
		await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
		const stub = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
		home = new RunnerHome(join(scratch, "runner"));
		proxy = await startProxy(binaryPath("cliproxy", process.env), home, process.env);
		// One key for each vendor at the stub, as a pooled credential, through the config the proxy reloads.
		// Its watcher starts after it listens, so the test writes until the proxy serves them.
		const path = join(home.proxyDir(), "config.yaml");
		const config = JSON.parse(readFileSync(path, "utf8"));
		const key = (base: string) => [{ name: "stub", "base-url": base, keys: [{ "api-key": "sk-stub" }] }];
		config["api-keys"] = { claude: key(stub), codex: key(`${stub}/v1`) };
		models = await vi.waitFor(
			async () => {
				writeFileSync(path, JSON.stringify(config));
				const listed = (await (
					await fetch(`${proxy.origin}/v1/models`, { headers: { Authorization: `Bearer ${proxy.key}` } })
				).json()) as { data: { id: string; owned_by?: string }[] };
				const claude = listed.data.find((model) => model.owned_by === "anthropic")?.id;
				const codex = listed.data.find((model) => /^gpt-\d/.test(model.id) && !/image/.test(model.id))?.id;
				if (!claude || !codex)
					throw new Error(
						`the proxy serves ${listed.data.map((model) => model.id).join(", ") || "nothing"} yet`,
					);
				return { claude, codex };
			},
			{ timeout: 30_000, interval: 1000 },
		);
	});

	afterAll(async () => {
		await proxy?.stop();
		if (upstream) await new Promise((resolve) => upstream.close(resolve));
		if (scratch) rmSync(scratch, { recursive: true, force: true });
	});

	test(
		"Claude Code's failure reads as the pool's limit, whose reset the proxy names",
		{ timeout: 10 * 60_000 },
		async () => {
			const pool = home.poolHome("claude");
			// As a job's Claude Code reaches the proxy: its origin, and its key only through apiKeyHelper.
			const settings = join(scratch, "settings.json");
			writeFileSync(settings, JSON.stringify({ apiKeyHelper: `cat '${proxy.keyFile}'` }));
			const before = refused;
			const { code, stdout, stderr } = await run(
				[
					binaryPath("claude", process.env),
					"-p",
					"--output-format",
					"stream-json",
					"--verbose",
					"--model",
					models.claude,
					"--settings",
					settings,
					"--setting-sources",
					"user",
					"Say hi.",
				],
				{ PATH: process.env.PATH, HOME: scratch, CLAUDE_CONFIG_DIR: pool, ANTHROPIC_BASE_URL: proxy.origin },
			);
			// The proxy took the key and asked the provider, which refused.
			expect(refused).toBeGreaterThan(before);
			const reader = streamReader();
			for (const line of stdout.split("\n")) reader.line(line);
			const exit = reader.exit(code, stderr);
			expect(exit.limited, `Claude Code ended: ${exit.reply}`).not.toBeNull();
			const now = Date.now();
			expect(await reset(proxy, "claude", models.claude, now)).toBeGreaterThan(now);
		},
	);

	test(
		"Codex's failure through the proxy reads as the pool's limit, whose reset the proxy names",
		{ timeout: 10 * 60_000 },
		async () => {
			const codex = process.env.QUEST_RUNNER_CODEX;
			if (!codex) throw new Error("QUEST_RUNNER_CODEX names no Codex; run this in the dev shell");
			const before = refused;
			const { stdout, stderr } = await run(
				[
					codex,
					"exec",
					"--json",
					"--skip-git-repo-check",
					"--ignore-user-config",
					"-c",
					`openai_base_url=${JSON.stringify(`${proxy.origin}/v1`)}`,
					"-m",
					models.codex,
					"Say hi.",
				],
				{ PATH: process.env.PATH, HOME: scratch, CODEX_HOME: home.poolHome("codex"), CODEX_API_KEY: proxy.key },
			);
			expect(refused).toBeGreaterThan(before);
			// What `quest review` counts as a gateway's usage limit.
			const failure = `${stdout}\n${stderr}`;
			expect(LIMIT.test(failure) || RETRIED_429.test(failure), failure.slice(-2000)).toBe(true);
			const now = Date.now();
			expect(await reset(proxy, "codex", models.codex, now)).toBeGreaterThan(now);
		},
	);
});
