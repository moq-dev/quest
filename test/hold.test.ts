// `quest iterate`, `ready`, `merge`, and `release`, against a PR replayed in memory.

import { describe, expect, test, vi } from "vitest";

import type { GitHubDependencies, ObjectValue } from "../src/cli/github";
import { finish, land, release, take, withoutHandBack } from "../src/cli/hold";
import { type Output, main } from "../src/cli/main";
import { Refusal } from "../src/cli/start";

const PR = { owner: "example", repo: "project", number: 7 };
const URL_ = "https://github.com/example/project/pull/7";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

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
	autoMerge: ObjectValue | null = null;
	queueEntry: ObjectValue | null = null;
	labels: string[] = [];
	events: Event[] = [];
	/** Mutations and label writes, in order. */
	readonly writes: string[] = [];
	/** Runs before each label is added, as when another session adds one at the same moment. */
	beforeAdd?: () => void;
	/** Runs after each label is added, as when another session adds one a moment later. */
	afterAdd?: () => void;
	beforeAutoMerge?: () => string | undefined;
	reads = 0;
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
			this.beforeAdd?.();
			for (const name of body.labels as string[]) this.label(name);
			this.afterAdd?.();
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
		if (url.pathname === `/repos/example/project/compare/main...${this.head}`) {
			this.comparisons.push(`${url.pathname}${url.search}`);
			return json(200, { status: this.comparison, base_commit: { sha: this.base } });
		}
		if (url.pathname === "/repos/example/project/rules/branches/main") {
			const checks = this.required.map((context) => ({ context }));
			return json(
				200,
				checks.length
					? [{ type: "required_status_checks", parameters: { required_status_checks: checks } }]
					: [],
			);
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
			this.writes.push(method ? `${name} ${variables.sha} ${method}${body}` : name);
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
			return { data: { [name]: { clientMutationId: null } } };
		}
		if (query.includes("node(id: $id)")) return { data: { node: { autoMergeRequest: this.autoMerge } } };
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
						headRefOid: this.head,
						mergeStateStatus: this.mergeState,
						isMergeQueueEnabled: this.queue,
						autoMergeRequest: this.autoMerge,
						mergeQueueEntry: this.queueEntry,
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

		pull.body = "Summary.\r\n\r\n## Decisions needed\r\n\r\n1. Pick one.\r\n";
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

	test("refuses a second session, naming the holder's token", async () => {
		const pull = new FakePull();
		const first = await take(PR, undefined, pull.deps());
		const message = await refused(take(PR, undefined, pull.deps()));
		expect(message).toContain(`held by quest:active, added just now as token ${first.token}`);
		expect(pull.labels).toEqual(["quest:active"]);
	});

	test.each(["quest:iterate", "quest:ready", "quest:kix"])(
		"refuses while %s holds it, as an older quest version or kix adds",
		async (label) => {
			const pull = new FakePull();
			const token = pull.label(label);
			expect(await refused(take(PR, undefined, pull.deps()))).toContain(`held by ${label}`);
			expect(pull.labels).toEqual([label]);
			// Its token releases it.
			expect(await release(PR, token!, pull.deps())).toBe(label);
			expect((await take(PR, undefined, pull.deps())).label).toBe("quest:active");
		},
	);

	test("ignores the quest:merge label older quest versions left on queued PRs", async () => {
		const pull = new FakePull();
		pull.label("quest:merge");
		expect((await take(PR, undefined, pull.deps())).label).toBe("quest:active");
		expect(pull.labels).toEqual(["quest:merge", "quest:active"]);
	});

	test("backs off when another session's label lands between its check and its add", async () => {
		const pull = new FakePull();
		pull.beforeAdd = () => {
			pull.beforeAdd = undefined;
			pull.label("quest:iterate");
		};
		expect(await refused(take(PR, undefined, pull.deps()))).toContain("held by quest:iterate");
		expect(pull.labels).toEqual(["quest:iterate"]);
		expect(pull.writes).toEqual(["add quest:active", "remove quest:active"]);
	});

	test("keeps the PR when another session's label lands after its own", async () => {
		const pull = new FakePull();
		pull.afterAdd = () => {
			pull.afterAdd = undefined;
			pull.label("quest:iterate");
		};
		expect(await take(PR, undefined, pull.deps())).toEqual({ label: "quest:active", token: "LabeledEvent_1" });
		// The later session sees the earlier label and backs off.
		expect(pull.labels).toEqual(["quest:active", "quest:iterate"]);
	});

	test("keeps the hold its token names, and swaps an older version's label for quest:active", async () => {
		const pull = new FakePull();
		const hold = await take(PR, undefined, pull.deps());
		expect(await take(PR, hold.token, pull.deps())).toEqual(hold);
		expect(pull.writes).toEqual(["add quest:active"]);

		const legacy = new FakePull();
		const token = legacy.label("quest:ready")!;
		expect(await take(PR, token, legacy.deps())).toEqual({ label: "quest:active", token: "LabeledEvent_2" });
		expect(legacy.labels).toEqual(["quest:active"]);
		expect(legacy.writes).toEqual(["add quest:active", "remove quest:ready"]);
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
	test("drops the Decisions needed section and marks the draft ready, keeping the hold", async () => {
		const pull = new FakePull();
		pull.draft = true;
		pull.body = "Summary.\n\n## Decisions needed\n\n1. Pick one.\n\n## Validation\n\nTests pass.";
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
		expect(await refused(land(PR, HEAD, "squash", pull.deps()))).toContain("CONTRIBUTING.md or AGENTS.md");
		expect(pull.writes).toEqual([]);
		expect(pull.state).toBe("OPEN");
	});

	test("refuses when the token cannot see the auto-merge setting", async () => {
		const pull = new FakePull();
		pull.allowAutoMerge = null;
		pull.mergeState = "CLEAN";
		expect(await refused(land(PR, HEAD, "squash", pull.deps()))).toContain("not visible to this token");
		expect(pull.writes).toEqual([]);
	});

	test("takes no label, and refuses while a session holds the PR", async () => {
		const pull = new FakePull();
		const { token } = await take(PR, undefined, pull.deps());
		expect(await refused(land(PR, HEAD, "merge", pull.deps()))).toContain(
			`held by quest:active, added just now as token ${token}`,
		);
		pull.label("quest:iterate");
		await release(PR, token, pull.deps());
		expect(await refused(land(PR, HEAD, "merge", pull.deps()))).toContain("held by quest:iterate");
		pull.labels = ["quest:merge"];
		await land(PR, HEAD, "merge", pull.deps());
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
		expect(await refused(land(PR, HEAD, "squash", pull.deps()))).toContain("retargeted from main to release");
		expect(pull.writes).toEqual([]);
	});

	test("refuses a merged PR or a draft its starter still holds", async () => {
		const pull = new FakePull();
		pull.draft = true;
		expect(await refused(land(PR, HEAD, "merge", pull.deps()))).toContain("its starter still holds");
		pull.state = "MERGED";
		expect(await refused(land(PR, HEAD, "merge", pull.deps()))).toContain("is merged");
		expect(pull.writes).toEqual([]);
	});

	test("leaves a merge queue to decide, even with auto-merge off", async () => {
		const pull = new FakePull();
		pull.allowAutoMerge = false;
		pull.queue = true;
		await land(PR, HEAD, "merge", pull.deps());
		expect(pull.writes.at(-1)).toBe(`enablePullRequestAutoMerge ${HEAD} MERGE`);
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

	test.each(["behind", "diverged"])(
		"refuses a stale ungated head (%s), then accepts it after a base merge",
		async (status) => {
			const pull = new FakePull();
			pull.comparison = status;
			const refusal = await refused(land(PR, HEAD, "squash", pull.deps()));
			expect(refusal).toContain(`head ${HEAD} does not contain main at ${BASE}`);
			expect(pull.writes).toEqual([]);
			pull.head = "c".repeat(40);
			pull.comparison = "ahead";
			await land(PR, pull.head, "squash", pull.deps());
			expect(pull.writes.at(-1)).toBe(`enablePullRequestAutoMerge ${pull.head} SQUASH`);
		},
	);

	test("accepts a head identical to the current base", async () => {
		const pull = new FakePull();
		pull.comparison = "identical";
		pull.base = HEAD;
		await land(PR, HEAD, "merge", pull.deps());
		expect(pull.writes.at(-1)).toBe(`enablePullRequestAutoMerge ${HEAD} MERGE`);
	});

	test("enables auto-merge with a merge commit by default, bound to the head", async () => {
		const pull = new FakePull();
		await land(PR, HEAD, "merge", pull.deps());
		expect(pull.writes).toEqual([`enablePullRequestAutoMerge ${HEAD} MERGE`]);
		expect(pull.labels).toEqual([]);
	});

	test("merges at once when nothing is left to wait for, with --squash or --rebase", async () => {
		for (const method of ["squash", "rebase"] as const) {
			const pull = new FakePull();
			pull.mergeState = "CLEAN";
			await land(PR, HEAD, method, pull.deps());
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
				await land(PR, HEAD, undefined, pull.deps());
				expect(pull.writes.at(-1)).toBe(`enablePullRequestAutoMerge ${HEAD} ${method.toUpperCase()}`);
			}
		});

		test("keeps a merge commit by default while one is allowed", async () => {
			const pull = allowing("merge", "squash");
			await land(PR, HEAD, undefined, pull.deps());
			expect(pull.writes.at(-1)).toBe(`enablePullRequestAutoMerge ${HEAD} MERGE`);
		});

		test("also applies with --direct", async () => {
			const pull = allowing("squash");
			pull.allowAutoMerge = false;
			pull.mergeState = "CLEAN";
			await land(PR, HEAD, undefined, pull.deps(), true);
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
				expect(await refused(land(PR, HEAD, named, pull.deps()))).toContain(refusal);
				expect(pull.writes).toEqual([]);
			}
		});

		test("leaves a gated base or a merge queue to its own method", async () => {
			const gated = allowing("merge");
			gated.required = ["quest land"];
			await land(PR, HEAD, undefined, gated.deps());
			expect(gated.writes.at(-1)).toBe(`enablePullRequestAutoMerge ${HEAD} SQUASH Quest-Land-Head: ${HEAD}`);

			const queued = allowing("squash");
			queued.queue = true;
			const warnings: string[] = [];
			await land(PR, HEAD, undefined, queued.deps(warnings));
			expect(queued.writes.at(-1)).toBe(`enablePullRequestAutoMerge ${HEAD} MERGE`);
			expect(warnings).toEqual([]);
		});
	});

	test("enters the merge queue through auto-merge even when clean", async () => {
		const pull = new FakePull();
		pull.mergeState = "CLEAN";
		pull.queue = true;
		const warnings: string[] = [];
		await land(PR, HEAD, "squash", pull.deps(warnings));
		expect(pull.writes.at(-1)).toBe(`enablePullRequestAutoMerge ${HEAD} SQUASH`);
		expect(warnings).toEqual([`${URL_} lands through a merge queue, which applies its own merge method`]);
	});

	test("queues a gated base's PR for quest land: squash auto-merge pinning the head", async () => {
		const pull = new FakePull();
		pull.required = ["test", "quest land"];
		pull.allowAutoMerge = false; // The host-gated path does not use the ungated pre-check.
		pull.comparison = "diverged";
		const warnings: string[] = [];
		await land(PR, HEAD, "merge", pull.deps(warnings));
		expect(pull.writes).toEqual([`enablePullRequestAutoMerge ${HEAD} SQUASH Quest-Land-Head: ${HEAD}`]);
		expect(warnings).toEqual([`${URL_} lands through quest land, which squashes`]);
		expect(pull.comparisons).toEqual([]);
	});

	test("re-pins a gated PR already auto-merging on an older head", async () => {
		const pull = new FakePull();
		pull.required = ["test", "quest land"];
		pull.autoMerge = { enabledAt: "2026-10-20T12:00:00Z", commitBody: `Quest-Land-Head: ${"0".repeat(40)}` };
		await land(PR, HEAD, "squash", pull.deps());
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
		await land(PR, HEAD, "squash", pull.deps());
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
			await land(PR, HEAD, "squash", pull.deps());
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
		await land(PR, HEAD, "merge", pull.deps());
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
			await expect(land(PR, HEAD, "merge", pull.deps())).rejects.toThrow(reason);
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
			await expect(land(PR, HEAD, "merge", pull.deps())).rejects.toThrow();
			expect(pull.state).toBe("OPEN");
			expect(pull.writes.at(-1)).toBe(`enablePullRequestAutoMerge ${HEAD} MERGE`);
		},
	);

	test("refuses a head that moved", async () => {
		const pull = new FakePull();
		pull.head = "b".repeat(40);
		expect(await refused(land(PR, HEAD, "merge", pull.deps()))).toContain(`head moved to ${"b".repeat(40)}`);
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

test("drops each Decisions needed section up to the next heading", () => {
	expect(withoutHandBack("Summary.\r\n\r\n## Decisions needed\r\n\r\n1. Pick.\r\n### Detail\r\nMore.\r\n")).toBe(
		"Summary.",
	);
	expect(withoutHandBack("# Title\n\n## Decisions needed ##\n- one\n# Next\nkept")).toBe("# Title\n\n# Next\nkept");
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
