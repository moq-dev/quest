// `quest start` and `quest unblocked --unclaimed`: claims on local bare
// remotes, with GitHub replayed in memory. URL rewrites (`insteadOf`) let a
// github.com remote name reach a local bare repository.

import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { claims, openDrafts, target } from "../src/cli/claims";
import {
	type GitHubDependencies,
	type ObjectValue,
	githubRepository,
	readRemote,
	remoteRepository,
} from "../src/cli/github";
import { type Output, main } from "../src/cli/main";
import { Refusal, ago, claimBase, releaseQuest, startQuest } from "../src/cli/start";
import { EPIC_README, GIT_SETTINGS, TWO, Tree, configure, initRepository, template, tempDir } from "./fixture";

/** A quest directly under the milestone, whose PR targets the default branch. */
const ONE = "quest/m0/one.md";
const BRANCH = "quest/m0/one";
/** The fixture's quests in its epic, whose PRs target the epic's branch. */
const EPIC_ONE = "quest/m0/epic/one.md";
const EPIC_TWO = "quest/m0/epic/two.md";
const EPIC_README_PATH = "quest/m0/epic/README.md";
const EPIC_BRANCH = "quest/m0/epic/README";
const UPSTREAM = "https://github.com/example/project.git";
const FORK = "https://github.com/me/project.git";

// Each test spawns git a few dozen times, which takes seconds on Windows runners.
vi.setConfig({ testTimeout: 30_000 });

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The committed baseline tree plus a quest directly under the milestone. */
const seeded = template((dir) => {
	Tree.committed(dir).write(ONE, "# [S] One\n\n## Goal\n\nA quest outside any epic.\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "seed");
});

/** A bare repository whose default branch holds the seeded tree. */
const upstream = template((dir) => {
	git(dir, "clone", "-q", "--bare", seeded(), ".");
	configure(dir, GIT_SETTINGS);
});

/** The seeded tree, tracking origin's main, with no origin URL until `clone` sets one. */
const baselineClone = template((dir) => {
	seeded(dir);
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
	/** The repository the PR is in. */
	base: string;
	/** The branch it merges into. */
	baseRef: string;
	head: { ref: string; sha?: string; repo: { full_name: string } | null };
	draft: boolean;
	state: string;
	merged_at?: string | null;
	body: string;
	title?: string;
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
			baseRef: "main",
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
			const baseRef = String(body.base);
			// GitHub refuses a second open PR between the same branches.
			const duplicate = this.open_(match[1]).some(
				(pull) => pull.head.ref === ref && pull.head.repo?.full_name === headRepo && pull.baseRef === baseRef,
			);
			if (duplicate) return json(422, { message: "Validation Failed" });
			const pull = this.open(match[1], String(ref), headRepo, {
				baseRef,
				draft: body.draft === true,
				body: String(body.body),
				title: String(body.title),
			});
			this.onCreate?.();
			return json(201, pull);
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
	const at = await target(work, "origin", dependencies);
	return startQuest(work, at, await claimBase(work, at, path, dependencies), path, "[S] One", dependencies);
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
			/^chore\(quest\): claim quest\/m0\/one\.md\n\nQuest-Claim: [0-9a-f]{16}$/,
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
		cpSync(join(seeded(), "quest"), join(work, "sub", "quest"), { recursive: true });
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
			`claimed, but local branch ${BRANCH} already exists from an earlier attempt; ` +
				`switch to it, merge the claim commit ${started.sha} into it, and resume that work before pushing`,
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
		pull.body = "Work so far.\n\n## Waiting\n\n1. Which name?\n";
		await expect(attempt()).rejects.toThrow(`held by ${pull.html_url} (draft, waiting,`);
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
		cpSync(join(seeded(), "quest"), join(work, dir, "quest"), { recursive: true });
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
		const extra = "quest/m0/three.md";
		writeFileSync(join(work, extra), "# [S] Three\n\n## Goal\n\nOnly local.\n");
		await expect(start(work, new FakeGitHub(), [], extra)).rejects.toThrow(
			new Refusal(`${extra} is not on the upstream default branch; update your checkout`),
		);
		expect(tip(bare, "quest/m0/three")).toBe("");
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
				`${EPIC_ONE} cannot be claimed: git cannot hold ${EPIC_BRANCH} on origin beside a branch named after its directory or inside it:\n` +
					`- quest/m0/epic: ${state}\n` +
					"Stop and report this; do not delete or rename a branch in the way.",
			);

		await expect(start(work, github, [], EPIC_ONE)).rejects.toThrow(refusal("not a merged PR's head"));
		const pull = github.closed("example/project", "quest/m0/epic", blocker, true);
		await expect(start(work, github, [], EPIC_ONE)).rejects.toThrow(
			refusal(`the head of ${pull.html_url}, which merged`),
		);
		expect(tip(bare, "quest/m0/epic")).toBe(blocker);
		expect(tip(bare, EPIC_BRANCH)).toBe("");
		expect(tip(bare, "quest/m0/epic/one")).toBe("");
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

/** Commit `files` on `branch` of `work`'s origin, where `null` deletes one, and push them there. */
function landOn(work: string, branch: string, files: Record<string, string | null>): void {
	git(work, "fetch", "-q", "origin", `refs/heads/${branch}`);
	git(work, "switch", "-q", "--detach", "FETCH_HEAD");
	for (const [path, text] of Object.entries(files)) {
		if (text === null) rmSync(join(work, path));
		else writeFileSync(join(work, path), text);
	}
	git(work, "add", "-A");
	git(work, "commit", "-q", "-m", "land");
	git(work, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
}

const THREE = "quest/m0/epic/three.md";

describe("epic branches", () => {
	test("the first claim in an epic opens its branch and PR, and later claims build on them", async () => {
		const bare = upstream();
		const github = new FakeGitHub();
		const started = await start(clone(UPSTREAM, { [UPSTREAM]: bare }), github, [], EPIC_ONE);

		const epic = tip(bare, EPIC_BRANCH);
		expect(git(bare, "rev-parse", `${epic}^`)).toBe(git(bare, "rev-parse", "main"));
		expect(git(bare, "rev-parse", `${epic}^{tree}`)).toBe(git(bare, "rev-parse", "main^{tree}"));
		expect(git(bare, "log", "-1", "--format=%s", epic)).toBe(`chore(quest): open epic ${EPIC_README_PATH}`);
		expect(git(bare, "rev-parse", `${started.sha}^`)).toBe(epic);
		expect(started.url).toBe("https://github.com/example/project/pull/2");
		expect(github.pulls).toMatchObject([
			{ baseRef: "main", head: { ref: EPIC_BRANCH }, draft: true, title: "Epic" },
			{ baseRef: EPIC_BRANCH, head: { ref: "quest/m0/epic/one" }, draft: true },
		]);
		expect(github.pulls[0].body).toBe(
			`Lands the epic [${EPIC_README_PATH}](https://github.com/example/project/blob/main/${EPIC_README_PATH}) on ` +
				"`main` as one PR. Its quests' PRs merge into this branch first; the README's own work comes last.\n\n" +
				"## Waiting\n\n- quest/m0/epic: its quests merge into this branch first; this PR lands once none remain.\n",
		);
		expect(github.pulls[1].body).toBe(
			`Claims [${EPIC_ONE}](https://github.com/example/project/blob/${EPIC_BRANCH}/${EPIC_ONE}).`,
		);

		// A quest planned on the epic's branch alone is claimed there, with no second epic PR.
		const planner = clone(UPSTREAM, { [UPSTREAM]: bare });
		landOn(planner, EPIC_BRANCH, { [THREE]: "# [S] Three\n\n## Goal\n\nPlanned on the epic's branch.\n" });
		const third = await start(clone(UPSTREAM, { [UPSTREAM]: bare }), github, [], THREE);
		expect(git(bare, "rev-parse", `${third.sha}^`)).toBe(tip(bare, EPIC_BRANCH));
		expect(github.pulls).toHaveLength(3);
		expect(github.pulls[2]).toMatchObject({ baseRef: EPIC_BRANCH, head: { ref: "quest/m0/epic/three" } });
	});

	test("two claims in one epic race to open its branch, and share the one that wins", async () => {
		const bare = upstream();
		const github = new FakeGitHub();
		land(clone(UPSTREAM, { [UPSTREAM]: bare }), { [THREE]: "# [S] Three\n\n## Goal\n\nAlso ready.\n" });
		const [a, b] = [clone(UPSTREAM, { [UPSTREAM]: bare }), clone(UPSTREAM, { [UPSTREAM]: bare })];
		const [one, three] = await Promise.all([start(a, github, [], EPIC_ONE), start(b, github, [], THREE)]);

		const epic = tip(bare, EPIC_BRANCH);
		expect(git(bare, "rev-parse", `${one.sha}^`)).toBe(epic);
		expect(git(bare, "rev-parse", `${three.sha}^`)).toBe(epic);
		expect(github.open_("example/project").filter((pull) => pull.head.ref === EPIC_BRANCH)).toHaveLength(1);
	});

	test("a fork cannot open an epic's branch, but claims on one that exists", async () => {
		const bare = upstream();
		const forkBare = upstream();
		const github = new FakeGitHub();
		github.fork("me/project");
		const work = clone(FORK, { [FORK]: forkBare, [UPSTREAM]: bare });
		await expect(start(work, github, [], EPIC_ONE)).rejects.toThrow(
			new Refusal(
				`${EPIC_ONE} is in the epic ${EPIC_README_PATH}, whose branch ${EPIC_BRANCH} is not on example/project; ` +
					"a fork cannot create it, so a maintainer starts a quest in the epic first",
			),
		);
		expect(github.pulls).toEqual([]);

		git(bare, "branch", EPIC_BRANCH, "main");
		github.open("example/project", EPIC_BRANCH, "example/project");
		const started = await start(work, github, [], EPIC_ONE);
		expect(git(forkBare, "rev-parse", `${started.sha}^`)).toBe(tip(bare, EPIC_BRANCH));
		expect(github.pulls[1]).toMatchObject({ baseRef: EPIC_BRANCH, head: { repo: { full_name: "me/project" } } });
	});

	test("an epic's branch a merged PR landed is replaced, and a branch without a PR gets one", async () => {
		const bare = upstream();
		git(bare, "branch", EPIC_BRANCH, "main");
		const github = new FakeGitHub();
		github.closed("example/project", EPIC_BRANCH, tip(bare, EPIC_BRANCH), true);
		const landed = tip(bare, EPIC_BRANCH);
		const started = await start(clone(UPSTREAM, { [UPSTREAM]: bare }), github, [], EPIC_ONE);
		expect(tip(bare, EPIC_BRANCH)).not.toBe(landed);
		expect(git(bare, "rev-parse", `${started.sha}^`)).toBe(tip(bare, EPIC_BRANCH));

		const other = upstream();
		git(other, "branch", EPIC_BRANCH, "main");
		const fresh = new FakeGitHub();
		const second = await start(clone(UPSTREAM, { [UPSTREAM]: other }), fresh, [], EPIC_ONE);
		expect(git(other, "rev-parse", `${second.sha}^`)).toBe(git(other, "rev-parse", "main"));
		expect(fresh.pulls).toMatchObject([{ baseRef: "main", head: { ref: EPIC_BRANCH } }, { baseRef: EPIC_BRANCH }]);
	});

	test("an epic's README is read from its branch, and the epic's PR holds it once its quests are done", async () => {
		const work = clone(upstream());
		expect((await cli("--root", work, "start", EPIC_ONE)).code).toBe(0);
		const early = await cli("--root", work, "start", EPIC_README_PATH);
		expect(early.code).toBe(3);
		expect(early.stderr).toContain(`quest: ${EPIC_README_PATH} is blocked;`);

		// Off GitHub the epic's branch has no PR, so the branch itself holds the README.
		landOn(work, EPIC_BRANCH, {
			[EPIC_ONE]: null,
			[EPIC_TWO]: null,
			[EPIC_README_PATH]: EPIC_README.replace("# Epic", "# [S] Epic"),
		});
		const done = await cli("--root", work, "start", EPIC_README_PATH);
		expect(done.code, done.stderr).toBe(3);
		expect(done.stderr).toContain(`quest: ${EPIC_README_PATH} is held by branch ${EPIC_BRANCH}, with no open PR\n`);
	});

	test("release gives back an epic quest's claim and keeps the epic's branch and PR", async () => {
		const bare = upstream();
		const github = new FakeGitHub();
		const work = clone(UPSTREAM, { [UPSTREAM]: bare });
		const started = await start(work, github, [], EPIC_ONE);
		expect(await releaseQuest(work, EPIC_ONE, "origin", deps(github))).toEqual({
			branch: "quest/m0/epic/one",
			closed: [started.url],
		});
		expect(tip(bare, "quest/m0/epic/one")).toBe("");
		expect(tip(bare, EPIC_BRANCH)).not.toBe("");
		expect(github.open_("example/project").map((pull) => pull.head.ref)).toEqual([EPIC_BRANCH]);
	});

	test("a quest finished on its epic's branch is gone from every reading; outside quests wait for the epic", async () => {
		const bare = upstream();
		const work = clone(bare);
		// A quest outside the epic waits on one inside it.
		land(work, {
			[ONE]: "# [S] One\n\n## Goal\n\nAfter the epic.\n\n## Required\n\n- [One](/quest/m0/epic/one.md)\n",
		});
		expect((await cli("--root", work, "start", EPIC_ONE)).code).toBe(0);
		// The epic's PR for One lands on its branch: One is deleted with its links, there alone.
		landOn(work, EPIC_BRANCH, {
			[EPIC_ONE]: null,
			[EPIC_TWO]: TWO.replace(/\n## Required\n[^]*$/, ""),
			[ONE]: "# [S] One\n\n## Goal\n\nAfter the epic.\n",
			// A quest planned on the epic's branch alone, after Two.
			[THREE]: "# [S] Three\n\n## Goal\n\nAfter Two.\n\n## Required\n\n- [Two](/quest/m0/epic/two.md)\n",
		});

		const main = clone(bare);
		git(main, "fetch", "-q", "origin");
		git(main, "merge", "-q", "--ff-only", "origin/main");
		expect(await cli("--root", main, "unblocked")).toMatchObject({ code: 0, stdout: `1\t${EPIC_TWO}\n` });
		expect(await cli("--root", main, "unblocked", "--unclaimed")).toMatchObject({
			code: 0,
			stdout: `1\t${EPIC_TWO}\n`,
		});
		expect(await cli("--root", main, "unblocked", EPIC_TWO)).toMatchObject({ code: 0, stdout: "" });
		expect(await cli("--root", main, "unblocked", THREE)).toMatchObject({ code: 0, stdout: `${EPIC_TWO}\n` });
		expect(await cli("--root", main, "unblocked", ONE)).toMatchObject({ stdout: `${EPIC_ONE}\n` });
		expect(await cli("--root", main, "unblocked", EPIC_ONE)).toMatchObject({
			code: 1,
			stderr: `quest: ${EPIC_ONE} is finished on its epic's branch, ${EPIC_BRANCH}\n`,
		});
		const finished = await cli("--root", main, "start", EPIC_ONE);
		expect(finished.code).toBe(3);
		expect((await cli("--root", main, "start", ONE)).code).toBe(3);

		const two = await cli("--root", main, "start", EPIC_TWO);
		expect(two.code, two.stderr).toBe(0);
		expect(git(bare, "rev-parse", `${tip(bare, "quest/m0/epic/two")}^`)).toBe(tip(bare, EPIC_BRANCH));
	});

	test("a quest finished on the default branch unblocks an epic's quest before the branch catches up", async () => {
		const bare = upstream();
		const work = clone(bare);
		land(work, { [THREE]: "# [S] Three\n\n## Goal\n\nAfter One.\n\n## Required\n\n- [One](/quest/m0/one.md)\n" });
		expect((await cli("--root", work, "start", EPIC_ONE)).code).toBe(0);
		expect((await cli("--root", work, "start", THREE)).code).toBe(3);

		// One lands on the default branch, after the epic's branch was cut.
		git(work, "switch", "-q", "--detach", "origin/main");
		land(work, { [ONE]: null, [THREE]: "# [S] Three\n\n## Goal\n\nAfter One.\n" });
		const three = await cli("--root", work, "start", THREE);
		expect(three.code, three.stderr).toBe(0);
		expect(git(bare, "rev-parse", `${tip(bare, "quest/m0/epic/three")}^`)).toBe(tip(bare, EPIC_BRANCH));
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
		cpSync(join(seeded(), "quest"), join(work, "sub", "quest"), { recursive: true });
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
		git(bare, "branch", BRANCH, "main");

		expect(await cli("--root", work, "unblocked", "--unclaimed")).toEqual({
			code: 0,
			stdout: `1\t${EPIC_ONE}\n`,
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
			[EPIC_ONE]: null,
		});

		expect(await cli("--root", behind, "unblocked")).toMatchObject({ stdout: `1\t${EPIC_ONE}\n0\t${ONE}\n` });
		expect(await cli("--root", behind, "unblocked", "--unclaimed")).toEqual({
			code: 0,
			stdout: `0\t${EPIC_TWO}\n0\t${ONE}\n`,
			stderr: "quest: origin is not on GitHub, so only its branches were checked for claims\n",
		});
		const finished = await cli("--root", behind, "start", EPIC_ONE);
		expect(finished.code).toBe(3);
		expect(finished.stderr).toBe(
			`quest: ${EPIC_ONE} is not on the upstream default branch or its epic's branch; update your checkout\n`,
		);
		const ready = await cli("--root", behind, "start", "quest/m0/epic/two.md");
		expect(ready.code, ready.stderr).toBe(0);
		expect(tip(bare, "quest/m0/epic/two")).not.toBe("");
	});
});

test("openDrafts reads the upstream's open drafts from a fork's clone, by number", async () => {
	const bare = upstream();
	const github = new FakeGitHub();
	github.fork("me/project");
	const work = clone(FORK, { [FORK]: initRepository(undefined, { bare: true }), [UPSTREAM]: bare });
	github.open("example/project", "quest/m0/b", "someone/project", { body: "## Waiting\n\n- Maintainer: pick.\n" });
	github.open("example/project", "quest/m0/a", "example/project");
	github.open("example/project", "feature", "example/project", { draft: false });
	github.open("me/project", "quest/m0/c", "me/project");
	const warnings: string[] = [];
	const drafts = await openDrafts(work, "origin", deps(github, warnings));
	expect(drafts.map((pull) => [pull.number, pull.branch, pull.body])).toEqual([
		[1, "quest/m0/b", "## Waiting\n\n- Maintainer: pick.\n"],
		[2, "quest/m0/a", ""],
	]);
	expect(warnings).toEqual([]);
});

test("waiting lists a draft's items under its URL, ranked as the quest it carries", async () => {
	const bare = upstream();
	const github = new FakeGitHub();
	const work = clone(UPSTREAM, { [UPSTREAM]: bare });
	appendFileSync(join(work, EPIC_ONE), "\n## Waiting\n\n- moq-dev/moq: a release.\n");
	github.open("example/project", "quest/m0/epic/two", "example/project", {
		body: "Work.\n\n## Waiting\n\n- Maintainer: pick a name.\n",
	});
	vi.stubEnv("GH_TOKEN", "token");
	vi.stubGlobal("fetch", github.deps().fetch);
	try {
		expect(await cli("--root", work, "waiting")).toEqual({
			code: 0,
			stdout:
				"0\tblocked\thttps://github.com/example/project/pull/1\tMaintainer: pick a name.\n" +
				`1\tready\t${EPIC_ONE}\tmoq-dev/moq: a release.\n`,
			stderr: "",
		});
	} finally {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	}
});

test("openDrafts skips drafts with a warning when GitHub cannot be read", async () => {
	const work = clone(UPSTREAM, { [UPSTREAM]: upstream() });
	const warnings: string[] = [];
	const offline = {
		github: () => {
			throw new Error("set GH_TOKEN or GITHUB_TOKEN, or sign in with gh auth login");
		},
		warn: (message: string) => warnings.push(message),
	};
	expect(await openDrafts(work, "origin", offline)).toEqual([]);
	expect(await openDrafts(clone(upstream()), "origin", offline)).toEqual([]);
	expect(await openDrafts(work, "nope", offline)).toEqual([]);
	expect(warnings).toEqual([
		"draft PRs were skipped: set GH_TOKEN or GITHUB_TOKEN, or sign in with gh auth login",
		"origin is not on GitHub, so draft PRs were skipped",
		"no nope remote, so draft PRs were skipped",
	]);
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

test("readRemote uses the first of several URLs, as git does, with or without rewrites", () => {
	const dir = initRepository();
	git(dir, "remote", "add", "origin", "https://github.com/example/first.git");
	git(dir, "config", "--add", "remote.origin.url", "https://github.com/example/second.git");
	git(dir, "config", "--add", "remote.origin.pushurl", "https://github.com/me/first.git");
	git(dir, "config", "--add", "remote.origin.pushurl", "https://github.com/me/second.git");
	const first = { fetch: "https://github.com/example/first.git", push: "https://github.com/me/first.git" };
	expect(readRemote(dir, "origin")!.used()).toEqual(first);
	// A partial clone's filter follows its fetch URL in `git remote -v`.
	git(dir, "config", "remote.origin.promisor", "true");
	git(dir, "config", "remote.origin.partialclonefilter", "blob:none");
	git(dir, "config", "url.https://github.com/.insteadOf", "https://example.invalid/");
	expect(readRemote(dir, "origin")!.used()).toEqual(first);
});

test("ago rounds to minutes, hours, then days", () => {
	const now = Date.parse("2026-10-21T12:00:00Z");
	expect(ago(now, now - 10_000)).toBe("just now");
	expect(ago(now, now - 60_000)).toBe("1 minute ago");
	expect(ago(now, now - 3 * 3_600_000)).toBe("3 hours ago");
	expect(ago(now, now - 3 * 86_400_000)).toBe("3 days ago");
});
