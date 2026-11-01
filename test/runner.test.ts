import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test, vi } from "vitest";

import type { AdapterName } from "../src/runner/adapter";
import { Claude, jobEnvironment, streamReader, TOOL_TIMEOUT_MS } from "../src/runner/claude";
import { addAccount, devShell, login, RunnerInputError, runnerAdapters } from "../src/runner/cli";
import { Connection, type Socket, backoff } from "../src/runner/connection";
import { type Account, RunnerHome } from "../src/runner/home";
import { serveTools } from "../src/runner/mcp";
import {
	accountDirectories,
	credentials,
	environment,
	Opencode,
	PLUGIN,
	retryLimit,
	signedIn,
	turnExit,
} from "../src/runner/opencode";
import { FLUSH_BYTES, OutputUploader, split } from "../src/runner/output";
import { formatAnswer, resumePrompt, startPrompt, systemPrompt } from "../src/runner/prompt";
import type { Job } from "../src/runner/protocol";
import { Runner } from "../src/runner/runner";
import { REGISTRIES, type Sandbox, closeSandbox, openSandbox } from "../src/runner/sandbox";
import { Changes, fingerprint, WAIT_LIMIT, waitForChange } from "../src/runner/wait";
import { Workspace } from "../src/runner/workspace";
import { tempDir } from "./fixture";

const posix = test.skipIf(process.platform === "win32");

function git(dir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.test",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.test",
		},
	}).trim();
}

/** An upstream repository with one commit, as a job's revision. */
function upstream(): { dir: string; commit: string } {
	const dir = join(tempDir(), "upstream");
	mkdirSync(dir);
	git(dir, "init", "-q", "-b", "main");
	writeFileSync(join(dir, "AGENTS.md"), "Always run the tests.\n");
	writeFileSync(join(dir, "flake.nix"), "{}\n");
	writeFileSync(join(dir, "old.txt"), "old\n");
	writeFileSync(join(dir, ".gitignore"), "ignored/\n");
	git(dir, "add", ".");
	git(dir, "commit", "-q", "-m", "init");
	return { dir, commit: git(dir, "rev-parse", "HEAD") };
}

function job(revision: string, extra: Partial<Job> = {}): Job {
	return {
		id: "job1",
		attempt: 1,
		workflow: "start",
		target: "quest/m0/thing.md",
		revision,
		branch: "quest/m0/thing",
		trusted: 1,
		account: "acct1",
		session: null,
		head: null,
		pull: null,
		owner: "owner",
		name: "repo",
		events: [],
		questions: [],
		...extra,
	};
}

describe("raw output", () => {
	test("splits on character boundaries within the chunk limit", () => {
		const text = `${"a".repeat(5)}é${"b".repeat(3)}`;
		const pieces = split(text, 6);
		expect(pieces.join("")).toBe(text);
		for (const piece of pieces) expect(Buffer.byteLength(piece)).toBeLessThanOrEqual(6);
		expect(pieces[0]).toBe("aaaaa");
	});

	test("numbers chunks contiguously and stops at the cap", async () => {
		const sent: [number, string][] = [];
		const uploader = new OutputUploader(
			async (seq, text) => {
				sent.push([seq, text]);
				return { truncated: seq === 1 };
			},
			() => {},
			4,
			60_000,
		);
		uploader.write("abcd");
		uploader.write("efgh");
		uploader.write("ijkl");
		await uploader.close();
		expect(sent).toEqual([
			[0, "abcd"],
			[1, "efgh"],
		]);
	});

	test("waits to batch small output", async () => {
		const sent: string[] = [];
		const uploader = new OutputUploader(
			async (_, text) => (sent.push(text), {}),
			() => {},
			1024,
			10,
		);
		uploader.write("a");
		uploader.write("b");
		expect(sent).toEqual([]);
		await new Promise((resolve) => setTimeout(resolve, 30));
		await uploader.close();
		expect(sent).toEqual(["ab"]);
	});
});

class FakeSocket implements Socket {
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	closed = false;
	constructor(readonly hub: FakeHub) {}
	send(data: string) {
		if (!this.closed) this.hub.receive(this, JSON.parse(data));
	}
	close(code = 1000, reason = "") {
		if (this.closed) return;
		this.closed = true;
		setTimeout(() => this.onclose?.({ code, reason }), 0);
	}
	deliver(message: unknown) {
		if (!this.closed) this.onmessage?.({ data: JSON.stringify(message) });
	}
}

type Sent = Record<string, any>;

/** The hub's side of the protocol, replying as the Worker would by default. */
class FakeHub {
	sockets: FakeSocket[] = [];
	messages: Sent[] = [];
	/** The action a status reply gives each attempt, by `job.attempt`. */
	actions = new Map<string, string>();
	/** Messages to hold without replying, to simulate a lost reply. */
	hold: ((message: Sent) => boolean) | null = null;
	#waiters: { match: (m: Sent) => boolean; resolve: (m: Sent) => void }[] = [];

	dial = () => {
		const socket = new FakeSocket(this);
		this.sockets.push(socket);
		setTimeout(() => socket.onopen?.(), 0);
		return socket;
	};

	get socket() {
		return this.sockets.at(-1)!;
	}

	receive(socket: FakeSocket, message: Sent) {
		this.messages.push(message);
		for (const waiter of [...this.#waiters])
			if (waiter.match(message)) {
				this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
				waiter.resolve(message);
			}
		if (this.hold?.(message)) return;
		const reply =
			message.type === "status"
				? {
						attempts: message.attempts.map((a: Sent) => ({
							...a,
							action: this.actions.get(`${a.job}.${a.attempt}`) ?? "continue",
						})),
					}
				: message.type === "question"
					? { question: "q1", cancel: false }
					: message.type === "checkpoint"
						? { cancel: false }
						: {};
		setTimeout(() => socket.deliver({ type: "reply", id: message.id, ...reply }), 0);
	}

	/** The first message so far, or the next, that matches. */
	next(match: (m: Sent) => boolean): Promise<Sent> {
		const found = this.messages.find(match);
		if (found) return Promise.resolve(found);
		return new Promise((resolve) => this.#waiters.push({ match, resolve }));
	}

	of(type: string): Sent[] {
		return this.messages.filter((m) => m.type === type);
	}
}

describe("connection", () => {
	test("backs off from one second to a minute", () => {
		expect(backoff(0, () => 0.5)).toBe(1000);
		expect(backoff(3, () => 0.5)).toBe(8000);
		expect(backoff(20, () => 0.5)).toBe(60_000);
	});

	test("resends unanswered requests after reconnecting, after a fresh status", async () => {
		const hub = new FakeHub();
		const logs: string[] = [];
		let opens = 0;
		const connection: Connection = new Connection(
			"ws://kix.test",
			"token",
			{
				open: () => {
					opens++;
					void connection.request({ type: "status", accounts: [], attempts: [], slots: 1 });
				},
				push: () => {},
				replaced: () => {},
				log: (line) => logs.push(line),
			},
			hub.dial,
		);
		connection.start();
		await hub.next((m) => m.type === "status");
		hub.hold = (m) => m.type === "checkpoint";
		const reply = connection.request({ type: "checkpoint", job: "j", attempt: 1, summary: "s", session: null });
		await hub.next((m) => m.type === "checkpoint");
		hub.hold = null;
		hub.socket.close(1006, "lost");
		await expect(reply).resolves.toMatchObject({ cancel: false });
		expect(opens).toBe(2);
		const types = hub.messages.map((m) => m.type);
		expect(types).toEqual(["status", "checkpoint", "status", "checkpoint"]);
		// The retry is identical, id included, so the hub accepts it as one.
		const [first, second] = hub.of("checkpoint");
		expect(second).toEqual(first);
		connection.close();
	});

	test("reports a replaced connection instead of reconnecting", async () => {
		const hub = new FakeHub();
		let replaced = false;
		const connection = new Connection(
			"ws://kix.test",
			"token",
			{ open: () => {}, push: () => {}, replaced: () => (replaced = true), log: () => {} },
			hub.dial,
		);
		connection.start();
		await new Promise((resolve) => setTimeout(resolve, 5));
		hub.socket.close(4000, "Replaced by a new connection");
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(replaced).toBe(true);
		expect(hub.sockets).toHaveLength(1);
	});
});

describe("workspace", () => {
	posix("publishes only what changed since the branch's head, by mode", async () => {
		const { dir, commit } = upstream();
		const root = tempDir();
		const workspace = await Workspace.prepare(root, job(commit), dir);
		expect(readFileSync(join(workspace.dir, "AGENTS.md"), "utf8")).toBe("Always run the tests.\n");
		writeFileSync(join(workspace.dir, "new.sh"), "#!/bin/sh\n");
		chmodSync(join(workspace.dir, "new.sh"), 0o755);
		symlinkSync("new.sh", join(workspace.dir, "link"));
		mkdirSync(join(workspace.dir, "ignored"));
		writeFileSync(join(workspace.dir, "ignored", "build.o"), "x");
		execFileSync("rm", [join(workspace.dir, "old.txt")]);
		const snapshot = await workspace.snapshot();
		expect(snapshot.changes).toEqual([
			{ path: "link", content: Buffer.from("new.sh").toString("base64"), symlink: true },
			{ path: "new.sh", content: Buffer.from("#!/bin/sh\n").toString("base64"), executable: true },
			{ path: "old.txt", content: null },
		]);
		await workspace.published("e".repeat(40), snapshot);
		expect(workspace.head).toBe("e".repeat(40));
		expect((await workspace.snapshot()).changes).toEqual([]);
		// The agent's own commits and index do not change what is published.
		writeFileSync(join(workspace.dir, "next.txt"), "next\n");
		git(workspace.dir, "add", "next.txt");
		git(workspace.dir, "commit", "-q", "-m", "local");
		expect((await workspace.snapshot()).changes.map((c) => c.path)).toEqual(["next.txt"]);

		// The next attempt reuses the checkout while the branch is where it left it.
		const again = await Workspace.prepare(root, job(commit, { attempt: 2, head: "e".repeat(40) }), dir);
		expect(existsSync(join(again.dir, "next.txt"))).toBe(true);
		await again.remove();
		expect(existsSync(again.dir)).toBe(false);
	});

	posix("publishes a merge of the base branch as a merge commit, relative to the merged files", async () => {
		const { dir, commit } = upstream();
		git(dir, "checkout", "-q", "-b", "feature");
		writeFileSync(join(dir, "feature.txt"), "feature\n");
		git(dir, "add", ".");
		git(dir, "commit", "-q", "-m", "feature");
		const head = git(dir, "rev-parse", "HEAD");
		git(dir, "checkout", "-q", "main");
		writeFileSync(join(dir, "main.txt"), "main\n");
		git(dir, "add", ".");
		git(dir, "commit", "-q", "-m", "main moved");
		const main = git(dir, "rev-parse", "HEAD");
		const workspace = await Workspace.prepare(
			tempDir(),
			job(commit, { workflow: "merge", target: "pulls/2", branch: "feature", head }),
			dir,
		);
		expect((await workspace.snapshot()).merge).toBeNull();
		git(workspace.dir, "fetch", "-q", "origin", "main");
		git(workspace.dir, "merge", "-q", "--no-edit", "FETCH_HEAD");
		writeFileSync(join(workspace.dir, "fix.txt"), "fix\n");
		const snapshot = await workspace.snapshot();
		expect(snapshot.merge).toBe(main);
		// Only what differs from the merged commit is sent: the branch's own files and the fix.
		expect(snapshot.changes.map((c) => c.path)).toEqual(["feature.txt", "fix.txt"]);
		await workspace.published("e".repeat(40), snapshot);
		// Once published, the merge is history; later changes build on it.
		writeFileSync(join(workspace.dir, "later.txt"), "later\n");
		const later = await workspace.snapshot();
		expect(later.merge).toBeNull();
		expect(later.changes.map((c) => c.path)).toEqual(["later.txt"]);
	});

	posix("lists the submodules a merge changes, which its changes cannot carry", async () => {
		const { dir } = upstream();
		const module = join(tempDir(), "module");
		mkdirSync(module);
		git(module, "init", "-q", "-b", "main");
		writeFileSync(join(module, "a.txt"), "a\n");
		git(module, "add", ".");
		git(module, "commit", "-q", "-m", "one");
		git(dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", module, "sub");
		git(dir, "commit", "-q", "-m", "submodule");
		const base = git(dir, "rev-parse", "HEAD");
		// The pull request moves the submodule; main moves on elsewhere.
		git(dir, "checkout", "-q", "-b", "feature");
		writeFileSync(join(module, "a.txt"), "b\n");
		git(module, "commit", "-q", "-am", "two");
		git(join(dir, "sub"), "-c", "protocol.file.allow=always", "pull", "-q", "origin", "main");
		git(dir, "commit", "-q", "-am", "bump submodule");
		const head = git(dir, "rev-parse", "HEAD");
		git(dir, "checkout", "-q", "main");
		writeFileSync(join(dir, "main.txt"), "main\n");
		git(dir, "add", "main.txt");
		git(dir, "commit", "-q", "-m", "main moved");
		const workspace = await Workspace.prepare(
			tempDir(),
			job(base, { workflow: "merge", target: "pulls/2", branch: "feature", head }),
			dir,
		);
		git(workspace.dir, "fetch", "-q", "origin", "main");
		git(workspace.dir, "merge", "-q", "--no-edit", "FETCH_HEAD");
		const snapshot = await workspace.snapshot();
		expect(snapshot.merge).not.toBeNull();
		// Relative to the merged commit, retain the pull request's existing pointer without uploading submodule contents.
		expect(snapshot.submodules).toEqual([{ path: "sub", sha: git(join(dir, "sub"), "rev-parse", "HEAD") }]);
	});

	for (const conflict of [false, true])
		posix(`continues a selected moved head while preserving unpublished work (conflict=${conflict})`, async () => {
			const { dir, commit } = upstream();
			const root = tempDir();
			const original = await Workspace.prepare(
				root,
				job(commit, { workflow: "merge", target: "pulls/2", head: commit }),
				dir,
			);
			writeFileSync(join(original.dir, "old.txt"), "local work\n");
			writeFileSync(join(original.dir, "untracked.txt"), "new source\n");
			writeFileSync(join(dir, conflict ? "old.txt" : "remote.txt"), "someone else's work\n");
			git(dir, "add", ".");
			git(dir, "commit", "-qm", "external head");
			const head = git(dir, "rev-parse", "HEAD");
			const current = await Workspace.prepare(
				root,
				job(head, {
					workflow: "merge",
					target: "pulls/2",
					head,
					attempt: 2,
					session: "s",
					questions: [
						{
							id: "q",
							kind: "publication",
							attempt: 1,
							approvedAt: 1,
							prompt: { continuation: { head, from: commit, revision: commit } },
							answer: { continue: head },
						},
					],
				}),
				dir,
			);
			expect(current.continued).toBe(true);
			expect(current.preserved).toMatch(/^refs\/kix\/checkpoints\/job1\//);
			expect(git(current.repository, "show", `${current.preserved}:old.txt`)).toBe("local work");
			expect(readFileSync(join(current.dir, "untracked.txt"), "utf8")).toBe("new source\n");
			if (conflict) {
				expect(await current.conflicts()).toEqual(["old.txt"]);
				await expect(current.snapshot()).rejects.toThrow("Resolve and stage");
				writeFileSync(join(current.dir, "old.txt"), "resolved both versions\n");
				git(current.dir, "add", "old.txt");
				git(current.dir, "commit", "-qm", "resolve preserved merge");
			} else expect(readFileSync(join(current.dir, "remote.txt"), "utf8")).toBe("someone else's work\n");
			const snapshot = await current.snapshot();
			expect(snapshot.merge).toBeNull();
			expect(snapshot.changes.map((change) => change.path)).toEqual(["old.txt", "untracked.txt"]);
		});

	for (const integrated of [false, true])
		posix(`continues after publication without replaying published files (integrated=${integrated})`, async () => {
			const { dir, commit } = upstream();
			const root = tempDir();
			const original = await Workspace.prepare(root, job(commit, { workflow: "merge", head: commit }), dir);
			writeFileSync(join(original.dir, "old.txt"), "published version\n");
			const snapshot = await original.snapshot();
			writeFileSync(join(dir, "old.txt"), "published version\n");
			git(dir, "commit", "-qam", "published checkpoint");
			const published = git(dir, "rev-parse", "HEAD");
			await original.published(published, snapshot);
			writeFileSync(join(dir, "old.txt"), "external version\n");
			git(dir, "commit", "-qam", "external change after publication");
			const head = git(dir, "rev-parse", "HEAD");
			if (integrated) {
				// An agent can already have integrated the head before publication detects it.
				git(original.dir, "fetch", "-q", "origin", head);
				git(original.dir, "reset", "--hard", "-q", head);
			}
			writeFileSync(join(original.dir, "untracked.txt"), "unpublished source\n");
			const current = await Workspace.prepare(
				root,
				job(head, {
					workflow: "merge",
					head,
					attempt: 2,
					questions: [
						{
							id: "q",
							kind: "publication",
							attempt: 1,
							approvedAt: 1,
							prompt: { continuation: { head, from: published, revision: commit } },
							answer: { continue: head },
						},
					],
				}),
				dir,
			);
			expect(current.continued).toBe(true);
			expect(await current.conflicts()).toEqual([]);
			expect(readFileSync(join(current.dir, "old.txt"), "utf8")).toBe("external version\n");
			expect((await current.snapshot()).changes.map((change) => change.path)).toEqual(["untracked.txt"]);
			let workspace = current;
			for (const round of [1, 2, 3]) {
				const snapshot = await workspace.snapshot();
				writeFileSync(join(dir, "untracked.txt"), readFileSync(join(workspace.dir, "untracked.txt")));
				git(dir, "add", ".");
				git(dir, "commit", "-qm", `published continuation ${round}`);
				const published = git(dir, "rev-parse", "HEAD");
				if (round === 2) await workspace.adopt(published);
				else await workspace.published(published, snapshot);
				expect(await workspace.snapshot()).toMatchObject({ merge: null, changes: [] });
				if (round === 3) break;
				writeFileSync(join(workspace.dir, "untracked.txt"), `next unpublished edit ${round}\n`);
				writeFileSync(join(dir, "remote.txt"), `another external edit ${round}\n`);
				git(dir, "add", ".");
				git(dir, "commit", "-qm", "another moved head");
				const next = git(dir, "rev-parse", "HEAD");
				workspace = await Workspace.prepare(
					root,
					job(next, {
						workflow: "merge",
						head: next,
						attempt: 3,
						questions: [
							{
								id: "q2",
								kind: "publication",
								attempt: 2,
								approvedAt: 2,
								prompt: { continuation: { head: next, from: published, revision: head } },
								answer: { continue: next },
							},
						],
					}),
					dir,
				);
			}
		});

	posix("leaves initialized submodule commits intact when a stale checkout needs replacement", async () => {
		const module = upstream().dir;
		const { dir } = upstream();
		git(dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", module, "module");
		git(dir, "commit", "-qam", "add module");
		const commit = git(dir, "rev-parse", "HEAD");
		const root = tempDir();
		const original = await Workspace.prepare(root, job(commit, { head: commit }), dir);
		git(original.dir, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q");
		const child = join(original.dir, "module");
		writeFileSync(join(child, "old.txt"), "unpublished module commit\n");
		git(child, "commit", "-qam", "module local");
		const local = git(child, "rev-parse", "HEAD");
		writeFileSync(join(dir, "new.txt"), "remote\n");
		git(dir, "add", ".");
		git(dir, "commit", "-qm", "new head");
		const head = git(dir, "rev-parse", "HEAD");
		await expect(Workspace.prepare(root, job(commit, { head, attempt: 2 }), dir)).rejects.toThrow(
			"initialized submodules",
		);
		expect(git(child, "rev-parse", "HEAD")).toBe(local);
		expect(readFileSync(join(child, "old.txt"), "utf8")).toBe("unpublished module commit\n");
	});

	posix("leaves an untracked embedded repository intact instead of deleting its commits", async () => {
		const { dir, commit } = upstream();
		const root = tempDir();
		const original = await Workspace.prepare(root, job(commit, { head: commit }), dir);
		const embedded = join(original.dir, "embedded");
		mkdirSync(embedded);
		git(embedded, "init", "-q");
		writeFileSync(join(embedded, "source"), "local repository\n");
		git(embedded, "add", ".");
		git(embedded, "commit", "-qm", "local commit");
		const local = git(embedded, "rev-parse", "HEAD");
		writeFileSync(join(dir, "new.txt"), "published\n");
		git(dir, "add", ".");
		git(dir, "commit", "-qm", "new head");
		const head = git(dir, "rev-parse", "HEAD");
		await expect(Workspace.prepare(root, job(commit, { head, attempt: 2 }), dir)).rejects.toThrow(
			"embedded repositories",
		);
		expect(git(embedded, "rev-parse", "HEAD")).toBe(local);
	});

	posix("preserves stale local work without reapplying it after another runner published", async () => {
		const { dir, commit } = upstream();
		const root = tempDir();
		const original = await Workspace.prepare(root, job(commit, { head: commit }), dir);
		writeFileSync(join(original.dir, "old.txt"), "stale unpublished work\n");
		writeFileSync(join(dir, "old.txt"), "new published work\n");
		git(dir, "commit", "-qam", "another runner published");
		const head = git(dir, "rev-parse", "HEAD");
		const current = await Workspace.prepare(root, job(commit, { head, attempt: 2 }), dir);
		expect(current.continued).toBe(false);
		expect(readFileSync(join(current.dir, "old.txt"), "utf8")).toBe("new published work\n");
		expect(git(current.repository, "show", `${current.preserved}:old.txt`)).toBe("stale unpublished work");
		expect((await current.snapshot()).changes).toEqual([]);
	});

	posix("prepares jobs on one repository at once without racing on its clone", async () => {
		const { dir, commit } = upstream();
		const root = tempDir();
		const jobs = ["a", "b", "c"].map((id) => job(commit, { id }));
		const workspaces = await Promise.all(jobs.map((j) => Workspace.prepare(root, j, dir)));
		for (const workspace of workspaces) expect(existsSync(join(workspace.dir, "AGENTS.md"))).toBe(true);
		await Promise.all(workspaces.map((workspace) => workspace.remove()));
		for (const workspace of workspaces) expect(existsSync(workspace.dir)).toBe(false);
	});
});

describe("sandbox", () => {
	posix("hides every account home, the runner's state, and shared temporary files", () => {
		const runnerHome = tempDir();
		const linux = openSandbox({
			cwd: "/w",
			repository: "/r.git",
			runnerHome,
			devShell: null,
			trusted: true,
			platform: "linux",
			home: "/home/me",
		});
		try {
			expect(linux.deny).toEqual(["/home", "/root", "/tmp", "/var/tmp", "/run/user", "/home/me", runnerHome]);
			expect(linux.domains).toEqual(REGISTRIES);
			// A bootstrap job runs in the runner's own environment: only the private HOME is set.
			expect(readFileSync(linux.env, "utf8")).toBe(`export HOME='${linux.tmp}/home'\n`);
			// Short enough for the sandbox's bridge sockets inside it.
			expect(linux.tmp.length).toBeLessThan(40);
		} finally {
			closeSandbox(linux);
		}
		expect(existsSync(linux.tmp)).toBe(false);
		const mac = openSandbox({
			cwd: "/w",
			repository: "/r.git",
			runnerHome,
			devShell: "export A=1\n",
			trusted: false,
			platform: "darwin",
			home: "/Users/me",
		});
		try {
			expect(mac.deny).toEqual(expect.arrayContaining(["/Users", "/private/tmp", "/private/var/folders"]));
			expect(readFileSync(join(mac.tmp, "devshell.sh"), "utf8")).toBe("export A=1\n");
			// An untrusted revision's commands reach no host.
			expect(mac.domains).toEqual([]);
		} finally {
			closeSandbox(mac);
		}
	});

	test("tells the agent which hosts its commands reach", () => {
		expect(systemPrompt(REGISTRIES)).toContain("reach only these package registries (registry.npmjs.org, ");
		expect(systemPrompt([])).toContain("reach no network host");
	});

	test("keeps only the agent's own variables in a job's environment", () => {
		const sandbox = { tmp: "/tmp/quest-job-x", env: "/tmp/quest-job-x/env.sh" } as Sandbox;
		const env = jobEnvironment(
			{
				PATH: "/bin",
				HOME: "/home/me",
				LANG: "C",
				HTTPS_PROXY: "p",
				AWS_SECRET_ACCESS_KEY: "s",
				SSH_AUTH_SOCK: "a",
			},
			"/acct",
			sandbox,
		);
		expect(env).toEqual({
			PATH: "/bin",
			HOME: "/home/me",
			LANG: "C",
			HTTPS_PROXY: "p",
			CLAUDE_CONFIG_DIR: "/acct",
			TMPDIR: "/tmp/quest-job-x",
			CLAUDE_ENV_FILE: "/tmp/quest-job-x/env.sh",
		});
	});
});

describe("Claude Code output", () => {
	test("reads limits from rate limit events, assistant errors, and results", () => {
		const event = streamReader();
		event.line(
			JSON.stringify({
				type: "rate_limit_event",
				rate_limit_info: { status: "rejected", resetsAt: 1_900_000_000 },
			}),
		);
		event.line(JSON.stringify({ type: "result", is_error: true, result: "limit" }));
		expect(event.exit(1, "")).toMatchObject({ limited: { until: 1_900_000_000_000 }, failed: true });

		const flagged = streamReader();
		flagged.line(JSON.stringify({ type: "assistant", error: "rate_limit" }));
		expect(flagged.exit(1, "").limited).toEqual({ until: null });

		const legacy = streamReader();
		legacy.line(
			JSON.stringify({ type: "result", is_error: true, result: "Claude AI usage limit reached|1900000000" }),
		);
		expect(legacy.exit(1, "").limited).toEqual({ until: 1_900_000_000_000 });

		const fine = streamReader();
		fine.line(JSON.stringify({ type: "result", is_error: false, result: "fixed the usage limit check" }));
		expect(fine.exit(0, "")).toEqual({ limited: null, failed: false, reply: "fixed the usage limit check" });

		const crashed = streamReader();
		expect(crashed.exit(1, "boom\n")).toEqual({ limited: null, failed: true, reply: "boom" });
	});
});

describe("waiting on a pull request", () => {
	const pull = (checks: string, reviews = 0) => ({
		state: "OPEN",
		head: { oid: "a".repeat(40) },
		checks: { commit: "a".repeat(40), state: checks, runs: [] },
		reviews: Array.from({ length: reviews }, () => ({ body: "" })),
		comments: [],
		threads: [],
	});

	test("wakes when what the merge loop acts on changes, not on every check", async () => {
		const reads = [pull("PENDING"), pull("PENDING"), pull("SUCCESS")];
		const slept: number[] = [];
		const waited = await waitForChange(async () => reads.shift(), {
			since: fingerprint(pull("PENDING")),
			until: 1_000_000,
			stopped: () => null,
			now: () => 0,
			pause: async (ms) => slept.push(ms),
		});
		expect(waited).toEqual({ changed: true, context: pull("SUCCESS") });
		expect(slept).toEqual([1_000_000, 1_000_000]);
		expect(fingerprint(pull("SUCCESS", 1))).not.toBe(fingerprint(pull("SUCCESS")));
		// A new review still counts once kix's window of the latest reviews is full.
		const full = (newest: string) => ({
			...pull("SUCCESS"),
			reviews: [...Array.from({ length: 49 }, () => ({ body: "" })), { body: newest }],
		});
		expect(fingerprint(full("Approved"))).not.toBe(fingerprint(full("")));
	});

	test("ends at its deadline, or when the job stops", async () => {
		let clock = 0;
		const options = {
			since: null,
			until: 25,
			now: () => clock,
			pause: async (ms: number) => (clock += ms),
		};
		expect(await waitForChange(async () => pull("PENDING"), { ...options, stopped: () => null })).toEqual({
			changed: false,
			context: pull("PENDING"),
		});
		expect(await waitForChange(async () => pull("PENDING"), { ...options, stopped: () => "Stopped." })).toEqual({
			stopped: "Stopped.",
		});
	});
});

test("a webhook arriving during the context read is not lost before subscribing", async () => {
	const changes = new Changes();
	let reads = 0;
	const result = await waitForChange(
		async () => {
			if (reads++ === 0) {
				changes.wake();
				return { state: "OPEN" };
			}
			return { state: "CLOSED" };
		},
		{ since: fingerprint({ state: "OPEN" }), until: Date.now() + 60_000, stopped: () => null, changes },
	);
	expect(result).toEqual({ changed: true, context: { state: "CLOSED" } });
	expect(reads).toBe(2);
});

test("a webhook wait reads only on a wake and wakes immediately when its job stops", async () => {
	const changes = new Changes();
	let stopped: string | null = null;
	let reads = 0;
	const result = waitForChange(
		async () => {
			reads++;
			return { state: "OPEN" };
		},
		{
			since: null,
			until: Date.now() + 60_000,
			stopped: () => stopped,
			changes,
		},
	);
	await vi.waitFor(() => expect(reads).toBe(1));
	changes.wake();
	await vi.waitFor(() => expect(reads).toBe(2));
	stopped = "Stopped.";
	changes.wake();
	expect(await result).toEqual({ stopped: "Stopped." });
	expect(reads).toBe(2);
});

describe("opencode", () => {
	test("labels an account by the providers its home signed in to", () => {
		const home = tempDir();
		expect(credentials(home)).toEqual([]);
		const data = join(accountDirectories(home).XDG_DATA_HOME, "opencode");
		mkdirSync(data, { recursive: true });
		writeFileSync(
			join(data, "auth.json"),
			JSON.stringify({ openai: { type: "oauth", access: "a" }, "opencode-go": { type: "api", key: "k" } }),
		);
		expect(signedIn(credentials(home))).toEqual({
			provider: "openai",
			kind: "subscription",
			label: "ChatGPT, OpenCode Go (opencode)",
		});
		expect(signedIn([{ provider: "wafer.ai", type: "api" }])).toEqual({
			provider: "wafer-ai",
			kind: "api-key",
			label: "wafer.ai API key (opencode)",
		});
		expect(signedIn([])).toBeNull();
	});

	test("keeps the user's provider credentials and opencode settings from the account", () => {
		const kept = environment({
			PATH: "/bin",
			CLOUDFLARE_API_KEY: "k",
			AWS_SECRET_ACCESS_KEY: "s",
			OPENCODE_CONFIG: "c",
		});
		expect(kept).toEqual({ PATH: "/bin" });
	});

	posix("keeps the file tools inside the checkout and the attempt's directory, through symlinks too", async () => {
		const root = realpathSync(tempDir());
		const [checkout, tmp, output, outside] = ["checkout", "tmp", "tool-output", "outside"].map((name) => {
			mkdirSync(join(root, name));
			return join(root, name);
		});
		writeFileSync(join(outside, "auth.json"), "{}");
		writeFileSync(join(checkout, "a.txt"), "a");
		symlinkSync(join(outside, "auth.json"), join(checkout, "auth.json"));
		symlinkSync(outside, join(checkout, "out"));
		symlinkSync(join(outside, "missing"), join(checkout, "dangling"));
		const file = join(root, "plugin.mjs");
		writeFileSync(file, PLUGIN);
		const { default: plugin } = await import(pathToFileURL(file).href);
		const hooks = await plugin.server({}, { cwd: checkout, writes: [checkout, tmp], reads: [output] });
		const call = (tool: string, args: Record<string, unknown>) =>
			hooks["tool.execute.before"]({ tool, sessionID: "s", callID: "c" }, { args });
		const patch = (...headers: string[]) => ({
			patchText: ["*** Begin Patch", ...headers, "+x", "*** End Patch"].join("\n"),
		});

		await call("read", { filePath: "a.txt" });
		await call("write", { filePath: "new/dir/b.txt" });
		await call("edit", { filePath: join(tmp, "notes.md") });
		await call("glob", { pattern: "**/*.ts" });
		await call("grep", { pattern: "x", path: "." });
		await call("apply_patch", patch("*** Update File: a.txt", "*** Move to: c.txt"));
		// opencode's saved output is readable, not writable.
		await call("read", { filePath: join(output, "tool_1") });
		await expect(call("write", { filePath: join(output, "tool_1") })).rejects.toThrow(/outside the checkout/);
		// Commands are the sandbox's to confine.
		await call("bash", { command: "cat /etc/passwd" });

		for (const [tool, args] of [
			["read", { filePath: "auth.json" }],
			["read", { filePath: "out/auth.json" }],
			["write", { filePath: "out/new.txt" }],
			["write", { filePath: "../outside/new.txt" }],
			["grep", { pattern: "x", path: outside }],
			["glob", { pattern: "*", path: "out" }],
			["apply_patch", patch("*** Add File: out/x")],
			["apply_patch", patch("*** Update File: a.txt", "*** Move to: /etc/x")],
		] as const)
			await expect(call(tool, args), `${tool} ${JSON.stringify(args)}`).rejects.toThrow(/outside the checkout/);
		// A write would follow a symlink to nothing out of the checkout.
		await expect(call("write", { filePath: "dangling" })).rejects.toThrow(/symlink to nothing/);
	});

	test("reads account limits from retries and errors, not brief rate limits", () => {
		const retry = { type: "retry" as const, attempt: 1, next: 1_900_000_000_000 };
		expect(
			retryLimit({
				...retry,
				message: "Go limit reached",
				action: { reason: "account_rate_limit", provider: "opencode-go", title: "", message: "", label: "" },
			}),
		).toEqual({ until: 1_900_000_000_000 });
		expect(retryLimit({ ...retry, message: "The usage limit has been reached" })).toEqual({ until: null });
		expect(retryLimit({ ...retry, message: "Rate limit reached for requests" })).toBeNull();
		expect(retryLimit({ type: "busy" })).toBeNull();

		const now = 1_000_000;
		const api = (message: string, responseBody?: string, responseHeaders?: Record<string, string>) =>
			({
				role: "assistant",
				error: { name: "APIError", data: { message, isRetryable: false, responseBody, responseHeaders } },
			}) as never;
		expect(
			turnExit(
				api("Too many", JSON.stringify({ error: { type: "usage_limit_reached", resets_at: 1_900_000 } })),
				[],
				null,
				now,
			).limited,
		).toEqual({ until: 1_900_000_000 });
		expect(turnExit(api("Quota exceeded.", "", { "retry-after": "60" }), [], null, now).limited).toEqual({
			until: now + 60_000,
		});
		expect(turnExit(api("Bad request"), [], null, now)).toEqual({
			limited: null,
			failed: true,
			reply: "Bad request",
		});
		expect(
			turnExit({ role: "assistant" } as never, [{ type: "text", text: "All done" } as never], null, now),
		).toEqual({ limited: null, failed: false, reply: "All done" });
	});
});

describe("kix tools", () => {
	test("speak MCP over HTTP to the attempt's agent only", async () => {
		const server = await serveTools([
			{
				name: "echo",
				description: "Echo",
				inputSchema: { type: "object" },
				call: async (args) => {
					if (args.fail) throw new Error("nope");
					return String(args.text);
				},
			},
		]);
		const post = (body: unknown, token = server.token) =>
			fetch(server.url, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		const call = async (body: unknown) => (await (await post(body)).json()) as Sent;
		try {
			expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, "wrong")).status).toBe(401);
			const init = await call({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2025-03-26" },
			});
			expect(init.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} } });
			expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
			const list = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
			expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["echo"]);
			const echoed = await call({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "echo", arguments: { text: "hi" } },
			});
			expect(echoed.result).toEqual({ content: [{ type: "text", text: "hi" }] });
			const failed = await call({
				jsonrpc: "2.0",
				id: 4,
				method: "tools/call",
				params: { name: "echo", arguments: { fail: true } },
			});
			expect(failed.result).toEqual({ content: [{ type: "text", text: "nope" }], isError: true });
			const unknown = await call({ jsonrpc: "2.0", id: 5, method: "resources/list" });
			expect(unknown.error.code).toBe(-32601);
		} finally {
			await server.close();
		}
	});
});

describe("prompts", () => {
	test("give the workflow's skill, the guide, and the repository's instructions", () => {
		const dir = tempDir();
		writeFileSync(join(dir, "AGENTS.md"), "Use tabs.\n");
		const prompt = startPrompt(job("a".repeat(40)), "Extra rule.", dir);
		expect(prompt).toContain("Start work on the quest `quest/m0/thing.md`");
		expect(prompt).toContain("kix adds for this job: Extra rule.");
		expect(prompt).toContain("Use tabs.");
		expect(prompt).toContain("# The start workflow");
		expect(prompt).toContain("# Quest guide");
	});

	posix("point to the nested AGENTS.md files that apply under their directories", () => {
		const { dir } = upstream();
		mkdirSync(join(dir, "cloudflare", "src"), { recursive: true });
		writeFileSync(join(dir, "cloudflare", "AGENTS.md"), "Run the Worker tests.\n");
		writeFileSync(join(dir, "cloudflare", "src", "AGENTS.md"), "No globals.\n");
		git(dir, "add", ".");
		const prompt = startPrompt(job("a".repeat(40)), null, dir);
		expect(prompt).toContain("Always run the tests.");
		expect(prompt).toContain("- `cloudflare/AGENTS.md`\n- `cloudflare/src/AGENTS.md`");
	});

	posix("carry CLAUDE.md, which the sandboxed CLI does not load, but never through a symlink", () => {
		const dir = tempDir();
		const secret = join(tempDir(), "id_ed25519");
		writeFileSync(secret, "PRIVATE KEY\n");
		symlinkSync(secret, join(dir, "AGENTS.md"));
		writeFileSync(join(dir, "CLAUDE.md"), "Prefer small diffs.\n");
		const prompt = startPrompt(job("a".repeat(40)), null, dir);
		expect(prompt).toContain("## CLAUDE.md\n\nPrefer small diffs.");
		expect(prompt).not.toContain("PRIVATE KEY");
		expect(prompt).not.toContain("## AGENTS.md");
	});

	test("send plan and iterate jobs to the context tool", () => {
		const plan = startPrompt(job("a".repeat(40), { workflow: "plan", target: "issues/4" }), null, tempDir());
		expect(plan).toContain("Plan issue #4 of owner/repo. Read it with the `context` tool first");
		const iterate = startPrompt(job("a".repeat(40), { workflow: "iterate", target: "pulls/9" }), null, tempDir());
		expect(iterate).toContain("Iterate on pull request #9 of owner/repo. Read it, its review threads");
		expect(iterate).toContain("merging the base branch into the checkout with `git merge`");
	});

	test("run a merge job through the merge skill, landing with deliver and waiting with wait", () => {
		const merge = startPrompt(job("a".repeat(40), { workflow: "merge", target: "pulls/9" }), null, tempDir());
		expect(merge).toContain("Merge pull request #9 of owner/repo. The maintainer picked merge");
		expect(merge).toContain("Where the workflow says to land with `quest merge --land`, call `deliver` instead");
		expect(merge).toContain("Where the workflow says to run `quest wait`, call `wait`");
		expect(merge).toContain("# The merge workflow");
		// The skill's design checkpoint still reaches the maintainer.
		expect(merge).toContain("Every fourth round");
	});

	test("carry earlier summaries and the latest answer", () => {
		const questions = [
			{
				id: "q",
				attempt: 1,
				kind: "agent" as const,
				prompt: {
					kind: "decision",
					questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }],
				},
				answer: { answers: [{ choices: ["B"], text: "and hurry" }] },
			},
		];
		const resumed = job("a".repeat(40), {
			attempt: 2,
			session: "s",
			questions,
			events: [{ attempt: 1, kind: "summary", body: "Wrote the parser" }],
		});
		expect(resumePrompt(resumed)).toContain("Q: Which?\nA: B\nThe maintainer wrote: and hurry");
		expect(startPrompt(resumed, null, tempDir())).toContain("- Wrote the parser");
		expect(
			formatAnswer({
				id: "p",
				attempt: 1,
				kind: "publication",
				prompt: { blocked: "branch moved" },
				answer: "retry",
			}),
		).toContain("(branch moved). The maintainer replied: retry");
	});
});

describe("account add", () => {
	posix("signs an opencode account in with its own flow in its own home", async () => {
		const dir = tempDir();
		const bin = join(dir, "bin");
		mkdirSync(bin);
		// opencode's sign-in stores the credential under its XDG data home.
		writeFileSync(
			join(bin, "opencode"),
			`#!/bin/sh\nmkdir -p "$XDG_DATA_HOME/opencode"\necho '{"opencode-go":{"type":"api","key":"k"}}' > "$XDG_DATA_HOME/opencode/auth.json"\n`,
		);
		chmodSync(join(bin, "opencode"), 0o755);
		const out: string[] = [];
		const io = {
			stdout: (text: string) => out.push(text),
			stderr: () => {},
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				QUEST_RUNNER_HOME: join(dir, "home"),
				QUEST_RUNNER_SRT: join(bin, "srt"),
			},
		};
		await expect(addAccount(io, { cli: "opencode", console: true })).rejects.toThrow(RunnerInputError);
		await expect(addAccount(io, { cli: "opencode", console: false, model: "gpt" })).rejects.toThrow(
			RunnerInputError,
		);
		expect(await addAccount(io, { cli: "opencode", console: false, model: "opencode-go/kimi-k3" })).toBe(0);
		const home = new RunnerHome(join(dir, "home"));
		const [account] = home.accounts();
		expect(account).toMatchObject({
			adapter: "opencode",
			provider: "opencode-go",
			kind: "subscription",
			label: "OpenCode Go (opencode)",
		});
		const config = join(
			accountDirectories(home.accountHome(account!.id)).XDG_CONFIG_HOME,
			"opencode",
			"opencode.json",
		);
		expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ model: "opencode-go/kimi-k3" });
	});
});

describe("runner adapters", () => {
	test.skipIf(process.platform !== "linux")("need the sandbox's programs only once an account needs them", () => {
		const bin = join(tempDir(), "bin");
		mkdirSync(bin);
		const install = (...names: string[]) => {
			for (const name of names) {
				writeFileSync(join(bin, name), "#!/bin/sh\n");
				chmodSync(join(bin, name), 0o755);
			}
		};
		install("claude", "opencode");
		const adapter = runnerAdapters({ PATH: bin });
		expect(() => adapter("claude")).toThrow(/bwrap and socat are not installed/);
		// An account added while the runner runs is checked then.
		install("bwrap", "socat");
		expect(adapter("claude")).toBeInstanceOf(Claude);
		// opencode's commands run through sandbox-runtime.
		expect(() => adapter("opencode")).toThrow(/srt is not installed/);
		install("srt");
		expect(adapter("opencode")).toBeInstanceOf(Opencode);
	});
});

describe("login", () => {
	posix("connects once the owner approves the link, keeping the token local", async () => {
		const home = tempDir();
		let polls = 0;
		let authorization = "";
		const out: string[] = [];
		const code = await login(
			{
				stdout: (text) => out.push(text),
				stderr: () => {},
				env: { ...process.env, QUEST_RUNNER_HOME: home },
				fetch: (async (_url: string, init: RequestInit) => {
					authorization = (init.headers as Record<string, string>).Authorization!;
					return ++polls < 3
						? new Response(null, { status: 401 })
						: Response.json({ id: "r1", name: "laptop" });
				}) as typeof fetch,
			},
			{ url: "https://kix.test/", name: "laptop", intervalMs: 1 },
		);
		expect(code).toBe(0);
		const link = new URL(/https:\/\/kix\.test\/runners\?\S+/.exec(out.join(""))![0]);
		const saved = new RunnerHome(home).login()!;
		expect(saved).toMatchObject({ url: "https://kix.test", id: "r1", name: "laptop" });
		expect(authorization).toBe(`Bearer ${saved.token}`);
		expect(link.searchParams.get("name")).toBe("laptop");
		const { createHash } = await import("node:crypto");
		expect(link.searchParams.get("key")).toBe(createHash("sha256").update(saved.token).digest("hex"));
		expect(out.join("")).not.toContain(saved.token);
	});
});

describe("runner home", () => {
	/** Another process holding `dir` until it is killed. */
	async function holder(dir: string) {
		const root = resolve(import.meta.dirname, "..");
		const script = join(tempDir(), "hold.ts");
		writeFileSync(
			script,
			`import { RunnerHome } from ${JSON.stringify(join(root, "src/runner/home.ts"))};\n` +
				`new RunnerHome(${JSON.stringify(dir)}).hold();\nconsole.log("held");\nsetInterval(() => {}, 1000);\n`,
		);
		const child = spawn("bun", [`--config=${join(root, "bunfig.toml")}`, script], {
			stdio: ["ignore", "pipe", "inherit"],
		});
		const [line] = await once(child.stdout, "data");
		expect(String(line)).toBe("held\n");
		return child;
	}

	posix("refuses a second runner while one holds the home", async () => {
		const dir = tempDir();
		const first = new RunnerHome(dir).hold();
		expect(() => new RunnerHome(dir).hold()).toThrow("another `quest runner` is running in");
		first.release();
		new RunnerHome(dir).hold().release();

		const child = await holder(dir);
		try {
			expect(() => new RunnerHome(dir).hold()).toThrow(`(process ${child.pid} `);
		} finally {
			child.kill("SIGKILL");
		}
	});

	posix("takes the home once its holder crashed", async () => {
		const dir = tempDir();
		const child = await holder(dir);
		child.kill("SIGKILL");
		await once(child, "exit");
		const held = new RunnerHome(dir).hold();
		// The crashed holder's record is gone, so only this one remains.
		expect(readdirSync(join(dir, "running"))).toHaveLength(1);
		held.release();
		expect(readdirSync(join(dir, "running"))).toEqual([]);
	});
});

/**
 * A fake `claude` that runs the steps the test wrote for a new or resumed
 * session. Its log and steps sit beside its directory, since a job's
 * environment keeps none of the test's variables.
 */
const FAKE_CLAUDE = `
const fs = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
const at = (flag) => argv[argv.indexOf(flag) + 1];
const resume = argv.includes("--resume");
const session = resume ? at("--resume") : at("--session-id");
const stdin = fs.readFileSync(0, "utf8");
const kix = JSON.parse(fs.readFileSync(at("--mcp-config"), "utf8")).mcpServers.kix;
const log = (value) => fs.appendFileSync(join(__dirname, "..", "calls.log"), JSON.stringify(value) + "\\n");
log({
	argv,
	stdin,
	cwd: process.cwd(),
	home: process.env.CLAUDE_CONFIG_DIR,
	gh: process.env.GH_TOKEN ?? null,
	secret: process.env.AWS_SECRET_ACCESS_KEY ?? null,
	tmp: process.env.TMPDIR,
	envFile: fs.readFileSync(process.env.CLAUDE_ENV_FILE, "utf8"),
	settings: JSON.parse(fs.readFileSync(at("--settings"), "utf8")),
	timeout: kix.timeout,
});
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
out({ type: "system", subtype: "init", session_id: session });
let id = 0;
async function rpc(method, params) {
	const response = await fetch(kix.url, {
		method: "POST",
		headers: { ...kix.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
		body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
	});
	return (await response.json()).result;
}
(async () => {
	await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } });
	const steps = JSON.parse(fs.readFileSync(join(__dirname, "..", "steps.json"), "utf8"))[resume ? "resume" : "start"] ?? [];
	for (const step of steps) {
		if (step.write) fs.writeFileSync(step.write, step.content);
		if (step.remove) fs.rmSync(step.remove);
		if (step.git) require("node:child_process").execFileSync("git", ["-c", "user.name=Fake Agent", "-c", "user.email=fake@example.test", ...step.git], { stdio: "ignore" });
		if (step.emit) out(step.emit);
		if (step.backgroundWait) {
			void rpc("tools/call", { name: "wait", arguments: {minutes:55} }).catch(() => {});
			await rpc("tools/call", { name: "context", arguments: {} });
			log({ backgroundWaitPid: process.pid });
		}
		if (step.tool) log({ tool: step.tool, reply: await rpc("tools/call", { name: step.tool, arguments: step.args }) });
		if (step.wait) {
			process.on("SIGTERM", () => { log({ terminated: true }); process.exit(143); });
			setInterval(() => {}, 1000);
			await new Promise(() => {});
		}
		if (step.exit !== undefined) process.exit(step.exit);
	}
	out({ type: "result", subtype: "success", is_error: false, result: "done", session_id: session });
})();
`;

/**
 * A fake `opencode serve` that runs the same steps as the fake `claude` on
 * each prompt: it checks the password, streams events, and ends a waiting
 * turn when the session is aborted.
 */
const FAKE_OPENCODE = `
const fs = require("node:fs");
const { join } = require("node:path");
const http = require("node:http");
const argv = process.argv.slice(2);
const logFile = join(__dirname, "..", "calls.log");
const log = (value) => fs.appendFileSync(logFile, JSON.stringify(value) + "\\n");
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const auth = "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_SERVER_PASSWORD).toString("base64");
const kix = config.mcp.kix;
const streams = [];
const send = (event) => { for (const s of streams) s.write("data: " + JSON.stringify(event) + "\\n\\n"); };
let aborted = () => {};
let sessions = 0;
let id = 0;
async function rpc(method, params) {
	const response = await fetch(kix.url, {
		method: "POST",
		headers: { ...kix.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
		body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
	});
	return (await response.json()).result;
}
const body = (request) => new Promise((resolve) => {
	let text = "";
	request.on("data", (chunk) => (text += chunk));
	request.on("end", () => resolve(text ? JSON.parse(text) : {}));
});
const json = (response, value) => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
async function prompt(session, input) {
	const steps = JSON.parse(fs.readFileSync(join(__dirname, "..", "steps.json"), "utf8"));
	const resume = fs.existsSync(logFile) && fs.readFileSync(logFile, "utf8").includes('"prompted":"' + session + '"');
	log({
		argv, cwd: process.cwd(), stdin: input.parts[0].text, system: input.system, session, prompted: session,
		xdg: process.env.XDG_DATA_HOME, home: process.env.HOME, devShell: process.env.IN_DEVSHELL ?? null,
		gh: process.env.GH_TOKEN ?? null, projectConfig: process.env.OPENCODE_DISABLE_PROJECT_CONFIG ?? null, config,
	});
	await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } });
	for (const step of steps[resume ? "resume" : "start"] ?? []) {
		if (step.write) fs.writeFileSync(step.write, step.content);
		if (step.remove) fs.rmSync(step.remove);
		// opencode runs a command as its shell's -c, with the server's own environment.
		if (step.shell)
			log({ shell: require("node:child_process").execFileSync(config.shell, ["-c", step.shell], { encoding: "utf8" }) });
		if (step.emit) send({ ...step.emit, properties: { ...step.emit.properties, sessionID: session } });
		if (step.tool) log({ tool: step.tool, reply: await rpc("tools/call", { name: step.tool, arguments: step.args }) });
		if (step.wait) {
			await new Promise((resolve) => (aborted = resolve));
			log({ aborted: session });
			return { info: { role: "assistant", error: { name: "MessageAbortedError", data: { message: "Aborted" } } }, parts: [] };
		}
	}
	return { info: { role: "assistant", finish: "stop" }, parts: [{ type: "text", text: "done" }] };
}
const server = http.createServer(async (request, response) => {
	if (request.headers.authorization !== auth) return response.writeHead(401).end();
	const path = new URL(request.url, "http://x").pathname;
	if (path === "/event") {
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		streams.push(response);
		return response.write("data: " + JSON.stringify({ type: "server.connected", properties: {} }) + "\\n\\n");
	}
	if (path === "/session") return json(response, { id: "ses_" + ++sessions + "_" + process.pid });
	const message = /^\\/session\\/([^/]+)\\/message$/.exec(path);
	if (message) return json(response, await prompt(message[1], await body(request)));
	if (/\\/abort$/.test(path)) {
		aborted();
		return json(response, true);
	}
	response.writeHead(404).end();
});
process.on("SIGTERM", () => process.exit(143));
server.listen(0, "127.0.0.1", () => console.log("opencode server listening on http://127.0.0.1:" + server.address().port));
`;

/** A fake sandbox-runtime that records its settings and environment, then runs the command unconfined. */
const FAKE_SRT = `
const fs = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(argv[argv.indexOf("--settings") + 1], "utf8"));
fs.appendFileSync(join(__dirname, "..", "calls.log"), JSON.stringify({ srt: argv, settings, env: Object.keys(process.env) }) + "\\n");
process.exit(require("node:child_process").spawnSync("/bin/sh", ["-c", argv[argv.indexOf("-c") + 1]], { stdio: "inherit" }).status);
`;

/** A fake `nix` whose `print-dev-env` prints a one-line devShell, or builds until killed when the steps say `nix`. */
const FAKE_NIX = `
const fs = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
const log = (value) => fs.appendFileSync(join(__dirname, "..", "calls.log"), JSON.stringify(value) + "\\n");
const steps = join(__dirname, "..", "steps.json");
if (fs.existsSync(steps) && JSON.parse(fs.readFileSync(steps, "utf8")).nix) {
	process.on("SIGTERM", () => { log({ nixTerminated: true }); process.exit(143); });
	setInterval(() => {}, 1000);
	log({ nix: argv });
} else {
	log({ nix: argv });
	process.stdout.write("export IN_DEVSHELL=1\\n");
}
`;

interface Rig {
	hub: FakeHub;
	runner: Runner;
	home: RunnerHome;
	publishes: Sent[];
	/** The context URLs the runner read. */
	contexts: string[];
	upstream: { dir: string; commit: string };
	logs: string[];
	calls(): Sent[];
	steps(steps: Record<string, unknown[]>): void;
	assign(job: Job, instructions?: string | null): void;
	result(): Promise<Sent>;
}

/** A rig whose `publishReply` may answer a publication itself, or throw as if its reply were lost. */
function rig(
	publishReply?: (
		body: Sent,
		upstream: { dir: string; commit: string },
	) => { status: number; body: unknown } | undefined,
	cli: AdapterName = "claude",
): Rig {
	const dir = tempDir();
	const bin = join(dir, "bin");
	mkdirSync(bin);
	for (const [name, body] of Object.entries({
		claude: FAKE_CLAUDE,
		opencode: FAKE_OPENCODE,
		nix: FAKE_NIX,
		srt: FAKE_SRT,
	})) {
		writeFileSync(join(bin, name), `#!${process.execPath}\n${body}`);
		chmodSync(join(bin, name), 0o755);
	}
	const log = join(dir, "calls.log");
	const stepsFile = join(dir, "steps.json");
	const home = new RunnerHome(join(dir, "home"));
	const account: Account = {
		id: "acct1",
		adapter: cli,
		provider: cli === "claude" ? "anthropic" : "openai",
		kind: "subscription",
		label: "me@example.test",
	};
	home.saveAccounts([account]);
	if (cli === "opencode") {
		const data = join(accountDirectories(home.accountHome("acct1")).XDG_DATA_HOME, "opencode");
		mkdirSync(data, { recursive: true });
		writeFileSync(join(data, "auth.json"), JSON.stringify({ openai: { type: "oauth", access: "secret" } }));
		Opencode.setModel(home.accountHome("acct1"), "openai/gpt-5.5");
	}
	const hub = new FakeHub();
	const publishes: Sent[] = [];
	const contexts: string[] = [];
	let heads = 0;
	const env = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		GH_TOKEN: "secret",
		AWS_SECRET_ACCESS_KEY: "secret",
	};
	const logs: string[] = [];
	const source = upstream();
	const runner = new Runner({
		home,
		login: { url: "http://kix.test", token: "token", id: "r1", name: "laptop" },
		slots: 2,
		adapter: () =>
			cli === "claude"
				? new Claude(join(bin, "claude"), env)
				: new Opencode(join(bin, "opencode"), join(bin, "srt"), env),
		devShell: (job, repository, signal) => devShell(job, repository, env, signal),
		remote: () => source.dir,
		env,
		dial: hub.dial,
		fetch: (async (url: string, init: RequestInit) => {
			if (url.includes("/api/runner/context?")) {
				contexts.push(url);
				return Response.json({ kind: "issue", number: 4, title: "Parser breaks", body: "On empty input" });
			}
			const body = JSON.parse(init.body as string);
			publishes.push(body);
			const custom = publishReply?.(body, source);
			if (custom) return Response.json(custom.body, { status: custom.status });
			const head = String(++heads).padStart(40, "0");
			return Response.json({
				head,
				...(body.pull && {
					pull: { number: 7, url: "https://github.com/owner/repo/pull/7", draft: body.pull.draft },
				}),
			});
		}) as typeof fetch,
		log: (line) => logs.push(line),
	});
	runner.start();
	return {
		hub,
		runner,
		home,
		publishes,
		contexts,
		upstream: source,
		logs,
		calls: () =>
			existsSync(log)
				? readFileSync(log, "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line))
				: [],
		steps: (steps) => writeFileSync(stepsFile, JSON.stringify(steps)),
		assign: (job, instructions = null) => {
			const send = () => hub.socket.deliver({ type: "assign", job, instructions });
			if (hub.of("status").length) send();
			else void hub.next((m) => m.type === "status").then(send);
		},
		result: () => hub.next((m) => m.type === "result"),
	};
}

/** A step whose output is large enough to upload at once, telling the test the agent reached it. */
const ready = { emit: { type: "marker", text: "ready", pad: "x".repeat(FLUSH_BYTES) } };
const waiting = (r: Rig) => r.hub.next((m) => m.type === "output" && m.text.includes('"text":"ready"'));

/** Wait until the runner has no attempts left, so every report has landed. */
async function idle(runner: Runner) {
	while (runner.running.length) await Promise.all(runner.running.map((a) => a.finished.catch(() => {})));
}

describe("quest runner", () => {
	posix("pauses a large conflicted continuation with a bounded question and intact checkout", async () => {
		const r = rig();
		try {
			const paths = Array.from({ length: 60 }, (_, i) => `component-${i}-${"long-path".repeat(6)}.txt`);
			for (const path of paths) writeFileSync(join(r.upstream.dir, path), "initial\n");
			git(r.upstream.dir, "add", ".");
			git(r.upstream.dir, "commit", "-qm", "initial component files");
			const from = git(r.upstream.dir, "rev-parse", "HEAD");
			const original = await Workspace.prepare(
				r.home.dir,
				job(from, { workflow: "merge", head: from }),
				r.upstream.dir,
			);
			for (const path of paths) {
				writeFileSync(join(original.dir, path), "local unpublished work\n");
				writeFileSync(join(r.upstream.dir, path), "external change\n");
			}
			git(r.upstream.dir, "commit", "-qam", "moved head");
			const head = git(r.upstream.dir, "rev-parse", "HEAD");
			const continued = job(head, {
				workflow: "merge",
				head,
				attempt: 2,
				questions: [
					{
						id: "q",
						kind: "publication",
						attempt: 1,
						approvedAt: 1,
						prompt: { continuation: { head, from, revision: from } },
						answer: { continue: head },
					},
				],
			});
			r.assign(continued);
			const question = await r.hub.next((message) => message.type === "question");
			await idle(r.runner);
			expect(question.prompt.questions[0].question.length).toBeLessThanOrEqual(2000);
			expect(question.prompt.questions[0].question).toContain("60 paths");
			expect(r.hub.of("result")).toEqual([]);
			expect((await original.conflicts()).length).toBe(60);
			expect(r.calls()).toEqual([]);
			r.steps({
				start: [
					...paths.map((path) => ({ write: path, content: "resolved both versions\n" })),
					{ git: ["add", "."] },
					{ git: ["commit", "-qm", "resolve preserved conflicts"] },
					{
						tool: "deliver",
						args: {
							summary: "Resolved preserved conflicts",
							title: "Merge",
							body: "Resolved",
							draft: false,
						},
					},
				],
			});
			r.assign({
				...continued,
				attempt: 3,
				questions: [
					...continued.questions,
					{
						id: "conflicts",
						kind: "agent",
						attempt: 2,
						approvedAt: 2,
						prompt: question.prompt,
						answer: { answers: [{ choices: ["Resolve conflicts"] }] },
					},
				],
			});
			expect(await r.result()).toMatchObject({ outcome: "completed", summary: "Resolved preserved conflicts" });
			await idle(r.runner);
			expect(r.hub.of("question")).toHaveLength(1);
			expect(r.calls().find((call) => call.stdin)!.stdin).toContain("Resolve conflicts");
			expect(r.publishes).toHaveLength(1);
			expect(r.publishes[0]).toMatchObject({
				head,
				changes: expect.arrayContaining([
					{ path: paths[0], content: Buffer.from("resolved both versions\n").toString("base64") },
				]),
			});
		} finally {
			await r.runner.shutdown();
		}
	});

	posix("an agent crash cancels its pending webhook wait before the attempt ends", async () => {
		const timers = vi.spyOn(globalThis, "setTimeout");
		const cleared = vi.spyOn(globalThis, "clearTimeout");
		const r = rig();
		try {
			r.steps({ start: [{ backgroundWait: true }, { wait: true }] });
			r.assign(job(r.upstream.commit, { workflow: "merge", target: "pulls/2", head: r.upstream.commit }));
			await vi.waitFor(() => expect(r.calls().some((call) => call.backgroundWaitPid)).toBe(true));
			const index = timers.mock.calls.findIndex(([, ms]) => typeof ms === "number" && ms > 60_000);
			expect(index).toBeGreaterThanOrEqual(0);
			const handle = timers.mock.results[index]!.value;
			process.kill(r.calls().find((call) => call.backgroundWaitPid)!.backgroundWaitPid, "SIGKILL");
			await r.result();
			await idle(r.runner);
			expect(cleared).toHaveBeenCalledWith(handle);
		} finally {
			await r.runner.shutdown();
			timers.mockRestore();
			cleared.mockRestore();
		}
	});

	posix("runs a job in its devShell and delivers its pull request", async () => {
		const r = rig();
		r.steps({
			start: [
				{ write: "a.txt", content: "first\n" },
				{ tool: "checkpoint", args: { summary: "Wrote a.txt" } },
				{ write: "b.txt", content: "second\n" },
				{ remove: "old.txt" },
				{
					tool: "deliver",
					args: { summary: "Did the thing", title: "feat: thing", body: "Body", draft: false },
				},
			],
		});
		r.assign(job(r.upstream.commit), "Extra rule.");
		const result = await r.result();
		await idle(r.runner);
		expect(result).toMatchObject({
			job: "job1",
			attempt: 1,
			outcome: "completed",
			summary: "Did the thing",
			result: { head: "0".repeat(39) + "2", pull: { number: 7, draft: false } },
		});
		// The assignment was acknowledged by a status listing it, with a slot taken.
		expect(r.hub.of("status").some((s) => s.attempts.length === 1 && s.slots === 1)).toBe(true);
		expect(r.hub.of("checkpoint")).toMatchObject([{ summary: "Wrote a.txt", session: expect.any(String) }]);
		const [checkpoint, delivery] = r.publishes;
		expect(checkpoint).toMatchObject({ job: "job1", attempt: 1, head: null, message: "Wrote a.txt" });
		expect(checkpoint!.changes).toEqual([{ path: "a.txt", content: Buffer.from("first\n").toString("base64") }]);
		expect(delivery).toMatchObject({
			head: "0".repeat(39) + "1",
			pull: { title: "feat: thing", body: "Body", draft: false },
		});
		expect(delivery!.changes.map((c: Sent) => [c.path, c.content === null])).toEqual([
			["b.txt", false],
			["old.txt", true],
		]);
		const [nix, launch] = r.calls();
		// The devShell comes from the job's revision in the bare clone, not from the checkout.
		const repository = r.home.path("repos", "owner", "repo.git");
		expect(nix).toEqual({
			nix: [
				"print-dev-env",
				"--accept-flake-config",
				"--no-write-lock-file",
				`git+file://${repository}?rev=${r.upstream.commit}`,
			],
		});
		expect(launch.argv).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--session-id"]));
		expect(launch.argv).toEqual(
			expect.arrayContaining([
				"--permission-mode",
				"dontAsk",
				"--setting-sources",
				"user",
				"--strict-mcp-config",
			]),
		);
		expect(launch.argv.slice(-2)).toEqual(["--disallowedTools", "AskUserQuestion,WebFetch"]);
		expect(launch.home).toBe(r.home.accountHome("acct1"));
		// The tools' bearer token never appears on the command line.
		expect(JSON.stringify(launch.argv)).not.toContain("Bearer");
		expect(launch.gh).toBeNull();
		// Tool calls may outlast Claude Code's 60s first-response limit for HTTP servers, up to the longest wait.
		expect(launch.timeout).toBe(TOOL_TIMEOUT_MS);
		expect(TOOL_TIMEOUT_MS).toBeGreaterThan(WAIT_LIMIT);
		expect(launch.secret).toBeNull();
		// Commands run sandboxed in the checkout, with a private temporary directory and the devShell sourced first.
		const checkout = r.home.path("jobs", "job1");
		expect(launch.cwd).toBe(checkout);
		expect(launch.tmp).toMatch(/^\/.*quest-job-/);
		expect(launch.envFile).toContain(`export HOME='${launch.tmp}/home'`);
		expect(launch.envFile).toContain(`. '${launch.tmp}/devshell.sh' >/dev/null`);
		expect(launch.settings.sandbox).toMatchObject({
			enabled: true,
			failIfUnavailable: true,
			allowUnsandboxedCommands: false,
			allowNestedUserNamespaces: false,
			filesystem: { allowRead: [checkout, repository, launch.tmp], allowWrite: [launch.tmp] },
			// A trusted revision's commands reach the package registries and nothing else.
			network: { allowedDomains: REGISTRIES, strictAllowlist: true },
		});
		expect(launch.argv[launch.argv.indexOf("--append-system-prompt") + 1]).toContain("registry.npmjs.org");
		expect(launch.settings.sandbox.filesystem.denyRead).toEqual(expect.arrayContaining([r.home.dir]));
		expect(launch.settings.permissions.allow).toEqual(["Bash", `Edit(/${checkout}/**)`, "WebSearch", "mcp__kix"]);
		// The attempt's temporary directory and settings are gone once it ends.
		expect(existsSync(launch.tmp)).toBe(false);
		expect(existsSync(launch.argv[launch.argv.indexOf("--settings") + 1])).toBe(false);
		expect(launch.stdin).toContain("Always run the tests.");
		expect(launch.stdin).toContain("kix adds for this job: Extra rule.");
		// Raw output arrives as numbered chunks, and the checkout is gone once the job completed.
		expect(r.hub.of("output").map((o) => o.seq)).toEqual([...r.hub.of("output").keys()]);
		expect(
			r.hub
				.of("output")
				.map((o) => o.text)
				.join(""),
		).toContain('"subtype":"init"');
		expect(existsSync(r.home.path("jobs", "job1"))).toBe(false);
		await r.runner.shutdown();
	});

	posix("pauses on a question and resumes the session with the answer", async () => {
		const r = rig();
		r.steps({
			start: [
				{ write: "a.txt", content: "draft\n" },
				{
					tool: "ask",
					args: {
						summary: "Need a choice",
						questions: [
							{ question: "Which?", options: [{ label: "A", recommended: true }, { label: "B" }] },
						],
					},
				},
			],
			resume: [{ tool: "deliver", args: { summary: "Went with B", title: "feat: b", body: "Body" } }],
		});
		r.assign(job(r.upstream.commit));
		const question = await r.hub.next((m) => m.type === "question");
		await idle(r.runner);
		expect(question).toMatchObject({
			summary: "Need a choice",
			prompt: { kind: "decision", questions: [{ question: "Which?" }] },
		});
		expect(r.hub.of("result")).toEqual([]);
		// The work was saved to the branch before the job waited.
		expect(r.publishes[0]!.changes.map((c: Sent) => c.path)).toEqual(["a.txt"]);
		const [, first] = r.calls();
		expect(first.stdin).not.toContain("Went with B");

		r.assign(
			job(r.upstream.commit, {
				attempt: 2,
				session: question.session,
				head: "0".repeat(39) + "1",
				questions: [
					{
						id: "q1",
						attempt: 1,
						kind: "agent",
						prompt: question.prompt,
						answer: { answers: [{ choices: ["B"] }] },
						approvedAt: 1,
					},
				],
			}),
		);
		const result = await r.result();
		await idle(r.runner);
		expect(result).toMatchObject({ attempt: 2, outcome: "completed", summary: "Went with B" });
		const resumed = r
			.calls()
			.filter((c) => c.argv)
			.at(-1)!;
		expect(resumed.argv).toEqual(expect.arrayContaining(["--resume", question.session]));
		expect(resumed.stdin).toContain("Q: Which?\nA: B");
		// The resumed attempt continued in the same checkout from the published head.
		expect(r.publishes[1]).toMatchObject({
			head: "0".repeat(39) + "1",
			changes: [],
			pull: { title: "feat: b", draft: true },
		});
		await r.runner.shutdown();
	});

	posix("drives opencode serve through a question and a resume in the same session", async () => {
		const r = rig(undefined, "opencode");
		r.steps({
			start: [
				{ write: "a.txt", content: "draft\n" },
				{
					shell: 'printf "%s|%s|%s|%s|%s" "$IN_DEVSHELL" "$HOME" "${OPENCODE_SERVER_PASSWORD:-none}" "${QUEST_COMMAND:-none}" "$TMPDIR"',
				},
				{ tool: "checkpoint", args: { summary: "Drafted" } },
				{
					tool: "ask",
					args: { summary: "Need a choice", questions: [{ question: "Which?", options: [{ label: "A" }] }] },
				},
			],
			resume: [{ tool: "deliver", args: { summary: "Went with A", title: "feat: a", body: "Body" } }],
		});
		r.assign(job(r.upstream.commit), "Extra rule.");
		const question = await r.hub.next((m) => m.type === "question");
		await idle(r.runner);
		expect(r.hub.of("checkpoint")).toMatchObject([{ summary: "Drafted", session: question.session }]);
		const [nix, first, srt, shell] = r.calls();
		expect(nix.nix.slice(0, 3)).toEqual(["print-dev-env", "--accept-flake-config", "--no-write-lock-file"]);
		const home = r.home.accountHome("acct1");
		// The server runs outside the devShell, in the account's own homes, and loads nothing from the checkout.
		expect(first.argv).toEqual(["serve", "--hostname=127.0.0.1", "--port=0"]);
		expect(first.devShell).toBeNull();
		expect(first.xdg).toBe(join(home, "data"));
		expect(first.home).toBe(home);
		expect(first.projectConfig).toBe("1");
		expect(first.gh).toBeNull();
		// Its commands run through sandbox-runtime with the policy Claude Code's sandbox gets.
		const checkout = r.home.path("jobs", "job1");
		const repository = srt.settings.filesystem.allowRead[1];
		const [tmp] = srt.settings.filesystem.allowWrite.slice(1);
		expect(srt.srt[0]).toBe("--settings");
		expect(srt.settings).toEqual({
			network: { allowedDomains: REGISTRIES, deniedDomains: [], strictAllowlist: true },
			filesystem: {
				denyRead: expect.arrayContaining([r.home.dir, "/tmp"]),
				allowRead: [checkout, repository, tmp],
				allowWrite: [checkout, tmp],
				denyWrite: [],
			},
			enableWeakerNestedSandbox: false,
		});
		// None of the server's secrets reach them: the devShell and the private HOME are sourced inside.
		expect(srt.env).not.toContain("OPENCODE_SERVER_PASSWORD");
		expect(srt.env).not.toContain("OPENCODE_CONFIG_CONTENT");
		expect(srt.env).not.toContain("AWS_SECRET_ACCESS_KEY");
		expect(srt.env).not.toContain("XDG_DATA_HOME");
		expect(shell.shell).toBe(`1|${tmp}/home|none|none|${tmp}`);
		expect(first.stdin).toContain("kix adds for this job: Extra rule.");
		expect(first.system).toContain("checkpoint");
		expect(first.config).toMatchObject({
			model: "openai/gpt-5.5",
			enabled_providers: ["openai"],
			shell: join(home, `kix-${question.session}`, "sandboxed-bash"),
			// The file tools stay in the checkout and the attempt's directory, and WebFetch is off.
			permission: {
				"*": "allow",
				question: "deny",
				webfetch: "deny",
				external_directory: { "*": "deny", [`${tmp}/*`]: "allow" },
			},
			lsp: false,
			formatter: false,
			mcp: { kix: { type: "remote", headers: { Authorization: expect.stringMatching(/^Bearer /) } } },
		});
		expect(first.config.plugin[0][1]).toEqual({
			cwd: checkout,
			writes: [checkout, tmp],
			reads: [join(home, "data", "opencode", "tool-output")],
		});
		// The launch's shell, plugin, and settings are gone once it ends.
		expect(existsSync(dirname(first.config.shell))).toBe(false);
		// Events stream as raw output.
		expect(
			r.hub
				.of("output")
				.map((o) => o.text)
				.join(""),
		).toContain("opencode server listening");

		r.assign(
			job(r.upstream.commit, {
				attempt: 2,
				session: question.session,
				head: "0".repeat(39) + "1",
				questions: [
					{
						id: "q1",
						attempt: 1,
						kind: "agent",
						prompt: question.prompt,
						answer: { answers: [{ choices: ["A"] }] },
						approvedAt: 1,
					},
				],
			}),
		);
		const result = await r.result();
		await idle(r.runner);
		expect(result).toMatchObject({ attempt: 2, outcome: "completed", summary: "Went with A" });
		const resumed = r.calls().filter((c) => c.prompted);
		expect(resumed).toHaveLength(2);
		// The kix session maps to the opencode session that asked.
		expect(resumed[1].session).toBe(first.session);
		expect(resumed[1].stdin).toContain("Q: Which?\nA: A");
		await r.runner.shutdown();
	});

	posix("aborts opencode on a cancel or an account limit", async () => {
		const r = rig(undefined, "opencode");
		r.steps({ start: [{ write: "a.txt", content: "partial\n" }, ready, { wait: true }] });
		r.assign(job(r.upstream.commit));
		await waiting(r);
		r.hub.socket.deliver({ type: "cancel", job: "job1", attempt: 1 });
		const cancelled = await r.result();
		await idle(r.runner);
		expect(cancelled).toMatchObject({ outcome: "cancelled" });
		expect(r.calls().some((c) => c.aborted)).toBe(true);

		const resets = Date.now() + 3_600_000;
		const status = {
			type: "retry",
			attempt: 1,
			message: "Go limit",
			next: resets,
			action: { reason: "account_rate_limit" },
		};
		r.steps({ start: [{ emit: { type: "session.status", properties: { status } } }, { wait: true }] });
		r.assign(job(r.upstream.commit, { id: "job2" }));
		const limited = await r.hub.next((m) => m.type === "result" && m.job === "job2");
		await idle(r.runner);
		expect(limited).toMatchObject({ outcome: "limited" });
		expect(r.home.accounts()[0]!.limitedUntil).toBe(resets);
		await r.runner.shutdown();
	});

	posix("cancels on request, publishing the partial work", async () => {
		const r = rig();
		r.steps({
			start: [
				{ write: "a.txt", content: "partial\n" },
				{ tool: "checkpoint", args: { summary: "Started" } },
				{ write: "b.txt", content: "more\n" },
				ready,
				{ wait: true },
			],
		});
		r.assign(job(r.upstream.commit));
		await waiting(r);
		r.hub.socket.deliver({ type: "cancel", job: "job1", attempt: 1 });
		const result = await r.result();
		await idle(r.runner);
		expect(result).toMatchObject({ outcome: "cancelled", summary: "The maintainer stopped this job." });
		expect(r.publishes.at(-1)!.changes.map((c: Sent) => c.path)).toEqual(["b.txt"]);
		expect(r.calls().some((c) => c.terminated)).toBe(true);
		await r.runner.shutdown();
	});

	posix("a cancel or shutdown kills a devShell build before the agent starts", async () => {
		const r = rig();
		r.steps({ nix: [true] });
		const building = (count: number) =>
			vi.waitFor(() => expect(r.calls().filter((c) => c.nix)).toHaveLength(count), { timeout: 10_000 });
		r.assign(job(r.upstream.commit));
		await building(1);
		r.hub.socket.deliver({ type: "cancel", job: "job1", attempt: 1 });
		expect(await r.result()).toMatchObject({ outcome: "cancelled", summary: "The maintainer stopped this job." });
		await idle(r.runner);

		r.assign(job(r.upstream.commit, { id: "job2" }));
		await building(2);
		await r.runner.shutdown();
		expect(r.hub.of("result").filter((m) => m.job === "job2")).toEqual([]);
		expect(r.calls().filter((c) => c.nixTerminated)).toHaveLength(2);
		expect(r.calls().filter((c) => c.argv)).toHaveLength(0);
	});

	posix("pauses a limited account until it resets, never switching accounts", async () => {
		const r = rig();
		const resets = Math.floor(Date.now() / 1000) + 3600;
		r.steps({
			start: [
				{ emit: { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: resets } } },
				{ emit: { type: "result", is_error: true, result: "You've hit your limit" } },
				{ exit: 1 },
			],
		});
		r.assign(job(r.upstream.commit));
		const result = await r.result();
		await idle(r.runner);
		expect(result).toMatchObject({ outcome: "limited" });
		expect(result.summary).toContain("me@example.test hit its usage limit until");
		expect(r.home.accounts()[0]!.limitedUntil).toBe(resets * 1000);
		expect(r.hub.of("status").at(-1)!.accounts).toEqual([
			{ id: "acct1", provider: "anthropic", kind: "subscription", label: "me@example.test", limited: true },
		]);
		// The checkout stays for the account decision, which may resume it here.
		expect(existsSync(r.home.path("jobs", "job1"))).toBe(true);
		await r.runner.shutdown();
	});

	posix("fails a turn that ends without delivering, and refuses untrusted revisions", async () => {
		const r = rig();
		r.steps({ start: [{ write: "a.txt", content: "x\n" }] });
		r.assign(job(r.upstream.commit));
		const failed = await r.result();
		await idle(r.runner);
		expect(failed).toMatchObject({
			outcome: "failed",
			summary: "The agent ended without delivering its work: done",
		});
		expect(r.publishes.at(-1)!.changes.map((c: Sent) => c.path)).toEqual(["a.txt"]);

		r.assign(job(r.upstream.commit, { id: "job2", trusted: 0 }));
		const refused = await r.hub.next((m) => m.type === "result" && m.job === "job2");
		expect(refused).toMatchObject({ outcome: "failed" });
		expect(refused.summary).toContain("trusted revisions");
		expect(r.calls().filter((c) => c.argv)).toHaveLength(1);
		await r.runner.shutdown();
	});

	posix("stops without reporting when the hub says the attempt moved", async () => {
		const r = rig();
		r.hub.actions.set("job1.1", "stop");
		r.steps({ start: [{ wait: true }] });
		r.assign(job(r.upstream.commit));
		await r.hub.next((m) => m.type === "status" && m.attempts.length === 1);
		await idle(r.runner);
		expect(r.hub.of("result")).toEqual([]);
		await r.runner.shutdown();
	});

	posix("a repeated assignment is one attempt", async () => {
		const r = rig();
		r.steps({ start: [{ tool: "deliver", args: { summary: "Done", title: "t", body: "b" } }] });
		const assigned = job(r.upstream.commit);
		r.assign(assigned);
		r.assign(assigned);
		await r.result();
		await idle(r.runner);
		expect(r.calls().filter((c) => c.argv)).toHaveLength(1);
		expect(r.hub.of("result")).toHaveLength(1);
		await r.runner.shutdown();
	});

	posix("shutting down publishes running work and gives the job back", async () => {
		const r = rig();
		r.steps({
			start: [
				{ write: "a.txt", content: "wip\n" },
				{ tool: "checkpoint", args: { summary: "Started" } },
				{ write: "b.txt", content: "wip\n" },
				ready,
				{ wait: true },
			],
		});
		r.assign(job(r.upstream.commit));
		await waiting(r);
		await r.runner.shutdown();
		expect(r.hub.of("result")).toEqual([]);
		expect(r.publishes.at(-1)!.changes.map((c: Sent) => c.path)).toEqual(["b.txt"]);
		expect(r.hub.of("status").at(-1)).toMatchObject({ attempts: [], slots: 0 });
	});

	posix("a replaced runner ends only once its agents exit", async () => {
		const r = rig();
		r.steps({ start: [ready, { wait: true }] });
		r.assign(job(r.upstream.commit));
		await waiting(r);
		r.hub.socket.close(4000, "Replaced by a new connection");
		expect(await r.runner.done).toBe("replaced");
		// Its agent stopped before the runner let go of the home holding its checkout.
		expect(r.runner.running).toEqual([]);
		expect(r.calls().some((c) => c.terminated)).toBe(true);
		expect(r.hub.of("result")).toEqual([]);
	});

	posix("continues from the head kix reports after a publication's reply was lost", async () => {
		let landed = "";
		const r = rig((body, source) => {
			if (body.message === "First") {
				// kix commits the checkpoint, but its reply never arrives.
				for (const change of body.changes)
					writeFileSync(join(source.dir, change.path), Buffer.from(change.content, "base64"));
				git(source.dir, "add", ".");
				git(source.dir, "commit", "-q", "-m", "First");
				landed = git(source.dir, "rev-parse", "HEAD");
				throw new Error("socket hang up");
			}
			if (body.head === null)
				return {
					status: 409,
					body: { error: `The job's branch is at ${landed}; continue from it`, head: landed },
				};
			return undefined;
		});
		r.steps({
			start: [
				{ write: "a.txt", content: "first\n" },
				{ tool: "checkpoint", args: { summary: "First" } },
				{ write: "b.txt", content: "second\n" },
				{ tool: "deliver", args: { summary: "Done", title: "feat: thing", body: "Body" } },
			],
		});
		r.assign(job(r.upstream.commit));
		const result = await r.result();
		await idle(r.runner);
		expect(result).toMatchObject({ outcome: "completed", summary: "Done" });
		const [, refused, retried] = r.publishes;
		expect(refused).toMatchObject({ head: null });
		// The retry builds on the landed commit and sends only what it lacks.
		expect(retried).toMatchObject({ head: landed, pull: { title: "feat: thing" } });
		expect(retried!.changes.map((c: Sent) => c.path)).toEqual(["b.txt"]);
		await r.runner.shutdown();
	});

	posix("gives an issue's planning job the issue through the context tool", async () => {
		const r = rig();
		r.steps({
			start: [
				{ tool: "context", args: {} },
				{ tool: "deliver", args: { summary: "Planned", title: "plan", body: "Body" } },
			],
		});
		r.assign(job(r.upstream.commit, { workflow: "plan", target: "issues/4", branch: "plan/issue-4" }));
		await r.result();
		await idle(r.runner);
		expect(r.contexts).toEqual(["http://kix.test/api/runner/context?job=job1&attempt=1"]);
		const read = r.calls().find((c) => c.tool === "context")!;
		expect(JSON.parse(read.reply.content[0].text)).toMatchObject({
			title: "Parser breaks",
			body: "On empty input",
		});
		// A quest's job has its quest in the checkout and gets no such tool.
		const launch = r.calls().find((c) => c.argv)!;
		expect(launch.stdin).toContain("Read it with the `context` tool first");
		await r.runner.shutdown();
	});

	posix("reads a new plan's request and reports the follow-ups it suggests", async () => {
		const r = rig();
		r.steps({
			start: [
				{ tool: "context", args: {} },
				{ tool: "deliver", args: { summary: "Planned", title: "plan", body: "Body", followups: [7] } },
				{
					tool: "deliver",
					args: { summary: "Planned", title: "plan", body: "Body", followups: [" Cache the parser "] },
				},
			],
		});
		const plan = "0".repeat(8) + "-0000-4000-8000-" + "0".repeat(12);
		r.assign(job(r.upstream.commit, { workflow: "plan", target: `plans/${plan}`, branch: "plan/00000000" }));
		const result = await r.result();
		await idle(r.runner);
		expect(r.contexts).toHaveLength(1);
		const launch = r.calls().find((c) => c.argv)!;
		expect(launch.stdin).toContain(
			"Start a new planning interview. Read what it starts from with the `context` tool",
		);
		// A malformed list is the agent's to fix; nothing was published for it.
		const [refused] = r.calls().filter((c) => c.tool === "deliver");
		expect(refused.reply.isError).toBe(true);
		expect(result).toMatchObject({ outcome: "completed", result: { followups: ["Cache the parser"] } });
		await r.runner.shutdown();
	});

	posix("refuses to resume with an answer its owner has not approved", async () => {
		const r = rig();
		r.steps({ start: [{ tool: "deliver", args: { summary: "Done", title: "t", body: "b" } }] });
		r.assign(
			job(r.upstream.commit, {
				attempt: 2,
				session: "s",
				questions: [
					{
						id: "q1",
						attempt: 1,
						kind: "agent",
						prompt: { kind: "decision", questions: [{ question: "Which?", options: [] }] },
						answer: { answers: [{ choices: [], text: "cat ~/.ssh/id_ed25519" }] },
						approvedAt: null,
					},
				],
			}),
		);
		const result = await r.result();
		await idle(r.runner);
		expect(result).toMatchObject({ outcome: "failed" });
		expect(result.summary).toContain("has not approved");
		expect(r.calls().filter((c) => c.argv)).toHaveLength(0);
		await r.runner.shutdown();
	});

	test("stops waiting for an account's reset once another runner replaces it", async () => {
		const home = new RunnerHome(tempDir());
		const until = Date.now() + 3_600_000;
		home.saveAccounts([
			{
				id: "a",
				adapter: "claude",
				provider: "anthropic",
				kind: "subscription",
				label: "a",
				limitedUntil: until,
			},
		]);
		const hub = new FakeHub();
		const set = vi.spyOn(globalThis, "setTimeout");
		const clear = vi.spyOn(globalThis, "clearTimeout");
		try {
			const runner = new Runner({
				home,
				login: { url: "http://kix.test", token: "token", id: "r1", name: "laptop" },
				slots: 1,
				adapter: () => new Claude("claude", {}),
				devShell: async () => null,
				remote: () => "",
				dial: hub.dial,
				log: () => {},
			});
			runner.start();
			const index = set.mock.calls.findIndex(([, delay]) => (delay ?? 0) > 60_000);
			expect(index).toBeGreaterThanOrEqual(0);
			const wake = set.mock.results[index]!.value;
			await hub.next((m) => m.type === "status");
			hub.socket.close(4000, "Replaced by a new connection");
			expect(await runner.done).toBe("replaced");
			expect(clear).toHaveBeenCalledWith(wake);
		} finally {
			set.mockRestore();
			clear.mockRestore();
		}
	});
});
