// Supervised runs against the host's real systemd user manager. On Linux these need 5.14+, systemd 254+
// and unified cgroup v2; a host without them fails here rather than skipping.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scope } from "../src/cli/gate";
import { Worktrees } from "../src/cli/worktree";
import { created, onTerminal, signalled, tempDir } from "./fixture";

const root = resolve(import.meta.dirname, "..");

async function fixture() {
	const dir = tempDir();
	const repo = join(dir, "repo");
	mkdirSync(repo);
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
	git("init", "-b", "main");
	git("config", "user.name", "Fixture");
	git("config", "user.email", "fixture@localhost");
	writeFileSync(join(repo, ".gitignore"), "cache/\n.worktrees/\n");
	git("add", ".");
	git("commit", "-m", "initial");
	const home = join(dir, "state");
	const worktrees = new Worktrees(home);
	worktrees.configure(100_000_000);
	const record = await worktrees.create(repo, "work", 10_000_000, "HEAD", ["cache"]);
	mkdirSync(join(record.path, "cache"));
	return { dir, home, worktrees, record };
}

/** The CLI supervising `script` in the checkout, with `env` added to its own and its streams piped here. */
function supervise(home: string, script: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
	const child = spawn(
		"bun",
		[
			`--config=${join(root, "bunfig.toml")}`,
			join(root, "src/cli/bin.ts"),
			"worktree",
			"run",
			"work",
			"--",
			"/bin/sh",
			"-c",
			script,
			"sh",
			...args,
		],
		{ env: { ...process.env, ...env, QUEST_WORKTREE_HOME: home }, stdio: ["ignore", "pipe", "pipe"] },
	);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	const ready = new Promise<void>((resolve, reject) => {
		child.stdout.on("data", (data: string) => {
			stdout += data;
			if (stdout.includes("ready\n")) resolve();
		});
		child.once("exit", () => reject(new Error(`exited before ready: ${stdout} ${stderr}`)));
	});
	ready.catch(() => {}); // Awaited only by cases that wait for readiness.
	child.stderr.on("data", (data: string) => (stderr += data));
	const exited = once(child, "exit").then(([code, signal]) => ({ code, signal, stdout, stderr }));
	return { child, ready, exited };
}

/** Gone, or a zombie its new parent has not reaped yet: either way it runs no code. */
function stopped(pid: number): boolean {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
	} catch {
		return true;
	}
}

describe.runIf(process.platform === "linux")("supervised runs under systemd", () => {
	it("forwards arguments and status, stops orphaned descendants, then releases", async () => {
		const { dir, home, worktrees, record } = await fixture();
		const pidFile = join(dir, "orphan");
		const run = supervise(
			home,
			`sleep 1000 & echo $! > ${JSON.stringify(pidFile)}; printf '%s|' "$@"; pwd; echo ready; exit 7`,
			["a $b", "--flag"],
		);
		const result = await run.exited;
		expect(result.code, result.stderr).toBe(7);
		expect(result.stdout).toBe(`a $b|--flag|${record.path}\nready\n`);
		expect(stopped(Number(readFileSync(pidFile, "utf8")))).toBe(true);
		expect(existsSync(join(record.path, "cache"))).toBe(false);
		expect(worktrees.status().records[0]).toMatchObject({ phase: "released", runs: [] });
	});

	it("runs the command in the checkout's repository when started from a Git hook, keeping -c config", async () => {
		const { dir, home, record } = await fixture();
		const store = join(dir, "repo", ".git");
		// What a hook in the main checkout exports, run by `git -c quest.probe=kept commit`.
		const hook = {
			GIT_DIR: store,
			GIT_WORK_TREE: join(dir, "repo"),
			GIT_INDEX_FILE: join(store, "index"),
			GIT_CONFIG_PARAMETERS: "'quest.probe'='kept'",
		};
		const run = supervise(home, "git rev-parse --show-toplevel; git config quest.probe", [], hook);
		const result = await run.exited;
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toBe(`${record.path}\nkept\n`);
	});

	it("forwards cancellation, stops live descendants, then releases", async () => {
		const { dir, home, worktrees, record } = await fixture();
		const pidFile = join(dir, "descendant");
		const run = supervise(home, `sleep 1000 & echo $! > ${JSON.stringify(pidFile)}; echo ready; wait`);
		await run.ready;
		expect(worktrees.status().records[0].runs).toHaveLength(1);
		run.child.kill("SIGTERM");
		const result = await run.exited;
		expect(result.code, result.stderr).toBe(143);
		expect(stopped(Number(readFileSync(pidFile, "utf8")))).toBe(true);
		expect(existsSync(join(record.path, "cache"))).toBe(false);
		expect(worktrees.status().records[0]).toMatchObject({ phase: "released", runs: [] });
	});

	it("keeps a crashed supervisor's scratch until its scope is empty", async () => {
		const { home, worktrees, record } = await fixture();
		const run = supervise(home, "echo ready; exec sleep 1000");
		await run.ready;
		run.child.kill("SIGKILL");
		await run.exited;
		// The command outlives its supervisor, so reconciliation keeps the run and its scratch.
		const [orphan] = worktrees.status().records[0].runs;
		expect(orphan).toBeDefined();
		expect(() => worktrees.release(record.id)).toThrow("supervised runs are live");
		expect(existsSync(join(record.path, "cache"))).toBe(true);
		// Stopping kills what the scope holds and waits until it is empty, which releases the checkout.
		expect(await worktrees.stop(record.id)).toMatchObject({ phase: "released", runs: [] });
		expect(
			spawnSync("systemctl", ["--user", "is-active", orphan.unit], { encoding: "utf8" }).stdout.trim(),
		).not.toBe("active");
		expect(existsSync(join(record.path, "cache"))).toBe(false);
	});

	it("lets a terminal Ctrl-C reach the command once", async () => {
		const { dir, home } = await fixture();
		const child = join(dir, "child.js");
		writeFileSync(
			child,
			`let interrupts = 0;
			process.on("SIGINT", () => interrupts++);
			console.log("ready");
			setTimeout(() => console.log("interrupts=" + interrupts), 1000);`,
		);
		const command = ["bun", `--config=${join(root, "bunfig.toml")}`, join(root, "src/cli/bin.ts")];
		const result = await onTerminal([...command, "worktree", "run", "work", "--", "bun", child], "\x03", {
			...process.env,
			QUEST_WORKTREE_HOME: home,
		});
		expect(result.output).toContain("interrupts=1");
		expect(result.code).toBe(130);
	});

	/**
	 * Runs `quest worktree run work -- <leaf>` through Just inside a gate's scope. The run itself stays
	 * in the gate's scope, which signals it, and so does Just, which forwards SIGTERM to the run on
	 * top; the run's command moves to a scope of its own, which only the run can signal.
	 */
	function gated(dir: string, home: string, leaf: string) {
		const justfile = join(dir, "justfile");
		const run = [process.execPath, `--config=${join(root, "bunfig.toml")}`, join(root, "src/cli/bin.ts")];
		const recipe = [...run, "worktree", "run", "work", "--", process.execPath, leaf];
		writeFileSync(justfile, `run:\n    ${recipe.map((word) => JSON.stringify(word)).join(" ")}\n`);
		const stop = new AbortController();
		const kill = new AbortController();
		const result = scope(`quest-gate-${randomUUID()}.scope`)(
			["just", "--justfile", justfile, "--working-directory", dir, "run"],
			{ ...process.env, QUEST_WORKTREE_HOME: home, QUEST_GATE_ADMITTED: "1" },
			{ signal: stop.signal, kill: kill.signal },
		);
		return { stop, kill, result };
	}

	it("still forwards a signal to its own scope from inside a gate's, once", async () => {
		const { dir, home } = await fixture();
		const leaf = signalled(dir, ["SIGTERM"], 200);
		const { stop, result } = gated(dir, home, leaf.script);
		await created(leaf.ready);
		stop.abort("SIGTERM");
		expect(await result).toBe(143);
		expect(leaf.log()).toEqual(["SIGTERM"]);
		// Just's copy of the signal did not kill the run's scope before the leaf's cleanup finished.
		expect(existsSync(leaf.done)).toBe(true);
	});

	it("is killed with the gate's scope it runs in", async () => {
		const { dir, home, worktrees, record } = await fixture();
		const leaf = signalled(dir, ["SIGTERM"]);
		const { stop, kill, result } = gated(dir, home, leaf.script);
		await created(leaf.ready);
		stop.abort("SIGTERM");
		await created(leaf.received);
		kill.abort();
		expect(await result).toBe(143);
		// The gate killed the supervisor with everything else in its scope, and systemd the run's own.
		for (let tries = 0; !stopped(leaf.pid()); tries++) {
			if (tries === 200) throw new Error("the run's scope outlived the gate's");
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(await worktrees.stop(record.id)).toMatchObject({ phase: "released", runs: [] });
	});
});
