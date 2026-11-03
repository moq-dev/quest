import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Owner, Retained, type Scopes, currentOwner, kill, killable } from "../src/cli/supervise";
import { GitHub, mergedHead } from "../src/cli/github";
import { main } from "../src/cli/main";
import { Worktrees, canonical, derivedDefaults, diskUsage } from "../src/cli/worktree";
import { claudeHook } from "../src/cli/worktree-hook";
import { initRepository, run, template } from "./fixture";

const source = dirname(dirname(fileURLToPath(import.meta.url)));
const roots: string[] = [];
function git(root: string, ...args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
/** A repository whose main holds one file and ignores scratch, at `path`. */
const repository: (path: string) => string = template((dir) => {
	initRepository(dir);
	writeFileSync(join(dir, "file"), "original\n");
	writeFileSync(join(dir, ".gitignore"), "cache/\n.env\n.worktrees/\n");
	git(dir, "add", ".");
	git(dir, "commit", "-q", "-m", "initial");
});

/** Scopes that are never live and whose runs exit at once, except where `overrides` says otherwise. */
function stubScopes(overrides: Partial<Scopes>): Scopes {
	return { check() {}, live: () => false, run: () => Promise.resolve(0), stop: async () => {}, ...overrides };
}
/** Scopes whose runs finish when the test says so, and stay live while listed until stopped. */
function fakeScopes() {
	const live = new Set<string>();
	const finish = new Map<string, (code: number) => void>();
	const scopes = stubScopes({
		live: (unit) => live.has(unit),
		run: (unit) => new Promise((resolve) => finish.set(unit, resolve)),
		stop: async (unit) => void live.delete(unit),
	});
	return { live, finish, scopes };
}
/** Record a run whose supervisor crashed, as `quest worktree run` leaves it. */
function orphan(home: string, unit: string, owner: Owner = deadOwner()) {
	const file = join(home, "registry.json");
	const registry = JSON.parse(readFileSync(file, "utf8"));
	registry.records[0].runs.push({ unit, owner });
	writeFileSync(file, JSON.stringify(registry));
}
function fixture(scopes?: Scopes) {
	const root = mkdtempSync(join(tmpdir(), "quest-worktree-test-"));
	roots.push(root);
	const repo = repository(join(root, "repo"));
	const home = join(root, "state");
	const worktrees = new Worktrees(home, scopes);
	worktrees.configure(100_000_000);
	return { root, repo, home, worktrees };
}
/** A process that has exited, identified so it can never match a live one. */
function deadOwner() {
	return { host: hostname(), pid: spawnSync(process.execPath, ["-e", ""]).pid!, start: "0" };
}
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Cases run up to 20 real Git processes. Process creation on the Windows ARM runner
// costs ~80-250 ms while other test files start, so the 5 s unit-test default is too short.
describe("worktrees", { timeout: 20_000 }, () => {
	it("prunes declared scratch in place and keeps source, Git state, and untracked files", async () => {
		const { repo, worktrees } = fixture();
		const record = await worktrees.create(repo, "work", 10_000_000, "HEAD", ["cache/", "cache/nested", "missing"]);
		expect(record.scratch).toEqual(["cache", "cache/nested", "missing"]);
		writeFileSync(join(record.path, "file"), "committed\n");
		git(record.path, "commit", "-am", "local only");
		const head = git(record.path, "rev-parse", "HEAD");
		writeFileSync(join(record.path, "file"), "staged\n");
		git(record.path, "add", "file");
		writeFileSync(join(record.path, "file"), "unstaged\n");
		writeFileSync(join(record.path, "new-source"), "untracked source");
		writeFileSync(join(record.path, ".env"), "ignored and undeclared");
		mkdirSync(join(record.path, "cache", "nested"), { recursive: true });
		writeFileSync(join(record.path, "cache", "nested", "artifact"), "disposable");
		const status = git(record.path, "status", "--porcelain=v1");
		expect(worktrees.release(record.id).phase).toBe("released");
		expect(existsSync(join(record.path, "cache"))).toBe(false);
		expect(git(record.path, "status", "--porcelain=v1")).toBe(status);
		expect(git(record.path, "rev-parse", "HEAD")).toBe(head);
		expect(git(record.path, "show", ":file")).toBe("staged");
		expect(readFileSync(join(record.path, "file"), "utf8")).toBe("unstaged\n");
		expect(readFileSync(join(record.path, "new-source"), "utf8")).toBe("untracked source");
		expect(readFileSync(join(record.path, ".env"), "utf8")).toBe("ignored and undeclared");
		expect(worktrees.restore(record.id).phase).toBe("active");
	});
	it("refuses scratch that is tracked, not ignored, or outside the checkout", async () => {
		const { repo, worktrees } = fixture();
		for (const path of ["../outside", ".git", ".GIT", "/absolute", ".", "./", ""])
			await expect(worktrees.create(repo, "invalid", 10_000_000, "HEAD", [path])).rejects.toThrow(
				"relative path",
			);
		let count = 0;
		const declare = async (scratch: string) => {
			const record = await worktrees.create(repo, `case-${count++}`, 1_000_000, "HEAD", [scratch]);
			writeFileSync(join(record.path, "new"), "source");
			mkdirSync(join(record.path, "cache"));
			writeFileSync(join(record.path, "cache", "forced"), "tracked despite the ignore rule");
			git(record.path, "add", "-f", "cache/forced");
			return record;
		};
		const tracked = await declare("file");
		expect(() => worktrees.release(tracked.id)).toThrow("tracked files: file");
		const cached = await declare("cache");
		expect(() => worktrees.release(cached.id)).toThrow("tracked files: cache/forced");
		// Another spelling, which a case-insensitive filesystem resolves to the tracked directory.
		const aliased = await declare("CACHE");
		mkdirSync(join(aliased.path, "CACHE"), { recursive: true });
		appendFileSync(join(repo, ".git", "info", "exclude"), "/CACHE/\n");
		expect(() => worktrees.release(aliased.id)).toThrow("tracked files: cache/forced");
		const unignored = await declare("new");
		expect(() => worktrees.release(unignored.id)).toThrow("ignored by Git: new");
		// Any other alias of the .git entry, here a hard link that an ignore rule matches.
		const linked = await declare(".env");
		linkSync(join(linked.path, ".git"), join(linked.path, ".env"));
		expect(() => worktrees.release(linked.id)).toThrow(".git entry: .env");
		expect(readFileSync(join(unignored.path, "new"), "utf8")).toBe("source");
		expect(readFileSync(join(unignored.path, "cache", "forced"), "utf8")).toBe("tracked despite the ignore rule");
		expect(worktrees.status().records.every((record) => record.phase === "active")).toBe(true);
	});
	it.skipIf(process.platform === "win32")("never follows symlinks out of the checkout", async () => {
		const { root, repo, worktrees } = fixture();
		const outside = join(root, "outside");
		mkdirSync(join(outside, "cache"), { recursive: true });
		writeFileSync(join(outside, "cache", "keep"), "outside");
		const through = await worktrees.create(repo, "through", 10_000_000, "HEAD", ["linked/cache"]);
		symlinkSync(outside, join(through.path, "linked"));
		expect(() => worktrees.release(through.id)).toThrow("reached through a symlink");
		const record = await worktrees.create(repo, "work", 10_000_000, "HEAD", ["cache", ".env"]);
		mkdirSync(join(record.path, "cache"));
		symlinkSync(outside, join(record.path, "cache", "link"));
		symlinkSync(outside, join(record.path, ".env"));
		worktrees.release(record.id);
		expect(existsSync(join(record.path, "cache"))).toBe(false);
		expect(existsSync(join(record.path, ".env"))).toBe(false);
		expect(readFileSync(join(outside, "cache", "keep"), "utf8")).toBe("outside");
	});
	it.skipIf(process.platform === "win32")("unlinks a scratch symlink to another worktree", async () => {
		const { repo, worktrees } = fixture();
		const other = await worktrees.create(repo, "other", 10_000_000);
		const record = await worktrees.create(repo, "work", 10_000_000, "HEAD", [".env"]);
		symlinkSync(other.path, join(record.path, ".env"));
		expect(worktrees.release(record.id).phase).toBe("released");
		expect(existsSync(join(record.path, ".env"))).toBe(false);
		expect(existsSync(join(other.path, "file"))).toBe(true);
	});
	it.skipIf(process.platform === "win32")(
		"charges allocated blocks of dangling symlinks and sparse files",
		async () => {
			const { root } = fixture();
			const dangling = join(root, "dangling");
			symlinkSync("missing", dangling);
			expect(diskUsage(dangling)).toBe(lstatSync(dangling).blocks * 512);
			const sparse = join(root, "sparse");
			writeFileSync(sparse, "");
			truncateSync(sparse, 1 << 30);
			expect(diskUsage(sparse)).toBeLessThan(1 << 20);
			const linked = join(root, "linked");
			mkdirSync(linked);
			writeFileSync(join(linked, "a"), Buffer.alloc(1 << 16, 1));
			linkSync(join(linked, "a"), join(linked, "b"));
			expect(diskUsage(linked)).toBe((lstatSync(linked).blocks + lstatSync(join(linked, "a")).blocks) * 512);
		},
	);
	it("charges active reservations and the footprint released checkouts keep", async () => {
		const { repo, worktrees } = fixture();
		const reserve = 1_000_000;
		worktrees.configure(reserve);
		const record = await worktrees.create(repo, "work", reserve);
		expect(worktrees.status().allocated).toBe(reserve);
		worktrees.release(record.id);
		const retained = worktrees.status().allocated;
		expect(retained).toBeGreaterThan(0);
		expect(retained).toBeLessThan(reserve);
		await worktrees.create(repo, "other", reserve - retained);
		expect(() => worktrees.restore(record.id)).toThrow("disk capacity exceeded");
		expect(worktrees.status().records[0].phase).toBe("released");
	});
	it("drops the record once its checkout is removed", async () => {
		const { repo, worktrees } = fixture();
		const record = await worktrees.create(repo, "work", 10_000_000, "HEAD", ["missing"]);
		expect(() => worktrees.release(record.id)).not.toThrow();
		git(repo, "worktree", "unlock", record.path);
		git(repo, "worktree", "remove", record.path);
		worktrees.release(record.id);
		expect(worktrees.status().records).toEqual([]);
		expect(() => worktrees.restore(record.id)).toThrow("unknown worktree");
		expect((await worktrees.create(repo, "work", 10_000_000)).phase).toBe("active");
	});
	it("removes a finished checkout once a branch or remote-tracking ref reaches its commits", async () => {
		const { repo, worktrees } = fixture();
		const forge = vi.fn(async () => false);
		const record = await worktrees.create(repo, "work", 10_000_000, "HEAD", ["cache"]);
		mkdirSync(join(record.path, "cache"));
		writeFileSync(join(record.path, "cache", "artifact"), "disposable");
		writeFileSync(join(record.path, "file"), "pushed\n");
		git(record.path, "commit", "-am", "pushed");
		const head = git(record.path, "rev-parse", "HEAD");
		await expect(worktrees.remove(record.id, forge)).rejects.toThrow(
			`remote-tracking ref reaches, and no merged change has as its head: ${head}`,
		);
		expect(forge.mock.calls).toEqual([[record.repository, head]]);
		git(record.path, "update-ref", "refs/remotes/origin/work", "HEAD");
		forge.mockClear();
		expect((await worktrees.remove(record.id, forge)).id).toBe(record.id);
		expect(forge).not.toHaveBeenCalled();
		expect(existsSync(record.path)).toBe(false);
		expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(".worktrees/work");
		expect(worktrees.status().records).toEqual([]);
		await expect(worktrees.remove(record.id)).rejects.toThrow("unknown worktree");
		// A branch made in the checkout outlives it, so its commits are preserved.
		const branched = await worktrees.create(repo, "branched", 10_000_000);
		git(branched.path, "switch", "-c", "topic");
		git(branched.path, "commit", "--allow-empty", "-m", "on a branch");
		const tip = git(branched.path, "rev-parse", "HEAD");
		await worktrees.remove(branched.id);
		expect(git(repo, "rev-parse", "topic")).toBe(tip);
		// A checkout already removed by hand only drops its record.
		const gone = await worktrees.create(repo, "gone", 10_000_000);
		git(repo, "worktree", "unlock", gone.path);
		git(repo, "worktree", "remove", gone.path);
		await worktrees.remove(gone.id);
		expect(worktrees.status().records).toEqual([]);
	});
	it("removes a squash-merged checkout only when a merged change's head is exactly its commit", async () => {
		const { repo, worktrees } = fixture();
		const record = await worktrees.create(repo, "work", 10_000_000);
		git(record.path, "commit", "--allow-empty", "-m", "first");
		const first = git(record.path, "rev-parse", "HEAD");
		git(record.path, "commit", "--allow-empty", "-m", "second");
		const head = git(record.path, "rev-parse", "HEAD");
		// A merged change whose head is an ancestor leaves the later commit unpreserved.
		await expect(worktrees.remove(record.id, async (_, commit) => commit === first)).rejects.toThrow(head);
		expect(existsSync(record.path)).toBe(true);
		await worktrees.remove(
			record.id,
			async (repository, commit) => repository === record.repository && commit === head,
		);
		expect(existsSync(record.path)).toBe(false);
	});
	it("refuses to remove a checkout holding work that is not preserved", async () => {
		const { live, scopes } = fakeScopes();
		const { root, repo, home, worktrees } = fixture(scopes);
		const record = await worktrees.create(repo, "work", 10_000_000, "HEAD", ["cache"]);
		const kept = () => {
			expect(existsSync(join(record.path, "file"))).toBe(true);
			expect(worktrees.status().records).toHaveLength(1);
		};
		writeFileSync(join(record.path, "file"), "modified\n");
		await expect(worktrees.remove(record.id)).rejects.toThrow("modified or untracked files:  M file");
		git(record.path, "checkout", "--", "file");
		writeFileSync(join(record.path, "new"), "untracked");
		await expect(worktrees.remove(record.id)).rejects.toThrow("modified or untracked files: ?? new");
		rmSync(join(record.path, "new"));
		kept();
		// A ref that only this checkout holds, such as a bisect mark, is deleted with it.
		git(record.path, "commit", "--allow-empty", "-m", "marked");
		const marked = git(record.path, "rev-parse", "HEAD");
		git(record.path, "update-ref", "refs/bisect/bad", "HEAD");
		git(record.path, "checkout", "--detach", "HEAD~1");
		await expect(worktrees.remove(record.id)).rejects.toThrow(marked);
		git(record.path, "update-ref", "-d", "refs/bisect/bad");
		kept();
		orphan(home, "orphan.scope");
		live.add("orphan.scope");
		await expect(worktrees.remove(record.id)).rejects.toThrow("supervised runs are live");
		live.delete("orphan.scope");
		// Ignored files nobody declared as scratch stay; the declared scratch is pruned first.
		mkdirSync(join(record.path, "cache"));
		writeFileSync(join(record.path, ".env"), "secret");
		await expect(worktrees.remove(record.id)).rejects.toThrow(
			"declared scratch remain, so the checkout was only released:",
		);
		expect(existsSync(join(record.path, "cache"))).toBe(false);
		expect(readFileSync(join(record.path, ".env"), "utf8")).toBe("secret");
		expect(worktrees.status().records[0].phase).toBe("released");
		rmSync(join(record.path, ".env"));
		// A clean submodule whose commits its remote has does not prevent removal.
		const sub = repository(join(root, "sub"));
		git(record.path, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", sub, "sub");
		git(record.path, "commit", "-m", "submodule");
		git(record.path, "update-ref", "refs/remotes/origin/work", "HEAD");
		await worktrees.remove(record.id);
		expect(existsSync(record.path)).toBe(false);
	});
	it("initializes nested submodules before returning a new checkout and preserves them on restore", async () => {
		const { root, repo, worktrees } = fixture();
		vi.stubEnv("GIT_ALLOW_PROTOCOL", "file");
		const inner = repository(join(root, "inner"));
		const sub = repository(join(root, "sub"));
		git(sub, "submodule", "add", "--quiet", inner, "nested/inner");
		git(sub, "commit", "-am", "nested submodule");
		git(repo, "submodule", "add", "--quiet", sub, "sub");
		git(repo, "commit", "-am", "submodule");
		const record = await worktrees.create(repo, "nested", 10_000_000, "HEAD", ["sub/nested/inner/cache"]);
		const nested = join(record.path, "sub", "nested", "inner");
		expect(readFileSync(join(nested, "file"), "utf8")).toBe("original\n");
		const direct = (await claudeHook(
			{ hook_event_name: "WorktreeCreate", cwd: nested, name: "direct" },
			worktrees,
			async () => false,
			nested,
		))!.trim();
		expect(direct).toBe(join(canonical(nested), ".worktrees", "direct"));
		const child = (await claudeHook(
			{ hook_event_name: "WorktreeCreate", cwd: nested, name: "agent-child" },
			worktrees,
			async () => false,
			repo,
		))!.trim();
		expect(child).toBe(join(canonical(repo), ".worktrees", "agent-child"));
		expect(git(child, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "HEAD"));
		await claudeHook(
			{ hook_event_name: "SubagentStop", cwd: join(child, "sub", "nested", "inner"), agent_id: "child" },
			worktrees,
			async () => false,
		);
		expect(worktrees.status().records.find((record) => record.name === "agent-child")?.phase).toBe("released");
		await claudeHook(
			{ hook_event_name: "SubagentStart", cwd: join(child, "sub"), agent_id: "child" },
			worktrees,
			async () => false,
		);
		expect(worktrees.status().records.find((record) => record.name === "agent-child")?.phase).toBe("active");
		writeFileSync(join(nested, "file"), "local work");
		mkdirSync(join(nested, "cache"));
		writeFileSync(join(nested, "cache", "output"), "build output");
		worktrees.release(record.id);
		worktrees.restore(record.id);
		expect(existsSync(join(nested, "cache"))).toBe(false);
		expect(readFileSync(join(nested, "file"), "utf8")).toBe("local work");
	});
	it("ignores inherited Git location variables that select a submodule", async () => {
		const { root, repo, worktrees } = fixture();
		vi.stubEnv("GIT_ALLOW_PROTOCOL", "file");
		const sub = repository(join(root, "sub"));
		git(repo, "submodule", "add", "--quiet", sub, "sub");
		git(repo, "commit", "-am", "submodule");
		const module = join(repo, "sub");
		// A Git hook or `git submodule foreach` running the session exports these for the submodule.
		const store = git(module, "rev-parse", "--absolute-git-dir");
		vi.stubEnv("GIT_DIR", store);
		vi.stubEnv("GIT_WORK_TREE", module);
		vi.stubEnv("GIT_INDEX_FILE", join(store, "index"));
		const path = (await claudeHook(
			{ hook_event_name: "WorktreeCreate", cwd: module, name: "agent-located" },
			worktrees,
			async () => false,
			repo,
		))!.trim();
		expect(path).toBe(join(canonical(repo), ".worktrees", "agent-located"));
		expect(readFileSync(join(path, "sub", "file"), "utf8")).toBe("original\n");
		const [record] = worktrees.status().records;
		expect(record.repository).toBe(canonical(repo));
		// Removal inspects the checkout itself, not the submodule the variables name.
		writeFileSync(join(path, "file"), "local work");
		await expect(worktrees.remove(record.id)).rejects.toThrow("checkout has modified or untracked files:  M file");
		expect(readFileSync(join(path, "file"), "utf8")).toBe("local work");
	});
	it("charges cloned module stores and keeps one that serves another worktree", async () => {
		const { root, repo, worktrees } = fixture();
		vi.stubEnv("GIT_ALLOW_PROTOCOL", "file");
		const sub = repository(join(root, "sub"));
		// Incompressible, so the module store holds about as much as the checked-out file.
		writeFileSync(join(sub, "blob"), randomBytes(1 << 20));
		git(sub, "add", "blob");
		git(sub, "commit", "-q", "-m", "blob");
		git(repo, "submodule", "add", "--quiet", sub, "sub");
		git(repo, "commit", "-am", "submodule");
		expect(derivedDefaults(repo).reserve).toBeGreaterThan(2 << 20);
		const record = await worktrees.create(repo, "stores", 1);
		worktrees.release(record.id);
		expect(worktrees.status().allocated).toBeGreaterThan(2 << 20);
		const elsewhere = join(root, "elsewhere");
		git(join(record.path, "sub"), "worktree", "add", "--quiet", "--detach", elsewhere);
		await expect(worktrees.remove(record.id)).rejects.toThrow("has linked worktrees that removal would break");
		expect(git(elsewhere, "rev-parse", "HEAD")).toBe(git(join(record.path, "sub"), "rev-parse", "HEAD"));
		git(join(record.path, "sub"), "worktree", "remove", elsewhere);
		await worktrees.remove(record.id);
		expect(existsSync(record.path)).toBe(false);
	});
	it("protects a live creation without giving interrupted-checkout removal advice", async () => {
		const { repo, worktrees } = fixture();
		const creation = worktrees.create(repo, "live", 10_000_000);
		const [record] = worktrees.status().records;
		expect(record.phase).toBe("creating");
		expect(() => worktrees.release(record.id)).toThrow("creation is still running");
		await creation;
		expect(worktrees.status().records[0].creator).toBeUndefined();
	});
	it("records remotely fetched module pins and tags outside the branch-prune namespace", async () => {
		const { root, repo, worktrees } = fixture();
		vi.stubEnv("GIT_ALLOW_PROTOCOL", "file");
		const sub = repository(join(root, "sub"));
		git(sub, "commit", "--allow-empty", "-m", "published pin");
		const pin = git(sub, "rev-parse", "HEAD");
		git(sub, "tag", "-a", "published", "-m", "remote tag", pin);
		git(sub, "reset", "--hard", "HEAD~1");
		for (const name of ["pinned", "tagged"]) git(repo, "submodule", "add", "--quiet", sub, name);
		git(join(repo, "pinned"), "checkout", "--detach", pin);
		git(repo, "commit", "-am", "modules");
		const record = await worktrees.create(repo, "published", 10_000_000);
		for (const name of ["pinned", "tagged"]) {
			const module = join(record.path, name);
			expect(git(module, "rev-list", "HEAD", "--all", "--not", "--remotes")).toBe("");
			git(module, "fetch", "--prune", "origin");
			expect(git(module, "rev-list", "HEAD", "--all", "--not", "--remotes")).toBe("");
		}
		await worktrees.remove(record.id);
		expect(existsSync(record.path)).toBe(false);
	});
	it("keeps a partly initialized creation charged and gives recovery advice for its lock and submodules", async () => {
		const { root, repo, worktrees } = fixture();
		vi.stubEnv("GIT_ALLOW_PROTOCOL", "file");
		const sub = repository(join(root, "sub"));
		git(repo, "submodule", "add", "--quiet", sub, "first");
		git(repo, "submodule", "add", "--quiet", sub, "second");
		git(repo, "config", "-f", ".gitmodules", "submodule.second.url", join(root, "missing"));
		git(repo, "config", "submodule.second.url", join(root, "missing"));
		git(repo, "commit", "-am", "submodules");
		await expect(worktrees.create(repo, "partial", 10_000_000)).rejects.toThrow();
		const [record] = worktrees.status().records;
		expect(record.phase).toBe("creating");
		expect(existsSync(join(record.path, "first", ".git"))).toBe(true);
		expect(() => worktrees.release(record.id)).toThrow("inspect and preserve");
		expect(() => worktrees.release(record.id)).toThrow("git worktree unlock");
		expect(() => worktrees.release(record.id)).toThrow("--force for submodules");
		expect(worktrees.status().allocated).toBe(10_000_000);
	});
	it("keeps nested submodule files and commits, including branches whose HEAD is back at the pin", async () => {
		const { root, repo, worktrees } = fixture();
		vi.stubEnv("GIT_ALLOW_PROTOCOL", "file");
		const inner = repository(join(root, "inner"));
		const sub = repository(join(root, "sub"));
		git(sub, "submodule", "add", "--quiet", inner, "nested/inner");
		git(sub, "commit", "-am", "nested submodule");
		git(repo, "submodule", "add", "--quiet", sub, "sub");
		git(repo, "commit", "-am", "submodule");
		const record = await worktrees.create(repo, "nested", 10_000_000);
		// Populate explicitly too, so the removal protection can be tested independently of creation.
		git(record.path, "submodule", "update", "--init", "--recursive");
		const nested = join(record.path, "sub", "nested", "inner");
		writeFileSync(join(nested, "file"), "local work");
		await expect(worktrees.remove(record.id)).rejects.toThrow("modified or untracked");
		git(nested, "checkout", "--", "file");
		writeFileSync(join(nested, ".env"), "ignored work");
		await expect(worktrees.remove(record.id)).rejects.toThrow("ignored files");
		expect(readFileSync(join(nested, ".env"), "utf8")).toBe("ignored work");
		rmSync(join(nested, ".env"));
		git(
			nested,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"--allow-empty",
			"-m",
			"local",
		);
		const local = git(nested, "rev-parse", "HEAD");
		expect(() => git(inner, "cat-file", "-e", local)).toThrow();
		git(nested, "branch", "local-only", local);
		git(nested, "checkout", "--detach", "HEAD~1");
		await expect(worktrees.remove(record.id)).rejects.toThrow(local);
		// Deinitializing does not make the repository's local refs disposable.
		git(record.path, "submodule", "deinit", "--all");
		writeFileSync(join(record.path, "sub", "untracked"), "kept after deinit");
		await expect(worktrees.remove(record.id)).rejects.toThrow("uninitialized submodule contains files");
		expect(readFileSync(join(record.path, "sub", "untracked"), "utf8")).toBe("kept after deinit");
		rmSync(join(record.path, "sub", "untracked"));
		await expect(worktrees.remove(record.id)).rejects.toThrow(local);
		expect(worktrees.status().records).toHaveLength(1);
		const store = git(
			record.path,
			"rev-parse",
			"--path-format=absolute",
			"--git-path",
			"modules/sub/modules/nested/inner",
		);
		git(
			record.path,
			"--git-dir",
			store,
			"--work-tree",
			record.path,
			"update-ref",
			"refs/remotes/origin/local-only",
			local,
		);
		await worktrees.remove(record.id);
		expect(existsSync(record.path)).toBe(false);
	});
	it("serializes reservations across independent repositories and preserves failed allocations", async () => {
		const { root, repo, home, worktrees } = fixture();
		const second = repository(join(root, "second"));
		worktrees.configure(20_000_000);
		await worktrees.create(repo, "first", 12_000_000);
		await expect(new Worktrees(home).create(second, "second", 12_000_000)).rejects.toThrow(
			"disk capacity exceeded",
		);
		expect(() => worktrees.configure(1_000_000)).toThrow("below existing");
		await expect(worktrees.create(second, "failed", 1_000_000, "nonexistent-ref")).rejects.toThrow();
		expect(worktrees.status().records.find((record) => record.name === "failed")?.phase).toBe("creating");
		worktrees.release("failed");
		expect(worktrees.status().records.map((record) => record.name)).toEqual(["first"]);
	});
	it("never steals a live registry lock and reclaims one whose owner exited", async () => {
		const { home, worktrees } = fixture();
		const lock = join(home, "lock");
		mkdirSync(lock);
		writeFileSync(join(lock, "live.json"), JSON.stringify(currentOwner()));
		expect(() => worktrees.status()).toThrow(`locked by process ${process.pid}`);
		// Another host's process cannot be checked, so it is assumed to be live.
		writeFileSync(join(lock, "live.json"), JSON.stringify({ ...deadOwner(), host: "elsewhere" }));
		expect(() => worktrees.status()).toThrow("on elsewhere");
		writeFileSync(join(lock, "live.json"), JSON.stringify(deadOwner()));
		expect(worktrees.status().capacity).toBe(100_000_000);
		expect(existsSync(lock)).toBe(false);
		// An empty lock is one whose owner was releasing or reclaiming it.
		mkdirSync(lock);
		expect(worktrees.status().capacity).toBe(100_000_000);
		expect(existsSync(lock)).toBe(false);
	});
	it("admits simultaneous creators atomically without oversubscribing disk", async () => {
		const { root, repo, home, worktrees } = fixture();
		const second = repository(join(root, "second"));
		worktrees.configure(15_000_000);
		const module = new URL("../src/cli/worktree.ts", import.meta.url).href;
		const create = (repository: string, name: string) =>
			new Promise<number | null>((resolve, reject) => {
				const source = `import { Worktrees } from ${JSON.stringify(module)}; await new Worktrees(${JSON.stringify(home)}).create(${JSON.stringify(repository)}, ${JSON.stringify(name)}, 10_000_000);`;
				const child = spawn(
					process.execPath,
					["--experimental-strip-types", "--input-type=module", "-e", source],
					{ stdio: "ignore" },
				);
				child.on("error", reject);
				child.on("exit", resolve);
			});
		const results = await Promise.all([create(repo, "one"), create(second, "two")]);
		expect(results.filter((result) => result === 0)).toHaveLength(1);
		expect(worktrees.status().records).toHaveLength(1);
		expect(worktrees.status().allocated).toBeLessThanOrEqual(15_000_000);
	});
	it("refuses foreign checkouts and changed ownership", async () => {
		const { repo, worktrees } = fixture();
		mkdirSync(join(repo, ".worktrees", "foreign"), { recursive: true });
		await expect(worktrees.create(repo, "foreign", 10_000_000)).rejects.toThrow("refusing to adopt");
		const record = await worktrees.create(repo, "work", 10_000_000);
		git(repo, "worktree", "unlock", record.path);
		git(repo, "worktree", "lock", "--reason", "another owner", record.path);
		expect(() => worktrees.release(record.id)).toThrow("ownership/lock changed");
		expect(() => worktrees.restore(record.id)).toThrow("ownership/lock changed");
	});
	it("refuses scratch that contains another Git worktree", async () => {
		const { root, repo, worktrees } = fixture();
		const outer = await worktrees.create(repo, "outer", 10_000_000, "HEAD", [".worktrees"]);
		// Created from inside the outer checkout, so it lands in the outer checkout's ignored .worktrees/.
		const inner = await worktrees.create(outer.path, "inner", 10_000_000);
		expect(inner.path).toBe(join(outer.path, ".worktrees", "inner"));
		expect(() => worktrees.release(outer.id)).toThrow("scratch contains a Git worktree");
		expect(existsSync(join(inner.path, "file"))).toBe(true);
		// A linked worktree of an unrelated repository, such as an agent's checkout under an ignored directory.
		const other = await worktrees.create(repo, "other", 10_000_000, "HEAD", ["cache"]);
		const foreign = repository(join(root, "foreign"));
		git(foreign, "worktree", "add", "--detach", join(other.path, "cache", "agent"));
		expect(() => worktrees.release(other.id)).toThrow("scratch contains a Git worktree: cache");
		expect(existsSync(join(other.path, "cache", "agent", "file"))).toBe(true);
		expect(worktrees.status().records.map((record) => record.phase)).toEqual(["active", "active", "active"]);
	});
	it.skipIf(process.platform === "win32")("refuses a root replaced by a link to another checkout", async () => {
		const { repo, worktrees } = fixture();
		const replaced = await worktrees.create(repo, "first", 10_000_000, "HEAD", ["cache"]);
		const other = await worktrees.create(repo, "second", 10_000_000);
		mkdirSync(join(other.path, "cache"));
		rmSync(replaced.path, { recursive: true });
		symlinkSync(other.path, replaced.path);
		expect(() => worktrees.release(replaced.id)).toThrow("ownership/lock changed");
		expect(existsSync(join(other.path, "cache"))).toBe(true);
	});
	it("wires capacity, reservation, scratch, stop, and removal through the command line", async () => {
		const { repo, home } = fixture();
		vi.stubEnv("QUEST_WORKTREE_HOME", home);
		expect(run("worktree", "create", "cli", "--root", repo).code).toBe(2);
		expect(run("worktree", "capacity", "0").code).toBe(2);
		let created = "";
		expect(
			await main(["--root", repo, "worktree", "create", "cli", "--reserve", "10000000", "--scratch", "cache"], {
				stdout: (text) => (created += text),
				stderr: () => {},
			}),
		).toBe(0);
		const { path } = JSON.parse(created);
		mkdirSync(join(path, "cache"));
		expect(run("worktree", "release", "cli").code).toBe(0);
		expect(existsSync(join(path, "cache"))).toBe(false);
		const status = run("worktree", "status");
		expect(status.code).toBe(0);
		expect(JSON.parse(status.stdout).records[0].phase).toBe("released");
		// The checkout's commit is on main, so removing it asks no forge, and the fixture has no origin.
		let stdout = "";
		const out = { stdout: (text: string) => (stdout += text), stderr: () => {} };
		expect(await main(["worktree", "stop", "cli"], out)).toBe(0);
		expect(await main(["worktree", "remove", "cli"], out)).toBe(0);
		expect(
			stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line).path),
		).toEqual([path, path]);
		expect(existsSync(path)).toBe(false);
		expect(await main(["worktree", "remove", "cli"], out)).toBe(1);
	});
});

describe("supervised runs", { timeout: 20_000 }, () => {
	it("keeps scratch while any run is live and prunes it once the last one stops", async () => {
		const { finish, scopes } = fakeScopes();
		const { repo, worktrees } = fixture(scopes);
		const record = await worktrees.create(repo, "work", 10_000_000, "HEAD", ["cache"]);
		worktrees.release(record.id);
		// A run restores a released checkout before it starts.
		const first = worktrees.run(record.id, ["first"]);
		const second = worktrees.run(record.id, ["second"]);
		const units = worktrees.status().records[0].runs.map((run) => run.unit);
		expect(units).toHaveLength(2);
		expect(worktrees.status().records[0].phase).toBe("active");
		mkdirSync(join(record.path, "cache"));
		expect(() => worktrees.release(record.id)).toThrow("supervised runs are live");
		finish.get(units[0])!(0);
		expect(await first).toEqual({ code: 0, failure: undefined });
		expect(existsSync(join(record.path, "cache"))).toBe(true);
		finish.get(units[1])!(7);
		expect(await second).toEqual({ code: 7, failure: undefined });
		expect(existsSync(join(record.path, "cache"))).toBe(false);
		expect(worktrees.status().records[0]).toMatchObject({ phase: "released", runs: [] });
	});
	it("reconciles a crashed supervisor only once its scope is empty", async () => {
		const { live, scopes } = fakeScopes();
		const { repo, home, worktrees } = fixture(scopes);
		const record = await worktrees.create(repo, "work", 10_000_000, "HEAD", ["cache"]);
		mkdirSync(join(record.path, "cache"));
		orphan(home, "orphan.scope");
		live.add("orphan.scope");
		expect(worktrees.status().records[0].runs).toHaveLength(1);
		expect(() => worktrees.release(record.id)).toThrow("supervised runs are live");
		expect(existsSync(join(record.path, "cache"))).toBe(true);
		live.delete("orphan.scope");
		expect(worktrees.status().records[0]).toMatchObject({ phase: "released", runs: [] });
		expect(existsSync(join(record.path, "cache"))).toBe(false);
	});
	it("treats a run it cannot inspect as live until an inspection succeeds", async () => {
		const { repo, home } = fixture();
		let inspect = (): boolean => {
			throw new Error("no user manager");
		};
		const worktrees = new Worktrees(home, stubScopes({ live: () => inspect() }));
		const record = await worktrees.create(repo, "work", 10_000_000, "HEAD", ["cache"]);
		mkdirSync(join(record.path, "cache"));
		orphan(home, "orphan.scope");
		expect(worktrees.status().records[0]).toMatchObject({
			phase: "active",
			runs: [{ unit: "orphan.scope", failure: expect.stringContaining("no user manager") }],
		});
		expect(existsSync(join(record.path, "cache"))).toBe(true);
		// The next inspection that succeeds clears the stale reason, though the run is still live.
		inspect = () => true;
		const [run] = worktrees.status().records[0].runs;
		expect(run.unit).toBe("orphan.scope");
		expect(run.failure).toBeUndefined();
		inspect = () => false;
		expect(worktrees.status().records[0]).toMatchObject({ phase: "released", runs: [] });
	});
	it("stops a crashed supervisor's processes and leaves a live supervisor's run alone", async () => {
		const { live, scopes } = fakeScopes();
		const stop = vi.spyOn(scopes, "stop");
		const { repo, home, worktrees } = fixture(scopes);
		const record = await worktrees.create(repo, "work", 10_000_000, "HEAD", ["cache"]);
		mkdirSync(join(record.path, "cache"));
		orphan(home, "crashed.scope");
		orphan(home, "supervised.scope", currentOwner());
		live.add("crashed.scope");
		await expect(worktrees.stop(record.id)).rejects.toThrow(
			`left to it; signal it instead: supervised.scope (process ${process.pid}`,
		);
		expect(stop.mock.calls).toEqual([["crashed.scope"]]);
		expect(worktrees.status().records[0].runs.map((run) => run.unit)).toEqual(["supervised.scope"]);
		expect(existsSync(join(record.path, "cache"))).toBe(true);
		// With only a crashed supervisor's run left, stopping it releases the checkout.
		const file = join(home, "registry.json");
		const registry = JSON.parse(readFileSync(file, "utf8"));
		registry.records[0].runs = [];
		writeFileSync(file, JSON.stringify(registry));
		orphan(home, "crashed-again.scope");
		live.add("crashed-again.scope");
		expect(worktrees.status().records[0].runs).toHaveLength(1);
		expect(await worktrees.stop(record.id)).toMatchObject({ phase: "released", runs: [] });
		expect(existsSync(join(record.path, "cache"))).toBe(false);
	});
	it("reports a failed release as a retained reservation", async () => {
		const { finish, scopes } = fakeScopes();
		const { repo, worktrees } = fixture(scopes);
		const record = await worktrees.create(repo, "work", 10_000_000, "HEAD", ["cache"]);
		const running = worktrees.run(record.id, ["build"]);
		mkdirSync(join(record.path, "cache"));
		writeFileSync(join(record.path, "cache", "forced"), "tracked");
		git(record.path, "add", "-f", "cache/forced");
		finish.get(worktrees.status().records[0].runs[0].unit)!(0);
		const result = await running;
		expect(result.code).toBe(0);
		expect(result.failure).toContain("tracked files: cache/forced");
		expect(worktrees.status().records[0]).toMatchObject({ phase: "active", runs: [] });
	});
	it("keeps scratch when the command never started", async () => {
		const { repo, home } = fixture();
		const worktrees = new Worktrees(home, stubScopes({ run: () => Promise.reject(new Error("no user manager")) }));
		const record = await worktrees.create(repo, "work", 10_000_000, "HEAD", ["cache"]);
		mkdirSync(join(record.path, "cache"));
		await expect(worktrees.run(record.id, ["build"])).rejects.toThrow("no user manager");
		expect(worktrees.status().records[0]).toMatchObject({ phase: "active", runs: [] });
		expect(existsSync(join(record.path, "cache"))).toBe(true);
	});
	it("keeps a run recorded when its processes cannot be confirmed stopped", async () => {
		const { repo, home } = fixture();
		const worktrees = new Worktrees(
			home,
			stubScopes({ run: () => Promise.reject(new Retained("cannot confirm that the scope stopped")) }),
		);
		const record = await worktrees.create(repo, "work", 10_000_000, "HEAD", ["cache"]);
		mkdirSync(join(record.path, "cache"));
		await expect(worktrees.run(record.id, ["build"])).rejects.toThrow("cannot confirm");
		// This process owns the run until it exits; then reconciliation asks the scope.
		expect(worktrees.status().records[0]).toMatchObject({
			phase: "active",
			runs: [{ failure: "cannot confirm that the scope stopped" }],
		});
		expect(() => worktrees.release(record.id)).toThrow("supervised runs are live");
		expect(existsSync(join(record.path, "cache"))).toBe(true);
	});
	it.skipIf(process.platform === "linux")("fails explicitly without a supported backend", async () => {
		const { repo, home } = fixture();
		vi.stubEnv("QUEST_WORKTREE_HOME", home);
		expect(run("--root", repo, "worktree", "create", "cli", "--reserve", "10000000").code).toBe(0);
		let stderr = "";
		const code = await main(["worktree", "run", "cli", "--", "git", "status"], {
			stdout: () => {},
			stderr: (text) => {
				stderr += text;
			},
		});
		expect(code).toBe(1);
		expect(stderr).toContain("needs Linux 5.14 or later with a systemd user manager");
		expect(new Worktrees(home).status().records[0].runs).toEqual([]);
	});
});

describe("merged PR heads on GitHub", () => {
	/** GitHub answering the commit query with `found`, recording the variables it was sent. */
	function github(found: unknown) {
		const sent: unknown[] = [];
		const fetch = (async (_url: unknown, init?: RequestInit) => {
			sent.push(JSON.parse(String(init?.body)).variables);
			return Response.json({ data: { repository: { object: found } } });
		}) as typeof globalThis.fetch;
		return { sent, client: new GitHub({ fetch, now: Date.now, sleep: async () => {}, token: "test", warn() {} }) };
	}
	const repository = { owner: "example", repo: "project" };
	const pulls = (...nodes: unknown[]) => ({ associatedPullRequests: { nodes } });

	it("accepts only a merged PR whose head is exactly the commit", async () => {
		const { sent, client } = github(pulls({ merged: true, headRefOid: "abc" }));
		expect(await mergedHead(client, repository, "abc")).toBe(true);
		expect(sent).toEqual([{ owner: "example", name: "project", oid: "abc" }]);
		// A PR that contains the commit below a later head, or was closed unmerged, is no evidence.
		expect(await mergedHead(github(pulls({ merged: true, headRefOid: "later" })).client, repository, "abc")).toBe(
			false,
		);
		expect(await mergedHead(github(pulls({ merged: false, headRefOid: "abc" })).client, repository, "abc")).toBe(
			false,
		);
		// GitHub does not have the commit, or the object is not a commit.
		expect(await mergedHead(github(null).client, repository, "abc")).toBe(false);
		expect(await mergedHead(github({}).client, repository, "abc")).toBe(false);
	});
});

describe("cgroup kill", () => {
	it("requires cgroup.kill in this process's unified cgroup", async () => {
		const root = mkdtempSync(join(tmpdir(), "quest-cgroup-test-"));
		roots.push(root);
		const self = join(root, "self");
		const cgroups = join(root, "cgroup");
		mkdirSync(join(cgroups, "user.slice"), { recursive: true });
		writeFileSync(self, "0::/user.slice\n");
		// Before Linux 5.14 the cgroup exists without cgroup.kill, so a run could never empty its scope.
		expect(killable(cgroups, self)).toBe(false);
		writeFileSync(join(cgroups, "user.slice", "cgroup.kill"), "");
		expect(killable(cgroups, self)).toBe(true);
		// A hybrid hierarchy lists v1 controllers, and /sys/fs/cgroup is not its unified mount.
		writeFileSync(self, "1:name=systemd:/user.slice\n");
		expect(killable(cgroups, self)).toBe(false);
	});

	it("ignores a missing cgroup.kill only once the cgroup is gone", async () => {
		const root = mkdtempSync(join(tmpdir(), "quest-cgroup-test-"));
		roots.push(root);
		const group = join(root, "run.scope");
		mkdirSync(group);
		expect(() => kill(group)).toThrow("ENOENT");
		expect(existsSync(join(group, "cgroup.kill"))).toBe(false);
		rmSync(group, { recursive: true });
		expect(() => kill(group)).not.toThrow();
	});
});

describe("Claude Code hooks", { timeout: 20_000 }, () => {
	const noForge = async () => false;
	/** A subagent's hook input, as Claude sends it from inside the subagent's checkout. */
	const subagent = (event: string, cwd: string, agent: string) => ({ hook_event_name: event, cwd, agent_id: agent });

	it("derives scratch from the main checkout's ignored entries and its size as the reserve", async () => {
		const { repo } = fixture();
		mkdirSync(join(repo, "cache", "deep"), { recursive: true });
		writeFileSync(join(repo, "cache", "deep", "artifact"), "x".repeat(100_000));
		writeFileSync(join(repo, ".env"), "secret");
		writeFileSync(join(repo, "untracked"), "source");
		// Nested repositories and other checkouts hold work, not scratch, even where ignored.
		appendFileSync(join(repo, ".gitignore"), "vendor/\n.claude/\n");
		mkdirSync(join(repo, "vendor", "lib"), { recursive: true });
		git(join(repo, "vendor", "lib"), "init");
		mkdirSync(join(repo, ".claude", "worktrees", "old"), { recursive: true });
		mkdirSync(join(repo, ".worktrees", "big"), { recursive: true });
		writeFileSync(join(repo, ".worktrees", "big", "blob"), "x".repeat(5_000_000));
		const { reserve, scratch } = derivedDefaults(repo);
		expect(scratch).toEqual([".env", "cache"]);
		expect(reserve).toBeGreaterThan(100_000);
		expect(reserve).toBeLessThan(5_000_000);
	});
	it("admits by free space alone while no capacity is set", async () => {
		const { root, repo } = fixture();
		expect((await new Worktrees(join(root, "fresh")).create(repo, "work", 1_000_000)).phase).toBe("active");
	});
	it("creates under the main checkout at the remote's default branch, or the session's commit without one, and restores a name it already holds", async () => {
		const { root, repo, worktrees } = fixture();
		mkdirSync(join(repo, "cache"));
		const session = join(root, "session");
		git(repo, "worktree", "add", "--detach", session);
		writeFileSync(join(session, "file"), "session\n");
		git(session, "commit", "-am", "session work");
		const created = { hook_event_name: "WorktreeCreate", cwd: session, name: "agent-1" };
		const path = (await claudeHook(created, worktrees, noForge))!.trim();
		expect(path).toBe(join(canonical(repo), ".worktrees", "agent-1"));
		expect(git(path, "rev-parse", "HEAD")).toBe(git(session, "rev-parse", "HEAD"));
		expect(worktrees.status().records[0]).toMatchObject({ name: "agent-1", scratch: ["cache"] });
		worktrees.release("agent-1");
		expect((await claudeHook(created, worktrees, noForge))!.trim()).toBe(path);
		expect(worktrees.status().records).toHaveLength(1);
		expect(worktrees.status().records[0].phase).toBe("active");
		// With a known remote default branch, a new checkout starts there, as Claude's do by default.
		const initial = git(repo, "rev-parse", "main");
		git(repo, "update-ref", "refs/remotes/origin/main", initial);
		git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
		const fresh = (await claudeHook({ ...created, name: "agent-2" }, worktrees, noForge))!.trim();
		expect(git(fresh, "rev-parse", "HEAD")).toBe(initial);
		for (const project of [root, repository(join(root, "unrelated"))]) {
			const name = project === root ? "nonrepo" : "unrelated";
			const path = (await claudeHook({ ...created, name }, worktrees, noForge, project))!.trim();
			expect(path).toBe(join(canonical(repo), ".worktrees", name));
		}
		await expect(claudeHook({ ...created, cwd: root }, worktrees, noForge)).rejects.toThrow(
			"not in a Git checkout",
		);
	});
	it("releases a stopped subagent's own checkout and restores it on resume", async () => {
		const { repo, worktrees } = fixture();
		mkdirSync(join(repo, "cache"));
		const create = { hook_event_name: "WorktreeCreate", cwd: repo, name: "agent-abc" };
		const path = (await claudeHook(create, worktrees, noForge))!.trim();
		mkdirSync(join(path, "cache", "nested"), { recursive: true });
		// A subagent without isolation runs in this checkout too, but stops under another ID.
		expect(await claudeHook(subagent("SubagentStop", path, "other"), worktrees, noForge)).toBeUndefined();
		expect(existsSync(join(path, "cache"))).toBe(true);
		await claudeHook(subagent("SubagentStop", join(path, "cache", "nested"), "abc"), worktrees, noForge);
		expect(existsSync(join(path, "cache"))).toBe(false);
		expect(worktrees.status().records[0].phase).toBe("released");
		const resumed = await claudeHook(subagent("SubagentStart", path, "abc"), worktrees, noForge);
		expect(JSON.parse(resumed!).hookSpecificOutput).toMatchObject({
			hookEventName: "SubagentStart",
			additionalContext: expect.stringContaining("cache"),
		});
		expect(worktrees.status().records[0].phase).toBe("active");
		// A fresh subagent's checkout is already active and needs no notice.
		expect(await claudeHook(subagent("SubagentStart", path, "abc"), worktrees, noForge)).toBeUndefined();
		// Subagents outside any quest checkout are left alone.
		expect(await claudeHook(subagent("SubagentStop", repo, "abc"), worktrees, noForge)).toBeUndefined();
	});
	it("removes a finished checkout, never forcing, and refuses one it does not own", async () => {
		const { root, repo, worktrees } = fixture();
		const create = { hook_event_name: "WorktreeCreate", cwd: repo, name: "session" };
		const path = (await claudeHook(create, worktrees, noForge))!.trim();
		const remove = { hook_event_name: "WorktreeRemove", cwd: repo, worktree_path: path };
		writeFileSync(join(path, "new"), "untracked work");
		await expect(claudeHook(remove, worktrees, noForge)).rejects.toThrow("untracked");
		expect(existsSync(path)).toBe(true);
		rmSync(join(path, "new"));
		mkdirSync(join(path, "cache"));
		await claudeHook(remove, worktrees, noForge);
		expect(existsSync(path)).toBe(false);
		expect(worktrees.status().records).toEqual([]);
		// Gone is removed; a checkout some other tool made is refused.
		await claudeHook(remove, worktrees, noForge);
		const foreign = join(root, "foreign");
		git(repo, "worktree", "add", "--detach", foreign);
		await expect(claudeHook({ ...remove, worktree_path: foreign }, worktrees, noForge)).rejects.toThrow(
			"not a checkout quest worktree owns",
		);
		await expect(claudeHook({ hook_event_name: "Stop", cwd: repo }, worktrees, noForge)).rejects.toThrow(
			"unsupported hook event",
		);
		await expect(claudeHook({ hook_event_name: "WorktreeCreate", cwd: repo }, worktrees, noForge)).rejects.toThrow(
			"lacks name",
		);
	});
	it("waits out another holder of the registry lock instead of failing", async () => {
		const { repo, home, worktrees } = fixture();
		const lock = join(home, "lock");
		mkdirSync(lock);
		writeFileSync(join(lock, "live.json"), JSON.stringify(currentOwner()));
		let settled = false;
		const created = claudeHook(
			{ hook_event_name: "WorktreeCreate", cwd: repo, name: "agent-wait" },
			worktrees,
			noForge,
		);
		void created.finally(() => (settled = true));
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(settled).toBe(false);
		rmSync(lock, { recursive: true });
		expect((await created)!.trim()).toBe(join(canonical(repo), ".worktrees", "agent-wait"));
	});
	it("keeps names unique per repository, and asks for the ID where several share one", async () => {
		const { root, repo, worktrees } = fixture();
		const other = repository(join(root, "other"));
		const first = await worktrees.create(repo, "feature", 1_000_000);
		const second = await worktrees.create(other, "feature", 1_000_000);
		await expect(worktrees.create(repo, "feature", 1_000_000)).rejects.toThrow("already exists in this repository");
		expect(() => worktrees.release("feature")).toThrow("give the ID instead");
		expect(worktrees.release(second.id).phase).toBe("released");
		await worktrees.remove(first.id);
		expect(worktrees.release("feature").id).toBe(second.id);
	});
	it("reads the event on stdin and exits 1, never 2, on failure", async () => {
		const { repo, home } = fixture();
		const cli = (input: string) =>
			spawnSync(
				"bun",
				[`--config=${join(source, "bunfig.toml")}`, join(source, "src/cli/bin.ts"), "worktree", "hook"],
				{
					input,
					encoding: "utf8",
					env: { ...process.env, QUEST_WORKTREE_HOME: home },
				},
			);
		const created = cli(JSON.stringify({ hook_event_name: "WorktreeCreate", cwd: repo, name: "agent-cli" }));
		expect(created.status).toBe(0);
		expect(created.stdout).toBe(`${join(canonical(repo), ".worktrees", "agent-cli")}\n`);
		expect(cli("not json").status).toBe(1);
		expect(cli(JSON.stringify({ hook_event_name: "WorktreeCreate", cwd: repo, name: "agent-cli/x" })).status).toBe(
			1,
		);
	});
});
