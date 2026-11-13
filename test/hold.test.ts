// `quest iterate`, `ready`, `merge`, and `release`, against a PR replayed in memory.

import { describe, expect, test, vi } from "vitest";

import type { GitHubDependencies, ObjectValue } from "../src/cli/github";
import { finish, land, release, take } from "../src/cli/hold";
import { withoutHandBack } from "../src/core";
import { type Output, main } from "../src/cli/main";
import { Refusal } from "../src/cli/start";

// `quest merge` through main would fetch the PR from GitHub to check it; these PRs exist only in memory.
vi.mock("../src/cli/landed", async (original) => ({
	...(await original<typeof import("../src/cli/landed")>()),
	landingCheck: () => async () => [],
}));

const PR = { owner: "example", repo: "project", number: 7 };
const URL_ = "https://github.com/example/project/pull/7";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
/** A landing check that finds nothing. */
const clean = async () => [];

interface Event {
	__typename: "LabeledEvent" | "AutoMergeEnabledEvent" | "AddedToMergeQueueEvent";
	id: string;
	createdAt: string;
	label?: { name: string };
}

/** One PR on GitHub: its labels, timeline, and landing state. */
class FakePull {
	state = "OPEN";
	draft = false;
	body = "Summary.";
	head = HEAD;
	mergeState = "BLOCKED";
	queue = false;
	allowAutoMerge: boolean | null = true;
	/** The repository's merge method settings, hidden from the token when null. */
	methods: Record<string, boolean> | null = null;
	baseRef = "main";
	/** Runs after each pull request read, to change it between reads. */
	afterRead?: () => void;
	comparison = "ahead";
	base = BASE;
	readonly comparisons: string[] = [];
	/** Check names the base branch's rulesets require. */
	required: string[] = [];
	/** The base branch's other ruleset rules. */
	rules: ObjectValue[] = [];
	/** The head's check runs, as its `statusCheckRollup` lists them. */
	checks: ObjectValue[] = [];
	/** The head's workflow runs, as `GET /actions/runs` lists them. */
	runs: ObjectValue[] = [];
	autoMerge: ObjectValue | null = null;
	queueEntry: ObjectValue | null = null;
	labels: string[] = [];
	events: Event[] = [];
	/** Mutations and label writes, in order. */
	readonly writes: string[] = [];
	beforeAutoMerge?: () => string | undefined;
	/** The error GitHub answers `enqueuePullRequest` with, if any. */
	beforeEnqueue?: () => { message: string; type?: string } | undefined;
	reads = 0;
	/** The base's REVIEW.md, absent when null. */
	reviewMd: string | null = null;
	/** The PR's reviews and review threads, as the online reviewer's activity read lists them. */
	reviews: ObjectValue[] = [];
	threads: ObjectValue[] = [];
	/** The head's check runs, as `GET /commits/{sha}/check-runs` lists them. */
	checkRuns: ObjectValue[] = [];
	/** Each account's repository permission; absent ones are no collaborators. */
	permissions: Record<string, string> = {};
	/** Each commit's diff from the base. */
	diffs: Record<string, string> = {};
	private clock = Date.parse("2026-10-21T12:00:00Z");

	/** Add a label as GitHub does: re-adding one already on the PR records no event. */
	label(name: string): string | undefined {
		if (this.labels.includes(name)) return undefined;
		this.labels.push(name);
		return this.event("LabeledEvent", { label: { name } });
	}

	event(type: Event["__typename"], extra: Partial<Event> = {}): string {
		const id = `${type}_${this.events.length + 1}`;
		this.events.push({ __typename: type, id, createdAt: new Date(this.clock++).toISOString(), ...extra });
		return id;
	}

	deps(warnings: string[] = []): GitHubDependencies {
		return {
			fetch: async (input, init) => this.handle(new URL(String(input)), init ?? {}),
			now: () => this.clock,
			sleep: async () => undefined,
			token: "token",
			warn: (message) => warnings.push(message),
		};
	}

	private handle(url: URL, init: RequestInit): Response {
		const method = init.method ?? "GET";
		const body = init.body ? (JSON.parse(String(init.body)) as ObjectValue) : {};
		const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status });
		if (url.pathname === "/repos/example/project")
			return json(200, {
				...(this.allowAutoMerge === null ? {} : { allow_auto_merge: this.allowAutoMerge }),
				...this.methods,
			});
		if (url.pathname === "/graphql")
			return json(200, this.graphql(String(body.query), body.variables as ObjectValue));
		if (url.pathname === "/repos/example/project/issues/7/labels" && method === "POST") {
			for (const name of body.labels as string[]) this.label(name);
			this.writes.push(`add ${(body.labels as string[]).join(",")}`);
			return json(
				200,
				this.labels.map((name) => ({ name })),
			);
		}
		const removed = /^\/repos\/example\/project\/issues\/7\/labels\/(.+)$/.exec(url.pathname);
		if (removed && method === "DELETE") {
			const name = decodeURIComponent(removed[1]);
			this.writes.push(`remove ${name}`);
			if (!this.labels.includes(name)) return json(404, { message: "Label does not exist" });
			this.labels = this.labels.filter((label) => label !== name);
			return json(200, []);
		}
		if (url.pathname === "/repos/example/project/branches/main") return json(200, { protection: {} });
		if (url.pathname === "/repos/example/project/actions/runs" && url.searchParams.get("head_sha") === this.head)
			return json(200, { total_count: this.runs.length, workflow_runs: this.runs });
		if (url.pathname === "/repos/example/project/contents/REVIEW.md" && url.searchParams.get("ref") === this.base)
			return this.reviewMd === null ? json(404, { message: "Not Found" }) : new Response(this.reviewMd);
		if (url.pathname === `/repos/example/project/commits/${this.head}/check-runs`)
			return json(200, { total_count: this.checkRuns.length, check_runs: this.checkRuns });
		const permission = /^\/repos\/example\/project\/collaborators\/(.+)\/permission$/.exec(url.pathname);
		if (permission) {
			const level = this.permissions[decodeURIComponent(permission[1])];
			return level ? json(200, { permission: level }) : json(404, { message: "Not Found" });
		}
		const diff = /^\/repos\/example\/project\/compare\/main\.\.\.(\w+)$/.exec(url.pathname);
		if (diff && new Headers(init.headers).get("accept") === "application/vnd.github.diff")
			return new Response(this.diffs[diff[1]] ?? "");
		if (url.pathname === `/repos/example/project/compare/main...${this.head}`) {
			this.comparisons.push(`${url.pathname}${url.search}`);
			return json(200, { status: this.comparison, base_commit: { sha: this.base } });
		}
		if (url.pathname === "/repos/example/project/rules/branches/main") {
			const checks = this.required.map((context) => ({ context }));
			return json(200, [
				...(checks.length
					? [{ type: "required_status_checks", parameters: { required_status_checks: checks } }]
					: []),
				...this.rules,
			]);
		}
		if (url.pathname === "/repos/example/project/pulls/7" && method === "PATCH") {
			this.body = String(body.body);
			this.writes.push("edit body");
			return json(200, {});
		}
		return json(404, { message: `no route for ${method} ${url.pathname}` });
	}

	private graphql(query: string, variables: ObjectValue): ObjectValue {
		if (query.startsWith("mutation")) {
			const name = /\{\s*(\w+)\(/.exec(query)![1];
			if (variables.id !== "PR_7") throw new Error("mutation on the wrong PR");
			const method = variables.method ?? /mergeMethod: (\w+)/.exec(query)?.[1];
			const body = variables.body ? ` ${String(variables.body)}` : "";
			this.writes.push([name, variables.sha, method].filter(Boolean).join(" ") + body);
			if (name === "markPullRequestReadyForReview") this.draft = false;
			if (name === "mergePullRequest") this.state = "MERGED";
			if (name === "enablePullRequestAutoMerge") {
				const reason = this.beforeAutoMerge?.();
				if (reason) return { errors: [{ message: reason }] };
				// Like GitHub, enabling it again keeps the existing request and its commit body.
				this.autoMerge ??= { enabledAt: "2026-10-21T12:00:00Z", commitBody: variables.body ?? null };
				this.event("AutoMergeEnabledEvent");
			}
			if (name === "disablePullRequestAutoMerge") this.autoMerge = null;
			if (name === "enqueuePullRequest") {
				const error = this.beforeEnqueue?.();
				if (error) return { errors: [error] };
				this.queueEntry = { state: "QUEUED" };
			}
			return { data: { [name]: { clientMutationId: null } } };
		}
		if (query.includes("node(id: $id)")) return { data: { node: { autoMergeRequest: this.autoMerge } } };
		if (query.includes("p7: pullRequest")) {
			const page = (nodes: ObjectValue[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });
			return {
				data: {
					repository: {
						p7: {
							headRefOid: this.head,
							reviews: page(this.reviews),
							reviewThreads: page(this.threads),
							comments: page([]),
						},
					},
				},
			};
		}
		if (query.includes("statusCheckRollup"))
			return {
				data: {
					repository: {
						object: {
							statusCheckRollup: {
								contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: this.checks },
							},
						},
					},
				},
			};
		this.reads++;
		const read = this.read();
		this.afterRead?.();
		return read;
	}

	private read(): ObjectValue {
		return {
			data: {
				repository: {
					pullRequest: {
						id: "PR_7",
						url: URL_,
						state: this.state,
						isDraft: this.draft,
						body: this.body,
						updatedAt: new Date(this.clock).toISOString(),
						baseRefName: this.baseRef,
						baseRefOid: this.base,
						headRefName: "quest/m0/example",
						headRefOid: this.head,
						mergeStateStatus: this.mergeState,
						isMergeQueueEnabled: this.queue,
						autoMergeRequest: this.autoMerge,
						mergeQueueEntry: this.queueEntry,
						isInMergeQueue: this.queueEntry !== null,
						labels: { nodes: this.labels.map((name) => ({ name })) },
						timelineItems: { nodes: this.events.slice(-100) },
					},
				},
			},
		};
	}
}

/** The refusal a promise rejects with. */
async function refused(work: Promise<unknown>): Promise<string> {
	const error = await work.then(
		() => undefined,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(Refusal);
	return (error as Refusal).message;
}

describe("taking a PR", () => {
	test("labels it quest:active and prints the event that added the label as the token", async () => {
		const pull = new FakePull();
		const hold = await take(PR, undefined, pull.deps());
		expect(hold).toEqual({ label: "quest:active", token: "LabeledEvent_1" });
		expect(pull.labels).toEqual(["quest:active"]);
	});

	test("refuses a draft its starter still holds, and takes one handed back", async () => {
		const pull = new FakePull();
		pull.draft = true;
		expect(await refused(take(PR, undefined, pull.deps()))).toContain("its starter still holds");
		expect(pull.writes).toEqual([]);

		pull.body = "Summary.\r\n\r\n## Waiting\r\n\r\n1. Pick one.\r\n";
		expect((await take(PR, undefined, pull.deps())).label).toBe("quest:active");
	});

	test("refuses a merged or closed PR", async () => {
		for (const state of ["MERGED", "CLOSED"]) {
			const pull = new FakePull();
			pull.state = state;
			expect(await refused(take(PR, undefined, pull.deps()))).toContain(
				`is ${state.toLowerCase()}; a push now would bring its branch back`,
			);
			expect(pull.writes).toEqual([]);
		}
	});

	test("refuses a second session without handing it the holder's token", async () => {
		const pull = new FakePull();
		const first = await take(PR, undefined, pull.deps());
		const message = await refused(take(PR, undefined, pull.deps()));
		expect(message).toContain("held by quest:active, added just now, so stop and report it");
		expect(message).not.toContain(first.token);
		expect(pull.labels).toEqual(["quest:active"]);
	});

	test("ignores the quest:merge label older quest versions left on queued PRs", async () => {
		const pull = new FakePull();
		pull.label("quest:merge");
		expect((await take(PR, undefined, pull.deps())).label).toBe("quest:active");
		expect(pull.labels).toEqual(["quest:merge", "quest:active"]);
	});

	test("keeps the hold its token names", async () => {
		const pull = new FakePull();
		const hold = await take(PR, undefined, pull.deps());
		expect(await take(PR, hold.token, pull.deps())).toEqual(hold);
		expect(pull.writes).toEqual(["add quest:active"]);
	});

	test("refuses a token naming a label that holds nothing", async () => {
		const pull = new FakePull();
		const token = pull.label("quest:ready")!;
		expect(await refused(take(PR, token, pull.deps()))).toContain("quest:ready is off");
		expect(pull.writes).toEqual([]);
	});

	test("refuses a token once another session holds the label", async () => {
		const pull = new FakePull();
		const stale = await take(PR, undefined, pull.deps());
		pull.labels = [];
		const current = await take(PR, undefined, pull.deps());
		expect(await refused(take(PR, stale.token, pull.deps()))).toContain(
			`quest:active was added to ${URL_} again after ${stale.token}`,
		);
		expect(await refused(take(PR, "LabeledEvent_99", pull.deps()))).toContain("is not an event");
		expect(pull.labels).toEqual(["quest:active"]);
		expect(current.token).toBe("LabeledEvent_2");
	});
});

describe("ready", () => {
	test("drops the Waiting section and marks the draft ready, keeping the hold", async () => {
		const pull = new FakePull();
		pull.draft = true;
		pull.body = "Summary.\n\n## Waiting\n\n1. Pick one.\n\n## Validation\n\nTests pass.";
		const hold = await take(PR, undefined, pull.deps());
		expect(await finish(PR, hold.token, pull.deps())).toEqual(hold);
		expect(pull.body).toBe("Summary.\n\n## Validation\n\nTests pass.");
		expect(pull.draft).toBe(false);
		expect(pull.labels).toEqual(["quest:active"]);
		expect(pull.writes.slice(-2)).toEqual(["edit body", "markPullRequestReadyForReview"]);
	});
});

describe("merge --land", () => {
	test.each(["CLEAN", "BLOCKED", "UNKNOWN"])("refuses auto-merge off (%s)", async (state) => {
		const pull = new FakePull();
		pull.allowAutoMerge = false;
		pull.mergeState = state;
		expect(await refused(land(PR, { sha: HEAD, method: "squash", check: clean }, pull.deps()))).toContain(
			"CONTRIBUTING.md or AGENTS.md",
		);
		expect(pull.writes).toEqual([]);
		expect(pull.state).toBe("OPEN");
	});

	test.each([false, true])("refuses a head whose latest run of any check failed (queue: %s)", async (queue) => {
		const pull = new FakePull();
		pull.queue = queue;
		const run = (databaseId: number, name: string, status: string, conclusion: string | null) => ({
			__typename: "CheckRun",
			databaseId,
			name,
			status,
			conclusion,
			detailsUrl: `https://ci.example/${databaseId}`,
			checkSuite: { app: { databaseId: 15368 } },
		});
		// The own queue's check reports a dropped pick, not the head, so it never blocks a requeue.
		pull.checks = [
			run(1, "Check", "COMPLETED", "FAILURE"),
			run(2, "Lint", "IN_PROGRESS", null),
			run(4, "quest queue", "COMPLETED", "FAILURE"),
		];
		expect(await refused(land(PR, { sha: HEAD, method: "merge", check: clean }, pull.deps()))).toContain(
			`head ${HEAD} failed a check: Check (https://ci.example/1)`,
		);
		expect(pull.writes).toEqual([]);
		// A rerun that passed supersedes the failure; a pending check does not block.
		pull.checks.push(run(3, "Check", "COMPLETED", "SUCCESS"));
		await land(PR, { sha: HEAD, method: "merge", check: clean }, pull.deps());
		expect(pull.writes).not.toEqual([]);
	});

	test("lands past a cancelled check once a newer run of its workflow exists, as on kixelated/token-max#78", async () => {
		const pull = new FakePull();
		const run = (databaseId: number, name: string, conclusion: string, suite: number) => ({
			__typename: "CheckRun",
			databaseId,
			name,
			status: "COMPLETED",
			conclusion,
			detailsUrl: `https://ci.example/${databaseId}`,
			checkSuite: { databaseId: suite, app: { databaseId: 15368 } },
		});
		pull.checks = [run(1, "Tests (${{ matrix.os }})", "CANCELLED", 10), run(2, "Tests (macos-15)", "SUCCESS", 20)];
		pull.runs = [{ id: 1, workflow_id: 7, check_suite_id: 10, run_started_at: "2026-11-12T23:42:53Z" }];
		expect(await refused(land(PR, { sha: HEAD, method: "merge", check: clean }, pull.deps()))).toContain(
			"Tests (${{ matrix.os }})",
		);
		expect(pull.writes).toEqual([]);
		pull.runs.push({ id: 2, workflow_id: 7, check_suite_id: 20, run_started_at: "2026-11-12T23:42:56Z" });
		await land(PR, { sha: HEAD, method: "merge", check: clean }, pull.deps());
		expect(pull.writes).not.toEqual([]);
	});

	test("refuses when the token cannot see the auto-merge setting", async () => {
		const pull = new FakePull();
		pull.allowAutoMerge = null;
		pull.mergeState = "CLEAN";
		expect(await refused(land(PR, { sha: HEAD, method: "squash", check: clean }, pull.deps()))).toContain(
			"not visible to this token",
		);
		expect(pull.writes).toEqual([]);
	});

	test("takes no label, and refuses while a session holds the PR", async () => {
		const pull = new FakePull();
		const { token } = await take(PR, undefined, pull.deps());
		const message = await refused(land(PR, { sha: HEAD, method: "merge", check: clean }, pull.deps()));
		expect(message).toContain("held by quest:active, added just now");
		expect(message).not.toContain(token);
		await release(PR, token, pull.deps());
		pull.label("quest:active");
		expect(await refused(land(PR, { sha: HEAD, method: "merge", check: clean }, pull.deps()))).toContain(
			"held by quest:active",
		);
		pull.labels = ["quest:merge"];
		await land(PR, { sha: HEAD, method: "merge", check: clean }, pull.deps());
		expect(pull.writes.at(-1)).toBe(`enablePullRequestAutoMerge ${HEAD} MERGE`);
		expect(pull.labels).toEqual(["quest:merge"]);
	});

	test.each([false, true])("refuses a PR retargeted while its policy was read (gated: %s)", async (gated) => {
		const pull = new FakePull();
		pull.required = gated ? ["quest land"] : [];
		pull.afterRead = () => {
			pull.afterRead = undefined;
			pull.baseRef = "release";
		};
		expect(await refused(land(PR, { sha: HEAD, method: "squash", check: clean }, pull.deps()))).toContain(
			"retargeted from main to release",
		);
		expect(pull.writes).toEqual([]);
	});

	test("refuses a merged PR or a draft its starter still holds", async () => {
		const pull = new FakePull();
		pull.draft = true;
		expect(await refused(land(PR, { sha: HEAD, method: "merge", check: clean }, pull.deps()))).toContain(
			"its starter still holds",
		);
		pull.state = "MERGED";
		expect(await refused(land(PR, { sha: HEAD, method: "merge", check: clean }, pull.deps()))).toContain(
			"is merged",
		);
		expect(pull.writes).toEqual([]);
	});

	test("leaves a merge queue to decide, even with auto-merge off", async () => {
		const pull = new FakePull();
		pull.allowAutoMerge = false;
		pull.queue = true;
		await land(PR, { sha: HEAD, method: "merge", check: clean }, pull.deps());
		expect(pull.writes.at(-1)).toBe(`enablePullRequestAutoMerge ${HEAD} MERGE`);
	});

	test.each(["CLEAN", "HAS_HOOKS", "UNSTABLE", "BEHIND", "DIRTY"])(
		"enqueues a %s head on a queue base without comparing it to the base",
		async (state) => {
			const pull = new FakePull();
			pull.queue = true;
			pull.mergeState = state;
			pull.comparison = "diverged";
			const warnings: string[] = [];
			await land(PR, { sha: HEAD, method: "merge", check: clean }, pull.deps(warnings));
			expect(pull.writes).toEqual([`enqueuePullRequest ${HEAD}`]);
			expect(pull.queueEntry).not.toBeNull();
			expect(pull.comparisons).toEqual([]);
			expect(warnings).toEqual([]);
		},
	);

	test("arms auto-merge bound to the head while a queue base's required checks are pending", async () => {
		const pull = new FakePull();
		pull.queue = true;
		pull.mergeState = "BLOCKED";
		await land(PR, { sha: HEAD, method: "merge", check: clean }, pull.deps());
		expect(pull.writes).toEqual([`enablePullRequestAutoMerge ${HEAD} MERGE`]);
	});

	test("enqueues an UNKNOWN head GitHub finds clean when arming auto-merge", async () => {
		const pull = new FakePull();
		pull.queue = true;
		pull.mergeState = "UNKNOWN";
		pull.beforeAutoMerge = () => "Pull request is in clean status";
		await land(PR, { sha: HEAD, method: "squash", check: clean }, pull.deps());
		expect(pull.writes).toEqual([`enablePullRequestAutoMerge ${HEAD} SQUASH`, `enqueuePullRequest ${HEAD}`]);
	});

	test("fails when GitHub refuses to enqueue the head, saying to fix the PR", async () => {
		const pull = new FakePull();
		pull.queue = true;
		pull.mergeState = "DIRTY";
		pull.beforeEnqueue = () => ({ message: "Pull request is not mergeable", type: "UNPROCESSABLE" });
		expect(await refused(land(PR, { sha: HEAD, method: "merge", check: clean }, pull.deps()))).toBe(
			`${URL_}: GitHub refused to enqueue ${HEAD} (GitHub GraphQL error: Pull request is not mergeable); fix the PR, for example with /quest-iterate, and land it again`,
		);
		expect(pull.queueEntry).toBeNull();
	});

	test("says nothing when GitHub refuses a head already in the queue", async () => {
		const pull = new FakePull();
		pull.queue = true;
		pull.mergeState = "CLEAN";
		pull.beforeEnqueue = () => {
			pull.queueEntry = { state: "QUEUED" };
			return { message: "Pull request is already queued" };
		};
		const warnings: string[] = [];
		await land(PR, { sha: HEAD, method: "merge", check: clean }, pull.deps(warnings));
		expect(warnings).toEqual([]);
	});

	test("refuses when the head moved before GitHub refused to enqueue it", async () => {
		const pull = new FakePull();
		pull.queue = true;
		pull.mergeState = "CLEAN";
		pull.beforeEnqueue = () => {
			pull.head = "c".repeat(40);
			return { message: "Head ref has moved" };
		};
		expect(await refused(land(PR, { sha: HEAD, method: "merge", check: clean }, pull.deps()))).toContain(
			`head moved to ${"c".repeat(40)}`,
		);
	});

	test("passes on an enqueue error that faults the token rather than the PR", async () => {
		const pull = new FakePull();
		pull.queue = true;
		pull.mergeState = "CLEAN";
		pull.beforeEnqueue = () => ({ message: "Resource not accessible by integration", type: "FORBIDDEN" });
		const error = await land(PR, { sha: HEAD, method: "merge", check: clean }, pull.deps()).catch(
			(caught: unknown) => caught,
		);
		expect(error).not.toBeInstanceOf(Refusal);
		expect(error).toMatchObject({ message: "GitHub GraphQL error: Resource not accessible by integration" });
	});

	test("--direct explicitly permits a clean merge with auto-merge off", async () => {
		const pull = new FakePull();
		pull.allowAutoMerge = false;
		pull.mergeState = "CLEAN";
		vi.stubEnv("GH_TOKEN", "token");
		vi.stubGlobal("fetch", pull.deps().fetch);
		try {
			let stdout = "";
			expect(
				await main(["merge", URL_, "--land", HEAD, "--direct"], {
					stdout: (text) => void (stdout += text),
					stderr: () => undefined,
				}),
			).toBe(0);
			expect(pull.writes).toEqual([`mergePullRequest ${HEAD} MERGE`]);
			expect(stdout).toBe("");
		} finally {
			vi.unstubAllEnvs();
			vi.unstubAllGlobals();
		}
	});

	test.each(["UNKNOWN", "BLOCKED"])("--direct merges at once in %s with auto-merge off", async (state) => {
		const pull = new FakePull();
		pull.allowAutoMerge = false;
		pull.mergeState = state;
		await land(PR, { sha: HEAD, method: "squash", direct: true, check: clean }, pull.deps());
		expect(pull.writes).toEqual([`mergePullRequest ${HEAD} SQUASH`]);
	});

	test.each(["behind", "diverged"])(
		"refuses a stale ungated head (%s), then accepts it after a base merge",
		async (status) => {
			const pull = new FakePull();
			pull.comparison = status;
			const refusal = await refused(land(PR, { sha: HEAD, method: "squash", check: clean }, pull.deps()));
			expect(refusal).toContain(`head ${HEAD} does not contain main at ${BASE}`);
			expect(pull.writes).toEqual([]);
			pull.head = "c".repeat(40);
			pull.comparison = "ahead";
			await land(PR, { sha: pull.head, method: "squash", check: clean }, pull.deps());
			expect(pull.writes.at(-1)).toBe(`enablePullRequestAutoMerge ${pull.head} SQUASH`);
		},
	);

	test("accepts a head identical to the current base", async () => {
		const pull = new FakePull();
		pull.comparison = "identical";
		pull.base = HEAD;
		await land(PR, { sha: HEAD, method: "merge", check: clean }, pull.deps());
		expect(pull.writes.at(-1)).toBe(`enablePullRequestAutoMerge ${HEAD} MERGE`);
	});

	test("enables auto-merge with a merge commit by default, bound to the head", async () => {
		const pull = new FakePull();
		await land(PR, { sha: HEAD, method: "merge", check: clean }, pull.deps());
		expect(pull.writes).toEqual([`enablePullRequestAutoMerge ${HEAD} MERGE`]);
		expect(pull.labels).toEqual([]);
	});

	test("merges at once when nothing is left to wait for, with --squash or --rebase", async () => {
		for (const method of ["squash", "rebase"] as const) {
			const pull = new FakePull();
			pull.mergeState = "CLEAN";
			await land(PR, { sha: HEAD, method: method, check: clean }, pull.deps());
			expect(pull.writes.at(-1)).toBe(`mergePullRequest ${HEAD} ${method.toUpperCase()}`);
		}
	});

	describe("picks the repository's merge method", () => {
		const allowing = (...methods: string[]) => {
			const pull = new FakePull();
			pull.methods = {
				allow_merge_commit: methods.includes("merge"),
				allow_squash_merge: methods.includes("squash"),
				allow_rebase_merge: methods.includes("rebase"),
			};
			return pull;
		};

		test("uses the only method allowed without a flag", async () => {
			for (const method of ["squash", "rebase"]) {
				const pull = allowing(method);
				await land(PR, { sha: HEAD, check: clean }, pull.deps());
				expect(pull.writes.at(-1)).toBe(`enablePullRequestAutoMerge ${HEAD} ${method.toUpperCase()}`);
			}
		});

		test("keeps a merge commit by default while one is allowed", async () => {
			const pull = allowing("merge", "squash");
			await land(PR, { sha: HEAD, check: clean }, pull.deps());
			expect(pull.writes.at(-1)).toBe(`enablePullRequestAutoMerge ${HEAD} MERGE`);
		});

		test("also applies with --direct", async () => {
			const pull = allowing("squash");
			pull.allowAutoMerge = false;
			pull.mergeState = "CLEAN";
			await land(PR, { sha: HEAD, direct: true, check: clean }, pull.deps());
			expect(pull.writes).toEqual([`mergePullRequest ${HEAD} SQUASH`]);
		});

		test("refuses a named method the repository disallows, or a choice it leaves open", async () => {
			const cases: [string[], "merge" | "squash" | "rebase" | undefined, string][] = [
				[["squash"], "merge", "does not allow merge commits; it allows squash merges"],
				[["merge", "squash"], "rebase", "does not allow rebase merges; it allows merge commits, squash merges"],
				[["squash", "rebase"], undefined, "pass --squash or --rebase"],
				[[], undefined, "allows no merge method"],
			];
			for (const [methods, named, refusal] of cases) {
				const pull = allowing(...methods);
				expect(await refused(land(PR, { sha: HEAD, method: named, check: clean }, pull.deps()))).toContain(
					refusal,
				);
				expect(pull.writes).toEqual([]);
			}
		});

		test("leaves a gated base or a merge queue to its own method", async () => {
			// The gate's auto-merge only signals the queue: squash where allowed, else a method the base allows.
			// A base's rulesets narrow the methods its repository allows.
			for (const [methods, ruled, signal] of [
				[["merge", "squash"], null, "SQUASH"],
				[["merge"], null, "MERGE"],
				[["merge", "squash", "rebase"], ["rebase", "merge"], "MERGE"],
			] as const) {
				const gated = allowing(...methods);
				gated.required = ["quest land"];
				if (ruled) gated.rules = [{ type: "pull_request", parameters: { allowed_merge_methods: [...ruled] } }];
				await land(PR, { sha: HEAD, check: clean }, gated.deps());
				expect(gated.writes.at(-1)).toBe(
					`enablePullRequestAutoMerge ${HEAD} ${signal} Quest-Land-Head: ${HEAD}`,
				);
			}
			const refusing = allowing("merge", "squash");
			refusing.required = ["quest land"];
			refusing.rules = [{ type: "pull_request", parameters: { allowed_merge_methods: ["merge"] } }];
			expect(await refused(land(PR, { sha: HEAD, method: "squash", check: clean }, refusing.deps()))).toContain(
				"cannot land with squash merges on main, by its repository settings or rulesets",
			);
			refusing.rules.push({ type: "pull_request", parameters: { allowed_merge_methods: ["squash"] } });
			expect(await refused(land(PR, { sha: HEAD, check: clean }, refusing.deps()))).toContain(
				"has no merge method its repository and main's rulesets both allow",
			);
			expect(refusing.writes).toEqual([]);

			const queued = allowing("squash");
			queued.queue = true;
			const warnings: string[] = [];
			await land(PR, { sha: HEAD, check: clean }, queued.deps(warnings));
			expect(queued.writes.at(-1)).toBe(`enablePullRequestAutoMerge ${HEAD} MERGE`);
			expect(warnings).toEqual([]);
		});
	});

	test("warns that a merge queue applies its own method", async () => {
		const pull = new FakePull();
		pull.mergeState = "CLEAN";
		pull.queue = true;
		const warnings: string[] = [];
		await land(PR, { sha: HEAD, method: "squash", check: clean }, pull.deps(warnings));
		expect(pull.writes.at(-1)).toBe(`enqueuePullRequest ${HEAD}`);
		expect(warnings).toEqual([`${URL_} lands through a merge queue, which applies its own merge method`]);
	});

	test("queues a gated base's PR for quest land: auto-merge pinning the head", async () => {
		const pull = new FakePull();
		pull.required = ["test", "quest land"];
		pull.allowAutoMerge = false; // The host-gated path does not use the ungated pre-check.
		pull.comparison = "diverged";
		const warnings: string[] = [];
		await land(PR, { sha: HEAD, method: "merge", check: clean }, pull.deps(warnings));
		expect(pull.writes).toEqual([`enablePullRequestAutoMerge ${HEAD} MERGE Quest-Land-Head: ${HEAD}`]);
		expect(warnings).toEqual([`${URL_} lands through quest land, which applies its own merge method`]);
		expect(pull.comparisons).toEqual([]);
	});

	test("re-pins a gated PR already auto-merging on an older head", async () => {
		const pull = new FakePull();
		pull.required = ["test", "quest land"];
		pull.autoMerge = { enabledAt: "2026-10-20T12:00:00Z", commitBody: `Quest-Land-Head: ${"0".repeat(40)}` };
		await land(PR, { sha: HEAD, method: "squash", check: clean }, pull.deps());
		expect(pull.writes.slice(-2)).toEqual([
			"disablePullRequestAutoMerge",
			`enablePullRequestAutoMerge ${HEAD} SQUASH Quest-Land-Head: ${HEAD}`,
		]);
		expect(pull.autoMerge?.commitBody).toBe(`Quest-Land-Head: ${HEAD}`);
	});

	test("replaces an unpinned auto-merge request with an empty commit body", async () => {
		const pull = new FakePull();
		pull.required = ["test", "quest land"];
		pull.autoMerge = { enabledAt: "2026-10-20T12:00:00Z", commitBody: "" };
		await land(PR, { sha: HEAD, method: "squash", check: clean }, pull.deps());
		expect(pull.autoMerge?.commitBody).toBe(`Quest-Land-Head: ${HEAD}`);
	});

	test.each(["CLEAN", "HAS_HOOKS", "UNSTABLE"])(
		"rereads an UNKNOWN state once after a clean refusal, then merges %s at the same head",
		async (state) => {
			const pull = new FakePull();
			pull.mergeState = "UNKNOWN";
			pull.beforeAutoMerge = () => {
				pull.mergeState = state;
				return "Pull request is in clean status";
			};
			await land(PR, { sha: HEAD, method: "squash", check: clean }, pull.deps());
			expect(pull.writes).toEqual([
				`enablePullRequestAutoMerge ${HEAD} SQUASH`,
				`mergePullRequest ${HEAD} SQUASH`,
			]);
			expect(pull.reads).toBe(3); // The first read, the reread before landing, then one after refusal.
			expect(pull.state).toBe("MERGED");
		},
	);

	test("keeps UNKNOWN on auto-merge when GitHub accepts it", async () => {
		const pull = new FakePull();
		pull.mergeState = "UNKNOWN";
		await land(PR, { sha: HEAD, method: "merge", check: clean }, pull.deps());
		expect(pull.writes.at(-1)).toBe(`enablePullRequestAutoMerge ${HEAD} MERGE`);
		expect(pull.reads).toBe(2);
		expect(pull.state).toBe("OPEN");
	});

	test.each(["Pull request is in clean status", "Auto merge is not allowed for this repository"])(
		"preserves a refused UNKNOWN auto-merge: %s",
		async (reason) => {
			const pull = new FakePull();
			pull.mergeState = "UNKNOWN";
			pull.beforeAutoMerge = () => reason;
			await expect(land(PR, { sha: HEAD, method: "merge", check: clean }, pull.deps())).rejects.toThrow(reason);
			expect(pull.reads).toBe(reason.includes("clean status") ? 3 : 2);
			expect(pull.writes.at(-1)).toBe(`enablePullRequestAutoMerge ${HEAD} MERGE`);
		},
	);

	test.each(["head", "hold", "base", "gate", "queue"])(
		"does not merge after the clean refusal changes its %s",
		async (change) => {
			const pull = new FakePull();
			pull.mergeState = "UNKNOWN";
			pull.beforeAutoMerge = () => {
				pull.mergeState = "CLEAN";
				if (change === "head") pull.head = "b".repeat(40);
				if (change === "hold") pull.label("quest:active");
				if (change === "base") pull.baseRef = "release";
				if (change === "gate") pull.required = ["quest land"];
				if (change === "queue") pull.queue = true;
				return "Pull request is in clean status";
			};
			await expect(land(PR, { sha: HEAD, method: "merge", check: clean }, pull.deps())).rejects.toThrow();
			expect(pull.state).toBe("OPEN");
			expect(pull.writes.at(-1)).toBe(`enablePullRequestAutoMerge ${HEAD} MERGE`);
		},
	);

	test("refuses a head that moved", async () => {
		const pull = new FakePull();
		pull.head = "b".repeat(40);
		expect(await refused(land(PR, { sha: HEAD, method: "merge", check: clean }, pull.deps()))).toContain(
			`head moved to ${"b".repeat(40)}`,
		);
		expect(pull.writes).toEqual([]);
	});
});

describe("release", () => {
	test("removes the label its token holds", async () => {
		const pull = new FakePull();
		const { token } = await take(PR, undefined, pull.deps());
		expect(await release(PR, token, pull.deps())).toBe("quest:active");
		expect(pull.labels).toEqual([]);
	});

	test("refuses a stale token and treats a label already off as released", async () => {
		const pull = new FakePull();
		const stale = await take(PR, undefined, pull.deps());
		pull.labels = [];
		const warnings: string[] = [];
		expect(await release(PR, stale.token, pull.deps(warnings))).toBe("quest:active");
		expect(warnings).toEqual([`quest:active is already off ${URL_}`]);

		await take(PR, undefined, pull.deps());
		expect(await refused(release(PR, stale.token, pull.deps()))).toContain("another session holds it");
		expect(pull.labels).toEqual(["quest:active"]);
	});
});

test("drops each Waiting section up to the next heading", () => {
	expect(withoutHandBack("Summary.\n\n## Waiting\n\n- Maintainer: pick.\n\n## Validation\n\nTests pass.")).toBe(
		"Summary.\n\n## Validation\n\nTests pass.",
	);
});

test("drops each Waiting section up to the next heading, whatever its line endings or closing hashes", () => {
	expect(withoutHandBack("Summary.\r\n\r\n## Waiting\r\n\r\n1. Pick.\r\n### Detail\r\nMore.\r\n")).toBe("Summary.");
	expect(withoutHandBack("# Title\n\n## Waiting ##\n- one\n# Next\nkept")).toBe("# Title\n\n# Next\nkept");
});

describe("arguments", () => {
	async function cli(...args: string[]) {
		let stderr = "";
		const out: Output = { stdout: () => undefined, stderr: (text) => void (stderr += text) };
		return { code: await main(args, out), stderr };
	}

	test.each([
		[["ready", URL_], "missing required argument 'token'"],
		[["merge", URL_], "required option '--land <sha>' not specified"],
		[["merge", URL_, "--land", "abc"], "--land needs a full 40-character SHA"],
		[["merge", URL_, "token", "--land", HEAD], "too many arguments"],
		[["iterate", "https://example.com/pull/1"], "expected a GitHub pull request URL"],
	])("%j is a usage error", async (args, message) => {
		const result = await cli(...args);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain(message);
	});

	test("--squash and --rebase conflict", async () => {
		expect((await cli("merge", URL_, "--land", HEAD, "--squash", "--rebase")).code).toBe(2);
	});
});

// process.stdout.write returns a boolean; printing the token once made it the exit code.
test("iterate and release exit 0 when stdout returns a value", async () => {
	const pull = new FakePull();
	vi.stubEnv("GH_TOKEN", "token");
	vi.stubGlobal("fetch", pull.deps().fetch);
	try {
		let stdout = "";
		const out = { stdout: (text: string) => ((stdout += text), true), stderr: () => true } as Output;
		expect(await main(["iterate", URL_], out)).toBe(0);
		const token = stdout.trim();
		expect(pull.labels).toEqual(["quest:active"]);
		expect(await main(["release", URL_, token], out)).toBe(0);
		expect(pull.labels).toEqual([]);
	} finally {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	}
});

describe("merge --land with an online reviewer", () => {
	const OLD = "c".repeat(40);
	const bot = { __typename: "Bot", login: "pullfrog" };
	const review = (id: string, commit: string, author: ObjectValue = bot, body = "Reviewed.") => ({
		id,
		url: `${URL_}#pullrequestreview-${id}`,
		state: "COMMENTED",
		author,
		body,
		submittedAt: `2026-10-21T11:0${id}:00Z`,
		commit: { oid: commit },
	});
	const thread = (id: string, resolvedBy: ObjectValue | null = null) => ({
		id: `T_${id}`,
		isResolved: resolvedBy !== null,
		resolvedBy,
		comments: {
			pageInfo: { hasNextPage: false, endCursor: null },
			nodes: [{ author: bot, body: "A bug.", url: `${URL_}#discussion_r${id}`, pullRequestReview: { id } }],
		},
	});
	const run = (status: string, conclusion: string | null, slug = "pullfrog") => ({
		name: slug,
		status,
		conclusion,
		app: { slug },
	});
	const declared = () => {
		const pull = new FakePull();
		pull.reviewMd = "---\nonline-reviewer: pullfrog[bot]\n---\n\nBe adversarial.\n";
		return pull;
	};
	const merge = (pull: FakePull) => land(PR, { sha: HEAD, method: "merge", check: clean }, pull.deps());

	test("lands on the local review alone when the base's REVIEW.md names no online reviewer", async () => {
		const pull = new FakePull();
		pull.reviewMd = "Be adversarial.\n";
		await merge(pull);
		expect(pull.writes).not.toEqual([]);
	});

	test("refuses a head it has not reviewed, and one it is still reviewing", async () => {
		const pull = declared();
		expect(await refused(merge(pull))).toBe(
			`${URL_} head ${HEAD}: pullfrog[bot], the online reviewer REVIEW.md names, has not reviewed it or a head with the same diff; land it once it has, asking it to review if it does not start`,
		);
		// Another app's check says nothing of this reviewer.
		pull.checkRuns = [run("in_progress", null), run("completed", "success", "coderabbitai")];
		expect(await refused(merge(pull))).toContain("is still reviewing it");
		pull.checkRuns = [run("completed", "cancelled")];
		expect(await refused(merge(pull))).toContain("has not reviewed it");
		expect(pull.writes).toEqual([]);
	});

	test("counts a review of the head, or its own app's successful check run on it", async () => {
		const checked = declared();
		checked.checkRuns = [run("completed", "success")];
		await merge(checked);
		expect(checked.writes).not.toEqual([]);
		const reviewed = declared();
		reviewed.reviews = [review("1", HEAD)];
		await merge(reviewed);
		expect(reviewed.writes).not.toEqual([]);
	});

	test("counts no review another account posts in its name", async () => {
		const pull = declared();
		pull.permissions = { outsider: "read" };
		pull.reviews = [
			review("1", HEAD, { __typename: "User", login: "outsider" }, "Automated review by pullfrog[bot]\n\nFine."),
		];
		expect(await refused(merge(pull))).toContain("has not reviewed it");
	});

	test("counts an earlier head's review only while the head's diff from the base matches it", async () => {
		const same = declared();
		same.reviews = [review("1", OLD)];
		same.diffs = { [HEAD]: "diff", [OLD]: "diff" };
		await merge(same);
		expect(same.writes).not.toEqual([]);
		const changed = declared();
		changed.reviews = [review("1", OLD)];
		changed.diffs = { [HEAD]: "new", [OLD]: "old" };
		expect(await refused(merge(changed))).toContain("has not reviewed it");
	});

	test("refuses while a thread it opened on any head is unresolved, or resolved by an account that cannot push", async () => {
		const pull = declared();
		pull.reviews = [review("1", OLD), review("2", HEAD)];
		pull.threads = [thread("1")];
		expect(await refused(merge(pull))).toContain(
			`has findings no writer resolved: ${URL_}#discussion_r1; fix or refute each in its thread and resolve it`,
		);
		// GitHub lets the PR's author resolve a thread without write access.
		pull.threads = [thread("1", { __typename: "User", login: "author" })];
		pull.permissions = { author: "read" };
		expect(await refused(merge(pull))).toContain(`${URL_}#discussion_r1`);
		expect(pull.writes).toEqual([]);
		pull.permissions = { author: "write" };
		await merge(pull);
		expect(pull.writes).not.toEqual([]);
	});

	test("a thread it resolved itself is settled", async () => {
		const pull = declared();
		pull.reviews = [review("1", HEAD)];
		pull.threads = [thread("1", bot)];
		await merge(pull);
		expect(pull.writes).not.toEqual([]);
	});
});
