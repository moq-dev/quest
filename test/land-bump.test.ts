// The pin bump pass against a fake GitHub and a local target repository, with the host's Nix and quest faked.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, test, vi } from "vitest";

import { type GitHubDependencies, requirements } from "../src/cli/github";
import { land } from "../src/cli/hold";
import { readRemote } from "../src/cli/land";
import {
	BUMP_BRANCH,
	type BumpContext,
	type BumpTools,
	bumpBody,
	bumpPass,
	latestRuns,
	questInput,
	unpin,
} from "../src/cli/land-bump";
import { configure, GIT_SETTINGS, tempDir } from "./fixture";

vi.mock("../src/cli/hold", () => ({ land: vi.fn(async () => {}) }));
const landed = vi.mocked(land);

const SOURCE = { owner: "moq-dev", repo: "quest" };
const OLD = "1".repeat(40);
const NEW = "2".repeat(40);

/** A flake.lock whose root input `quest` locks the source at `rev`, pinned in its URL when `pinned`. */
function lockFile(rev: string, pinned: boolean): string {
	const original = { owner: "moq-dev", repo: "quest", type: "github", ...(pinned ? { rev } : {}) };
	return `${JSON.stringify(
		{
			nodes: {
				nixpkgs: { locked: { type: "github", owner: "NixOS", repo: "nixpkgs", rev: "9".repeat(40) } },
				quest_2: { locked: { type: "github", owner: "moq-dev", repo: "quest", rev }, original },
				root: { inputs: { nixpkgs: "nixpkgs", quest: "quest_2", follows: ["nixpkgs"] } },
			},
			root: "root",
			version: 7,
		},
		null,
		2,
	)}\n`;
}

const flakeNix = (rev?: string) =>
	`{\n  inputs.quest.url = "github:moq-dev/quest${rev ? `/${rev}` : ""}";\n  outputs = { ... }: { };\n}\n`;

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** The target's repository, its `main` pinning the source at `OLD` in flake.nix's URL. */
function target(): { remote: string; base: string } {
	const work = tempDir();
	git(work, "init", "--quiet", "--initial-branch=main");
	configure(work, GIT_SETTINGS);
	writeFileSync(join(work, "flake.nix"), flakeNix(OLD));
	writeFileSync(join(work, "flake.lock"), lockFile(OLD, true));
	git(work, "add", ".");
	git(work, "commit", "--quiet", "-m", "init");
	const remote = tempDir();
	git(remote, "clone", "--quiet", "--bare", work, ".");
	configure(remote, { "uploadpack.allowAnySHA1InWant": "true" });
	return { remote: `file://${remote}`, base: git(work, "rev-parse", "HEAD") };
}

interface World {
	target: { owner: string; repo: string };
	remote: string;
	base: string;
	pulls: {
		number: number;
		head: string;
		state: string;
		draft: boolean;
		auto_merge: unknown;
		body?: string;
		base?: string;
	}[];
	rules: { type: string }[] | "free";
	allowAutoMerge: boolean;
	/** Each check on a head, as `statusCheckRollup` contexts. */
	checks: Record<string, Record<string, unknown>[]>;
	/** Each check suite on a head. */
	suites: Record<string, { status: string; latest_check_runs_count: number; app: { slug: string } }[]>;
	/** Each workflow run on a head. */
	runs: Record<string, { status: string; conclusion: string | null; [field: string]: unknown }[]>;
	requests: string[];
	/** The flake.lock GitHub serves on `main`, when it differs from the remote's. */
	lock?: string;
}

function deps(world: World): GitHubDependencies {
	const path = `/repos/${world.target.owner}/${world.target.repo}`;
	const json = (value: unknown, status = 200) => Response.json(value, { status });
	return {
		token: "test",
		now: () => 0,
		sleep: async () => {},
		warn: () => {},
		fetch: (async (input: URL, init?: RequestInit) => {
			const url = new URL(input);
			const method = init?.method ?? "GET";
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			world.requests.push(`${method} ${url.pathname}${url.search}`);
			if (url.pathname === "/graphql") {
				const query = String(body.query);
				if (query.includes("statusCheckRollup")) {
					const nodes = world.checks[body.variables.oid] ?? [];
					return json({
						data: {
							repository: {
								object: {
									statusCheckRollup: { contexts: { nodes, pageInfo: { hasNextPage: false } } },
								},
							},
						},
					});
				}
				const mutation = /mutation[^{]*\{\s*(\w+)/.exec(query)?.[1];
				const pull = world.pulls.find((candidate) => `PR_${candidate.number}` === body.variables.id)!;
				if (mutation === "disablePullRequestAutoMerge") pull.auto_merge = null;
				if (mutation === "convertPullRequestToDraft") pull.draft = true;
				if (mutation === "markPullRequestReadyForReview") pull.draft = false;
				return json({ data: {} });
			}
			if (url.pathname === path) return json({ default_branch: "main", allow_auto_merge: world.allowAutoMerge });
			if (url.pathname === `${path}/git/ref/heads/main`) return json({ object: { sha: world.base } });
			if (url.pathname === `${path}/contents/flake.lock`) {
				const text =
					world.lock ??
					git(world.remote.slice("file://".length), "show", `${url.searchParams.get("ref")}:flake.lock`);
				return json({ content: Buffer.from(text).toString("base64") });
			}
			if (url.pathname === `${path}/actions/runs`) {
				const listed = world.runs[url.searchParams.get("head_sha")!] ?? [];
				return json({ total_count: listed.length, workflow_runs: listed });
			}
			const suites = new RegExp(`^${path}/commits/(\\w+)/check-suites$`).exec(url.pathname);
			if (suites) {
				const listed = world.suites[suites[1]] ?? [];
				return json({ total_count: listed.length, check_suites: listed });
			}
			if (url.pathname === `${path}/branches/main`) return json({ protection: { enabled: false } });
			if (url.pathname === `${path}/rules/branches/main`) {
				if (world.rules === "free")
					return json(
						{ message: "Upgrade to GitHub Pro or make this repository public to enable this feature." },
						403,
					);
				return json(world.rules);
			}
			const view = (pull: World["pulls"][number]) => ({
				number: pull.number,
				node_id: `PR_${pull.number}`,
				state: pull.state,
				draft: pull.draft,
				auto_merge: pull.auto_merge,
				head: { sha: pull.head },
				base: { ref: pull.base ?? "main" },
			});
			if (url.pathname === `${path}/pulls` && method === "GET") {
				expect(url.searchParams.get("head")).toBe(`${world.target.owner}:${BUMP_BRANCH}`);
				return json(world.pulls.filter((pull) => pull.state === "open").map(view));
			}
			if (url.pathname === `${path}/pulls` && method === "POST") {
				const head = git(world.remote.slice("file://".length), "rev-parse", body.head);
				const pull = { number: 7, head, state: "open", draft: body.draft, auto_merge: null, body: body.body };
				world.pulls.push(pull);
				return json(view(pull), 201);
			}
			const number = /\/(?:pulls|issues)\/(\d+)/.exec(url.pathname)?.[1];
			const pull = world.pulls.find((candidate) => candidate.number === Number(number));
			if (pull && url.pathname === `${path}/pulls/${number}`) {
				if (method === "PATCH") {
					if (body.state) pull.state = body.state;
					if (body.base) pull.base = body.base;
					if (body.body) pull.body = body.body;
					if (body.body) pull.head = git(world.remote.slice("file://".length), "rev-parse", BUMP_BRANCH);
				}
				return json(view(pull));
			}
			if (pull && url.pathname === `${path}/issues/${number}/comments`)
				return method === "GET" ? json([]) : json({ id: 1 }, 201);
			throw new Error(`unexpected request ${method} ${url.pathname}`);
		}) as typeof fetch,
	};
}

/** Tools that lock as Nix would and a quest whose `init` writes a stub and whose `check --fix` passes unless told. */
function tools(findings?: string): BumpTools & { locks: string[] } {
	const locks: string[] = [];
	return {
		locks,
		lock: (checkout, input, url) => {
			locks.push(`${input} ${url}`);
			const rev = url.split("/").at(-1)!;
			writeFileSync(join(checkout, "flake.lock"), lockFile(rev, false));
		},
		quest: (sha) => `quest-${sha}`,
		run: (quest, checkout, args) => {
			if (args[0] === "init") writeFileSync(join(checkout, "stub.md"), `${quest}\n`);
			return findings !== undefined && args[0] === "check"
				? { status: 1, output: findings }
				: { status: 0, output: "" };
		},
	};
}

function context(world: World, faked = tools()): BumpContext {
	return {
		source: SOURCE,
		targets: [world.target],
		state: tempDir(),
		reader: async () => "reader",
		tools: faked,
		connect: () => ({ remote: world.remote, deps: deps(world), token: async () => "push", read: readRemote }),
	};
}

function world(overrides: Partial<World> = {}): World {
	const { remote, base } = target();
	return {
		target: { owner: "moq-dev", repo: "widget" },
		remote,
		base,
		pulls: [],
		rules: [{ type: "merge_queue" }],
		allowAutoMerge: true,
		checks: {},
		suites: {},
		runs: {},
		requests: [],
		...overrides,
	};
}

const bare = (world: World) => world.remote.slice("file://".length);

beforeEach(() => landed.mockClear());

describe("questInput", () => {
	test("finds the one root input locking the source, skipping follows and other inputs", () => {
		expect(questInput(JSON.parse(lockFile(OLD, true)), SOURCE)).toEqual({
			input: "quest",
			locked: OLD,
			pinned: OLD,
		});
		expect(questInput(JSON.parse(lockFile(OLD, false)), { owner: "Moq-Dev", repo: "Quest" })).toEqual({
			input: "quest",
			locked: OLD,
		});
	});

	test("fails on a lock with no such input, or more than one", () => {
		expect(() => questInput(JSON.parse(lockFile(OLD, false)), { owner: "moq-dev", repo: "other" })).toThrow(
			"0 root inputs",
		);
		const lock = JSON.parse(lockFile(OLD, false));
		lock.nodes.root.inputs.again = "quest_2";
		expect(() => questInput(lock, SOURCE)).toThrow("2 root inputs");
	});
});

describe("unpin", () => {
	test("drops the revision from the source's URL", () => {
		expect(unpin(flakeNix(OLD), SOURCE, OLD)).toBe(flakeNix());
	});

	test("matches the source's name in any case", () => {
		expect(unpin(flakeNix(OLD).replace("moq-dev/quest", "Moq-Dev/Quest"), SOURCE, OLD)).toBe(flakeNix());
	});

	test("fails unless the pinned URL appears exactly once", () => {
		expect(() => unpin(flakeNix(), SOURCE, OLD)).toThrow("0 times");
		expect(() => unpin(flakeNix(OLD) + flakeNix(OLD), SOURCE, OLD)).toThrow("2 times");
	});
});

test("bumpBody waits on a maintainer only for findings", () => {
	const options = { source: SOURCE, input: "quest", from: OLD, to: NEW, unpinned: false, changed: ["flake.lock"] };
	expect(bumpBody(options)).not.toContain("## Waiting");
	expect(bumpBody(options)).toContain("## Review\n\nSkipped: pin bump");
	expect(bumpBody({ ...options, findings: "quest/a.md: <bad>" })).toContain(
		"## Waiting\n\n- Maintainer: `quest check`",
	);
	expect(bumpBody({ ...options, findings: "quest/a.md: <bad>" })).toContain("&lt;bad>");
});

describe("requirements", () => {
	test("reads no rules from a private repository on GitHub Free", async () => {
		const free = world({ rules: "free" });
		expect(
			(await requirements(new (await import("../src/cli/github")).GitHub(deps(free)), free.target, "main")).rules,
		).toEqual([]);
	});
});

describe("bumpPass", () => {
	test("opens a bump PR on a gated base, unpinning the URL, and queues it once", async () => {
		const target = world();
		const ctx = context(target);
		expect(await bumpPass(ctx, NEW)).toEqual([`bump moq-dev/widget 7 ${NEW}`, "bump landing moq-dev/widget 7"]);

		const head = git(bare(target), "rev-parse", BUMP_BRANCH);
		expect(git(bare(target), "show", "-s", "--format=%P %an", head)).toBe(`${target.base} moq-bot`);
		expect(git(bare(target), "show", `${head}:flake.nix`)).toBe(flakeNix().trim());
		expect(JSON.parse(git(bare(target), "show", `${head}:flake.lock`)).nodes.quest_2.locked.rev).toBe(NEW);
		expect(git(bare(target), "show", `${head}:stub.md`)).toBe(`quest-${NEW}`);
		expect(target.pulls[0]).toMatchObject({ draft: false });
		expect(target.pulls[0].body).toContain("drops the revision");
		expect(target.pulls[0].body).toContain("changed `stub.md`");
		expect(landed).toHaveBeenCalledExactlyOnceWith(
			{ ...target.target, number: 7 },
			head,
			undefined,
			expect.anything(),
			false,
		);

		// The next pass at the same commit asks GitHub nothing.
		target.requests.length = 0;
		expect(await bumpPass(ctx, NEW)).toEqual([]);
		expect(target.requests).toEqual([]);
	});

	test("moves an open bump PR forward with a merge, disarming its auto-merge first", async () => {
		const target = world();
		const ctx = context(target);
		await bumpPass(ctx, OLD.replace(/1/g, "3"));
		const first = git(bare(target), "rev-parse", BUMP_BRANCH);
		target.pulls[0].auto_merge = { enabled_at: "now" };
		landed.mockClear();

		expect(await bumpPass(ctx, NEW)).toEqual([`bump moq-dev/widget 7 ${NEW}`, "bump landing moq-dev/widget 7"]);
		const head = git(bare(target), "rev-parse", BUMP_BRANCH);
		expect(git(bare(target), "show", "-s", "--format=%P", head)).toBe(`${first} ${target.base}`);
		expect(JSON.parse(git(bare(target), "show", `${head}:flake.lock`)).nodes.quest_2.locked.rev).toBe(NEW);
		expect(target.pulls[0].auto_merge).toBeNull();
		expect(target.pulls).toHaveLength(1);
		expect(landed).toHaveBeenCalledOnce();
	});

	test("leaves findings --fix cannot resolve as a draft for a maintainer", async () => {
		const target = world();
		expect(await bumpPass(context(target, tools("quest/a.md: broken")), NEW)).toEqual([
			`bump moq-dev/widget 7 ${NEW} waiting`,
		]);
		expect(target.pulls[0]).toMatchObject({ draft: true });
		expect(target.pulls[0].body).toContain("## Waiting");
		expect(target.pulls[0].body).toContain("quest/a.md: broken");
		expect(landed).not.toHaveBeenCalled();
	});

	test("closes an open bump PR once the base already pins the commit", async () => {
		const target = world({ lock: lockFile(NEW, false) });
		target.pulls.push({ number: 3, head: target.base, state: "open", draft: false, auto_merge: null });
		expect(await bumpPass(context(target), NEW)).toEqual(["bump closed moq-dev/widget 3"]);
		expect(target.pulls[0].state).toBe("closed");
	});

	test("on an ungated base, waits for every check to pass, then merges directly without auto-merge", async () => {
		const target = world({ rules: "free", allowAutoMerge: false });
		const ctx = context(target);
		expect(await bumpPass(ctx, NEW)).toEqual([`bump moq-dev/widget 7 ${NEW}`]);
		const head = git(bare(target), "rev-parse", BUMP_BRANCH);
		target.checks[head] = [{ __typename: "CheckRun", databaseId: 1, name: "check", status: "IN_PROGRESS" }];
		expect(await bumpPass(ctx, NEW)).toEqual([]);
		expect(landed).not.toHaveBeenCalled();

		// A workflow whose later job has not started yet shows only its passing first job.
		target.checks[head] = [
			{ __typename: "CheckRun", databaseId: 1, name: "check", status: "COMPLETED", conclusion: "SUCCESS" },
		];
		target.suites[head] = [
			{ status: "in_progress", latest_check_runs_count: 1, app: { slug: "ci-app" } },
			{ status: "queued", latest_check_runs_count: 0, app: { slug: "never-reports" } },
		];
		expect(await bumpPass(ctx, NEW)).toEqual([]);
		target.suites[head][0].status = "completed";
		// A queued workflow with no check run yet still holds it.
		target.suites[head].push({ status: "queued", latest_check_runs_count: 0, app: { slug: "github-actions" } });
		target.runs[head] = [{ status: "queued", conclusion: null }];
		expect(await bumpPass(ctx, NEW)).toEqual([]);
		expect(landed).not.toHaveBeenCalled();

		target.runs[head] = [{ status: "completed", conclusion: "success" }];
		expect(await bumpPass(ctx, NEW)).toEqual(["bump landing moq-dev/widget 7"]);
		expect(landed).toHaveBeenCalledExactlyOnceWith(
			{ ...target.target, number: 7 },
			head,
			undefined,
			expect.anything(),
			true,
		);
	});

	test("on an ungated base, a run a newer run cancelled counts as replaced, not failed", async () => {
		const target = world({ rules: "free", allowAutoMerge: false });
		const ctx = context(target);
		await bumpPass(ctx, NEW);
		const head = git(bare(target), "rev-parse", BUMP_BRANCH);
		// Push and pull_request share a cancel-in-progress group: the pull_request run cancelled the push run,
		// whose later job reported cancelled before the newer run started it.
		const cancelled = { id: 1, workflow_id: 10, event: "push", check_suite_id: 100 };
		const newer = { id: 2, workflow_id: 10, event: "pull_request", check_suite_id: 200 };
		const run = (suite: number, id: number, name: string, status: string, conclusion?: string) => ({
			__typename: "CheckRun",
			databaseId: id,
			name,
			status,
			conclusion,
			checkSuite: { databaseId: suite },
		});
		target.runs[head] = [
			{ ...cancelled, status: "completed", conclusion: "cancelled" },
			{ ...newer, status: "in_progress", conclusion: null },
		];
		target.checks[head] = [
			run(100, 1, "check", "COMPLETED", "CANCELLED"),
			run(100, 2, "later", "COMPLETED", "CANCELLED"),
			run(200, 3, "check", "IN_PROGRESS"),
		];
		expect(await bumpPass(ctx, NEW)).toEqual([]);
		expect(landed).not.toHaveBeenCalled();

		target.runs[head][1] = { ...newer, status: "completed", conclusion: "success" };
		target.checks[head] = [
			run(100, 1, "check", "COMPLETED", "CANCELLED"),
			run(100, 2, "later", "COMPLETED", "CANCELLED"),
			run(200, 3, "check", "COMPLETED", "SUCCESS"),
			run(200, 4, "later", "COMPLETED", "SUCCESS"),
		];
		expect(await bumpPass(ctx, NEW)).toEqual(["bump landing moq-dev/widget 7"]);
	});

	test("latestRuns keeps each workflow's latest run per event, and drops a cancelled run a newer one replaced", () => {
		const runs = [
			{ id: 1, workflow_id: 10, event: "push", conclusion: "failure" },
			{ id: 2, workflow_id: 10, event: "push", conclusion: "success" },
			{ id: 3, workflow_id: 20, event: "push", conclusion: "cancelled" },
			{ id: 4, workflow_id: 20, event: "pull_request", conclusion: "success" },
			{ id: 5, workflow_id: 30, event: "push", conclusion: "failure" },
			{ id: 6, workflow_id: 30, event: "pull_request", conclusion: "success" },
			{ id: 7, workflow_id: 40, event: "push", conclusion: "cancelled" },
		];
		// Another event's failure still counts, as does a cancellation nothing replaced.
		expect(latestRuns(runs).map((run) => run.id)).toEqual([2, 4, 5, 6, 7]);
	});

	test("a failed check on an ungated base is left for a maintainer", async () => {
		const target = world({ rules: [] });
		const ctx = context(target);
		await bumpPass(ctx, NEW);
		const head = git(bare(target), "rev-parse", BUMP_BRANCH);
		target.checks[head] = [
			{ __typename: "CheckRun", databaseId: 1, name: "check", status: "COMPLETED", conclusion: "FAILURE" },
		];
		expect(await bumpPass(ctx, NEW)).toEqual(["bump failed moq-dev/widget 7"]);
		expect(target.requests).toContain("POST /repos/moq-dev/widget/issues/7/comments");
		target.requests.length = 0;
		expect(await bumpPass(ctx, NEW)).toEqual([]);
		expect(target.requests).toEqual([]);
		expect(landed).not.toHaveBeenCalled();
	});

	test("refuses a target whose tree has a symlink out of the checkout", async () => {
		const target = world();
		const work = tempDir();
		git(work, "clone", "--quiet", bare(target), ".");
		configure(work, GIT_SETTINGS);
		// The checkout's parent, the daemon's own directory, exists; the dangling link would be created on write.
		symlinkSync("..", join(work, "AGENTS.md"));
		symlinkSync("../../nothing", join(work, "CLAUDE.md"));
		symlinkSync("flake.nix", join(work, "inside"));
		git(work, "add", ".");
		git(work, "commit", "--quiet", "-m", "link");
		git(work, "push", "--quiet", "origin", "HEAD:main");
		target.base = git(work, "rev-parse", "HEAD");
		await expect(bumpPass(context(target), NEW)).rejects.toThrow("AGENTS.md is a symlink out of the repository");
		expect(target.pulls).toEqual([]);
	});

	test("refuses an escaping symlink whose name holds a tab", async () => {
		const target = world();
		const work = tempDir();
		git(work, "clone", "--quiet", bare(target), ".");
		configure(work, GIT_SETTINGS);
		mkdirSync(join(work, "quest"));
		symlinkSync("../..", join(work, "quest", "\tescape.md"));
		git(work, "add", ".");
		git(work, "commit", "--quiet", "-m", "link");
		git(work, "push", "--quiet", "origin", "HEAD:main");
		target.base = git(work, "rev-parse", "HEAD");
		await expect(bumpPass(context(target), NEW)).rejects.toThrow("escape.md is a symlink out of the repository");
	});

	test("runs quest check --fix on the base's whole history, which names deleted quests", async () => {
		const target = world();
		const work = tempDir();
		git(work, "clone", "--quiet", bare(target), ".");
		configure(work, GIT_SETTINGS);
		writeFileSync(join(work, "second.md"), "second\n");
		git(work, "add", ".");
		git(work, "commit", "--quiet", "-m", "second");
		git(work, "push", "--quiet", "origin", "HEAD:main");
		target.base = git(work, "rev-parse", "HEAD");
		const faked = tools();
		const counts: string[] = [];
		const run = faked.run;
		faked.run = (quest, checkout, args) => {
			if (args[0] === "check") counts.push(git(checkout, "rev-list", "--count", "HEAD"));
			return run(quest, checkout, args);
		};
		const ctx = context(target, faked);
		await bumpPass(ctx, NEW);
		expect(counts).toEqual(["2"]);
	});

	test("starts over when the open bump PR closes while the bump is prepared", async () => {
		const target = world();
		const ctx = context(target);
		await bumpPass(ctx, OLD.replace(/1/g, "3"));
		const first = git(bare(target), "rev-parse", BUMP_BRANCH);
		const lock = ctx.tools.lock;
		ctx.tools.lock = (...args) => {
			target.pulls[0].state = "closed";
			lock(...args);
		};
		await expect(bumpPass(ctx, NEW)).rejects.toThrow("bump PR 7 closed while the bump was prepared");
		expect(git(bare(target), "rev-parse", BUMP_BRANCH)).toBe(first);
	});

	test("retargets an open bump PR at the target's current default branch", async () => {
		const target = world();
		const ctx = context(target);
		await bumpPass(ctx, OLD.replace(/1/g, "3"));
		target.pulls[0].base = "old";
		await bumpPass(ctx, NEW);
		expect(target.pulls[0].base).toBe("main");
	});

	test("a target that fails does not hold up the others, and the pass reports it", async () => {
		const broken = world({
			target: { owner: "moq-dev", repo: "broken" },
			lock: lockFile(OLD, false).replace(/moq-dev/g, "other"),
		});
		const good = world();
		const ctx = context(good);
		ctx.targets = [broken.target, good.target];
		ctx.connect = (target) =>
			target.repo === "broken"
				? { remote: broken.remote, deps: deps(broken), token: async () => "push", read: readRemote }
				: { remote: good.remote, deps: deps(good), token: async () => "push", read: readRemote };
		await expect(bumpPass(ctx, NEW)).rejects.toThrow("moq-dev/broken: flake.lock has 0 root inputs");
		expect(good.pulls).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(ctx.state, "bump.json"), "utf8"))).toEqual({
			"moq-dev/widget": { sha: NEW, pr: 7, head: git(bare(good), "rev-parse", BUMP_BRANCH), status: "done" },
		});
	});
});
