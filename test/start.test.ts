// `quest start` and `quest unblocked --unclaimed`: claims on local bare
// remotes, with GitHub replayed in memory. URL rewrites (`insteadOf`) let a
// github.com remote name reach a local bare repository.

import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { claims, target } from "../src/cli/claims";
import {
	type GitHubDependencies,
	type ObjectValue,
	githubRepository,
	readRemote,
	remoteRepository,
} from "../src/cli/github";
import { type Output, main } from "../src/cli/main";
import { Refusal, ago, releaseQuest, startQuest } from "../src/cli/start";
import { EPIC_README, GIT_SETTINGS, TWO, Tree, configure, initRepository, template, tempDir } from "./fixture";

const ONE = "quest/m0/epic/one.md";
const BRANCH = "quest/m0/epic/one";
const UPSTREAM = "https://github.com/example/project.git";
const FORK = "https://github.com/me/project.git";

// Each test spawns git a few dozen times, which takes seconds on Windows runners.
vi.setConfig({ testTimeout: 30_000 });

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A bare repository whose default branch holds the baseline tree. */
const upstream = template((dir) => {
	git(dir, "clone", "-q", "--bare", Tree.committed().path, ".");
	configure(dir, GIT_SETTINGS);
});

/** The committed baseline, tracking origin's main, with no origin URL until `clone` sets one. */
const baselineClone = template((dir) => {
	Tree.committed(dir);
	git(dir, "remote", "add", "origin", upstream());
	git(dir, "fetch", "-q", "origin");
	git(dir, "branch", "-q", "--set-upstream-to", "origin/main");
	git(dir, "config", "--unset", "remote.origin.url");
});

/**
 * A clone of the baseline whose origin is `url`, rewritten to the bare
 * repositories in `routes`. Without routes, origin is a bare path.
 */
function clone(url: string, routes: Record<string, string> = {}): string {
	const dir = baselineClone();
	configure(dir, { "remote.origin.url": url });
	for (const [from, to] of Object.entries(routes)) configure(dir, { [`url.${to}.insteadOf`]: from });
	return dir;
}

interface Pull {
	number: number;
	base: string;
	head: { ref: string; sha?: string; repo: { full_name: string } | null };
	draft: boolean;
	state: string;
	merged_at?: string | null;
	body: string;
	created_at: string;
	updated_at: string;
	html_url: string;
}

/** GitHub's repositories and pull requests, in memory. */
class FakeGitHub {
	readonly repos = new Map<string, ObjectValue>();
	readonly pulls: Pull[] = [];
	/** The status of each `owner/repo/path` contents lookup on a default branch; any other path is a 404. */
	readonly files = new Map<string, number>([["example/project/quest/README.md", 200]]);
	/** Runs after each PR is created, as when another claimer opens one at the same moment. */
	onCreate?: () => void;
	private clock = Date.now();

	constructor() {
		this.repo("example/project", { fork: false, default_branch: "main" });
	}

	repo(name: string, extra: ObjectValue): void {
		const [owner, repo] = name.split("/");
		this.repos.set(name, {
			owner: { login: owner },
			name: repo,
			full_name: name,
			clone_url: `https://github.com/${name}.git`,
			ssh_url: `git@github.com:${name}.git`,
			...extra,
		});
	}

	/** A fork of `parent`. */
	fork(name: string, parent = "example/project"): void {
		const [owner, repo] = parent.split("/");
		this.repo(name, {
			fork: true,
			default_branch: "main",
			parent: { owner: { login: owner }, name: repo, default_branch: "main" },
		});
	}

	/** Open a PR as another contributor, `minutes` before now. */
	open(base: string, ref: string, headRepo: string, options: Partial<Pull> = {}): Pull {
		const number = this.pulls.length + 1;
		const pull: Pull = {
			number,
			base,
			head: { ref, repo: { full_name: headRepo } },
			draft: true,
			state: "open",
			body: "",
			created_at: new Date(this.clock++).toISOString(),
			updated_at: new Date(this.clock).toISOString(),
			html_url: `https://github.com/${base}/pull/${number}`,
			...options,
		};
		this.pulls.push(pull);
		return pull;
	}

	/** Close a PR from `ref` of `headRepo` whose head was `sha`, merged or not. */
	closed(headRepo: string, ref: string, sha: string, merged: boolean): Pull {
		return this.open("example/project", ref, headRepo, {
			head: { ref, sha, repo: { full_name: headRepo } },
			state: "closed",
			merged_at: merged ? new Date(this.clock).toISOString() : null,
		});
	}

	open_(base: string): Pull[] {
		return this.pulls.filter((pull) => pull.base === base && pull.state === "open");
	}

	/** The listing's `state` (default open) and `head` (`owner:ref`) filters. */
	private list(base: string, query: URLSearchParams): Pull[] {
		const state = query.get("state") ?? "open";
		const head = query.get("head");
		return this.pulls.filter(
			(pull) =>
				pull.base === base &&
				(state === "all" || pull.state === state) &&
				(head === null || `${pull.head.repo?.full_name.split("/")[0]}:${pull.head.ref}` === head),
		);
	}

	deps(): GitHubDependencies {
		return {
			fetch: async (input, init) => this.handle(new URL(String(input)), init ?? {}),
			now: () => this.clock,
			sleep: async () => undefined,
			token: "token",
			warn: () => undefined,
		};
	}

	private handle(url: URL, init: RequestInit): Response {
		const method = init.method ?? "GET";
		const body = init.body ? (JSON.parse(String(init.body)) as ObjectValue) : {};
		const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status });
		let match = /^\/repos\/([^/]+\/[^/]+)$/.exec(url.pathname);
		if (match && method === "GET") {
			const repo = this.repos.get(match[1]);
			return repo ? json(200, repo) : json(404, { message: "Not Found" });
		}
		match = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(url.pathname);
		if (match && method === "GET") {
			const status = this.files.get(`${match[1]}/${decodeURIComponent(match[2])}`) ?? 404;
			return json(status, status === 200 ? { type: "file", path: match[2] } : { message: "Not Found" });
		}
		match = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(url.pathname);
		if (match && method === "GET") return json(200, this.list(match[1], url.searchParams));
		if (match && method === "POST") {
			const [owner, ref] = String(body.head).includes(":") ? String(body.head).split(":") : [null, body.head];
			const headRepo = owner ? `${owner}/${match[1].split("/")[1]}` : match[1];
			const pull = this.open(match[1], String(ref), headRepo, {
				draft: body.draft === true,
				body: String(body.body),
			});
			this.onCreate?.();
			return json(201, { ...pull, title: body.title, baseRef: body.base });
		}
		match = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(url.pathname);
		if (match && method === "PATCH") {
			const pull = this.pulls.find((p) => p.base === match![1] && p.number === Number(match![2]))!;
			Object.assign(pull, body);
			return json(200, pull);
		}
		return json(404, { message: `no route for ${method} ${url.pathname}` });
	}
}

function deps(github: FakeGitHub, warnings: string[] = []) {
	return { github: () => github.deps(), warn: (message: string) => warnings.push(message) };
}

/** Commit `files` in `work`, where `null` deletes one, and push them to origin's default branch. */
function land(work: string, files: Record<string, string | null>): void {
	for (const [path, text] of Object.entries(files)) {
		if (text === null) rmSync(join(work, path));
		else writeFileSync(join(work, path), text);
	}
	git(work, "add", "-A");
	git(work, "commit", "-q", "-m", "land");
	git(work, "push", "-q", "origin", "HEAD:refs/heads/main");
}

/** Claim `path` from `work` as `quest start` does, reading the upstream tree first. */
async function start(work: string, github: FakeGitHub, warnings: string[] = [], path = ONE) {
	const dependencies = deps(github, warnings);
	return startQuest(work, await target(work, "origin", dependencies), path, "[S] One", dependencies);
}

/** The branch tip on a bare repository, or "" when it is missing. */
function tip(bare: string, branch = BRANCH): string {
	return git(bare, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`);
}

/** Run the CLI and wait for it. */
async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const out: Output = { stdout: (text) => void (stdout += text), stderr: (text) => void (stderr += text) };
	const code = await main(args, out);
	return { code, stdout, stderr };
}

describe("start on GitHub", () => {
	test("claims a free quest with an empty commit and a draft PR", async () => {
		const bare = upstream();
		const github = new FakeGitHub();
		const work = clone(UPSTREAM, { [UPSTREAM]: bare });
		const started = await start(work, github);

		expect(started).toEqual({ branch: BRANCH, sha: tip(bare), url: "https://github.com/example/project/pull/1" });
		const base = git(bare, "rev-parse", "main");
		expect(git(bare, "rev-parse", `${started.sha}^`)).toBe(base);
		expect(git(bare, "rev-parse", `${started.sha}^{tree}`)).toBe(git(bare, "rev-parse", `${base}^{tree}`));
		expect(git(bare, "log", "-1", "--format=%B", started.sha)).toMatch(
			/^chore\(quest\): claim quest\/m0\/epic\/one\.md\n\nQuest-Claim: [0-9a-f]{16}$/,
		);
		expect(git(work, "symbolic-ref", "HEAD")).toBe(`refs/heads/${BRANCH}`);
		expect(git(work, "rev-parse", "HEAD")).toBe(started.sha);
		expect(github.pulls).toMatchObject([
			{ base: "example/project", head: { ref: BRANCH, repo: { full_name: "example/project" } }, draft: true },
		]);
		expect(github.pulls[0].body).toBe(`Claims [${ONE}](https://github.com/example/project/blob/main/${ONE}).`);
	});

	test("links the quest by its repository path when the tree is below the top level", async () => {
		const bare = initRepository(undefined, { bare: true });
		const work = tempDir();
		initRepository(work);
		mkdirSync(join(work, "sub"));
		cpSync(join(Tree.baseline().path, "quest"), join(work, "sub", "quest"), { recursive: true });
		git(work, "add", ".");
		git(work, "commit", "-q", "-m", "seed");
		git(work, "remote", "add", "origin", UPSTREAM);
		git(work, "config", `url.${bare}.insteadOf`, UPSTREAM);
		git(work, "push", "-q", "origin", "HEAD:refs/heads/main");
		const github = new FakeGitHub();

		await start(join(work, "sub"), github);
		expect(github.pulls[0].body).toBe(`Claims [${ONE}](https://github.com/example/project/blob/main/sub/${ONE}).`);
	});

	test("fast-forwards the quest branch a worktree already has checked out", async () => {
		const bare = upstream();
		const work = clone(UPSTREAM, { [UPSTREAM]: bare });
		git(work, "switch", "-q", "-c", BRANCH);
		const warnings: string[] = [];
		const started = await start(work, new FakeGitHub(), warnings);
		expect(warnings).toEqual([]);
		expect(git(work, "rev-parse", "HEAD")).toBe(started.sha);
	});

	test("warns rather than moving a diverged local branch", async () => {
		const bare = upstream();
		const work = clone(UPSTREAM, { [UPSTREAM]: bare });
		git(work, "branch", BRANCH);
		const warnings: string[] = [];
		const started = await start(work, new FakeGitHub(), warnings);
		expect(warnings).toEqual([
			`local branch ${BRANCH} already exists; merge the claim commit ${started.sha} into it before pushing`,
		]);
		expect(git(work, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
	});

	test("reaches a fork's parent with the scheme a URL alias resolves to", async () => {
		const bare = upstream();
		const forkBare = initRepository(undefined, { bare: true });
		const github = new FakeGitHub();
		github.fork("me/project");
		// `corp:me/project` expands to the fork's HTTPS URL, so the parent is read over HTTPS too.
		// The SSH form leads nowhere, so choosing it fails fast; pushes go to the fork's bare repository.
		const work = clone("corp:me/project.git", {
			[UPSTREAM]: bare,
			"git@github.com:example/project.git": join(tempDir(), "missing"),
		});
		git(work, "config", "url.https://github.com/.insteadOf", "corp:");
		git(work, "config", "remote.origin.pushurl", forkBare);
		const started = await start(work, github);
		expect(tip(forkBare)).toBe(started.sha);
	});

	test("refuses a quest whose branch is already upstream", async () => {
		const bare = upstream();
		git(bare, "branch", BRANCH, "main");
		const work = clone(UPSTREAM, { [UPSTREAM]: bare });
		await expect(start(work, new FakeGitHub())).rejects.toThrow(
			new Refusal(`${ONE} is held by branch ${BRANCH}, with no open PR`),
		);
	});

	test("replaces a branch whose tip a merged PR landed", async () => {
		const bare = upstream();
		git(bare, "branch", BRANCH, "main");
		const landed = tip(bare);
		const github = new FakeGitHub();
		github.closed("example/project", BRANCH, landed, true);
		const work = clone(UPSTREAM, { [UPSTREAM]: bare });

		expect(await claims(work, "origin", [BRANCH], deps(github))).toEqual([]);
		const started = await start(work, github);
		expect(started.sha).not.toBe(landed);
		expect(tip(bare)).toBe(started.sha);
		expect(github.open_("example/project")).toMatchObject([{ head: { ref: BRANCH } }]);
	});

	test("a branch whose PR closed unmerged, or that moved on after merging, still holds its quest", async () => {
		const bare = upstream();
		git(bare, "branch", BRANCH, "main");
		const github = new FakeGitHub();
		const closed = github.closed("example/project", BRANCH, tip(bare), false);
		const work = clone(UPSTREAM, { [UPSTREAM]: bare });
		const held = new Refusal(`${ONE} is held by branch ${BRANCH}, with no open PR`);
		await expect(start(work, github)).rejects.toThrow(held);

		// A merged PR whose head is no longer the tip: the work pushed since has not landed.
		Object.assign(closed, { merged_at: closed.updated_at, head: { ...closed.head, sha: "0".repeat(40) } });
		await expect(start(work, github)).rejects.toThrow(held);
		expect(tip(bare)).toBe(git(bare, "rev-parse", "main"));
	});

	test("a fork replaces its own branch that a merged PR landed", async () => {
		const bare = upstream();
		const forkBare = upstream();
		git(forkBare, "branch", BRANCH, "main");
		const github = new FakeGitHub();
		github.fork("me/project");
		github.closed("me/project", BRANCH, tip(forkBare), true);
		const work = clone(FORK, { [FORK]: forkBare, [UPSTREAM]: bare });

		const started = await start(work, github);
		expect(tip(forkBare)).toBe(started.sha);
		expect(tip(bare)).toBe("");
	});

	test("pushes where the push URL points, as a fork, when the remote fetches from upstream", async () => {
		const bare = upstream();
		const forkBare = initRepository(undefined, { bare: true });
		const github = new FakeGitHub();
		github.fork("me/project");
		const forkSsh = "git@github.com:me/project.git";
		const work = clone(UPSTREAM, { [UPSTREAM]: bare, [forkSsh]: forkBare });
		git(work, "config", "remote.origin.pushurl", forkSsh);

		const started = await start(work, github);
		expect(tip(forkBare)).toBe(started.sha);
		expect(tip(bare)).toBe("");
		expect(github.pulls).toMatchObject([
			{ base: "example/project", head: { ref: BRANCH, repo: { full_name: "me/project" } } },
		]);
		// The fork's branch is seen as a claim even before its PR is listed.
		github.pulls.length = 0;
		expect(await claims(work, "origin", [BRANCH], deps(github))).toEqual([
			{ branch: BRANCH, url: null, pull: null },
		]);
	});

	test("refuses a quest a fork's PR claims, and says whether it was handed back", async () => {
		const bare = upstream();
		const work = clone(UPSTREAM, { [UPSTREAM]: bare });
		const github = new FakeGitHub();
		const pull = github.open("example/project", BRANCH, "someone/project");
		const attempt = () => start(work, github);

		await expect(attempt()).rejects.toThrow(`${ONE} is held by ${pull.html_url} (draft, last active just now)`);
		pull.body = "Work so far.\n\n## Decisions needed\n\n1. Which name?\n";
		await expect(attempt()).rejects.toThrow(`held by ${pull.html_url} (draft, decisions needed,`);
		pull.draft = false;
		await expect(attempt()).rejects.toThrow(`held by ${pull.html_url} (ready for review,`);
		expect(tip(bare)).toBe("");
	});

	test("two claimers race: one push wins and the other is refused", async () => {
		const bare = upstream();
		const github = new FakeGitHub();
		const [a, b] = [clone(UPSTREAM, { [UPSTREAM]: bare }), clone(UPSTREAM, { [UPSTREAM]: bare })];
		const results = await Promise.allSettled([start(a, github), start(b, github)]);

		const won = results.filter((result) => result.status === "fulfilled");
		const lost = results.filter((result) => result.status === "rejected");
		expect(won).toHaveLength(1);
		expect(lost).toHaveLength(1);
		expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(Refusal);
		expect(tip(bare)).toBe((won[0] as PromiseFulfilledResult<{ sha: string }>).value.sha);
		expect(github.open_("example/project")).toHaveLength(1);
	});

	test("a fork PR opened first keeps the claim; the later PR closes and its branch goes", async () => {
		const bare = upstream();
		const github = new FakeGitHub();
		const work = clone(UPSTREAM, { [UPSTREAM]: bare });
		let fork: Pull | undefined;
		github.onCreate = () => {
			github.onCreate = undefined;
			fork = github.open("example/project", BRANCH, "someone/project", {
				created_at: new Date(Date.now() - 3_600_000).toISOString(),
			});
		};

		await expect(start(work, github)).rejects.toThrow(
			`${fork?.html_url ?? "https://github.com/example/project/pull/2"} claimed ${ONE} first; closed https://github.com/example/project/pull/1`,
		);
		expect(github.open_("example/project").map((pull) => pull.number)).toEqual([2]);
		expect(tip(bare)).toBe("");
	});

	test("a fork pushes to itself and opens the PR on its parent", async () => {
		const bare = upstream();
		const forkBare = initRepository(undefined, { bare: true });
		const github = new FakeGitHub();
		github.fork("me/project");
		const work = clone(FORK, { [FORK]: forkBare, [UPSTREAM]: bare });

		const started = await start(work, github);
		expect(tip(forkBare)).toBe(started.sha);
		expect(tip(bare)).toBe("");
		expect(github.pulls).toMatchObject([
			{ base: "example/project", head: { ref: BRANCH, repo: { full_name: "me/project" } } },
		]);

		// Another clone of the upstream sees the fork's claim.
		const other = clone(UPSTREAM, { [UPSTREAM]: bare });
		await expect(start(other, github)).rejects.toThrow(Refusal);

		const released = await releaseQuest(work, ONE, "origin", deps(github));
		expect(released).toEqual({ branch: BRANCH, closed: [started.url] });
		expect(tip(forkBare)).toBe("");
	});

	test("a fork whose parent keeps no quests claims on itself", async () => {
		const parentBare = initRepository(undefined, { bare: true });
		const forkBare = upstream();
		const github = new FakeGitHub();
		github.files.delete("example/project/quest/README.md");
		github.fork("me/project");
		const work = clone(FORK, { [FORK]: forkBare, [UPSTREAM]: parentBare });

		const started = await start(work, github);
		expect(started.url).toBe("https://github.com/me/project/pull/1");
		expect(tip(forkBare)).toBe(started.sha);
		expect(tip(parentBare)).toBe("");
		expect(github.pulls).toMatchObject([
			{ base: "me/project", head: { ref: BRANCH, repo: { full_name: "me/project" } } },
		]);
	});

	test.each([
		["keeps no quests", "me/project", false],
		["keeps quests too", "example/project", true],
	])("a fork of a fork with quests whose parent %s claims on %s", async (_, expected, rooted) => {
		const bares: Record<string, string> = { "example/project": upstream(), "me/project": upstream() };
		const ownBare = initRepository(undefined, { bare: true });
		const github = new FakeGitHub();
		if (!rooted) github.files.delete("example/project/quest/README.md");
		github.files.set("me/project/quest/README.md", 200);
		github.fork("me/project");
		github.fork("them/project", "me/project");
		const own = "https://github.com/them/project.git";
		const work = clone(own, { [own]: ownBare, [FORK]: bares["me/project"], [UPSTREAM]: bares["example/project"] });

		const started = await start(work, github);
		expect(tip(ownBare)).toBe(started.sha);
		for (const bare of Object.values(bares)) expect(tip(bare)).toBe("");
		expect(github.pulls).toMatchObject([
			{ base: expected, head: { ref: BRANCH, repo: { full_name: "them/project" } } },
		]);
	});

	test("looks up a parent's README below a directory whose name a URL would cut short", async () => {
		const parentBare = initRepository(undefined, { bare: true });
		const forkBare = initRepository(undefined, { bare: true });
		const dir = "sub#1";
		const work = tempDir();
		initRepository(work);
		mkdirSync(join(work, dir));
		cpSync(join(Tree.baseline().path, "quest"), join(work, dir, "quest"), { recursive: true });
		git(work, "add", ".");
		git(work, "commit", "-q", "-m", "seed");
		git(work, "remote", "add", "origin", FORK);
		git(work, "config", `url.${forkBare}.insteadOf`, FORK);
		git(work, "config", `url.${parentBare}.insteadOf`, UPSTREAM);
		git(work, "push", "-q", "origin", "HEAD:refs/heads/main");
		git(work, "push", "-q", UPSTREAM, "HEAD:refs/heads/main");
		const github = new FakeGitHub();
		github.files.delete("example/project/quest/README.md");
		github.files.set(`example/project/${dir}/quest/README.md`, 200);
		github.fork("me/project");

		await start(join(work, dir), github);
		expect(github.pulls).toMatchObject([
			{ base: "example/project", head: { ref: BRANCH, repo: { full_name: "me/project" } } },
		]);
	});

	test("a failed lookup of a parent's README fails rather than picking an upstream", async () => {
		const bare = upstream();
		const forkBare = upstream();
		const github = new FakeGitHub();
		github.files.set("example/project/quest/README.md", 401);
		github.fork("me/project");
		const work = clone(FORK, { [FORK]: forkBare, [UPSTREAM]: bare });

		await expect(start(work, github)).rejects.toThrow(
			"GitHub HTTP 401 for /repos/example/project/contents/quest/README.md",
		);
		expect(tip(forkBare)).toBe("");
		expect(github.pulls).toEqual([]);
	});

	test("refuses a quest missing from the upstream default branch", async () => {
		const bare = upstream();
		const work = clone(UPSTREAM, { [UPSTREAM]: bare });
		const extra = "quest/m0/epic/three.md";
		writeFileSync(join(work, extra), "# [S] Three\n\n## Goal\n\nOnly local.\n");
		await expect(start(work, new FakeGitHub(), [], extra)).rejects.toThrow(
			new Refusal(`${extra} is not on the upstream default branch; update your checkout`),
		);
		expect(tip(bare, "quest/m0/epic/three")).toBe("");
	});

	test("names a branch named after the epic's directory, says whether it merged, and leaves it", async () => {
		const bare = upstream();
		// A planning PR's branch named after the epic: git cannot also hold the child's claim beneath it.
		git(bare, "branch", "quest/m0/epic", "main");
		const blocker = tip(bare, "quest/m0/epic");
		const github = new FakeGitHub();
		const work = clone(UPSTREAM, { [UPSTREAM]: bare });
		const refusal = (state: string) =>
			new Refusal(
				`${ONE} cannot be claimed: git cannot hold ${BRANCH} on origin beside a branch named after its directory or inside it:\n` +
					`- quest/m0/epic: ${state}\n` +
					"Stop and report this; do not delete or rename a branch in the way.",
			);

		await expect(start(work, github)).rejects.toThrow(refusal("not a merged PR's head"));
		const pull = github.closed("example/project", "quest/m0/epic", blocker, true);
		await expect(start(work, github)).rejects.toThrow(refusal(`the head of ${pull.html_url}, which merged`));
		expect(tip(bare, "quest/m0/epic")).toBe(blocker);
		expect(tip(bare)).toBe("");
		expect(github.open_("example/project")).toEqual([]);
	});

	test("release deletes the empty claim branch and closes its PR", async () => {
		const bare = upstream();
		const github = new FakeGitHub();
		const work = clone(UPSTREAM, { [UPSTREAM]: bare });
		const started = await start(work, github);

		expect(await releaseQuest(work, ONE, "origin", deps(github))).toEqual({
			branch: BRANCH,
			closed: [started.url],
		});
		expect(tip(bare)).toBe("");
		expect(github.pulls[0].state).toBe("closed");
	});

	test("release refuses a branch with work on it", async () => {
		const bare = upstream();
		const github = new FakeGitHub();
		const work = clone(UPSTREAM, { [UPSTREAM]: bare });
		await start(work, github);
		appendFileSync(join(work, ONE), "\nWork in progress.\n");
		git(work, "commit", "-q", "-m", "work", "--", ONE);
		git(work, "push", "-q", "origin", `refs/heads/${BRANCH}:refs/heads/${BRANCH}`);

		await expect(releaseQuest(work, ONE, "origin", deps(github))).rejects.toThrow(
			new Refusal(
				`${BRANCH} on origin has work beyond its empty claim commit; close its PR yourself to abandon that work`,
			),
		);
		expect(tip(bare)).toBe(git(work, "rev-parse", "HEAD"));
		expect(github.pulls[0].state).toBe("open");

		// An empty commit after the work, such as a CI retrigger, is not a claim either.
		git(work, "commit", "-q", "--allow-empty", "-m", "retrigger");
		git(work, "push", "-q", "origin", `refs/heads/${BRANCH}:refs/heads/${BRANCH}`);
		await expect(releaseQuest(work, ONE, "origin", deps(github))).rejects.toThrow(Refusal);
		expect(tip(bare)).toBe(git(work, "rev-parse", "HEAD"));
	});
});

describe("start on another forge", () => {
	/** A clone whose origin is a plain bare repository path. */
	function plain(): { bare: string; work: string } {
		const bare = upstream();
		return { bare, work: clone(bare) };
	}

	test("pushes the claim branch without a PR, then refuses a second claim", async () => {
		const { bare, work } = plain();
		const first = await cli("--root", work, "start", ONE);
		expect(first).toEqual({
			code: 0,
			stdout: `${BRANCH}\n`,
			stderr: "quest: origin is not on GitHub, so the claim branch was pushed without a PR\n",
		});
		expect(tip(bare)).not.toBe("");

		const second = await cli("--root", work, "start", `/${ONE}`);
		expect(second.code).toBe(3);
		expect(second.stderr).toContain(`quest: ${ONE} is held by branch ${BRANCH}, with no open PR\n`);
	});

	test("claims a quest whose tree is below the repository root", async () => {
		const bare = initRepository(undefined, { bare: true });
		const work = tempDir();
		initRepository(work);
		mkdirSync(join(work, "sub"));
		cpSync(join(Tree.baseline().path, "quest"), join(work, "sub", "quest"), { recursive: true });
		git(work, "add", ".");
		git(work, "commit", "-q", "-m", "seed");
		git(work, "remote", "add", "origin", bare);
		git(work, "push", "-q", "origin", "HEAD:refs/heads/main");

		const out = await cli("--root", join(work, "sub"), "start", ONE);
		expect(out.code, out.stderr).toBe(0);
		expect(out.stdout).toBe(`${BRANCH}\n`);
		expect(tip(bare)).not.toBe("");
	});

	test("fails on a malformed upstream tree before pushing a claim", async () => {
		const { bare, work } = plain();
		// A misspelled `## Required` hides the blocker from the readiness check.
		land(work, { "quest/m0/epic/two.md": TWO.replace("## Required", "## Requires") });
		const out = await cli("--root", work, "start", "quest/m0/epic/two.md");
		expect(out.code).toBe(1);
		expect(out.stderr).toContain("unknown '## Requires'");
		expect(tip(bare, "quest/m0/epic/two")).toBe("");
	});

	test("refuses a blocked quest with exit 3", async () => {
		const { bare, work } = plain();
		const out = await cli("--root", work, "start", "quest/m0/epic/two.md");
		expect(out.code).toBe(3);
		expect(out.stderr).toContain("quest: quest/m0/epic/two.md is blocked;");
		expect(tip(bare, "quest/m0/epic/two")).toBe("");
	});

	test.each(["quest", `${BRANCH}/extra`])("refuses with exit 3 while branch %s is in the way", async (blocker) => {
		const { bare, work } = plain();
		git(bare, "branch", blocker, "main");
		const out = await cli("--root", work, "start", ONE);
		expect(out.code).toBe(3);
		expect(out.stderr).toContain(`\n- ${blocker}: whether it is a merged PR's head is unknown off GitHub\n`);
		// The blocker stays, and no claim branch was pushed.
		expect(git(bare, "for-each-ref", "--format=%(refname:short)", "refs/heads/")).toBe(`main\n${blocker}`);
	});

	test("releases the claim", async () => {
		const { bare, work } = plain();
		await cli("--root", work, "start", ONE);
		expect(await cli("--root", work, "start", "--release", ONE)).toEqual({
			code: 0,
			stdout: `deleted ${BRANCH}\n`,
			stderr: "",
		});
		expect(tip(bare)).toBe("");
		expect((await cli("--root", work, "start", "--release", ONE)).code).toBe(1);
	});

	test("unblocked --unclaimed drops held quests and lists them on stderr", async () => {
		const { bare, work } = plain();
		// Two ready quests, so the filter leaves one.
		land(work, {
			"quest/m0/epic/README.md": `${EPIC_README}- [Three](/quest/m0/epic/three.md)\n`,
			"quest/m0/epic/three.md": "# [S] Three\n\n## Goal\n\nAlso ready.\n",
		});
		git(bare, "branch", BRANCH, "main");

		expect(await cli("--root", work, "unblocked", "--unclaimed")).toEqual({
			code: 0,
			stdout: "0\tquest/m0/epic/three.md\n",
			stderr:
				"quest: origin is not on GitHub, so only its branches were checked for claims\n" +
				`quest: skipped ${ONE}: held by branch ${BRANCH}, with no open PR\n`,
		});
		expect((await cli("--root", work, "unblocked", "--unclaimed", "--remote", "nope")).stderr).toBe(
			"quest: no nope remote, so claims were not checked\n",
		);
	});

	test("readiness comes from the upstream tree, not a checkout behind it", async () => {
		const { bare, work } = plain();
		const behind = clone(bare);
		// Upstream finished One: it deleted the quest and its links, so Two is ready there.
		land(work, {
			"quest/m0/epic/README.md": EPIC_README.replace("- [One](/quest/m0/epic/one.md)\n", ""),
			"quest/m0/epic/two.md": TWO.replace(/\n## Required\n[^]*$/, ""),
			[ONE]: null,
		});

		expect(await cli("--root", behind, "unblocked")).toMatchObject({ stdout: `1\t${ONE}\n` });
		expect(await cli("--root", behind, "unblocked", "--unclaimed")).toEqual({
			code: 0,
			stdout: "0\tquest/m0/epic/two.md\n",
			stderr: "quest: origin is not on GitHub, so only its branches were checked for claims\n",
		});
		const finished = await cli("--root", behind, "start", ONE);
		expect(finished.code).toBe(3);
		expect(finished.stderr).toBe(`quest: ${ONE} is not on the upstream default branch; update your checkout\n`);
		const ready = await cli("--root", behind, "start", "quest/m0/epic/two.md");
		expect(ready.code, ready.stderr).toBe(0);
		expect(tip(bare, "quest/m0/epic/two")).not.toBe("");
	});
});

test("claims reports the earliest open PR on each branch", async () => {
	const bare = upstream();
	const github = new FakeGitHub();
	const work = clone(UPSTREAM, { [UPSTREAM]: bare });
	const first = github.open("example/project", BRANCH, "a/project");
	github.open("example/project", BRANCH, "b/project");
	github.open("example/project", "feature", "example/project");
	const held = await claims(work, "origin", [BRANCH, "quest/m0/epic/two"], deps(github));
	expect(held).toEqual([{ branch: BRANCH, url: first.html_url, pull: expect.objectContaining({ number: 1 }) }]);
});

test("claims from a fork count the parent's branches and PRs, and the fork's own", async () => {
	const bare = upstream();
	const forkBare = initRepository(undefined, { bare: true });
	const github = new FakeGitHub();
	github.fork("me/project");
	const work = clone(FORK, { [FORK]: forkBare, [UPSTREAM]: bare });
	git(bare, "branch", "quest/m0/a", "main");
	git(work, "push", "-q", "origin", "HEAD:refs/heads/quest/m0/b");
	const pull = github.open("example/project", "quest/m0/c", "someone/project");
	const own = github.open("me/project", "quest/m0/d", "me/project");

	const held = await claims(
		work,
		"origin",
		["quest/m0/a", "quest/m0/b", "quest/m0/c", "quest/m0/d", "quest/m0/e"],
		deps(github),
	);
	expect(held.map((claim) => [claim.branch, claim.url])).toEqual([
		["quest/m0/a", null],
		["quest/m0/b", null],
		["quest/m0/c", pull.html_url],
		["quest/m0/d", own.html_url],
	]);
});

test("githubRepository reads HTTPS, ssh://, and scp-like remote URLs", () => {
	const repository = { owner: "example", repo: "project" };
	for (const url of [
		"https://github.com/example/project.git",
		"https://github.com/example/project",
		"https://x-access-token:secret@github.com/example/project.git",
		"https://github.com/example/project/",
		"ssh://git@github.com/example/project.git",
		"ssh://git@github.com:22/example/project",
		"git@github.com:example/project.git",
		"org-123@github.com:example/project.git",
	]) {
		expect(githubRepository(url), url).toEqual(repository);
	}
	for (const url of [
		"https://gitlab.com/example/project.git",
		"https://github.com.evil.example/example/project",
		"git@github.com:example",
		"/srv/git/project.git",
	]) {
		expect(githubRepository(url), url).toBeNull();
	}
});

test("readRemote reads configured URLs, and rewritten ones as git uses them", () => {
	const dir = initRepository();
	expect(readRemote(dir, "origin")).toBeNull();
	// A name with regex characters matches only itself.
	configure(dir, { "remote.a.b+.url": "https://github.com/example/other.git" });
	expect(readRemote(dir, "a.b")).toBeNull();
	expect(readRemote(dir, "a.b+")?.used()).toEqual({
		fetch: "https://github.com/example/other.git",
		push: "https://github.com/example/other.git",
	});

	configure(dir, {
		"remote.origin.url": "https://github.com/example/project.git",
		"remote.origin.pushurl": "https://github.com/me/project.git",
	});
	const plain = readRemote(dir, "origin")!;
	expect(plain.configured).toEqual({
		fetch: "https://github.com/example/project.git",
		push: "https://github.com/me/project.git",
	});
	expect(plain.used()).toEqual({
		fetch: "https://github.com/example/project.git",
		push: "https://github.com/me/project.git",
	});
	expect(remoteRepository(plain).repository).toEqual({ owner: "example", repo: "project" });
	expect(remoteRepository(plain, true).repository).toEqual({ owner: "me", repo: "project" });

	// A rewrite to another host still names GitHub by the configured URL, and git applies it.
	configure(dir, { "url.C:\\srv\\git\\.insteadOf": "https://github.com/" });
	const rewritten = readRemote(dir, "origin")!;
	expect(rewritten.used()).toEqual({
		fetch: "C:\\srv\\git\\example/project.git",
		push: "C:\\srv\\git\\me/project.git",
	});
	expect(remoteRepository(rewritten)).toEqual({
		url: "https://github.com/example/project.git",
		repository: { owner: "example", repo: "project" },
	});
});

test("ago rounds to minutes, hours, then days", () => {
	const now = Date.parse("2026-10-21T12:00:00Z");
	expect(ago(now, now - 10_000)).toBe("just now");
	expect(ago(now, now - 60_000)).toBe("1 minute ago");
	expect(ago(now, now - 3 * 3_600_000)).toBe("3 hours ago");
	expect(ago(now, now - 3 * 86_400_000)).toBe("3 days ago");
});
