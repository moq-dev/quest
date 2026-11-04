import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Commit, type Repo, type World, fakeGitHub, intercept } from "../dev/github";
import { GitHubService } from "../src/github/service";
import * as store from "../src/jobs/store";
import { verify } from "../src/jobs/trust";
import { privateKey } from "./github-key";
import { owner } from "./owners";

const db = env.DB;
const base = "a".repeat(40);
const head = "b".repeat(40);
const tree = "c".repeat(40);
const repository = { id: 10, owner: "upstream", name: "project" };
const signature = (login = "maintainer", databaseId = 7) => ({ isValid: true, signer: { login, databaseId } });
const commit = (parents = [base]): Commit => ({ parents, tree, message: "Change", signature: signature() });
let repo: Repo;
let github: typeof fetch;
const testEnv = { ...env, GITHUB_APP_PRIVATE_KEY: privateKey };
const service = () => new GitHubService(testEnv);
const trusted = (revision = head) => service().jobTrust(repository, "pulls/2", revision);

beforeEach(async () => {
	repo = {
		...repository,
		maintainers: ["maintainer"],
		files: [],
		issues: [],
		pulls: [{ number: 2, title: "Fix", author: "maintainer", branch: "fix", checks: null, review: null }],
		branches: { main: base, fix: head },
		trees: {},
		commits: { [base]: { parents: [], tree, message: "Base" }, [head]: commit() },
	};
	const world: World = {
		app: { id: Number(env.GITHUB_APP_ID), slug: "quest" },
		installation: 5,
		owner,
		users: [
			{ id: 7, login: "maintainer", name: "Maintainer", email: "maintainer@example.test" },
			{ id: 8, login: "contributor", name: "Contributor", email: "contributor@example.test" },
		],
		repos: [repo],
	};
	github = fakeGitHub(world);
	vi.spyOn(globalThis, "fetch").mockImplementation(github);
	await db.batch([
		db.prepare(
			"INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('owner','Owner','owner@example.test',1,0,0)",
		),
		db.prepare(
			"INSERT INTO account(id,accountId,providerId,userId,createdAt,updatedAt) VALUES('owner-github','7','github','owner',0,0)",
		),
		db.prepare(
			"INSERT INTO github_projects(id,owner,name,installation,state,enrolledBy,updatedAt) VALUES(10,'upstream','project',5,'enabled','owner',0)",
		),
	]);
});
afterEach(() => vi.restoreAllMocks());

async function queued(revision = head) {
	return (
		await store.createJob(
			db,
			{
				repository: repo.id,
				actor: "owner",
				workflow: "iterate",
				target: "pulls/2",
				revision,
				branch: "fix",
				trusted: await trusted(revision),
			},
			0,
		)
	).id;
}

async function runner(name: string, platform: store.Platform, vm = false) {
	const { id } = await store.createRunner(db, "owner", name, platform, vm, 0);
	const machine = { id, owner: "owner", name, platform, vm: vm ? 1 : 0 };
	await store.report(
		db,
		machine,
		[{ id: "account", provider: "anthropic", kind: "subscription", label: name, limited: false }],
		[],
		0,
	);
	return machine;
}

const dispatch = (machines: store.Runner[]) =>
	store.dispatch(db, "owner", new Map(machines.map((r) => [r.id, 1])), 1, verify(testEnv));

describe("authenticated PR provenance", () => {
	it("routes a maintainer-signed head to an ordinary macOS runner", async () => {
		const id = await queued();
		const mac = await runner("mac", "darwin");
		expect((await dispatch([mac])).assign).toMatchObject([{ runner: mac.id, job: { id, trusted: 1 } }]);
	});

	it("requires every commit, including the parents of a signed merge, to be authenticated", async () => {
		const other = "d".repeat(40);
		repo.commits[other] = { ...commit(), signature: signature("contributor", 8) };
		repo.commits[head]!.parents = [base, other];
		expect(await trusted()).toBe(false);
	});

	it("does not let a retargeted PR hide an unsigned ancestor under its signed head", async () => {
		const hidden = "d".repeat(40);
		repo.commits[hidden] = { ...commit(), signature: null };
		repo.branches.feature = hidden;
		repo.pulls[0]!.base = "feature";
		repo.commits[head]!.parents = [hidden];
		expect(await trusted()).toBe(false);
		// A non-default PR base itself does not make an authenticated ancestry untrusted.
		repo.commits[hidden]!.signature = signature();
		expect(await trusted()).toBe(true);
	});

	it("trusts revisions already inherited by the repository default branch", async () => {
		repo.branches.main = head;
		repo.commits[head]!.signature = null;
		expect(await trusted()).toBe(true);
	});

	it("refuses unsigned commits and a contributor forging a maintainer's author email", async () => {
		// The PR author is a maintainer; only the signature signer proves who committed.
		repo.commits[head]!.signature = null;
		expect(await trusted()).toBe(false);
		repo.commits[head]!.signature = signature("contributor", 8);
		expect(await trusted()).toBe(false);
		repo.commits[head]!.signature = { ...signature(), isValid: false };
		expect(await trusted()).toBe(false);
	});

	it("reclassifies a queued head after a contributor pushes and routes it only to a Linux VM runner", async () => {
		const id = await queued();
		const next = "d".repeat(40);
		repo.commits[next] = { ...commit([head]), signature: signature("contributor", 8) };
		repo.branches.fix = next;
		const mac = await runner("mac", "darwin", true);
		const linux = await runner("linux", "linux");
		const vm = await runner("vm", "linux", true);
		expect((await dispatch([mac, linux, vm])).assign).toMatchObject([{ runner: vm.id, job: { id, trusted: 0 } }]);
	});

	it("rechecks current maintainer roles and leaves a revoked signer's head queued without a VM", async () => {
		const id = await queued();
		repo.maintainers = [];
		const mac = await runner("mac", "darwin");
		expect((await dispatch([mac])).assign).toEqual([]);
		expect(await store.readJob(db, id)).toMatchObject({ trusted: 0, state: "queued" });
	});

	it("pages all commits and checks a contributor beyond the first page", async () => {
		let parent = base;
		for (let i = 1; i <= 102; i++) {
			const oid = i.toString(16).padStart(40, "0");
			repo.commits[oid] = commit([parent]);
			parent = oid;
		}
		repo.branches.fix = parent;
		expect(await trusted(parent)).toBe(true);
		repo.commits["1".padStart(40, "0")]!.signature = signature("contributor", 8);
		expect(await trusted(parent)).toBe(false);
	});

	it.each(["default tip", "default name", "pull head", "comparison head", "comparison base", "commit count"])(
		"fails closed when %s changes during comparison paging",
		async (change) => {
			let parent = base;
			for (let i = 1; i <= 102; i++) {
				const oid = i.toString(16).padStart(40, "0");
				repo.commits[oid] = commit([parent]);
				parent = oid;
			}
			repo.branches.fix = parent;
			let pages = 0;
			vi.mocked(globalThis.fetch).mockImplementation(
				intercept(
					github,
					(url) => url.pathname === "/graphql" && ++pages === 2,
					async (next) => {
						const response = (await (await next()).json()) as any;
						const repository = response.data.repository;
						const branch = repository.defaultBranchRef;
						if (change === "default tip") branch.target.oid = head;
						if (change === "default name") branch.name = "release";
						if (change === "pull head") repository.pullRequest.headRefOid = head;
						if (change === "comparison head") branch.compare.headTarget.oid = head;
						if (change === "comparison base") branch.compare.baseTarget.oid = head;
						if (change === "commit count") branch.compare.commits.totalCount++;
						return Response.json(response);
					},
				),
			);
			expect(await trusted(parent)).toBe(false);
		},
	);

	it("fails closed when GitHub cannot finish paging", async () => {
		vi.mocked(globalThis.fetch).mockImplementation(
			intercept(
				github,
				(url) => url.pathname === "/graphql",
				async (next) => {
					const response = (await (await next()).json()) as any;
					response.data.repository.defaultBranchRef.compare.commits.pageInfo = {
						hasNextPage: true,
						endCursor: null,
					};
					return Response.json(response);
				},
			),
		);
		await expect(trusted()).rejects.toThrow("cursor");
	});

	it("rechecks an undelivered assignment and cancels a revoked trusted attempt", async () => {
		const id = await queued();
		const mac = await runner("mac", "darwin");
		expect((await dispatch([mac])).assign).toMatchObject([{ job: { id, trusted: 1 } }]);
		repo.maintainers = [];
		const pass = await dispatch([mac]);
		expect(pass.assign).toEqual([]);
		expect(pass.cancel).toEqual([{ runner: mac.id, job: id, attempt: 1 }]);
		expect(await store.readJob(db, id)).toMatchObject({ trusted: 0, state: "queued" });
	});

	it("rechecks a head a lost publication settles between the claim and the assignment", async () => {
		const id = await queued();
		const first = await runner("first", "darwin");
		await dispatch([first]);
		await store.report(
			db,
			first,
			[{ id: "account", provider: "anthropic", kind: "subscription", label: "First", limited: false }],
			[{ job: id, attempt: 1 }],
			1,
		);
		const published = "d".repeat(40);
		repo.commits[published] = { ...commit([head]), signature: { isValid: true, signer: null } };
		await store.claim(db, first, id, 1, head, published, 2);
		await store.dispatch(db, "owner", new Map(), 3, verify(testEnv));
		// The lost push lands and settles only after the next pass claims the signed head.
		const racing = new Proxy(db, {
			get(target, key) {
				if (key !== "prepare") return Reflect.get(target, key).bind(target);
				return (sql: string) => {
					const statement = target.prepare(sql);
					if (!sql.startsWith("SELECT j.id,j.runner")) return statement;
					return {
						bind: (...values: unknown[]) => ({
							all: async () => {
								repo.branches.fix = published;
								await store.settle(db, id, published, true, 5);
								return statement.bind(...values).all();
							},
						}),
					};
				};
			},
		});
		const mac = await runner("mac", "darwin");
		const pass = await store.dispatch(racing, "owner", new Map([[mac.id, 1]]), store.GRACE + 4, verify(testEnv));
		expect(pass.assign).toEqual([]);
		expect(pass.cancel).toEqual([{ runner: mac.id, job: id, attempt: 2 }]);
		// The delivery recheck's head-guarded read leaves nothing stale to reread.
		expect(await store.readJob(db, id)).toMatchObject({ head: published, trusted: 0, recheck: 0, state: "queued" });
	});

	it("leaves a head kix published to VM-only, even after a lost response", async () => {
		const id = await queued();
		const first = await runner("first", "darwin");
		await dispatch([first]);
		await store.report(
			db,
			first,
			[{ id: "account", provider: "anthropic", kind: "subscription", label: "First", limited: false }],
			[{ job: id, attempt: 1 }],
			1,
		);
		// kix's commits are signed for the App, never a maintainer.
		const published = "d".repeat(40);
		repo.commits[published] = { ...commit([head]), signature: { isValid: true, signer: null } };
		await store.claim(db, first, id, 1, head, published, 2);
		repo.branches.fix = published;
		expect(await trusted(published)).toBe(false);
		// The push lands but its response is lost, and the runner's lease expires.
		await store.dispatch(db, "owner", new Map(), 3, verify(testEnv));
		const mac = await runner("mac", "darwin");
		const vm = await runner("vm", "linux", true);
		const slots = new Map([mac, vm].map((r) => [r.id, 1]));
		const pass = await store.dispatch(db, "owner", slots, store.GRACE + 4, verify(testEnv));
		expect(pass.assign).toMatchObject([{ runner: vm.id, job: { id, trusted: 0, attempt: 2 } }]);
	});
});

describe("trust recheck on queue", () => {
	// kix's commits are signed for the App, never a maintainer.
	const published = "d".repeat(40);
	let reads: number;
	const counted: store.Verify = (job) => {
		reads++;
		return verify(testEnv)(job);
	};
	// No runner has a free slot.
	const busy = (now: number) => store.dispatch(db, "owner", new Map(), now, counted);

	// A trusted job runs on a runner, whose attempt kix publishes an unsigned commit for.
	async function publishedJob() {
		const id = await queued();
		const mac = await runner("mac", "darwin");
		expect((await dispatch([mac])).assign).toMatchObject([{ job: { id, trusted: 1 } }]);
		await store.report(
			db,
			mac,
			[{ id: "account", provider: "anthropic", kind: "subscription", label: "mac", limited: false }],
			[{ job: id, attempt: 1 }],
			1,
		);
		repo.commits[published] = { ...commit([head]), signature: { isValid: true, signer: null } };
		await store.claim(db, mac, id, 1, head, published, 2);
		repo.branches.fix = published;
		await store.settle(db, id, published, true, 2);
		reads = 0;
		return { id, mac };
	}

	it("shows a resumed job's unsigned head for approval without a free runner slot", async () => {
		const { id, mac } = await publishedJob();
		const { question } = await store.ask(db, mac, id, 1, { summary: "?", session: "s", prompt: {} }, 3);
		expect(await store.answer(db, id, question, "owner", "A", 4)).toEqual({ resumed: true });
		expect(await store.readJob(db, id)).toMatchObject({ state: "queued", trusted: 1, recheck: 1 });
		await busy(5);
		expect(await store.readJob(db, id)).toMatchObject({ state: "queued", head: published, trusted: 0, recheck: 0 });
		// Another pass without a free slot rereads nothing until the job queues again.
		await busy(6);
		expect(reads).toBe(1);
	});

	it("shows an expired lease's unsigned head for approval without a free runner slot", async () => {
		const { id } = await publishedJob();
		// The runner disconnects, and its lease expires with no other runner free.
		await busy(3);
		expect(await store.readJob(db, id)).toMatchObject({ state: "running", trusted: 1 });
		await busy(store.GRACE + 3);
		expect(await store.readJob(db, id)).toMatchObject({ state: "queued", head: published, trusted: 0, recheck: 0 });
		expect(reads).toBe(1);
	});

	it("rereads a paused project's stale trust, which the inbox still shows", async () => {
		const { id } = await publishedJob();
		await busy(3);
		await busy(store.GRACE + 3);
		expect(await store.readJob(db, id)).toMatchObject({ state: "queued", trusted: 0 });
		await db.prepare("UPDATE github_projects SET state='paused' WHERE id=10").run();
		await service().approveHead(repository, "owner", 2, published);
		await store.recheck(db, id);
		await busy(store.GRACE + 4);
		expect(await store.readJob(db, id)).toMatchObject({ state: "queued", trusted: 1, recheck: 0 });
	});

	it("rechecks a head that settles while the job is queued", async () => {
		const { id, mac } = await publishedJob();
		const next = "e".repeat(40);
		repo.commits[next] = { ...commit([published]), signature: { isValid: true, signer: null } };
		await store.claim(db, mac, id, 1, published, next, 3);
		await busy(4);
		await busy(store.GRACE + 4);
		expect(await store.readJob(db, id)).toMatchObject({ state: "queued", head: published, recheck: 0 });
		// The lost publication lands after the job queued, and a maintainer approves it.
		repo.branches.fix = next;
		await service().approveHead(repository, "owner", 2, next);
		await store.settle(db, id, next, true, store.GRACE + 5);
		expect(await store.readJob(db, id)).toMatchObject({ state: "queued", head: next, trusted: 0, recheck: 1 });
		await busy(store.GRACE + 6);
		expect(await store.readJob(db, id)).toMatchObject({ head: next, trusted: 1, recheck: 0 });
	});

	it("never rereads a job that opens its pull request rather than working on one", async () => {
		reads = 0;
		const { id } = await store.createJob(
			db,
			{
				repository: repo.id,
				actor: "owner",
				workflow: "start",
				target: "quest/first.md",
				revision: base,
				branch: "quest/first",
				trusted: true,
			},
			0,
		);
		expect(await store.readJob(db, id)).toMatchObject({ state: "queued", recheck: 1 });
		expect(await store.stale(db, "owner", id)).toBe(false);
		await busy(1);
		expect(reads).toBe(0);
	});
});

describe("head approval", () => {
	// kix's own commits are signed for the App, never a maintainer.
	const pushed = "d".repeat(40);
	const approve = (user = "owner", sha = pushed) => service().approveHead(repository, user, 2, sha);

	beforeEach(async () => {
		repo.commits[pushed] = { ...commit([head]), signature: { isValid: true, signer: null } };
		repo.branches.fix = pushed;
		await db.batch([
			db.prepare(
				"INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('outsider','Contributor','contributor@example.test',1,0,0)",
			),
			db.prepare(
				"INSERT INTO account(id,accountId,providerId,userId,createdAt,updatedAt) VALUES('outsider-github','8','github','outsider',0,0)",
			),
		]);
	});

	it("runs a kix-pushed head a maintainer approved on an ordinary runner", async () => {
		const id = await queued(pushed);
		const mac = await runner("mac", "darwin");
		expect((await dispatch([mac])).assign).toEqual([]);
		await approve();
		expect(
			await db
				.prepare("SELECT pull,head,approver,approvedAt FROM head_approvals WHERE repository=?")
				.bind(10)
				.first(),
		).toMatchObject({ pull: 2, head: pushed, approver: "owner", approvedAt: expect.any(Number) });
		expect((await dispatch([mac])).assign).toMatchObject([{ runner: mac.id, job: { id, trusted: 1 } }]);
	});

	it("lapses when the head moves after the approval", async () => {
		await approve();
		expect(await trusted(pushed)).toBe(true);
		const next = "e".repeat(40);
		repo.commits[next] = { ...commit([pushed]), signature: { isValid: true, signer: null } };
		repo.branches.fix = next;
		expect(await trusted(next)).toBe(false);
		expect(await trusted(pushed)).toBe(false);
		// The approval names the head the maintainer saw, never a later one.
		await expect(approve()).rejects.toThrow("moved since you looked");
		repo.branches.fix = pushed;
		expect(await trusted(pushed)).toBe(true);
	});

	it("counts only while the approver keeps a maintain or admin role", async () => {
		await approve();
		repo.maintainers = [];
		expect(await trusted(pushed)).toBe(false);
		repo.maintainers = ["maintainer"];
		expect(await trusted(pushed)).toBe(true);
	});

	it("refuses an approval from someone who is not a maintainer, and never counts one", async () => {
		await expect(approve("outsider")).rejects.toThrow("maintainer authority required");
		expect(await db.prepare("SELECT 1 FROM head_approvals").first()).toBeNull();
		await db
			.prepare("INSERT INTO head_approvals(repository,pull,head,approver,approvedAt) VALUES(10,2,?,'outsider',0)")
			.bind(pushed)
			.run();
		expect(await trusted(pushed)).toBe(false);
	});

	it("covers only its own pull request", async () => {
		repo.pulls.push({
			number: 3,
			title: "Other",
			author: "maintainer",
			branch: "other",
			checks: null,
			review: null,
		});
		repo.branches.other = pushed;
		await approve();
		expect(await service().jobTrust(repository, "pulls/3", pushed)).toBe(false);
	});
});
