// Git checkouts under a shared disk budget. Release prunes declared scratch in place, by hand or
// once the last supervised run in the checkout stops. Remove deletes a checkout that holds no unpreserved work.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	type Stats,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	statfsSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type Owner, Retained, type RunOptions, type Scopes, alive, currentOwner, systemdScopes } from "./supervise";

/** A supervised command, live while its owner runs or its scope holds a process. */
export interface Run {
	unit: string;
	owner: Owner;
	/** Why the run is kept although it may have stopped; cleared once its scope is inspected again. */
	failure?: string;
}
export interface WorktreeRecord {
	id: string;
	name: string;
	repository: string;
	path: string;
	reserve: number;
	/** Ignored paths, declared at creation, that release deletes. */
	scratch: string[];
	runs: Run[];
	phase: "creating" | "active" | "released";
	failure?: string;
}
interface Registry {
	version: 1;
	capacity: number;
	records: WorktreeRecord[];
}

/** Another live process holds the registry lock. */
export class Busy extends Error {}

function git(root: string, ...args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
}
/** Write `value` as JSON, user-only, replacing `path` atomically. */
export function save(path: string, value: unknown): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporary, path);
}
function code(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}
function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
/** The entry itself, without following a final symlink; undefined when it is missing. */
function entry(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if (code(error) === "ENOENT") return undefined;
		throw error;
	}
}
/** The filesystem holding a path, or its nearest existing ancestor. */
function device(path: string): number {
	try {
		return statSync(path).dev;
	} catch (error) {
		if (code(error) !== "ENOENT" || dirname(path) === path) throw error;
		return device(dirname(path));
	}
}
/** One spelling per path: Git prints `C:/...`, Node `C:\...`, and Windows may use 8.3 names. */
export function canonical(path: string): string {
	return existsSync(path) ? realpathSync.native(path) : resolve(path);
}
/** Git's registered checkouts, with canonical paths and lock reasons. */
function checkouts(repository: string): { path: string; locked?: string }[] {
	return git(repository, "worktree", "list", "--porcelain", "-z")
		.split("\0\0")
		.flatMap((entry) => {
			const lines = entry.split("\0");
			const path = lines.find((line) => line.startsWith("worktree "))?.slice(9);
			const locked = lines.find((line) => line === "locked" || line.startsWith("locked "))?.slice(7);
			return path ? [{ path: canonical(path), locked }] : [];
		});
}
function childPath(path: string): string {
	const parts = path.split(/[\\/]/);
	if (
		isAbsolute(path) ||
		parts.some((part) => part === ".." || part.toLowerCase() === ".git") ||
		parts.every((part) => part === "" || part === ".") // Names the checkout itself.
	) {
		throw new Error(`expected a relative path without .. or .git: ${path}`);
	}
	return path.replaceAll("\\", "/").replace(/\/$/, "");
}
/** Whether a scratch path exists; refuses one reached through a symlink, which could leave the checkout. */
function present(root: string, path: string): boolean {
	const parts = path.split("/");
	for (let i = 1; i <= parts.length; i++) {
		const stat = entry(join(root, ...parts.slice(0, i)));
		if (!stat) return false;
		if (i < parts.length && !stat.isDirectory())
			throw new Error(`scratch path is reached through a symlink or file: ${path}`);
	}
	return true;
}
/** The paths Git ignores; check-ignore exits 1 when it matches none. */
function ignored(root: string, paths: string[]): Set<string> {
	try {
		const output = execFileSync("git", ["-C", root, "check-ignore", "-z", "--stdin"], {
			encoding: "utf8",
			input: `${paths.join("\0")}\0`,
			stdio: ["pipe", "pipe", "pipe"],
		});
		return new Set(output.split("\0"));
	} catch (error) {
		if ((error as { status?: number }).status === 1) return new Set();
		throw error;
	}
}

/** The first linked worktree of any repository, marked by a `.git` file, at or under `path`; symlinks are never followed. */
function linkedWorktree(path: string): string | undefined {
	if (!entry(path)?.isDirectory()) return undefined;
	if (entry(join(path, ".git"))?.isFile()) return path;
	for (const child of readdirSync(path)) {
		const found = child === ".git" ? undefined : linkedWorktree(join(path, child));
		if (found) return found;
	}
	return undefined;
}

/**
 * Git's lock reason for the checkout actually at `path`, read through its own `.git` file and
 * administrative directory, so a root replaced by another checkout reports that checkout's lock.
 */
function lockReason(path: string): string | undefined {
	try {
		const admin = /^gitdir: (.+)$/m.exec(readFileSync(join(path, ".git"), "utf8"))?.[1];
		return admin && readFileSync(resolve(path, admin.trim(), "locked"), "utf8").replace(/\r?\n$/, "");
	} catch (error) {
		if (["ENOENT", "ENOTDIR", "EISDIR"].includes(code(error) ?? "")) return undefined;
		throw error;
	}
}

function interrupted(record: WorktreeRecord): void {
	if (record.phase === "creating")
		throw new Error(
			`creation was interrupted; inspect and remove the partial checkout with git worktree remove, then release again: ${record.path}`,
		);
}

/** Git status entries, plus ignored paths (collapsed to their directories) when `ignored` is set. */
function changes(root: string, ignored: boolean): string[] {
	const args = ["status", "--porcelain=v1", "-z", "--untracked-files=normal", ...(ignored ? ["--ignored"] : [])];
	return git(root, ...args)
		.split("\0")
		.filter(Boolean);
}
function clean(root: string): void {
	const found = changes(root, false);
	if (found.length) throw new Error(`checkout has modified or untracked files: ${found.slice(0, 20).join(", ")}`);
}

/**
 * HEAD and the refs removal deletes with the checkout, such as `refs/bisect/*`, that no branch or
 * remote-tracking ref reaches.
 */
function unreached(root: string): string[] {
	const own = git(root, "for-each-ref", "--format=%(objectname)", "refs/worktree", "refs/bisect", "refs/rewritten");
	const tips = new Set([git(root, "rev-parse", "HEAD").trim(), ...own.split("\n").filter(Boolean)]);
	return [...tips].filter((tip) => git(root, "rev-list", "-n1", tip, "--not", "--branches", "--remotes").trim());
}

/** Whether the forge merged a change, such as a squash-merged PR, whose head is exactly `commit`. */
export type Merged = (repository: string, commit: string) => Promise<boolean>;

/**
 * Allocated blocks, including ignored build output; symlinks are never traversed and hard links count once.
 * Paths in `skip` are left out with everything under them.
 */
export function diskUsage(path: string, seen = new Set<string>(), skip = new Set<string>()): number {
	if (skip.has(path)) return 0;
	const stat = entry(path);
	if (!stat) return 0;
	if (stat.nlink > 1 && !stat.isDirectory()) {
		const inode = `${stat.dev}:${stat.ino}`;
		if (seen.has(inode)) return 0;
		seen.add(inode);
	}
	// Allocated blocks, not logical length, so sparse files are not overcharged. Windows reports no blocks.
	let bytes = process.platform === "win32" ? stat.size : stat.blocks * 512;
	if (stat.isDirectory()) for (const child of readdirSync(path)) bytes += diskUsage(join(path, child), seen, skip);
	return bytes;
}

/** The first repository or linked worktree, marked by a `.git` entry, at or under `path`; symlinks are never followed. */
function repositoryWithin(path: string): string | undefined {
	if (!entry(path)?.isDirectory()) return undefined;
	const children = readdirSync(path, { withFileTypes: true });
	if (children.some((child) => child.name === ".git")) return path;
	for (const child of children) {
		const found = child.isDirectory() ? repositoryWithin(join(path, child.name)) : undefined;
		if (found) return found;
	}
	return undefined;
}

/** The repository's main checkout, which every linked worktree of it shares, from any path inside one. */
export function mainCheckout(path: string): string {
	const [main] = git(path, "worktree", "list", "--porcelain", "-z").split("\0\0");
	const lines = main?.split("\0") ?? [];
	const found = lines.find((line) => line.startsWith("worktree "))?.slice(9);
	if (!found || lines.includes("bare")) throw new Error(`repository has no main checkout: ${path}`);
	return canonical(found);
}

/** Directories holding other checkouts, which neither count toward a checkout's size nor become its scratch. */
const CHECKOUTS = [".worktrees", ".claude"];

/**
 * Defaults for a checkout of `main`'s repository when its creator gives only a name. The scratch is
 * `main`'s top-level ignored entries, leaving out the directories that hold checkouts and any entry
 * holding a nested repository, whose commits are work rather than scratch. The reserve is `main`'s
 * disk usage without its Git directory and the checkouts under it.
 */
export function derivedDefaults(main: string): { reserve: number; scratch: string[] } {
	const names = readdirSync(main).filter((name) => name !== ".git" && !CHECKOUTS.includes(name));
	const matched = names.length ? ignored(main, names) : new Set<string>();
	const scratch = names.filter((name) => matched.has(name) && !repositoryWithin(join(main, name))).sort();
	const skip = new Set([join(main, ".git"), join(main, ".worktrees"), join(main, ".claude", "worktrees")]);
	return { reserve: Math.max(1, diskUsage(main, new Set(), skip)), scratch };
}

/**
 * The registry lock is a directory holding one file named for its owner. It is created whole by a
 * rename, which fails while a non-empty lock exists. A dead owner's lock is reclaimed by unlinking
 * that exact owner file, so a reclaimer can never remove a lock some later owner took.
 */
function acquire(lock: string): string {
	const token = randomUUID();
	const staging = `${lock}.${token}`;
	mkdirSync(staging, { mode: 0o700 });
	try {
		writeFileSync(join(staging, `${token}.json`), JSON.stringify(currentOwner()), { mode: 0o600 });
		for (;;) {
			try {
				renameSync(staging, lock);
				return token;
			} catch (error) {
				if (!existsSync(lock)) throw error;
			}
			let holders: string[];
			try {
				holders = readdirSync(lock);
			} catch (error) {
				if (code(error) === "ENOENT") continue;
				throw error;
			}
			const holder = holders[0];
			if (holder !== undefined) {
				let owner: Owner;
				try {
					owner = JSON.parse(readFileSync(join(lock, holder), "utf8"));
				} catch (error) {
					if (code(error) === "ENOENT") continue;
					throw error;
				}
				if (alive(owner))
					throw new Busy(
						`worktree registry is locked by process ${owner.pid} on ${owner.host ?? "an unknown host"}: ${lock}`,
					);
				try {
					unlinkSync(join(lock, holder));
				} catch (error) {
					if (code(error) !== "ENOENT") throw error;
				}
			}
			// An empty lock is mid-release or reclaimed; a later owner's file makes this fail instead.
			try {
				rmdirSync(lock);
			} catch (error) {
				if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(code(error) ?? "")) throw error;
			}
		}
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}
function unlock(lock: string, token: string): void {
	unlinkSync(join(lock, `${token}.json`));
	try {
		rmdirSync(lock);
	} catch (error) {
		if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(code(error) ?? "")) throw error;
	}
}

/** All allocations share one registry across repositories for this user/host. */
export class Worktrees {
	readonly home: string;
	constructor(
		home = process.env.QUEST_WORKTREE_HOME ??
			join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "quest", "worktrees"),
		private readonly scopes: Scopes = systemdScopes,
	) {
		mkdirSync(home, { recursive: true, mode: 0o700 });
		this.home = realpathSync(home);
	}
	/** Every operation first reconciles runs whose supervisor and processes are gone. */
	private locked<T>(action: (registry: Registry) => T): T {
		const lock = join(this.home, "lock");
		const token = acquire(lock);
		try {
			const file = join(this.home, "registry.json");
			const registry: Registry = existsSync(file)
				? JSON.parse(readFileSync(file, "utf8"))
				: { version: 1, capacity: 0, records: [] };
			if (registry.version !== 1) throw new Error("unsupported worktree registry version");
			for (const record of registry.records) {
				record.scratch ??= [];
				record.runs ??= [];
			}
			try {
				this.reconcile(registry);
				return action(registry);
			} finally {
				save(file, registry);
			}
		} finally {
			unlock(lock, token);
		}
	}
	/** Waits out another live holder, whose critical sections are short; a dead one is reclaimed. */
	private async lockedWait<T>(action: (registry: Registry) => T): Promise<T> {
		for (;;) {
			try {
				return this.locked(action);
			} catch (error) {
				if (!(error instanceof Busy)) throw error;
			}
			await sleep(100);
		}
	}
	/** Names are unique per repository, so a name that several repositories use needs the ID. */
	private find(registry: Registry, id: string): WorktreeRecord {
		const byId = registry.records.find((item) => item.id === id);
		if (byId) return byId;
		const named = registry.records.filter((item) => item.name === id);
		if (named.length > 1)
			throw new Error(
				`worktree name is used in several repositories; give the ID instead: ${named.map((item) => `${item.id} (${item.repository})`).join(", ")}`,
			);
		if (!named[0]) throw new Error(`unknown worktree: ${id}`);
		return named[0];
	}
	/** Unknown counts as running, so scratch is never deleted under a process that may use it. */
	private running(run: Run): boolean {
		if (alive(run.owner)) return true;
		try {
			const live = this.scopes.live(run.unit);
			delete run.failure;
			return live;
		} catch (error) {
			run.failure = `cannot inspect supervised run ${run.unit}: ${message(error)}`;
			return true;
		}
	}
	/** Drops finished runs a crashed supervisor left behind, and releases a checkout none remain in. */
	private reconcile(registry: Registry): void {
		for (const record of [...registry.records]) {
			if (!record.runs.length) continue;
			record.runs = record.runs.filter((run) => this.running(run));
			if (!record.runs.length) this.settle(registry, record);
		}
	}
	private idle(record: WorktreeRecord): void {
		if (record.runs.length)
			throw new Error(
				`supervised runs are live in this checkout: ${record.runs.map((run) => run.unit).join(", ")}`,
			);
	}
	/** Releases a checkout whose last run stopped, keeping it charged and noting why on failure. */
	private settle(registry: Registry, record: WorktreeRecord): void {
		try {
			this.prune(registry, record);
			delete record.failure;
		} catch (error) {
			record.failure = `release failed; the checkout stays reserved: ${message(error)}`;
		}
	}
	/**
	 * Bytes on disk, plus the growth active reservations still expect. Released checkouts keep only
	 * what remains. `local` is the expected growth on the filesystem holding `parent`.
	 */
	private usage(registry: Registry, parent?: string): { used: number; growth: number; local: number } {
		const target = parent === undefined ? undefined : device(parent);
		let used = 0;
		let growth = 0;
		let local = 0;
		for (const record of registry.records) {
			const bytes = diskUsage(record.path);
			used += bytes;
			if (record.phase === "released") continue;
			const expected = Math.max(0, record.reserve - bytes);
			growth += expected;
			if (target !== undefined && device(record.path) === target) local += expected;
		}
		return { used, growth, local };
	}
	/** An unset capacity leaves admission to the free-space check alone. */
	private admit(registry: Registry, reserve: number, parent: string): void {
		const { used, growth, local } = this.usage(registry, parent);
		if (registry.capacity && used + growth + reserve > registry.capacity)
			throw new Error(
				`disk capacity exceeded: ${used + growth} allocated + ${reserve} requested > ${registry.capacity}`,
			);
		const fs = statfsSync(parent);
		if (Number(fs.bavail) * Number(fs.bsize) < local + reserve)
			throw new Error("insufficient free space after accounting for concurrent build reservations");
	}
	/** Capacity persists; reducing it below existing allocations is rejected. */
	configure(capacity: number): void {
		this.locked((registry) => {
			if (!Number.isSafeInteger(capacity) || capacity <= 0)
				throw new Error("capacity must be a positive safe integer in bytes");
			const { used, growth } = this.usage(registry);
			if (used + growth > capacity) throw new Error("capacity is below existing allocations");
			registry.capacity = capacity;
		});
	}
	status(): { capacity: number; allocated: number; records: WorktreeRecord[] } {
		return this.locked((registry) => {
			const { used, growth } = this.usage(registry);
			return { capacity: registry.capacity, allocated: used + growth, records: registry.records };
		});
	}
	/** A registered checkout at this exact canonical path, still owned by its recorded Git worktree. */
	registered(path: string): WorktreeRecord | undefined {
		return this.locked((registry) => {
			const record = registry.records.find((record) => record.path === path);
			return record && this.owned(record) ? record : undefined;
		});
	}
	/** `scratch` names the ignored paths release deletes, such as dependencies and build output. */
	create(root: string, name: string, reserve: number, ref = "HEAD", scratch: string[] = []): WorktreeRecord {
		return this.locked((registry) => {
			if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name))
				throw new Error("name must contain only letters, digits, dots, underscores, or hyphens");
			if (!Number.isSafeInteger(reserve) || reserve <= 0)
				throw new Error("reserve must be a positive safe integer in bytes, including expected build growth");
			const declared = scratch.map(childPath);
			const repository = canonical(git(root, "rev-parse", "--show-toplevel").trim());
			if (registry.records.some((item) => item.name === name && item.repository === repository))
				throw new Error(
					`worktree name already exists in this repository; use restore or another name: ${name}`,
				);
			const path = join(repository, ".worktrees", name);
			mkdirSync(dirname(path), { recursive: true });
			if (existsSync(path)) throw new Error(`refusing to adopt an existing checkout: ${path}`);
			this.admit(registry, reserve, dirname(path));
			const record: WorktreeRecord = {
				id: randomUUID(),
				name,
				repository,
				path,
				reserve,
				scratch: declared,
				runs: [],
				phase: "creating",
			};
			registry.records.push(record);
			save(join(this.home, "registry.json"), registry); // Reservation survives a crash in git.
			try {
				git(
					repository,
					"worktree",
					"add",
					"--detach",
					"--lock",
					"--reason",
					`quest worktree ${record.id}`,
					path,
					ref,
				);
				record.phase = "active";
				return record;
			} catch (error) {
				record.failure = String(error);
				throw error;
			}
		});
	}
	/** Refuses unless this record exclusively owns the checkout; false once Git and the disk both lack it. */
	private owned(record: WorktreeRecord): boolean {
		const path = canonical(record.path);
		const registered = checkouts(record.repository).find((entry) => entry.path === path);
		if (!registered && !existsSync(path)) return false;
		// Canonical paths follow a replaced root to its target, so ask the checkout on disk for its lock.
		const lock = existsSync(path) ? lockReason(record.path) : registered?.locked;
		if (lock !== `quest worktree ${record.id}`)
			throw new Error(
				"checkout ownership/lock changed; use the owning tool, never adopt or remove a shared checkout",
			);
		return true;
	}
	/**
	 * Deletes only the declared scratch, which Git must ignore and which holds no tracked files.
	 * The checkout, its Git state, and untracked source stay in place. A checkout that Git and the
	 * disk both lack, such as one removed with `git worktree remove`, drops its record instead.
	 */
	private prune(registry: Registry, record: WorktreeRecord): void {
		if (!this.owned(record)) {
			registry.records.splice(registry.records.indexOf(record), 1);
			return;
		}
		interrupted(record);
		const root = canonical(record.path);
		const paths = record.scratch.filter((path) => present(root, path)); // Reruns skip pruned paths.
		const admin = entry(join(root, ".git"));
		for (const path of paths) {
			// Case folding and other platform aliases can still name the checkout's .git entry.
			const stat = entry(join(root, path));
			if (admin && stat?.dev === admin.dev && stat.ino === admin.ino)
				throw new Error(`scratch path is the checkout's .git entry: ${path}`);
		}
		if (paths.length) {
			// icase, because a case-insensitive filesystem resolves `CACHE` to a tracked `cache`.
			const pathspecs = paths.map((path) => `:(literal,icase)${path}`);
			const tracked = git(root, "ls-files", "-z", "--", ...pathspecs)
				.split("\0")
				.filter(Boolean);
			if (tracked.length) throw new Error(`scratch includes tracked files: ${tracked.slice(0, 20).join(", ")}`);
			const matched = ignored(root, paths);
			const unignored = paths.filter((path) => !matched.has(path));
			if (unignored.length) throw new Error(`scratch must be ignored by Git: ${unignored.join(", ")}`);
			// Another checkout, such as one created inside this one, is work rather than scratch.
			const registered = checkouts(record.repository)
				.map((checkout) => checkout.path)
				.filter((path) => path !== root);
			for (const path of paths) {
				// A symlink is unlinked rather than followed, whatever it points to.
				if (entry(join(root, path))?.isSymbolicLink()) continue;
				const target = canonical(join(root, path));
				const nested =
					registered.find((checkout) => checkout === target || checkout.startsWith(target + sep)) ??
					linkedWorktree(join(root, path));
				if (nested) throw new Error(`scratch contains a Git worktree: ${path} holds ${nested}`);
			}
			// Removal unlinks symlinks rather than following them; force skips paths an overlapping parent removed.
			for (const path of paths) rmSync(join(root, path), { recursive: true, force: true });
		}
		record.phase = "released";
	}
	/** Prunes the scratch declared at creation; refuses while a supervised run may still use it. */
	release(id: string): WorktreeRecord {
		return this.locked((registry) => {
			const record = this.find(registry, id);
			this.idle(record);
			this.prune(registry, record);
			delete record.failure;
			return record;
		});
	}
	/**
	 * Deletes a finished checkout and drops its record, never forcing. Refuses while supervised runs
	 * are live, and refuses a checkout holding modified, untracked, or ignored files beyond its
	 * declared scratch, or a commit no branch or remote-tracking ref reaches. Such a commit counts as
	 * preserved only when `merged` reports a merged change whose head is exactly that commit.
	 */
	async remove(id: string, merged: Merged = async () => false): Promise<WorktreeRecord> {
		// The forge is asked outside the lock; the locked pass below inspects the checkout again.
		const pending = this.locked((registry) => {
			const record = this.find(registry, id);
			this.idle(record);
			if (!this.owned(record)) return [];
			interrupted(record);
			const root = canonical(record.path);
			clean(root);
			return unreached(root).map((commit) => ({ repository: record.repository, commit }));
		});
		const landed = new Set<string>();
		for (const { repository, commit } of pending) if (await merged(repository, commit)) landed.add(commit);
		return this.locked((registry) => {
			const record = this.find(registry, id);
			this.idle(record);
			const drop = () => registry.records.splice(registry.records.indexOf(record), 1);
			if (!this.owned(record)) {
				drop();
				return record;
			}
			interrupted(record);
			const root = canonical(record.path);
			clean(root);
			const kept = unreached(root).filter((commit) => !landed.has(commit));
			if (kept.length)
				throw new Error(
					`commits that no branch or remote-tracking ref reaches, and no merged change has as its head: ${kept.join(", ")}`,
				);
			this.prune(registry, record);
			const left = changes(root, true);
			if (left.length)
				throw new Error(
					`ignored files outside the declared scratch remain, so the checkout was only released: ${left.slice(0, 20).join(", ")}`,
				);
			const reason = `quest worktree ${record.id}`;
			git(record.repository, "worktree", "unlock", record.path);
			try {
				git(record.repository, "worktree", "remove", record.path);
			} catch (error) {
				try {
					git(record.repository, "worktree", "lock", "--reason", reason, record.path);
				} catch (relock) {
					throw new Error(`${message(error)}; locking the checkout again failed: ${message(relock)}`);
				}
				throw error;
			}
			drop();
			return record;
		});
	}
	/**
	 * Ends the processes a crashed supervisor left in this checkout's scopes; reconciliation then
	 * releases the checkout once no run remains. Runs whose supervisor is alive are left to it, and
	 * reported as a failure once the crashed ones are stopped.
	 */
	async stop(id: string): Promise<WorktreeRecord> {
		const orphans = this.locked((registry) =>
			this.find(registry, id)
				.runs.filter((run) => !alive(run.owner))
				.map((run) => run.unit),
		);
		for (const unit of orphans) await this.scopes.stop(unit);
		return this.lockedWait((registry) => {
			const record = this.find(registry, id);
			const supervised = record.runs.filter((run) => alive(run.owner));
			if (supervised.length)
				throw new Error(
					`runs whose supervisor is alive are left to it; signal it instead: ${supervised.map((run) => `${run.unit} (process ${run.owner.pid} on ${run.owner.host})`).join(", ")}`,
				);
			return record;
		});
	}
	/** Reserves the released checkout's disk again; the caller then reinstalls or rebuilds its scratch. */
	restore(id: string): WorktreeRecord {
		return this.locked((registry) => {
			const record = this.find(registry, id);
			if (!this.owned(record)) throw new Error(`checkout is missing; release drops its record: ${record.path}`);
			this.activate(registry, record);
			return record;
		});
	}
	private activate(registry: Registry, record: WorktreeRecord): void {
		if (record.phase === "active") return;
		if (record.phase !== "released") throw new Error(`cannot use a ${record.phase} checkout`);
		this.admit(registry, Math.max(0, record.reserve - diskUsage(record.path)), dirname(record.path));
		record.phase = "active";
	}
	/**
	 * Runs a command in the checkout, restoring it first when released. Once the command and every
	 * descendant have stopped, and no other run remains, its declared scratch is pruned. Resolves
	 * with the command's status; a failed release is recorded and leaves the checkout reserved.
	 */
	async run(id: string, command: string[], options?: RunOptions): Promise<{ code: number; failure?: string }> {
		this.scopes.check();
		const run: Run = { unit: `quest-worktree-${randomUUID()}.scope`, owner: currentOwner() };
		const record = this.locked((registry) => {
			const record = this.find(registry, id);
			if (!this.owned(record)) throw new Error(`checkout is missing; release drops its record: ${record.path}`);
			this.activate(registry, record);
			record.runs.push(run); // Recorded before the scope exists, so a crash is reconciled.
			return { id: record.id, path: record.path };
		});
		const result = await this.scopes.run(run.unit, record.path, command, options).then(
			(code) => ({ code }),
			(error: unknown) => ({ error }),
		);
		// Waits out a busy lock rather than failing: the run's record keeps its scratch until this lands.
		const failure = await this.lockedWait((registry) => {
			const current = registry.records.find((item) => item.id === record.id);
			if (!current) return undefined;
			// Reconciliation drops a retained run once this process exits and its scope is empty.
			const retained = current.runs.find((item) => item.unit === run.unit);
			if (retained && "error" in result && result.error instanceof Retained)
				retained.failure = result.error.message;
			else current.runs = current.runs.filter((item) => item.unit !== run.unit);
			// A command that never started, such as on a host without a user manager, keeps its scratch.
			if (!current.runs.length && "code" in result) this.settle(registry, current);
			return current.failure;
		});
		if ("error" in result) throw result.error;
		return { code: result.code, failure };
	}
}
