// The fixer keeps its agent's output and real exit code, and hands back with their bounded tail.
import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixer, collectFixers } from "../src/cli/land-fixer";
import type { GitHubDependencies } from "../src/cli/github";
import type { Plan } from "../src/cli/land";

// Linux only, like the land daemon: the fixture uses mkfifo and POSIX shells.
test.skipIf(process.platform === "win32")(
	"retains agent output and actual exit code, with a bounded escaped handback tail",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "quest-fixer-diagnostics-"));
		const root = join(dir, "repo"),
			state = join(dir, "state"),
			checkout = join(dir, "fix-test");
		for (const path of [root, state, checkout]) mkdirSync(path);
		const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
		git("init", "-q");
		git("-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "--allow-empty", "-qm", "fixture");
		const sha = git("rev-parse", "HEAD");
		const plan: Plan = {
			repository: "moq-dev/fixture",
			base: { ref: "main", sha },
			eject: [],
			queue: [
				{
					id: "PR_test",
					number: 1,
					url: "https://github.com/moq-dev/fixture/pull/1",
					title: "fixture",
					enabledAt: "2026-01-01T00:00:00Z",
					head: sha,
					approved: sha,
					repository: "moq-dev/fixture",
					branch: "test",
					maintainerCanModify: true,
				},
			],
		};
		let comment = "";
		const deps: GitHubDependencies = {
			token: "fake",
			now: Date.now,
			sleep: async () => {},
			warn: () => {},
			fetch: (async (input, init) => {
				const path = new URL(String(input)).pathname;
				if (path === "/graphql") {
					const query = JSON.parse(String(init?.body)).query;
					return Response.json({
						data: query.includes("viewer")
							? { viewer: { login: "moq-bot" } }
							: { node: { autoMergeRequest: null } },
					});
				}
				if (path.endsWith("/pulls/1")) return Response.json({ state: "open", head: { sha } });
				if (path.endsWith("/comments")) {
					if (init?.method === "POST") {
						comment = JSON.parse(String(init.body)).body;
						return Response.json({});
					}
					return Response.json([]);
				}
				throw new Error(`unexpected request: ${path}`);
			}) as typeof fetch,
		};
		const log = join(dir, "failure.log"),
			agent = join(dir, "agent"),
			wrapper = join(dir, "wrapper");
		const ready = join(dir, "ready"),
			release = join(dir, "release");
		execFileSync("mkfifo", [release]);
		writeFileSync(log, "fixture failure\n");
		writeFileSync(
			agent,
			`#!/bin/sh\ncat >/dev/null\ni=0; while [ $i -lt 150 ]; do printf 'prefix-%s\\n' $i; i=$((i+1)); done\nprintf '<panic>& diagnostic stdout\\n'\nprintf 'diagnostic stderr\\n' >&2\ntouch '${ready}'\nread -r release < '${release}'\nexit 101\n`,
		);
		writeFileSync(
			wrapper,
			`#!/bin/sh\nexec bun --config='${join(import.meta.dirname, "..", "bunfig.toml")}' '${join(import.meta.dirname, "..", "src", "cli", "bin.ts")}' land fix --agent '${agent}' --agent-arg=- "$@"\n`,
		);
		chmodSync(agent, 0o755);
		chmodSync(wrapper, 0o755);
		try {
			await startFixer(
				root,
				checkout,
				{ plan, tip: sha, log, numbers: [1], ejections: [] },
				wrapper,
				state,
				deps,
			);
			const path = join(
				state,
				readdirSync(state).find((name) => /^fix-job-.*\.json$/.test(name))!,
			);
			const deadline = Date.now() + 5000;
			while (!existsSync(ready) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
			expect(existsSync(ready)).toBe(true);
			expect(JSON.parse(readFileSync(path, "utf8")).identity).toMatch(/^[0-9a-f-]+:\d+$/);
			expect(await collectFixers(root, state, deps, async () => "fake")).toEqual([]);
			writeFileSync(release, "continue\n");
			while (!existsSync(`${path}.exit`) && Date.now() < deadline)
				await new Promise((done) => setTimeout(done, 10));
			expect(readFileSync(`${path}.exit`, "utf8")).toBe("101");
			const output = readFileSync(`${path}.log`, "utf8");
			expect(output).toContain("prefix-0\n");
			expect(output).toContain("diagnostic stdout");
			expect(output).toContain("diagnostic stderr");
			expect(await collectFixers(root, state, deps, async () => "fake")).toEqual(["handback 1"]);
			expect(comment).toContain("fixer crashed (exit 101)");
			expect(comment).toContain("&lt;panic>&amp; diagnostic stdout");
			expect(comment).toContain("diagnostic stderr");
			expect(comment).not.toContain("prefix-0\n");
			expect(comment.length).toBeLessThan(65000);
			expect(existsSync(path)).toBe(false);
			expect(existsSync(`${path}.log`)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
