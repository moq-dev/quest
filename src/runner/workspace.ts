// A job's checkout and the changes it publishes. Each repository is fetched
// once into a bare clone; each job gets its own worktree, which stays put
// across the job's attempts on this runner so a paused session resumes where
// it was. kix publishes, so the runner never pushes: it sends the files that
// differ from what the job's branch holds, as data.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { save } from "../cli/worktree";
import type { Job } from "./protocol";

const run = promisify(execFile);
const identity = () => ({
	...process.env,
	GIT_AUTHOR_NAME: "kix",
	GIT_AUTHOR_EMAIL: "kix@localhost",
	GIT_COMMITTER_NAME: "kix",
	GIT_COMMITTER_EMAIL: "kix@localhost",
});

/** One file as `POST /api/runner/publish` takes it. */
export interface Change {
	path: string;
	/** Base64 content, or null to delete. A symlink's content is its target. */
	content: string | null;
	executable?: boolean;
	symlink?: boolean;
}

/** What the runner remembers of a job's checkout between attempts. */
interface Record {
	/** The job branch's head as kix last reported it, or null before the first publication. */
	head: string | null;
	/** A local commit whose tree is exactly what that head holds. */
	base: string;
	/** Local-only recovery point while unpublished work is merged onto a selected head. */
	reapply?: string;
	/** Recovery commits in this checkout's ancestry are not agent merge requests. */
	checkpoints?: string[];
}

/** A pending publication: the changes, and the tree they would make the branch hold. */
export interface Snapshot {
	tree: string;
	/**
	 * A commit the checkout merged in since the branch's head, such as its
	 * base branch: the publication is a merge commit, and `changes` are
	 * relative to this commit's files rather than the head's.
	 */
	merge: string | null;
	changes: Change[];
	/** Gitlinks in the snapshot; merge publication retains only pointers already on its head. */
	submodules: { path: string; sha: string }[];
}

/** A snapshot before any file is read: each changed path's blob, or null to delete it. */
interface Pending extends Omit<Snapshot, "changes"> {
	files: { path: string; mode: string; blob: string | null }[];
}

export class Workspace {
	readonly dir: string;
	#record: Record;
	readonly #file: string;
	readonly #git: string;
	preserved: string | null = null;
	continued = false;

	private constructor(git: string, dir: string, file: string, record: Record) {
		this.#git = git;
		this.dir = dir;
		this.#file = file;
		this.#record = record;
	}

	/** The bare clone the checkout belongs to, which holds the job's revision. */
	get repository(): string {
		return this.#git;
	}

	/** The head the job's branch holds, as the next publication must name it. */
	get head(): string | null {
		return this.#record.head;
	}

	/**
	 * The job's checkout, ready for an attempt: the existing one when it still
	 * matches the branch kix reports, or a fresh one at the branch's head (or
	 * the job's revision before its first publication).
	 */
	static async prepare(root: string, job: Job, remote: string): Promise<Workspace> {
		const git = join(root, "repos", job.owner, `${job.name}.git`);
		const dir = join(root, "jobs", job.id);
		const file = join(root, "jobs", `${job.id}.json`);
		return locked(git, async () => {
			if (!existsSync(join(git, "HEAD"))) {
				await run("git", ["init", "--quiet", "--bare", git]);
				await run("git", ["-C", git, "remote", "add", "origin", remote]);
				// kix publishes the job's work; a push from the checkout has nowhere to go.
				await run("git", ["-C", git, "config", "remote.origin.pushurl", "kix-publishes-this-job"]);
			} else {
				await run("git", ["-C", git, "remote", "set-url", "origin", remote]);
			}
			// The devShell is evaluated from the job's revision, never from the checkout.
			await fetch(git, job.revision);
			const record = load(file);
			if (record && record.head === job.head && existsSync(join(dir, ".git")))
				return new Workspace(git, dir, file, record);
			const previous = record && existsSync(join(dir, ".git")) ? new Workspace(git, dir, file, record) : null;
			const source = previous ? await previous.#pending() : null;
			if (previous) {
				const entries = (await run("git", ["-C", dir, "ls-files", "--stage", "-z"])).stdout.split("\0");
				const links = [
					...entries
						.filter((entry) => entry.startsWith("160000 "))
						.map((entry) => entry.slice(entry.indexOf("\t") + 1)),
					...(source?.submodules ?? []).map((entry) => entry.path),
				];
				if (links.some((path) => existsSync(join(dir, path, ".git"))))
					throw new Error(
						"The paused checkout has initialized submodules or embedded repositories; preserve their local commits and changes before replacing it. Its checkout was left intact.",
					);
			}
			const saved = previous ? await previous.#checkpoint(job.id, source!) : null;
			const continuing =
				job.workflow === "merge" &&
				job.head !== null &&
				record &&
				job.questions.some((question) => {
					const offer = (question.prompt as { continuation?: { from?: unknown; head?: unknown } } | null)
						?.continuation;
					return (
						question.kind === "publication" &&
						typeof question.approvedAt === "number" &&
						offer?.from === record.head &&
						offer?.head === job.head &&
						(question.answer as { continue?: unknown } | null)?.continue === job.head
					);
				});
			const start = job.head ?? job.revision;
			await fetch(git, start);
			await remove(git, dir);
			await run("git", [
				"-C",
				git,
				"worktree",
				"add",
				"--quiet",
				"--detach",
				dir,
				continuing && saved ? saved.sha : start,
			]);
			const fresh: Record = {
				head: job.head,
				base: start,
				...(continuing &&
					saved && { reapply: saved.ref, checkpoints: [...(record.checkpoints ?? []), saved.sha] }),
			};
			save(file, fresh);
			const workspace = new Workspace(git, dir, file, fresh);
			workspace.preserved = saved?.ref ?? null;
			workspace.continued = !!continuing;
			if (continuing && saved) {
				// The WIP checkpoint is the first parent: the selected branch head is
				// merged into it locally, so normal publication is a delta on that head.
				try {
					await run(
						"git",
						[
							"-C",
							dir,
							"merge",
							"--no-commit",
							"--no-ff",
							"--allow-unrelated-histories",
							"--no-overwrite-ignore",
							start,
						],
						{ env: identity() },
					);
					const merging = await run("git", [
						"-C",
						dir,
						"rev-parse",
						"--verify",
						"--quiet",
						"MERGE_HEAD",
					]).then(
						() => true,
						() => false,
					);
					if (merging) await run("git", ["-C", dir, "commit", "--no-edit"], { env: identity() });
				} catch (error) {
					if (!(await workspace.conflicts()).length) throw error;
					// Standard unmerged index entries block publication until the resumed agent resolves them.
				}
			}
			return workspace;
		});
	}

	/** The worktree's files that differ from what the branch holds, untracked ones included and ignored ones not. */
	async snapshot(): Promise<Snapshot> {
		if ((await this.conflicts()).length)
			throw new Error("Resolve and stage the preserved merge conflicts before publishing");
		if (this.#record.reapply) {
			try {
				await run("git", ["-C", this.dir, "merge-base", "--is-ancestor", this.#record.base, "HEAD"]);
			} catch {
				throw new Error("Merge and commit the selected head with the preserved work before publishing");
			}
		}
		const { tree, merge, files, submodules } = await this.#pending();
		const contents = await blobs(
			this.dir,
			files.flatMap((file) => (file.blob ? [file.blob] : [])),
		);
		const changes = files.map(({ path, mode, blob }): Change => {
			if (!blob) return { path, content: null };
			return {
				path,
				content: contents.get(blob)!.toString("base64"),
				...(mode === "100755" && { executable: true }),
				...(mode === "120000" && { symlink: true }),
			};
		});
		return { tree, merge, changes, submodules };
	}

	/** The worktree's tree and the paths that differ from what the branch holds, by blob, before reading any file. */
	async #pending(): Promise<Pending> {
		const index = `${this.#file.replace(/\.json$/, "")}.index`;
		const env = { ...process.env, GIT_INDEX_FILE: index };
		const git = (args: string[]) =>
			run("git", ["-C", this.dir, ...args], { env, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
		try {
			const merge = await this.#merged();
			await git(["read-tree", this.#record.base]);
			await git(["add", "--all", "--", "."]);
			const tree = (await git(["write-tree"])).stdout.trim();
			const diff = (await git(["diff-tree", "-r", "-z", "--no-renames", merge ?? this.#record.base, tree]))
				.stdout;
			const files: Pending["files"] = [];
			const submodules: Snapshot["submodules"] = [];
			const fields = diff.split("\0");
			for (let i = 0; i + 1 < fields.length; i += 2) {
				const [, mode, , blob, status] = fields[i]!.split(" ");
				const path = fields[i + 1]!;
				if (status === "D") files.push({ path, mode: mode!, blob: null });
				else if (mode === "160000") submodules.push({ path, sha: blob! });
				else files.push({ path, mode: mode!, blob: blob! });
			}
			return { tree, merge, files, submodules };
		} finally {
			rmSync(index, { force: true });
		}
	}

	/** Unmerged paths are a decision, not file contents to publish as conflict markers. */
	async conflicts(): Promise<string[]> {
		const { stdout } = await run("git", ["-C", this.dir, "diff", "--name-only", "--diff-filter=U", "-z"]);
		return stdout.split("\0").filter(Boolean);
	}

	/** Preserve tracked/untracked source in a local Git ref before replacing any stale checkout. */
	async #checkpoint(job: string, pending: Pending): Promise<{ ref: string; sha: string } | null> {
		if (!pending.files.length && !pending.merge && !pending.submodules.length) return null;
		const local = (await run("git", ["-C", this.dir, "rev-parse", "HEAD"])).stdout.trim();
		// published() keeps a synthetic tree base. The real published head is
		// needed too, so merging an external descendant uses that publication
		// as its merge base rather than replaying already-published changes.
		if (this.#record.head) await fetch(this.#git, this.#record.head);
		const parents = [
			...new Set([local, this.#record.base, this.#record.head].filter((sha): sha is string => !!sha)),
		];
		const { stdout } = await run(
			"git",
			[
				"-C",
				this.dir,
				"commit-tree",
				pending.tree,
				...parents.flatMap((sha) => ["-p", sha]),
				"-m",
				"Preserved unpublished kix workspace",
			],
			{ env: identity() },
		);
		const sha = stdout.trim();
		const ref = `refs/kix/checkpoints/${job}/${randomUUID()}`;
		await run("git", ["-C", this.#git, "update-ref", ref, sha]);
		return { ref, sha };
	}

	/**
	 * The commit the checkout's latest merge brought in that the branch does
	 * not hold yet, or null. The agent merges with Git; only its effect on
	 * history is read here, and the working tree is still what is published.
	 */
	async #merged(): Promise<string | null> {
		const base = this.#record.base;
		const checkpoints = new Set(this.#record.checkpoints);
		const listed = await run("git", ["-C", this.dir, "rev-list", "--merges", "--parents", `${base}..HEAD`]);
		for (const line of listed.stdout.trim().split("\n")) {
			const [commit, , merged] = line.split(" ");
			// The preservation commit joins local and published ancestry, but is
			// not an agent request to merge another branch into the publication.
			if (checkpoints.has(commit!) || !merged) continue;
			const held = await run("git", ["-C", this.dir, "merge-base", "--is-ancestor", merged, base]).then(
				() => true,
				() => false,
			);
			if (!held) return merged;
		}
		return null;
	}

	/** Record that the branch now holds `snapshot` at `head`, so the next snapshot is relative to it. */
	async published(head: string | null, snapshot: Snapshot | null): Promise<void> {
		let base = this.#record.base;
		if (snapshot && (snapshot.changes.length > 0 || snapshot.merge)) {
			const parents = ["-p", base, ...(snapshot.merge ? ["-p", snapshot.merge] : [])];
			const commit = await run(
				"git",
				["-C", this.dir, "commit-tree", snapshot.tree, ...parents, "-m", `kix ${head}`],
				{
					encoding: "utf8",
					env: {
						...process.env,
						GIT_AUTHOR_NAME: "kix",
						GIT_AUTHOR_EMAIL: "kix@localhost",
						GIT_COMMITTER_NAME: "kix",
						GIT_COMMITTER_EMAIL: "kix@localhost",
					},
				},
			);
			base = commit.stdout.trim();
		}
		this.#record = { head, base, ...(this.#record.checkpoints && { checkpoints: this.#record.checkpoints }) };
		save(this.#file, this.#record);
	}

	/**
	 * Continue from `head`, which kix reports the branch holds after a
	 * publication whose reply never arrived. It must descend from the head this
	 * checkout last saw, since only this attempt's publications move the branch.
	 */
	async adopt(head: string): Promise<void> {
		if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`kix reported an invalid head: ${head}`);
		const known = this.#record.head ?? this.#record.base;
		await locked(this.#git, () => fetch(this.#git, head));
		try {
			await run("git", ["-C", this.#git, "merge-base", "--is-ancestor", known, head]);
		} catch {
			throw new Error(`kix reports the branch at ${head}, which does not continue from ${known}`);
		}
		this.#record = { head, base: head, ...(this.#record.checkpoints && { checkpoints: this.#record.checkpoints }) };
		save(this.#file, this.#record);
	}

	/** Delete the checkout and its record once the job is done with this runner. */
	async remove(): Promise<void> {
		await locked(this.#git, () => remove(this.#git, this.dir));
		rmSync(this.#file, { force: true });
	}
}

/** Each bare clone's queue: jobs on one repository share its config, objects, and worktree list. */
const queues = new Map<string, Promise<void>>();

/** Run `action` once every earlier operation on the bare clone `git` has settled. */
function locked<T>(git: string, action: () => Promise<T>): Promise<T> {
	const result = (queues.get(git) ?? Promise.resolve()).then(action);
	const settled = result.then(
		() => {},
		() => {},
	);
	queues.set(git, settled);
	void settled.then(() => {
		if (queues.get(git) === settled) queues.delete(git);
	});
	return result;
}

function load(file: string): Record | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as Record;
	} catch {
		return undefined;
	}
}

async function remove(git: string, dir: string): Promise<void> {
	if (existsSync(dir)) {
		await run("git", ["-C", git, "worktree", "remove", "--force", "--force", dir]).catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	}
	await run("git", ["-C", git, "worktree", "prune"]).catch(() => {});
}

/**
 * Read blobs with one `cat-file --batch`: `<oid> blob <size>\n<content>\n`
 * each, in input order. One process rather than one per file keeps a large
 * publication from paying a spawn per path. kix refuses publications over
 * 16 MiB, so the 64 MiB buffer bounds only what it would reject anyway.
 */
async function blobs(dir: string, oids: string[]): Promise<Map<string, Buffer>> {
	const contents = new Map<string, Buffer>();
	if (!oids.length) return contents;
	const reading = run("git", ["-C", dir, "cat-file", "--batch"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
	reading.child.stdin!.end(`${oids.join("\n")}\n`);
	const { stdout } = await reading;
	let offset = 0;
	for (const oid of oids) {
		const header = stdout.indexOf(10, offset);
		const [, type, size] = stdout.toString("utf8", offset, header).split(" ");
		if (type !== "blob") throw new Error(`could not read blob ${oid}`);
		contents.set(oid, stdout.subarray(header + 1, header + 1 + Number(size)));
		offset = header + 1 + Number(size) + 1;
	}
	return contents;
}

/**
 * Fetch one commit by id. GitHub serves any commit in a repository's fork
 * network this way, so a job branch kix published on its fork is reachable
 * from the upstream URL.
 */
async function fetch(git: string, commit: string): Promise<void> {
	const present = await run("git", ["-C", git, "cat-file", "-e", `${commit}^{commit}`]).then(
		() => true,
		() => false,
	);
	if (present) return;
	try {
		await run("git", ["-C", git, "fetch", "--quiet", "--no-tags", "origin", commit], {
			maxBuffer: 16 * 1024 * 1024,
		});
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr?.trim();
		throw new Error(`could not fetch ${commit}${stderr ? `: ${stderr}` : ""}`);
	}
}
