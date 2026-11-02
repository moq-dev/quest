import { createScheduledController, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { app } from "../src/index";
import * as landing from "../src/jobs/landing";
import * as output from "../src/jobs/output";
import { wake } from "../src/jobs/wake";
import * as store from "../src/jobs/store";
import { GRACE } from "../src/jobs/store";
import { parse } from "../src/jobs/protocol";
import { refName } from "../src/github/service";
import { formAnswer, parseAnswer, parsePrompt } from "../src/jobs/prompt";
import { resume } from "../src/jobs/routes";
import { privateKey } from "./github-key";
import { identity, oauth, origin } from "./login-fixtures";
import { commit, delivery, head, maintainerOf, project } from "./project-fixtures";

const testEnv = { ...env, GITHUB_APP_PRIVATE_KEY: privateKey };
const db = env.DB;
async function user(id: string) {
	await db
		.prepare("INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)")
		.bind(id, id, `${id}@example.test`)
		.run();
}
async function runner(owner: string, name: string, platform: store.Platform = "linux", vm = false) {
	const { id, token } = await store.createRunner(db, owner, name, platform, vm, 0);
	return { id, token, owner, name, platform, vm: vm ? 1 : 0 } as store.Runner & { token: string };
}
function account(id: string, limited = false): store.AccountReport {
	return { id, provider: "anthropic", kind: "subscription", label: id, limited };
}
async function connected(r: store.Runner, accounts: store.AccountReport[]) {
	await store.report(db, r, accounts, [], 0);
}
async function job(repository: number, actor: string, extra: Partial<store.NewJob> = {}, now = 0) {
	return (
		await store.createJob(
			db,
			{
				repository,
				actor,
				workflow: "start",
				target: "quest/first.md",
				revision: commit,
				branch: "quest/first",
				trusted: true,
				...extra,
			},
			now,
		)
	).id;
}
async function state(id: string) {
	return (await store.readJob(db, id))!;
}
/** One dispatch pass over connected runners and their free slots, whose runners acknowledge what they receive. */
async function run(slots: Record<string, number>, now: number, owner = "owner", deliver = true) {
	const pass = await store.dispatch(db, owner, new Map(Object.entries(slots)), now, async (job) => !!job.trusted);
	if (deliver)
		for (const { job } of pass.assign)
			await db.prepare("UPDATE jobs SET delivered=1 WHERE id=?").bind(job.id).run();
	return pass;
}

beforeEach(async () => {
	await user("owner");
	await user("other");
	await project(10, "owner");
});
afterEach(() => vi.restoreAllMocks());

const sockets: WebSocket[] = [];
afterEach(() => {
	for (const ws of sockets.splice(0)) ws.close();
});

function request(token: string | null, upgrade = true) {
	return app.request(
		`${origin}/api/runner/connect`,
		{
			headers: {
				...(token ? { Authorization: `Bearer ${token}` } : {}),
				...(upgrade ? { Upgrade: "websocket" } : {}),
			},
		},
		testEnv,
	);
}
async function connect(token: string) {
	const response = await request(token);
	expect(response.status).toBe(101);
	const ws = response.webSocket!;
	ws.accept();
	sockets.push(ws);
	const inbox: unknown[] = [];
	const waiting: ((message: unknown) => void)[] = [];
	ws.addEventListener("message", (event) => {
		const message = JSON.parse(event.data as string);
		const next = waiting.shift();
		if (next) next(message);
		else inbox.push(message);
	});
	const closed = new Promise<number>((resolve) => ws.addEventListener("close", (event) => resolve(event.code)));
	return {
		ws,
		closed,
		send: (message: unknown) => ws.send(JSON.stringify(message)),
		next: (): Promise<any> =>
			inbox.length ? Promise.resolve(inbox.shift()) : new Promise((resolve) => waiting.push(resolve)),
	};
}
const status = (id: number, name: string, attempts: store.Attempt[] = [], slots = 1) => ({
	id,
	type: "status",
	accounts: [account(name)],
	attempts,
	slots,
});

describe("job coordination", () => {
	it("assigns a job exactly once across racing dispatch passes and records the placement", async () => {
		const runners = await Promise.all(["a", "b", "c"].map((name) => runner("owner", name)));
		for (const r of runners) await connected(r, [account(`${r.name}-account`)]);
		const id = await job(10, "owner");
		const slots = Object.fromEntries(runners.map((r) => [r.id, 1]));
		const passes = await Promise.all([run(slots, 1), run(slots, 1), run(slots, 1)]);
		// A pass may resend another's unacknowledged claim, but only one pass claims it.
		const assigned = passes.flatMap((pass) => pass.assign);
		expect(new Set(assigned.map((a) => `${a.runner}/${a.job.attempt}`)).size).toBe(1);
		expect(assigned[0]!.job).toMatchObject({
			id,
			attempt: 1,
			owner: "upstream",
			name: "project",
			state: "running",
		});
		expect((await state(id)).events).toEqual([
			{
				attempt: 1,
				kind: "claimed",
				body: { runner: assigned[0]!.runner, account: assigned[0]!.job.account },
				at: 1,
			},
		]);
	});

	it("resends an assignment until its runner acknowledges it, and cancels one never delivered", async () => {
		const machine = await runner("owner", "machine");
		await connected(machine, [account("main")]);
		const id = await job(10, "owner");
		const next = await job(10, "owner", { target: "issues/1", workflow: "plan" }, 1);
		expect((await run({ [machine.id]: 1 }, 1, "owner", false)).assign).toMatchObject([{ job: { id } }]);
		// The delivery was lost, so the runner still reports its slot free. The
		// assignment holds that slot and is sent again rather than claimed anew.
		expect((await run({ [machine.id]: 1 }, 2, "owner", false)).assign).toMatchObject([{ job: { id, attempt: 1 } }]);
		await store.report(db, machine, [account("main")], [{ job: id, attempt: 1 }], 3);
		expect((await run({ [machine.id]: 0 }, 4, "owner", false)).assign).toEqual([]);
		await store.finish(db, machine, id, 1, { outcome: "completed", summary: "Done", result: undefined }, 5);
		await store.cancel(db, next, "owner", 5);

		const lost = await job(10, "owner", {}, 6);
		await run({ [machine.id]: 1 }, 7, "owner", false);
		await store.cancel(db, lost, "owner", 8);
		expect(await state(lost)).toMatchObject({ state: "cancelled" });
	});

	it("reaches a routable job behind many older jobs that cannot route", async () => {
		const offline = await runner("owner", "offline");
		const online = await runner("owner", "online");
		await connected(offline, [account("away")]);
		await connected(online, [account("here")]);
		for (let i = 0; i < 51; i++)
			await job(10, "owner", { target: `issues/${i}`, pinRunner: offline.id, pinAccount: "away" }, i);
		const id = await job(10, "owner", {}, 100);
		expect((await run({ [online.id]: 1 }, 101)).assign).toMatchObject([{ runner: online.id, job: { id } }]);
	});

	it("routes by the owner's account preference across connected runners with free slots", async () => {
		const first = await runner("owner", "first");
		const second = await runner("owner", "second");
		await connected(first, [account("one")]);
		await connected(second, [account("two")]);
		await db.prepare("UPDATE runner_accounts SET rank=0 WHERE id='two'").run();
		const id = await job(10, "owner");
		expect((await run({ [first.id]: 1, [second.id]: 1 }, 1)).assign).toMatchObject([
			{ runner: second.id, job: { id, account: "two" } },
		]);
		// A busy preferred runner leaves the next account to take new work.
		const other = await job(10, "owner", { workflow: "plan", target: "issues/1" }, 2);
		expect((await run({ [first.id]: 1, [second.id]: 0 }, 3)).assign).toMatchObject([
			{ runner: first.id, job: { id: other, account: "one" } },
		]);
		await job(10, "owner", { workflow: "plan", target: "issues/2" }, 4);
		expect((await run({}, 5)).assign).toEqual([]);
	});

	it("keeps untrusted heads, pins, other owners, and paused projects away from unsuitable runners", async () => {
		const mac = await runner("owner", "mac", "darwin");
		const linux = await runner("owner", "linux");
		const vm = await runner("owner", "vm", "linux", true);
		const stranger = await runner("other", "stranger");
		for (const r of [mac, linux, vm, stranger]) await connected(r, [account("main")]);
		const untrusted = await job(10, "owner", { workflow: "iterate", target: "pulls/2", trusted: false });
		expect((await run({ [stranger.id]: 1, [mac.id]: 1, [linux.id]: 1 }, 1)).assign).toEqual([]);
		expect((await run({ [stranger.id]: 1 }, 1, "other")).assign).toEqual([]);
		expect((await run({ [mac.id]: 1, [linux.id]: 1, [vm.id]: 1 }, 1)).assign).toMatchObject([
			{ runner: vm.id, job: { id: untrusted } },
		]);

		await db.prepare("UPDATE runner_accounts SET rank=99 WHERE runner=?").bind(mac.id).run();
		const pinned = await job(10, "owner", { pinRunner: mac.id, pinAccount: "main" }, 2);
		expect((await run({ [linux.id]: 1, [mac.id]: 1 }, 3)).assign).toMatchObject([
			{ runner: mac.id, job: { id: pinned } },
		]);
		await expect(job(10, "owner", { target: "x", pinRunner: stranger.id })).rejects.toThrow("Pinned runner");
		await expect(job(10, "owner", { target: "x", pinRunner: mac.id, pinAccount: "missing" })).rejects.toThrow(
			"Pinned runner or account",
		);
		// An untrusted head can only pin a runner that builds it in a VM.
		await expect(
			job(10, "owner", { workflow: "iterate", target: "pulls/9", trusted: false, pinRunner: linux.id }),
		).rejects.toThrow("Pinned runner or account");
		await expect(job(10, "owner", { target: "x", pinAccount: "main" })).rejects.toThrow("together");

		// A pause wins over a job queued before it and a request that read the project before it.
		await job(10, "owner", { target: "issues/3", workflow: "plan" }, 4);
		await project(10, "owner", "paused");
		expect((await run({ [linux.id]: 1 }, 5)).assign).toEqual([]);
		await expect(job(10, "owner", { target: "issues/4", workflow: "plan" }, 6)).rejects.toThrow("paused");
	});

	it("returns the active job for duplicate requests and allows new work after it ends", async () => {
		const id = await job(10, "owner");
		expect(
			await store.createJob(
				db,
				{
					repository: 10,
					actor: "other",
					workflow: "start",
					target: "quest/first.md",
					revision: commit,
					branch: "quest/first",
					trusted: true,
				},
				1,
			),
		).toEqual({ id, created: false });
		await store.cancel(db, id, "owner", 2);
		expect(await job(10, "owner")).not.toBe(id);
	});

	it("reassigns a disconnected runner's job after the grace period and fences it out", async () => {
		const old = await runner("owner", "old");
		const replacement = await runner("owner", "replacement");
		await connected(old, [account("old")]);
		await connected(replacement, [account("new")]);
		const id = await job(10, "owner");
		await run({ [old.id]: 1 }, 0);
		await store.checkpoint(db, old, id, 1, "Wrote the parser", "session-1", 10);
		expect((await run({ [old.id]: 0, [replacement.id]: 1 }, 20)).assign).toEqual([]);
		// Disconnecting starts the grace period instead of moving the job at once.
		expect(await run({ [replacement.id]: 1 }, 30)).toMatchObject({ assign: [], wake: 30 + GRACE });
		expect((await run({ [replacement.id]: 1 }, 30 + GRACE - 1)).assign).toEqual([]);
		expect((await run({ [replacement.id]: 1 }, 30 + GRACE)).assign).toMatchObject([
			{
				runner: replacement.id,
				job: {
					id,
					attempt: 2,
					// A different runner continues from the summaries, not the old session.
					session: null,
					events: [
						{ kind: "claimed", attempt: 1 },
						{ kind: "summary", attempt: 1, body: "Wrote the parser" },
						{ kind: "claimed", attempt: 2 },
					],
				},
			},
		]);
		const late = 31 + GRACE;
		await expect(store.checkpoint(db, old, id, 1, "Still here", null, late)).rejects.toThrow("no longer current");
		await expect(output.append(env, old, { job: id, attempt: 1, seq: 0, text: "late" }, late)).rejects.toThrow(
			"no longer current",
		);
		await expect(
			store.finish(db, old, id, 1, { outcome: "completed", summary: "Done", result: { pr: 1 } }, late),
		).rejects.toThrow("no longer current");
		await expect(store.ask(db, old, id, 1, { summary: "?", session: "s", prompt: {} }, late)).rejects.toThrow(
			"no longer current",
		);
		expect((await store.report(db, old, [account("old")], [{ job: id, attempt: 1 }], late)).attempts).toEqual([
			{ job: id, attempt: 1, action: "stop" },
		]);
		const done = { outcome: "completed", summary: "Done", result: { pr: 1 } } as const;
		await store.finish(db, replacement, id, 2, done, late + 1);
		// A retried report is accepted once; the job keeps the replacement's result.
		await store.finish(db, replacement, id, 2, done, late + 2);
		expect(await state(id)).toMatchObject({ state: "completed", summary: "Done", result: { pr: 1 }, attempt: 2 });
		expect((await state(id)).events.filter((e) => e.kind === "result")).toHaveLength(1);
		// A retry carrying a different payload is not the same report.
		await expect(store.finish(db, replacement, id, 2, { ...done, result: { pr: 2 } }, late + 3)).rejects.toThrow(
			"no longer current",
		);
	});

	it("keeps a job on a runner that reconnects in time and moves one a restarted runner lost", async () => {
		const machine = await runner("owner", "machine");
		await connected(machine, [account("main")]);
		const id = await job(10, "owner");
		await run({ [machine.id]: 1 }, 0);
		await run({}, 1);
		expect((await state(id)).lease).toBe(1 + GRACE);
		const listed = [{ job: id, attempt: 1 }];
		expect((await store.report(db, machine, [account("main")], listed, 2)).attempts).toEqual([
			{ job: id, attempt: 1, action: "continue" },
		]);
		await run({ [machine.id]: 0 }, 3);
		expect(await state(id)).toMatchObject({ state: "running", lease: null });
		// A status that omits an acknowledged attempt means the runner lost it.
		await store.report(db, machine, [account("main")], [], 4);
		expect((await state(id)).state).toBe("queued");
		// An unacknowledged assignment may still be on its way, so it stays.
		await run({ [machine.id]: 1 }, 5, "owner", false);
		await store.report(db, machine, [account("main")], [], 6);
		expect(await state(id)).toMatchObject({ state: "running", attempt: 2 });
	});

	it("pauses on a question, accepts one answer, and resumes the same session where it lives", async () => {
		const home = await runner("owner", "home");
		const away = await runner("owner", "away");
		await connected(home, [account("main")]);
		await connected(away, [account("spare")]);
		const id = await job(10, "owner");
		await run({ [home.id]: 1 }, 0);
		const input = { summary: "Need a decision", session: "session-1", prompt: { question: "A or B?" } };
		const { question } = await store.ask(db, home, id, 1, input, 1);
		expect(await store.ask(db, home, id, 1, input, 2)).toEqual({ question, cancel: false, asked: false });
		await expect(store.ask(db, home, id, 1, { ...input, prompt: { question: "C?" } }, 2)).rejects.toThrow(
			"no longer current",
		);
		expect(await state(id)).toMatchObject({ state: "waiting", lease: null, session: "session-1" });
		await expect(store.answer(db, id, "missing", "owner", "A", 3)).rejects.toThrow("no longer open");
		await Promise.allSettled([
			store.answer(db, id, question, "owner", "A", 3),
			store.answer(db, id, question, "other", "B", 3),
		]);
		const answered = await state(id);
		expect(answered.state).toBe("queued");
		expect(answered.questions).toHaveLength(1);
		expect(["A", "B"]).toContain(answered.questions[0]!.answer);
		await expect(store.answer(db, id, question, "owner", "C", 4)).rejects.toThrow("no longer open");
		// The other runner waits while the session's runner is connected but busy.
		expect((await run({ [home.id]: 0, [away.id]: 1 }, 5)).assign).toEqual([]);
		expect((await run({ [home.id]: 1, [away.id]: 1 }, 6)).assign).toMatchObject([
			{ runner: home.id, job: { id, attempt: 2, session: "session-1" } },
		]);
	});

	it("resumes with another maintainer's answer only once the requester approves it", async () => {
		const home = await runner("owner", "home");
		await connected(home, [account("main")]);
		const id = await job(10, "owner");
		await run({ [home.id]: 1 }, 0);
		const input = { summary: "Need a decision", session: "session-1", prompt: { question: "A or B?" } };
		const { question } = await store.ask(db, home, id, 1, input, 1);
		expect(await store.answer(db, id, question, "other", "B", 2)).toEqual({ resumed: false });
		expect(await state(id)).toMatchObject({ state: "waiting" });
		expect((await state(id)).questions[0]).toMatchObject({ answer: "B", answeredBy: "other", approvedAt: null });
		expect((await run({ [home.id]: 1 }, 3)).assign).toEqual([]);
		// Another maintainer can neither answer it again nor approve it.
		await expect(store.answer(db, id, question, "other", "C", 4)).rejects.toThrow("no longer open");
		await expect(store.approve(db, id, question, "other", 4)).rejects.toThrow("Only the job's requester");
		await store.approve(db, id, question, "owner", 5);
		expect(await state(id)).toMatchObject({ state: "queued" });
		expect((await state(id)).questions[0]).toMatchObject({ answer: "B", answeredBy: "other", approvedAt: 5 });
		await expect(store.approve(db, id, question, "owner", 6)).rejects.toThrow("No answer awaits approval");
		expect((await run({ [home.id]: 1 }, 7)).assign).toMatchObject([
			{ job: { id, attempt: 2, questions: [{ answer: "B", approvedAt: 5 }] } },
		]);
	});

	it("lets the requester answer instead of approving, and approves account choices too", async () => {
		const machine = await runner("owner", "machine");
		await connected(machine, [account("first"), account("second")]);
		const id = await job(10, "owner");
		await run({ [machine.id]: 1 }, 0);
		const { question } = await store.ask(db, machine, id, 1, { summary: "?", session: "s", prompt: {} }, 1);
		await store.answer(db, id, question, "other", "B", 2);
		expect(await store.answer(db, id, question, "owner", "A", 3)).toEqual({ resumed: true });
		expect(await state(id)).toMatchObject({ state: "queued" });
		expect((await state(id)).questions[0]).toMatchObject({ answer: "A", answeredBy: "owner", approvedAt: 3 });

		await run({ [machine.id]: 1 }, 4);
		await store.finish(db, machine, id, 2, { outcome: "limited", summary: "Limit", result: undefined }, 5);
		const choice = (await state(id)).questions.find((q) => q.kind === "account")!.id;
		await store.answer(db, id, choice, "other", { runner: machine.id, account: "second" }, 6);
		expect(await state(id)).toMatchObject({ state: "waiting", pinAccount: null });
		await store.approve(db, id, choice, "owner", 7);
		expect(await state(id)).toMatchObject({ state: "queued", pinRunner: machine.id, pinAccount: "second" });
	});

	it("pauses an account-limited job with a decision instead of switching accounts", async () => {
		const machine = await runner("owner", "machine");
		await connected(machine, [account("first"), account("second")]);
		const id = await job(10, "owner");
		expect((await run({ [machine.id]: 2 }, 0)).assign).toMatchObject([{ job: { account: "first" } }]);
		await store.finish(db, machine, id, 1, { outcome: "limited", summary: "Hit the limit", result: undefined }, 1);
		const paused = await state(id);
		expect(paused).toMatchObject({ state: "waiting", summary: "Hit the limit" });
		expect(paused.questions).toMatchObject([{ kind: "account", prompt: { runner: machine.id, account: "first" } }]);
		expect((await run({ [machine.id]: 2 }, 2)).assign).toEqual([]);
		// Other work avoids the limited account while it is flagged.
		const other = await job(10, "owner", { workflow: "plan", target: "issues/9" }, 3);
		expect((await run({ [machine.id]: 2 }, 4)).assign).toMatchObject([{ job: { id: other, account: "second" } }]);
		const choice = paused.questions[0]!.id;
		await expect(store.answer(db, id, choice, "owner", { runner: machine.id, account: "nope" }, 5)).rejects.toThrow(
			"owner's accounts",
		);
		await store.answer(db, id, choice, "owner", { runner: machine.id, account: "first" }, 5);
		expect(await state(id)).toMatchObject({
			state: "queued",
			pinRunner: machine.id,
			pinAccount: "first",
			session: null,
		});
		expect((await run({ [machine.id]: 1 }, 6)).assign).toMatchObject([
			{ job: { id, account: "first", attempt: 2 } },
		]);
	});

	it("cancels queued work immediately and asks running work to stop with its partial result", async () => {
		const machine = await runner("owner", "machine");
		await connected(machine, [account("main")]);
		const queued = await job(10, "owner");
		await store.cancel(db, queued, "owner", 1);
		expect(await state(queued)).toMatchObject({ state: "cancelled" });
		await expect(store.cancel(db, queued, "owner", 2)).rejects.toThrow("already finished");

		const running = await job(10, "owner", {}, 3);
		await run({ [machine.id]: 1 }, 3);
		await store.cancel(db, running, "owner", 4);
		expect((await run({ [machine.id]: 0 }, 5)).cancel).toEqual([{ job: running, attempt: 1, runner: machine.id }]);
		expect(
			(await store.report(db, machine, [account("main")], [{ job: running, attempt: 1 }], 5)).attempts,
		).toEqual([{ job: running, attempt: 1, action: "cancel" }]);
		expect(await store.checkpoint(db, machine, running, 1, "Stopping", null, 6)).toEqual({ cancel: true });
		const stopped = { outcome: "cancelled", summary: "Stopped after the parser", result: undefined } as const;
		await store.finish(db, machine, running, 1, stopped, 7);
		expect(await state(running)).toMatchObject({ state: "cancelled", summary: "Stopped after the parser" });

		// Cancellation wins over a question or a result that races it.
		const asking = await job(10, "owner", {}, 11);
		await run({ [machine.id]: 1 }, 11);
		await store.cancel(db, asking, "owner", 12);
		// The reply tells the runner to stop, since no pass pushes cancellation for a stopped job.
		const asked = await store.ask(db, machine, asking, 1, { summary: "Which?", session: "s", prompt: {} }, 13);
		expect(asked).toMatchObject({ cancel: true });
		expect(await state(asking)).toMatchObject({ state: "cancelled" });
		const finishing = await job(10, "owner", {}, 14);
		await run({ [machine.id]: 1 }, 14);
		await store.cancel(db, finishing, "owner", 15);
		await store.finish(db, machine, finishing, 1, { outcome: "completed", summary: "Done", result: { pr: 3 } }, 16);
		expect(await state(finishing)).toMatchObject({ state: "cancelled", summary: "Done", result: { pr: 3 } });
		const limited = await job(10, "owner", {}, 17);
		await run({ [machine.id]: 1 }, 17);
		await store.cancel(db, limited, "owner", 18);
		await store.finish(db, machine, limited, 1, { outcome: "limited", summary: "Limit", result: undefined }, 19);
		expect(await state(limited)).toMatchObject({ state: "cancelled", questions: [] });

		// A cancelled attempt whose runner vanished stops instead of moving.
		const abandoned = await job(10, "owner", {}, 8);
		await run({ [machine.id]: 1 }, 8);
		await store.cancel(db, abandoned, "owner", 9);
		await run({}, 10);
		expect((await run({}, 10 + GRACE)).assign).toEqual([]);
		expect(await state(abandoned)).toMatchObject({ state: "cancelled" });
	});

	it("keeps account preference order and removes accounts a runner stops reporting", async () => {
		const first = await runner("owner", "first");
		const second = await runner("owner", "second");
		await connected(first, [account("a"), account("b")]);
		await connected(second, [account("c")]);
		await store.report(db, first, [account("b", true)], [], 1);
		const listed = await store.listRunners(db, "owner", new Set([first.id]));
		const [one, two] = ["first", "second"].map((name) => listed.find((r) => r.name === name));
		expect(one).toMatchObject({ name: "first", online: true, accounts: [{ id: "b", rank: 2, limited: 1 }] });
		expect(two).toMatchObject({ name: "second", online: false, accounts: [{ id: "c", rank: 3 }] });
	});

	it("deletes jobs with their project on disconnect", async () => {
		const id = await job(10, "owner");
		await db.prepare("DELETE FROM github_projects WHERE id=10").run();
		expect(await store.readJob(db, id)).toBeNull();
	});
});

describe("runner connections", () => {
	const hub = () => env.RUNNERS.get(env.RUNNERS.idFromName("owner"));
	it("requires a registered runner token and a WebSocket", async () => {
		const machine = await runner("owner", "machine");
		expect((await request(null)).status).toBe(401);
		expect((await request("x".repeat(43))).status).toBe(401);
		expect((await request(machine.token, false)).status).toBe(426);
	});

	it("notifies the project's maintainer when a job asks a question or fails, once each", async () => {
		// The project's maintainer is a member of it, with a device.
		const maintainer = await maintainerOf();
		const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
			"deriveBits",
		])) as CryptoKeyPair;
		const p256dh = Buffer.from((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer).toString(
			"base64url",
		);
		await db
			.prepare(
				"INSERT INTO push_subscriptions(endpoint,user,session,p256dh,auth,createdAt) VALUES('https://fcm.googleapis.com/fcm/send/owner',?,'s',?,'AAAAAAAAAAAAAAAAAAAAAA',0)",
			)
			.bind(maintainer.user, p256dh)
			.run();
		const sent: string[] = [];
		// Push services answer here; GitHub answers the recipient's authority check.
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			if (!String(input).startsWith("https://fcm.googleapis.com/")) return maintainer.mock(input);
			sent.push(String(input));
			return new Response(null, { status: 201 });
		});
		const machine = await runner("owner", "machine");
		const live = await connect(machine.token);
		live.send(status(1, "main", [], 2));
		await live.next();
		const asking = await job(10, "owner", {}, Date.now());
		const failing = await job(10, "owner", { target: "quest/second.md", branch: "quest/second" }, Date.now());
		await hub().dispatch("owner");
		await live.next();
		await live.next();
		const attempts = [asking, failing].map((id) => ({ job: id, attempt: 1 }));
		live.send(status(9, "main", attempts, 0));
		expect(await live.next()).toMatchObject({ type: "reply", id: 9 });
		const prompt = { questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }] };
		const question = { id: 2, type: "question", job: asking, attempt: 1, summary: "Asked", session: "s", prompt };
		live.send(question);
		expect(await live.next()).toMatchObject({ type: "reply", id: 2, cancel: false });
		// A retried question is the same decision, so it does not notify again.
		live.send(question);
		expect(await live.next()).toMatchObject({ type: "reply", id: 2, cancel: false });
		live.send({ id: 3, type: "result", job: failing, attempt: 1, outcome: "failed", summary: "Broke" });
		expect(await live.next()).toEqual({ type: "reply", id: 3 });
		await vi.waitFor(() => expect(sent).toHaveLength(2));
		expect(sent).toEqual([
			"https://fcm.googleapis.com/fcm/send/owner",
			"https://fcm.googleapis.com/fcm/send/owner",
		]);
	});

	it("pushes assignments and cancellation and fences progress over the live connection", async () => {
		const machine = await runner("owner", "machine");
		const live = await connect(machine.token);
		live.send(status(1, "main"));
		expect(await live.next()).toEqual({ type: "reply", id: 1, attempts: [] });
		expect(await hub().online()).toEqual([machine.id]);
		const id = await job(10, "owner", {}, Date.now());
		await hub().dispatch("owner");
		expect(await live.next()).toMatchObject({
			type: "assign",
			job: { id, attempt: 1, revision: commit, branch: "quest/first", owner: "upstream", account: "main" },
		});
		// Listing the attempt acknowledges the assignment, so the hub stops resending it.
		live.send(status(20, "main", [{ job: id, attempt: 1 }], 0));
		expect(await live.next()).toEqual({
			type: "reply",
			id: 20,
			attempts: [{ job: id, attempt: 1, action: "continue" }],
		});
		live.send({ id: 2, type: "checkpoint", job: id, attempt: 1, summary: "Halfway" });
		expect(await live.next()).toEqual({ type: "reply", id: 2, cancel: false });
		// A retried checkpoint is recorded once.
		live.send({ id: 2, type: "checkpoint", job: id, attempt: 1, summary: "Halfway" });
		expect(await live.next()).toEqual({ type: "reply", id: 2, cancel: false });
		expect((await state(id)).events.filter((e) => e.kind === "summary")).toHaveLength(1);
		live.send({ id: 3, type: "output", job: id, attempt: 1, seq: 0, text: "raw log" });
		expect(await live.next()).toEqual({ type: "reply", id: 3 });
		// A retried chunk lands once; another chunk cannot reuse its number.
		live.send({ id: 3, type: "output", job: id, attempt: 1, seq: 0, text: "raw log" });
		expect(await live.next()).toEqual({ type: "reply", id: 3 });
		live.send({ id: 8, type: "output", job: id, attempt: 1, seq: 0, text: "other" });
		expect(await live.next()).toEqual({
			type: "reply",
			id: 8,
			error: "A different chunk has that sequence number",
		});
		live.send({ id: 4, type: "checkpoint", job: id, attempt: 2, summary: "Wrong attempt" });
		expect(await live.next()).toEqual({ type: "reply", id: 4, error: "Attempt is no longer current" });
		live.send({ id: 5, type: "result", job: id, attempt: 1, outcome: "done", summary: "x" });
		expect(await live.next()).toEqual({ type: "reply", id: 5, error: "Outcome and summary required" });
		live.send({ id: 6, type: "deploy" });
		expect(await live.next()).toEqual({ type: "reply", id: 6, error: "Unknown message type" });
		await store.cancel(db, id, "owner", Date.now());
		await hub().dispatch("owner");
		expect(await live.next()).toEqual({ type: "cancel", job: id, attempt: 1 });
		live.send({ id: 7, type: "result", job: id, attempt: 1, outcome: "cancelled", summary: "Stopped" });
		expect(await live.next()).toEqual({ type: "reply", id: 7 });
		expect(await state(id)).toMatchObject({ state: "cancelled", summary: "Stopped" });
		expect(await output.read(env, id, null)).toMatchObject({
			output: [{ attempt: 1, seq: 0, text: "raw log" }],
			next: null,
			truncated: [],
		});
	});

	it("assigns queued work to idle runners when its project resumes", async () => {
		const machine = await runner("owner", "machine");
		const live = await connect(machine.token);
		const id = await job(10, "owner", {}, Date.now());
		await project(10, "owner", "paused");
		live.send(status(1, "main"));
		expect(await live.next()).toEqual({ type: "reply", id: 1, attempts: [] });
		await hub().dispatch("owner");
		expect(await state(id)).toMatchObject({ state: "queued" });
		// Resuming sends no runner event, so the resume itself dispatches.
		await project(10, "owner");
		await resume(env, 10);
		expect(await live.next()).toMatchObject({ type: "assign", job: { id, attempt: 1 }, instructions: null });
	});

	it("tells a planning job's agent that kix writes its decision record", async () => {
		const machine = await runner("owner", "machine");
		const live = await connect(machine.token);
		const id = await job(10, "owner", { workflow: "plan", target: "plans/x", branch: "plan/x" }, Date.now());
		live.send(status(1, "main"));
		expect(await live.next()).toEqual({ type: "reply", id: 1, attempts: [] });
		expect(await live.next()).toMatchObject({
			type: "assign",
			job: { id, workflow: "plan" },
			instructions: expect.stringContaining("Do not write the interview's questions, options, or answers"),
		});
	});

	it("keeps a job across a replaced connection and reassigns it after a disconnect", async () => {
		const first = await runner("owner", "first");
		const second = await runner("owner", "second");
		const old = await connect(first.token);
		old.send(status(1, "a"));
		await old.next();
		const id = await job(10, "owner", {}, Date.now());
		await hub().dispatch("owner");
		expect(await old.next()).toMatchObject({ type: "assign", job: { id, attempt: 1 } });

		// Reconnecting replaces the old connection; the job stays put.
		const fresh = await connect(first.token);
		expect(await old.closed).toBe(4000);
		// Until its first status, the new connection does not hold the job.
		await hub().dispatch("owner");
		expect((await state(id)).lease).toBeGreaterThan(Date.now());
		fresh.send(status(1, "a", [{ job: id, attempt: 1 }]));
		expect(await fresh.next()).toEqual({
			type: "reply",
			id: 1,
			attempts: [{ job: id, attempt: 1, action: "continue" }],
		});
		// Passes run in order, so this one follows the pass the status started.
		await hub().dispatch("owner");
		expect(await state(id)).toMatchObject({ state: "running", runner: first.id, lease: null });

		const other = await connect(second.token);
		other.send(status(1, "b"));
		await other.next();
		fresh.ws.close(1000);
		await fresh.closed;
		await hub().dispatch("owner");
		expect((await state(id)).lease).toBeGreaterThan(Date.now());
		// The grace period ends: the hub's alarm moves the job to the connected runner.
		await db.prepare("UPDATE jobs SET lease=1 WHERE id=?").bind(id).run();
		expect(await runDurableObjectAlarm(hub())).toBe(true);
		expect(await other.next()).toMatchObject({ type: "assign", job: { id, attempt: 2, runner: second.id } });
	});
});

describe("raw output", () => {
	async function started() {
		const machine = await runner("owner", "machine");
		await connected(machine, [account("main")]);
		const id = await job(10, "owner");
		await run({ [machine.id]: 1 }, 1);
		return { machine, id };
	}
	const chunk = (job: string, seq: number, text: string) => ({ job, attempt: 1, seq, text });
	const object = (job: string, seq: number) => env.OUTPUT.head(`output/${job}/1/${seq}`);
	const totals = (job: string) =>
		db.prepare("SELECT next,bytes,truncated FROM job_output_attempts WHERE job=?").bind(job).first();

	it("accepts each attempt's chunks in order and retries without writing again", async () => {
		const { machine, id } = await started();
		await expect(output.append(env, machine, chunk(id, 1, "early"), 2)).rejects.toThrow("Expected sequence 0");
		expect(await output.append(env, machine, chunk(id, 0, "first"), 2)).toEqual({});
		const written = (await object(id, 0))!.version;
		expect(await output.append(env, machine, chunk(id, 0, "first"), 3)).toEqual({});
		expect((await object(id, 0))!.version).toBe(written);
		// A conflicting chunk is refused before it reaches R2.
		await expect(output.append(env, machine, chunk(id, 0, "other"), 3)).rejects.toThrow("A different chunk");
		expect((await object(id, 0))!.version).toBe(written);
		expect(await output.append(env, machine, chunk(id, 1, "界"), 4)).toEqual({});
		expect(await totals(id)).toEqual({ next: 2, bytes: 8, truncated: 0 });
		// Another of the owner's runners cannot write into or replay this attempt.
		const other = await runner("owner", "other");
		await expect(output.append(env, other, chunk(id, 2, "x"), 5)).rejects.toThrow("no longer current");
		await expect(output.append(env, other, chunk(id, 0, "first"), 5)).rejects.toThrow("no longer current");
	});

	it("completes a reserved chunk when a retry follows a failed object write", async () => {
		const { machine, id } = await started();
		const failing = { DB: db, OUTPUT: { put: () => Promise.reject(new Error("R2 down")) } as unknown as R2Bucket };
		await expect(output.append(failing, machine, chunk(id, 0, "kept"), 2)).rejects.toThrow("R2 down");
		expect(await object(id, 0)).toBeNull();
		// The reservation holds the sequence number for that text.
		await expect(output.append(env, machine, chunk(id, 0, "changed"), 3)).rejects.toThrow("A different chunk");
		expect(await output.append(env, machine, chunk(id, 0, "kept"), 3)).toEqual({});
		// Retention counts from the successful upload, as the bucket lifecycle does.
		expect((await output.read(env, id, null)).output).toEqual([{ attempt: 1, seq: 0, at: 3, text: "kept" }]);
		expect(await output.append(env, machine, chunk(id, 0, "kept"), 4)).toEqual({});
		expect((await output.read(env, id, null)).output).toMatchObject([{ at: 3 }]);
	});

	it("never pages past a chunk that may still land", async () => {
		const { machine, id } = await started();
		const failing = { DB: db, OUTPUT: { put: () => Promise.reject(new Error("R2 down")) } as unknown as R2Bucket };
		for (const seq of [0, 1, 2]) await output.append(env, machine, chunk(id, seq, `${seq}`), 2);
		await expect(output.append(failing, machine, chunk(id, 3, "3"), 2)).rejects.toThrow("R2 down");
		// The pending chunk would fill the page; the cursor stops before it.
		expect(await output.read(env, id, null)).toMatchObject({
			output: [{ seq: 0 }, { seq: 1 }, { seq: 2 }],
			next: null,
		});
		// Later chunks wait for it, so it stays the attempt's last.
		await expect(output.append(env, machine, chunk(id, 4, "4"), 3)).rejects.toThrow("Chunk 3 is not stored yet");
		expect(await output.append(env, machine, chunk(id, 3, "3"), 3)).toEqual({});
		expect(await output.read(env, id, null)).toMatchObject({
			output: [{}, {}, {}, { seq: 3 }],
			next: { attempt: 1, seq: 3 },
		});
		expect(await output.append(env, machine, chunk(id, 4, "4"), 3)).toEqual({});
		await expect(output.append(failing, machine, chunk(id, 5, "5"), 4)).rejects.toThrow("R2 down");
		// Once the job is reassigned, a late retry cannot land behind a reader's cursor.
		await db.prepare("UPDATE jobs SET attempt=2 WHERE id=?").bind(id).run();
		await expect(output.append(env, machine, chunk(id, 5, "5"), 5)).rejects.toThrow("no longer current");
		expect(await object(id, 5)).toBeNull();
		expect(await output.read(env, id, { attempt: 1, seq: 3 })).toMatchObject({ output: [{ seq: 4 }], next: null });
	});

	it("refuses chunks past the attempt's cap as truncated while the job carries on", async () => {
		const { machine, id } = await started();
		expect(await output.append(env, machine, chunk(id, 0, "kept"), 2)).toEqual({});
		await db
			.prepare("UPDATE job_output_attempts SET bytes=? WHERE job=?")
			.bind(output.MAX_BYTES - 4, id)
			.run();
		expect(await output.append(env, machine, chunk(id, 1, "12345"), 3)).toEqual({ truncated: true });
		// Smaller and later chunks are refused too, so the kept output stays a prefix.
		expect(await output.append(env, machine, chunk(id, 1, "1"), 4)).toEqual({ truncated: true });
		expect(await output.append(env, machine, chunk(id, 2, "1"), 4)).toEqual({ truncated: true });
		expect(await object(id, 1)).toBeNull();
		expect(await totals(id)).toEqual({ next: 1, bytes: output.MAX_BYTES - 4, truncated: 1 });
		expect(await store.checkpoint(db, machine, id, 1, "Still going", null, 5)).toEqual({ cancel: false });
		expect(await state(id)).toMatchObject({ state: "running", summary: "Still going" });
		expect(await output.read(env, id, null)).toMatchObject({
			output: [{ seq: 0, text: "kept" }],
			truncated: [1],
		});
	});

	it("caps the number of chunks per attempt", async () => {
		const { machine, id } = await started();
		await output.append(env, machine, chunk(id, 0, "x"), 2);
		await db.prepare("UPDATE job_output_attempts SET next=? WHERE job=?").bind(output.MAX_CHUNKS, id).run();
		expect(await output.append(env, machine, chunk(id, output.MAX_CHUNKS, "x"), 3)).toEqual({ truncated: true });
		expect(await totals(id)).toMatchObject({ next: output.MAX_CHUNKS, truncated: 1 });
	});

	it("forgets chunks after the retention period without giving back their capacity", async () => {
		const { machine, id } = await started();
		const now = Date.now();
		await output.append(env, machine, chunk(id, 0, "old"), now - output.RETENTION - 1);
		await output.append(env, machine, chunk(id, 1, "new"), now);
		await worker.scheduled(createScheduledController(), env);
		expect(await output.read(env, id, null)).toMatchObject({ output: [{ seq: 1, text: "new" }], next: null });
		// An expired sequence number is never reclaimed, and the attempt keeps counting.
		await expect(output.append(env, machine, chunk(id, 0, "old"), now)).rejects.toThrow("That chunk has expired");
		expect(await totals(id)).toEqual({ next: 2, bytes: 6, truncated: 0 });
		// Reads skip a row whose object the bucket lifecycle already deleted.
		await env.OUTPUT.delete(`output/${id}/1/1`);
		expect(await output.read(env, id, null)).toEqual({ output: [], next: null, truncated: [] });
	});

	it("deletes its own object when the job is disconnected during the write", async () => {
		const { machine, id } = await started();
		const racing = {
			DB: db,
			OUTPUT: {
				put: async (key: string, value: string) => {
					await db.prepare("DELETE FROM github_projects WHERE id=10").run();
					return env.OUTPUT.put(key, value);
				},
				delete: (key: string) => env.OUTPUT.delete(key),
			} as unknown as R2Bucket,
		};
		await expect(output.append(racing, machine, chunk(id, 0, "racing"), 2)).rejects.toThrow("no longer current");
		expect(await object(id, 0)).toBeNull();
	});

	it("queues a cleanup when an upload racing a disconnect cannot delete its object", async () => {
		const { machine, id } = await started();
		const racing = {
			DB: db,
			OUTPUT: {
				put: async (key: string, value: string) => {
					await db.prepare("DELETE FROM github_projects WHERE id=10").run();
					return env.OUTPUT.put(key, value);
				},
				delete: () => Promise.reject(new Error("R2 down")),
			} as unknown as R2Bucket,
		};
		await expect(output.append(racing, machine, chunk(id, 0, "racing"), 2)).rejects.toThrow("R2 down");
		expect(await object(id, 0)).not.toBeNull();
		await worker.scheduled(createScheduledController(), env);
		expect(await object(id, 0)).toBeNull();
		expect((await db.prepare("SELECT job FROM output_cleanup").all()).results).toEqual([]);
	});

	it("retries a failed output cleanup from the daily cron", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await env.OUTPUT.put("output/gone/1/0", "orphan");
		await db.prepare("INSERT INTO output_cleanup(job,at) VALUES('gone',0)").run();
		const failing = { DB: db, OUTPUT: { list: () => Promise.reject(new Error("R2 down")) } as unknown as R2Bucket };
		await output.purge(failing);
		expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: "output_cleanup_failed" }));
		expect((await db.prepare("SELECT job FROM output_cleanup").all()).results).toEqual([{ job: "gone" }]);
		await output.retain(env, Date.now());
		expect(await env.OUTPUT.head("output/gone/1/0")).toBeNull();
		expect((await db.prepare("SELECT job FROM output_cleanup").all()).results).toEqual([]);
	});
});

describe("runner messages", () => {
	it("limits output chunks by their UTF-8 size", () => {
		const output = (text: string) => JSON.stringify({ id: 1, type: "output", job: "j", attempt: 1, seq: 0, text });
		expect(parse(output("a".repeat(1024 * 1024)))).toMatchObject({ type: "output" });
		// Fewer than 1 Mi code units, but three bytes each.
		expect(() => parse(output("界".repeat(400_000)))).toThrow("at most 1 MiB");
	});

	it("accepts only prompts the inbox can render", () => {
		const question = (prompt: unknown) =>
			parse(JSON.stringify({ type: "question", job: "j", attempt: 1, summary: "Why", session: "s", prompt }));
		const ask = { question: "Which?", options: [{ label: "A", recommended: true }, { label: "B" }] };
		expect(question({ questions: [ask] })).toMatchObject({ prompt: { kind: "decision", questions: [ask] } });
		expect(question({ kind: "permission", questions: [{ question: "Run it?", options: [] }] })).toMatchObject({
			prompt: { kind: "permission" },
		});
		expect(() => question({ q: 1 })).toThrow("1 to 10 questions");
		expect(() => question({ kind: "chat", questions: [ask] })).toThrow("Invalid prompt");
		expect(() => question({ questions: [{ ...ask, options: [{ label: "A" }, { label: "A" }] }] })).toThrow(
			"unique",
		);
		expect(() => question({ questions: [{ question: " ", options: [] }] })).toThrow("Invalid prompt");
	});

	it("checks answers against their prompt", () => {
		const prompt = parsePrompt({
			questions: [
				{ question: "One?", options: [{ label: "A" }, { label: "B" }] },
				{ question: "Many?", options: [{ label: "X" }, { label: "Y" }], multiple: true },
				{ question: "Say", options: [] },
			],
		});
		const answer = (...answers: unknown[]) => parseAnswer(prompt, { answers });
		expect(answer({ choices: ["A"] }, { choices: ["X", "Y"] }, { choices: [], text: " Hi " })).toEqual({
			answers: [{ choices: ["A"] }, { choices: ["X", "Y"] }, { choices: [], text: "Hi" }],
		});
		// Free text can stand in for, or add to, a choice.
		expect(answer({ text: "C" }, { choices: ["X"], text: "why" }, { text: "Hi" }).answers[0]).toEqual({
			choices: [],
			text: "C",
		});
		expect(() => answer({ choices: ["A", "B"] }, { choices: ["X"] }, { text: "Hi" })).toThrow("offered options");
		expect(() => answer({ choices: ["Z"] }, { choices: ["X"] }, { text: "Hi" })).toThrow("offered options");
		expect(() => answer({ choices: ["A"] }, { choices: [] }, { text: "Hi" })).toThrow("every question");
		expect(() => answer({ choices: ["A"] })).toThrow("every question");
		expect(formAnswer(prompt, { q0: "B", q1: ["X", "Y"], "q1-text": "", "q2-text": "Hello" })).toEqual({
			answers: [{ choices: ["B"] }, { choices: ["X", "Y"] }, { choices: [], text: "Hello" }],
		});
	});
});

describe("branch names", () => {
	it("accepts what git check-ref-format accepts", () => {
		for (const name of ["quest/m0/kix/jobs", "quest/v1.2/x", "plan/issue-4", "quest/fix|parser"])
			expect(refName(name)).toBe(true);
		for (const name of [
			"quest/fix bug",
			"quest/a..b",
			"quest/.hidden",
			"quest/x.lock",
			"quest/a:b",
			"quest/x/",
			"@",
		])
			expect(refName(name)).toBe(false);
	});
});

describe("job routes", () => {
	const base = `${origin}/projects/github/upstream/project/jobs`;
	let maintainer = "";
	let cookie = "";
	let github: Awaited<ReturnType<typeof maintainerOf>>["github"];
	let mock: Awaited<ReturnType<typeof maintainerOf>>["mock"];

	beforeEach(async () => {
		({ user: maintainer, cookie, github, mock } = await maintainerOf());
	});

	function post(path: string, body: unknown, headers: Record<string, string> = { Cookie: cookie, Origin: origin }) {
		return app.request(
			`${base}${path}`,
			{ method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) },
			testEnv,
		);
	}

	it("stops a disconnected project's running jobs and deletes their output", async () => {
		const machine = await runner(maintainer, "machine");
		const live = await connect(machine.token);
		live.send(status(1, "main"));
		await live.next();
		const id = await job(10, maintainer, {}, Date.now());
		await env.RUNNERS.get(env.RUNNERS.idFromName(maintainer)).dispatch(maintainer);
		expect(await live.next()).toMatchObject({ type: "assign", job: { id, attempt: 1 } });
		live.send(status(2, "main", [{ job: id, attempt: 1 }], 0));
		await live.next();
		for (const seq of [0, 1]) {
			live.send({ id: 3, type: "output", job: id, attempt: 1, seq, text: `chunk ${seq}` });
			expect(await live.next()).toEqual({ type: "reply", id: 3 });
		}
		expect((await env.OUTPUT.list({ prefix: `output/${id}/` })).objects).toHaveLength(2);
		const response = await app.request(
			`${origin}/projects/github/upstream/project`,
			{
				method: "POST",
				headers: { Cookie: cookie, Origin: origin },
				body: new URLSearchParams({ id: "10", state: "disconnected" }),
			},
			testEnv,
		);
		expect(response.status).toBe(303);
		expect(await live.next()).toEqual({ type: "cancel", job: id, attempt: 1 });
		expect(await store.readJob(db, id)).toBeNull();
		expect((await env.OUTPUT.list({ prefix: `output/${id}/` })).objects).toEqual([]);
		expect(await db.prepare("SELECT job FROM output_cleanup").all()).toMatchObject({ results: [] });
		// The runner's late chunk finds no job.
		live.send({ id: 4, type: "output", job: id, attempt: 1, seq: 2, text: "late" });
		expect(await live.next()).toEqual({ type: "reply", id: 4, error: "Attempt is no longer current" });
	});

	it("authorizes each workflow against current observations and deduplicates requests", async () => {
		const started = await post("", { workflow: "start", target: "quest/first.md" });
		expect(started.status).toBe(201);
		const { id } = (await started.json()) as { id: string };
		expect(await (await post("", { workflow: "start", target: "quest/first.md" })).json()).toEqual({
			id,
			created: false,
		});
		expect((await post("", { workflow: "start", target: "quest/README.md" })).status).toBe(409);
		expect((await post("", { workflow: "plan", target: "issues/7" })).status).toBe(409);
		expect((await post("", { workflow: "plan", target: "issues/1" })).status).toBe(201);
		expect((await post("", { workflow: "plan", idea: "Plan the importer" })).status).toBe(201);
		expect((await post("", { workflow: "iterate", target: "pulls/2" })).status).toBe(201);
		expect((await post("", { workflow: "bootstrap" })).status).toBe(409);
		expect((await post("", { workflow: "deploy" })).status).toBe(409);
		const listed = (await (await app.request(base, { headers: { Cookie: cookie } }, testEnv)).json()) as {
			jobs: store.Job[];
		};
		expect(listed.jobs.map((j) => [j.workflow, j.target, j.revision, j.branch, j.trusted, j.actor])).toEqual(
			expect.arrayContaining([
				["start", "quest/first.md", commit, "quest/first", 1, maintainer],
				["plan", "issues/1", commit, "plan/issue-1", 1, maintainer],
				["iterate", "pulls/2", head, "contributor/fix", 0, maintainer],
			]),
		);
	});

	it("classifies a verified maintainer PR at creation and rechecks before hub assignment", async () => {
		const identity = await db
			.prepare("SELECT accountId FROM account WHERE userId=? AND providerId='github'")
			.bind(maintainer)
			.first<{ accountId: string }>();
		const databaseId = Number(identity!.accountId);
		github.signature = { isValid: true, signer: { databaseId, login: `person${databaseId}` } };
		const response = await post("", { workflow: "iterate", target: "pulls/2" });
		expect(response.status).toBe(201);
		const { id } = (await response.json()) as { id: string };
		expect(await state(id)).toMatchObject({ trusted: 1, state: "queued" });
		// A role revoked after creation must not execute on an ordinary runner.
		github.role = "read";
		const machine = await runner(maintainer, "machine");
		const live = await connect(machine.token);
		live.send(status(1, "main"));
		expect(await live.next()).toMatchObject({ type: "reply", id: 1 });
		await env.RUNNERS.get(env.RUNNERS.idFromName(maintainer)).dispatch(maintainer);
		expect(await state(id)).toMatchObject({ trusted: 0, state: "queued" });
	});

	it("starts a new plan from the maintainer's idea and keeps it across a retry", async () => {
		const refuse = async (body: Record<string, unknown>, error: string) => {
			const response = await post("", body);
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ error });
		};
		await refuse({ workflow: "plan" }, "Describe what to plan");
		await refuse({ workflow: "plan", idea: "  ", context: "pasted" }, "Describe what to plan");
		await refuse({ workflow: "plan", idea: "x".repeat(4001) }, "Keep the idea to at most 4000 characters");
		await refuse({ workflow: "plan", target: "issues/1", idea: "Also this" }, "Only a new plan takes an idea");
		// An interview no job started, or one whose follow-ups nobody suggested, is not a plan to retry.
		await refuse({ workflow: "plan", target: `plans/${crypto.randomUUID()}` }, "Nothing is left to plan here");
		const created = await post("", { workflow: "plan", idea: " Config includes\r\n", context: "Notes:\r\nA" });
		expect(created.status).toBe(201);
		const { id } = (await created.json()) as { id: string };
		const job = (await store.readJob(db, id))!;
		expect(job).toMatchObject({
			idea: "Config includes",
			context: "Notes:\nA",
			branch: `plan/${job.target.slice(6, 14)}`,
		});
		await db.prepare("UPDATE jobs SET state='failed' WHERE id=?").bind(id).run();
		const retried = (await (await post("", { workflow: "plan", target: job.target })).json()) as { id: string };
		expect(await store.readJob(db, retried.id)).toMatchObject({
			target: job.target,
			idea: "Config includes",
			context: "Notes:\nA",
			continues: id,
		});
	});

	it("plans a finished job's suggested follow-ups once, from its own result", async () => {
		const id = await job(10, maintainer, {}, 1);
		await db
			.prepare("UPDATE jobs SET state='completed',summary='Shipped it.',result=? WHERE id=?")
			.bind(JSON.stringify({ head: null, followups: ["Cache the parser", "Document `--fast`"] }), id)
			.run();
		await db
			.prepare("INSERT INTO job_events(job,attempt,kind,body,at) VALUES(?,0,'result',?,?)")
			.bind(id, JSON.stringify({ outcome: "completed", summary: "Shipped it." }), Date.now())
			.run();
		expect(await store.listFollowups(db, 10)).toMatchObject([
			{ id, followups: ["Cache the parser", "Document `--fast`"] },
		]);
		// The request names only the target; the follow-ups come from the job, not the form.
		const refused = await post("", { workflow: "plan", target: `plans/${id}`, context: "forged" });
		expect(refused.status).toBe(409);
		const planned = await post("", { workflow: "plan", target: `plans/${id}` });
		expect(planned.status).toBe(201);
		const plan = (await store.readJob(db, ((await planned.json()) as { id: string }).id))!;
		expect(plan).toMatchObject({
			workflow: "plan",
			target: `plans/${id}`,
			idea: "Plan the follow-ups that the start job on quest/first.md suggested.",
			context:
				"A finished job suggested these follow-ups:\n\n- Cache the parser\n- Document `--fast`\n\nIts summary: Shipped it.",
		});
		expect(await store.listFollowups(db, 10)).toEqual([]);
		await db.prepare("UPDATE jobs SET state='completed' WHERE id=?").bind(plan.id).run();
		expect((await post("", { workflow: "plan", target: `plans/${id}` })).status).toBe(409);
	});

	it("lists all recent follow-up offers instead of the newest 50", async () => {
		const now = Date.now();
		await db
			.prepare(
				`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<60)
 INSERT INTO jobs(id,repository,workflow,target,revision,branch,actor,trusted,state,result,createdAt,updatedAt)
 SELECT 'recent-'||i,10,'start','quest/extra-'||i||'.md',?,'quest/extra-'||i,?,1,'completed',?,?-i,? FROM n`,
			)
			.bind(commit, maintainer, JSON.stringify({ followups: ["Still useful"] }), now, now)
			.run();
		await db
			.prepare(
				"INSERT INTO job_events(job,attempt,kind,body,at) SELECT id,attempt,'result',?,createdAt FROM jobs WHERE id LIKE 'recent-%'",
			)
			.bind(JSON.stringify({ outcome: "completed", summary: "Done" }))
			.run();
		const offers = await store.listFollowups(db, 10, now);
		expect(offers).toHaveLength(60);
		expect(offers[0]).toMatchObject({ id: "recent-1", completedAt: now - 1 });
		expect(offers.at(-1)).toMatchObject({ id: "recent-60", completedAt: now - 60 });
		expect(await store.followupRequest(db, 10, "recent-60", now)).not.toBeNull();
	});

	it("starts an epic on its README branch while a child's branch is claimed", async () => {
		// The epic's last listed child merged, leaving its own work; another quest under it is claimed.
		const documents = [
			{
				path: "quest/README.md",
				content: "# Project\n\n## Goal\n\nBuild it.\n\n## Required\n\n- [M0](/quest/m0/README.md)\n",
			},
			{
				path: "quest/m0/README.md",
				content: "# First\n\n## Goal\n\nShip.\n\n## Required\n\n- [Epic](/quest/m0/epic/README.md)\n",
			},
			{ path: "quest/m0/epic/README.md", content: "# [S] Epic\n\n## Goal\n\nThe epic's own work.\n" },
			{ path: "quest/m0/epic/child.md", content: "# [S] Child\n\n## Goal\n\nClaimed.\n" },
		];
		await db
			.prepare(
				"UPDATE github_project_state SET snapshot=json_set(snapshot,'$.documents',json(?)),scan=json_set(scan,'$.occupancy.claims',json(?))",
			)
			.bind(JSON.stringify(documents), JSON.stringify(["quest/m0/epic/child"]))
			.run();
		expect((await post("", { workflow: "start", target: "quest/m0/epic/child.md" })).status).toBe(409);
		expect((await post("", { workflow: "start", target: "quest/m0/epic/README.md" })).status).toBe(201);
		const [job] = await store.listJobs(db, 10);
		expect(job).toMatchObject({
			workflow: "start",
			target: "quest/m0/epic/README.md",
			branch: "quest/m0/epic/README",
		});
	});

	it("starts work while history is still paging, but not before a refresh reads a new pull request head", async () => {
		// A long history needs many refreshes; open PRs and claims are already current.
		await db
			.prepare("UPDATE github_project_state SET scan=json_set(scan,'$.history.complete',json('false'))")
			.run();
		expect((await post("", { workflow: "start", target: "quest/first.md" })).status).toBe(201);
		const pushed = {
			action: "synchronize",
			installation: { id: 5 },
			repository: { id: 10 },
			pull_request: { id: 21, number: 2 },
		};
		expect((await delivery("pull_request", pushed)).status).toBe(202);
		const stale = await post("", { workflow: "iterate", target: "pulls/2" });
		expect(stale.status).toBe(403);
		expect(await stale.json()).toMatchObject({ error: "Refresh project activity before starting work" });
	});

	it("refuses an issue or pull request that closed or moved since it was read", async () => {
		// Closing or commenting leaves availability known, and history has not reread the target.
		const changed = "This changed on GitHub since it was read; refresh and review it again";
		github.issue = "closed";
		const closed = await post("", { workflow: "plan", target: "issues/1" });
		expect(closed.status).toBe(403);
		expect(await closed.json()).toEqual({ error: changed });
		github.pull = "closed";
		expect(await (await post("", { workflow: "iterate", target: "pulls/2" })).json()).toEqual({ error: changed });
		github.pull = "open";
		github.head = "e".repeat(40);
		expect(await (await post("", { workflow: "iterate", target: "pulls/2" })).json()).toEqual({ error: changed });
		// Work that targets no issue or pull request still starts.
		expect((await post("", { workflow: "start", target: "quest/first.md" })).status).toBe(201);
	});

	it("offers a devShell bootstrap job instead of starting without a flake", async () => {
		github.flake = false;
		const refused = await post("", { workflow: "start", target: "quest/first.md" });
		expect(refused.status).toBe(409);
		expect(await refused.json()).toMatchObject({ bootstrap: true });
		// Iterating on the bootstrap PR checks its head, which adds the flake.
		expect((await post("", { workflow: "iterate", target: "pulls/2" })).status).toBe(201);
		expect((await post("", { workflow: "bootstrap" })).status).toBe(201);
	});

	it.each(["completed", "failed", "cancelled"] as const)(
		"sweeps a %s merge job whose lifecycle callback missed its hold",
		async (outcome) => {
			const { id } = (await (await post("", { workflow: "merge", target: "pulls/2" })).json()) as { id: string };
			const machine = await runner(maintainer, "machine", "linux", true);
			await connected(machine, [account("main")]);
			await store.dispatch(db, maintainer, new Map([[machine.id, 1]]), Date.now());
			await store.finish(db, machine, id, 1, { outcome, summary: "Ended", result: undefined }, Date.now());
			// No event-driven release is called: the schedule is the backstop.
			expect(github.labels).toEqual(["quest:kix"]);
			await worker.scheduled(createScheduledController({ cron: landing.SWEEP_CRON }), testEnv);
			expect(github.labels).toEqual([]);
			expect(await state(id)).toMatchObject({ hold: null });
		},
	);

	it.each(["queued", "running", "waiting"])("keeps a %s job's live hold during the sweep", async (state) => {
		const { id } = (await (await post("", { workflow: "merge", target: "pulls/2" })).json()) as { id: string };
		await db.prepare("UPDATE jobs SET state=? WHERE id=?").bind(state, id).run();
		await worker.scheduled(createScheduledController({ cron: landing.SWEEP_CRON }), testEnv);
		expect(github.labels).toEqual(["quest:kix"]);
		expect(await store.readJob(db, id)).toMatchObject({ hold: "LE_1", state });
	});

	it("preserves a landing and a replacement hold while sweeping ended jobs", async () => {
		const { id } = (await (await post("", { workflow: "merge", target: "pulls/2" })).json()) as { id: string };
		await db.prepare("UPDATE jobs SET state='completed' WHERE id=?").bind(id).run();
		github.landing = true;
		github.events.push({ id: "AUTO", label: null });
		await worker.scheduled(createScheduledController({ cron: landing.SWEEP_CRON }), testEnv);
		expect(github.labels).toEqual(["quest:kix"]);
		expect(await state(id)).toMatchObject({ hold: "LE_1" });
		github.landing = false;
		// Another session removed and re-added the label. The old token may be cleared, never its label.
		github.events.push({ id: "REPLACEMENT", label: "quest:kix" });
		await worker.scheduled(createScheduledController({ cron: landing.SWEEP_CRON }), testEnv);
		expect(github.labels).toEqual(["quest:kix"]);
		expect(await state(id)).toMatchObject({ hold: null });
	});

	it.each(["lease", "status"])(
		"sweeps a stopped attempt abandoned through %s without its release callback",
		async (path) => {
			const { id } = (await (await post("", { workflow: "merge", target: "pulls/2" })).json()) as { id: string };
			const machine = await runner(maintainer, "machine", "linux", true);
			await connected(machine, [account("main")]);
			const now = Date.now();
			await store.dispatch(db, maintainer, new Map([[machine.id, 1]]), now);
			await store.report(db, machine, [account("main")], [{ job: id, attempt: 1 }], now);
			await post(`/${id}/cancel`, {});
			if (path === "lease") {
				await store.dispatch(db, maintainer, new Map(), now);
				expect((await store.dispatch(db, maintainer, new Map(), now + 2 * GRACE)).ended).toEqual([id]);
			} else expect((await store.report(db, machine, [account("main")], [], now)).ended).toEqual([id]);
			expect(github.labels).toEqual(["quest:kix"]);
			await worker.scheduled(createScheduledController({ cron: landing.SWEEP_CRON }), testEnv);
			expect(github.labels).toEqual([]);
			expect(await state(id)).toMatchObject({ hold: null, state: "cancelled" });
		},
	);

	it("retains a token acquired after cancellation so the sweep can retry its failed immediate release", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
			const path = new URL(String(input)).pathname;
			if (path.endsWith("/issues/2/labels") && init?.method === "POST") {
				const queued = await db
					.prepare("SELECT id FROM jobs WHERE workflow='merge' AND state='queued'")
					.first<{ id: string }>();
				await post(`/${queued!.id}/cancel`, {});
			}
			if (path.includes("/issues/2/labels/") && init?.method === "DELETE")
				return new Response(null, { status: 503 });
			return mock(input, init);
		});
		const response = await post("", { workflow: "merge", target: "pulls/2" });
		expect(response.status).toBe(403);
		const { id } = (await db.prepare("SELECT id FROM jobs WHERE workflow='merge'").first<{ id: string }>())!;
		expect(await state(id)).toMatchObject({ hold: "LE_1", state: "cancelled" });
		expect(github.labels).toEqual(["quest:kix"]);
		vi.mocked(globalThis.fetch).mockImplementation(mock);
		await worker.scheduled(createScheduledController({ cron: landing.SWEEP_CRON }), testEnv);
		expect(github.labels).toEqual([]);
		expect(await state(id)).toMatchObject({ hold: null });
	});

	it("directly releases an acquired token when disconnect removed the project and job", async () => {
		vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
			if (new URL(String(input)).pathname.endsWith("/issues/2/labels") && init?.method === "POST")
				await db.prepare("DELETE FROM github_projects WHERE id=10").run();
			return mock(input, init);
		});
		const response = await post("", { workflow: "merge", target: "pulls/2" });
		expect(response.status).toBe(201);
		const { id } = (await response.json()) as { id: string };
		expect(await store.readJob(db, id)).toBeNull();
		expect(github.labels).toEqual([]);
	});

	it("keeps daily output retention separate from the frequent hold sweep", async () => {
		await env.OUTPUT.put("output/gone/1/0", "orphan");
		await db.prepare("INSERT INTO output_cleanup(job,at) VALUES('gone',0)").run();
		await worker.scheduled(createScheduledController({ cron: landing.SWEEP_CRON }), testEnv);
		expect(await env.OUTPUT.head("output/gone/1/0")).not.toBeNull();
		await worker.scheduled(createScheduledController({ cron: "17 4 * * *" }), testEnv);
		expect(await env.OUTPUT.head("output/gone/1/0")).toBeNull();
	});

	it("holds a pull request picked for merge until its job stops, unless another session holds it", async () => {
		const created = await post("", { workflow: "merge", target: "pulls/2" });
		expect(created.status).toBe(201);
		const { id } = (await created.json()) as { id: string };
		expect(github.labels).toEqual(["quest:kix"]);
		expect(await state(id)).toMatchObject({
			workflow: "merge",
			state: "queued",
			revision: head,
			head,
			branch: "contributor/fix",
			trusted: 0,
			hold: "LE_1",
		});
		// Picking it again finds the same job, which already holds the pull request.
		expect(await (await post("", { workflow: "merge", target: "pulls/2" })).json()).toEqual({ id, created: false });
		expect(github.events).toHaveLength(1);
		// Stopping the job gives the pull request back.
		expect((await post(`/${id}/cancel`, {})).status).toBe(204);
		expect(github.labels).toEqual([]);
		expect(await state(id)).toMatchObject({ state: "cancelled", hold: null });

		// A local session's hold refuses the pick and leaves no job behind.
		github.labels = ["quest:active"];
		github.events.push({ id: "LOCAL", label: "quest:active" });
		const refused = await post("", { workflow: "merge", target: "pulls/2" });
		expect(refused.status).toBe(403);
		expect(await refused.json()).toEqual({
			error: "Another session holds this pull request with quest:active; pick it again once it is released",
		});
		expect(github.labels).toEqual(["quest:active"]);
		expect(await store.active(db, 10, "pulls/2")).toBe(false);

		// The quest:merge label older quest versions left on queued PRs holds nothing.
		github.labels = ["quest:merge"];
		github.events = [
			{ id: "QUEUED", label: "quest:merge" },
			{ id: "AUTO", label: null },
		];
		const again = await post("", { workflow: "merge", target: "pulls/2" });
		expect(again.status).toBe(201);
		const { id: next } = (await again.json()) as { id: string };
		expect(await state(next)).toMatchObject({ hold: "LE_3" });
		expect(github.labels).toEqual(["quest:merge", "quest:kix"]);
	});

	it("gives a merge job's pull request back once its landing ends unmerged", async () => {
		const { id } = (await (await post("", { workflow: "merge", target: "pulls/2" })).json()) as { id: string };
		const machine = await runner(maintainer, "machine", "linux", true);
		await connected(machine, [account("main")]);
		await store.dispatch(db, maintainer, new Map([[machine.id, 1]]), Date.now());
		const dequeued = {
			action: "dequeued",
			installation: { id: 5 },
			repository: { id: 10 },
			pull_request: { id: 21, number: 2 },
		};
		// A running job keeps its hold whatever GitHub says.
		await delivery("pull_request", dequeued, undefined, {}, testEnv);
		expect(github.labels).toEqual(["quest:kix"]);
		// The job started a landing, which keeps the hold while it is queued.
		github.landing = true;
		github.events.push({ id: "AUTO", label: null });
		await store.finish(
			db,
			machine,
			id,
			1,
			{ outcome: "completed", summary: "Landing", result: undefined },
			Date.now(),
		);
		await delivery("pull_request", { ...dequeued, action: "auto_merge_enabled" }, undefined, {}, testEnv);
		expect(github.labels).toEqual(["quest:kix"]);
		expect(await state(id)).toMatchObject({ hold: "LE_1" });
		// It left the queue unmerged: the bot removes the label.
		github.landing = false;
		await delivery("pull_request", dequeued, undefined, {}, testEnv);
		expect(github.labels).toEqual([]);
		expect(await state(id)).toMatchObject({ hold: null });
	});

	it("gives the label back when a merge pick is stopped while it takes the pull request", async () => {
		vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
			// The maintainer stops the queued job while GitHub adds its label.
			if (new URL(String(input)).pathname.endsWith("/issues/2/labels") && init?.method === "POST") {
				const queued = await db
					.prepare("SELECT id FROM jobs WHERE workflow='merge' AND state='queued'")
					.first<{ id: string }>();
				expect((await post(`/${queued!.id}/cancel`, {})).status).toBe(204);
			}
			return mock(input, init);
		});
		const created = await post("", { workflow: "merge", target: "pulls/2" });
		expect(created.status).toBe(201);
		const { id } = (await created.json()) as { id: string };
		expect(await state(id)).toMatchObject({ state: "cancelled", hold: null });
		expect(github.labels).toEqual([]);
	});

	it("starts a merge job only once it holds its pull request", async () => {
		const machine = await runner(maintainer, "machine", "linux", true);
		await connected(machine, [account("main")]);
		const { id } = await store.createJob(
			db,
			{
				repository: 10,
				actor: maintainer,
				workflow: "merge",
				target: "pulls/2",
				revision: head,
				branch: "contributor/fix",
				trusted: false,
			},
			0,
		);
		const slots = new Map([[machine.id, 1]]);
		expect((await store.dispatch(db, maintainer, slots, 0)).assign).toEqual([]);
		expect(await store.held(db, id, "LE_1")).toBe(true);
		expect((await store.dispatch(db, maintainer, slots, 0)).assign.map((a) => a.job.id)).toEqual([id]);
	});

	it("gives a merge job's pull request back once an attempt it asked to stop is abandoned", async () => {
		const machine = await runner(maintainer, "machine", "linux", true);
		await connected(machine, [account("main")]);
		const pick = async () =>
			((await (await post("", { workflow: "merge", target: "pulls/2" })).json()) as { id: string }).id;
		const now = Date.now();

		// The runner disconnects after the stop, so its attempt reports no result; the lease expiring cancels it.
		const lost = await pick();
		await store.dispatch(db, maintainer, new Map([[machine.id, 1]]), now);
		await store.report(db, machine, [account("main")], [{ job: lost, attempt: 1 }], now);
		expect((await post(`/${lost}/cancel`, {})).status).toBe(204);
		expect(github.labels).toEqual(["quest:kix"]);
		await store.dispatch(db, maintainer, new Map(), now);
		expect((await store.dispatch(db, maintainer, new Map(), now + 2 * GRACE)).ended).toEqual([lost]);
		await landing.ended(testEnv, lost);
		expect(github.labels).toEqual([]);
		expect(await state(lost)).toMatchObject({ state: "cancelled", hold: null });

		// A status that omits an acknowledged attempt asked to stop cancels it too.
		const omitted = await pick();
		await store.dispatch(db, maintainer, new Map([[machine.id, 1]]), now);
		await store.report(db, machine, [account("main")], [{ job: omitted, attempt: 1 }], now);
		expect((await post(`/${omitted}/cancel`, {})).status).toBe(204);
		expect((await store.report(db, machine, [account("main")], [], now)).ended).toEqual([omitted]);
		await landing.ended(testEnv, omitted);
		expect(github.labels).toEqual([]);
	});

	it("refuses to merge a draft", async () => {
		await db
			.prepare("UPDATE github_project_activity SET data=json_set(data,'$.isDraft',json('true')) WHERE id='21'")
			.run();
		const refused = await post("", { workflow: "merge", target: "pulls/2" });
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({ error: "Mark the draft ready for review before merging it" });
		expect(github.labels).toEqual([]);
	});

	it("refuses to iterate on a pull request head without a flake", async () => {
		github.pullFlake = false;
		const refused = await post("", { workflow: "iterate", target: "pulls/2" });
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({ error: "The pull request's head has no flake devShell" });
	});

	it("refuses new work on paused projects and requests without current authority or origin", async () => {
		expect((await post("", { workflow: "plan" }, { Cookie: cookie, Origin: "https://evil.example" })).status).toBe(
			403,
		);
		expect((await post("", { workflow: "plan" }, { Origin: origin })).status).toBe(403);
		github.role = "write";
		expect((await post("", { workflow: "plan" })).status).toBe(403);
		github.role = "maintain";
		await project(10, maintainer, "paused");
		expect((await post("", { workflow: "plan" })).status).toBe(409);
	});

	it("answers, cancels, and reads raw output only for the project's current maintainers", async () => {
		const machine = await runner(maintainer, "machine");
		await connected(machine, [account("main")]);
		const { id } = (await (await post("", { workflow: "start", target: "quest/first.md" })).json()) as {
			id: string;
		};
		await store.dispatch(db, maintainer, new Map([[machine.id, 1]]), Date.now());
		for (const [seq, text] of ["secret transcript", "b", "c", "d", "e"].entries())
			await output.append(env, machine, { job: id, attempt: 1, seq, text }, Date.now());
		const { question } = await store.ask(
			db,
			machine,
			id,
			1,
			{
				summary: "Which?",
				session: "s",
				prompt: { questions: [{ question: "Which?", options: [{ label: "A" }] }] },
			},
			Date.now(),
		);
		const page = (query = "") =>
			app.request(`${base}/${id}/output${query}`, { headers: { Cookie: cookie } }, testEnv);
		// Output comes in bounded pages.
		const first = (await (await page()).json()) as { output: { text: string }[]; next: unknown };
		expect(first.output.map((chunk) => chunk.text)).toEqual(["secret transcript", "b", "c", "d"]);
		expect(first.next).toEqual({ attempt: 1, seq: 3 });
		expect(await (await page("?after=1.3")).json()).toEqual({
			output: [expect.objectContaining({ seq: 4, text: "e" })],
			next: null,
			truncated: [],
		});
		expect((await page("?after=x")).status).toBe(409);
		// Signed-out visitors and other signed-in users never see raw output.
		expect((await app.request(`${base}/${id}/output`, {}, testEnv)).status).toBe(403);
		const stranger = (await oauth(identity("github"))).session!;
		vi.spyOn(globalThis, "fetch").mockImplementation(mock);
		const refused = await app.request(`${base}/${id}/output`, { headers: { Cookie: stranger } }, testEnv);
		expect(refused.status).toBe(403);
		expect(await refused.json()).toEqual({ error: "Current GitHub maintainer authority required" });
		// A maintainer whose role was revoked is refused on the next request.
		github.role = "write";
		expect((await page()).status).toBe(403);
		const a = { answers: [{ choices: ["A"] }] };
		expect((await post(`/${id}/answer`, { question, answer: a })).status).toBe(403);
		github.role = "maintain";
		// An answer must fit the prompt it answers.
		expect((await post(`/${id}/answer`, { question, answer: "A" })).status).toBe(409);
		expect((await post(`/${id}/answer`, { question, answer: { answers: [{ choices: ["Z"] }] } })).status).toBe(409);
		expect((await post(`/${id}/answer`, { question, answer: a })).status).toBe(204);
		expect((await post(`/${id}/answer`, { question, answer: a })).status).toBe(409);
		expect((await post(`/${id}/cancel`, {})).status).toBe(204);
		expect(await state(id)).toMatchObject({ state: "cancelled" });
		expect((await post(`/missing/cancel`, {})).status).toBe(409);
	});

	it("registers runners for the signed-in user only", async () => {
		const register = (headers: Record<string, string>, body: unknown = { name: "laptop", platform: "darwin" }) =>
			app.request(
				`${origin}/api/runners`,
				{
					method: "POST",
					headers: { ...headers, "Content-Type": "application/json" },
					body: JSON.stringify(body),
				},
				testEnv,
			);
		expect((await register({ Origin: origin })).status).toBe(403);
		expect((await register({ Cookie: cookie, Origin: "https://evil.example" })).status).toBe(403);
		expect((await register({ Cookie: cookie, Origin: origin }, { name: "x", platform: "windows" })).status).toBe(
			409,
		);
		const created = await register({ Cookie: cookie, Origin: origin });
		expect(created.status).toBe(201);
		const { token } = (await created.json()) as { token: string };
		expect(await store.authenticate(db, token)).toMatchObject({
			owner: maintainer,
			name: "laptop",
			platform: "darwin",
		});
		const listed = await app.request(`${origin}/api/runners`, { headers: { Cookie: cookie } }, testEnv);
		expect(JSON.stringify(await listed.json())).not.toContain(token);
	});
});

describe("merge wait webhook wakeups", () => {
	it("wakes only the current merge attempt for the enrolled repository and matching head or PR", async () => {
		// GitHub cannot verify the head here, so the merge job routes as untrusted to a VM runner.
		const real = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
			new URL(input instanceof Request ? input.url : input).hostname === "api.github.com"
				? new Response(null, { status: 503 })
				: real(input, init),
		);
		const machine = await runner("owner", "webhooks", "linux", true);
		await connected(machine, [account("main")]);
		const id = await job(10, "owner", { workflow: "merge", target: "pulls/2", branch: "feature", revision: head });
		await store.held(db, id, "merge-token");
		const socket = await connect(machine.token);
		socket.send(status(1, "main"));
		expect(await socket.next()).toMatchObject({ type: "reply", id: 1 });
		expect(await socket.next()).toMatchObject({ type: "assign", job: { id, attempt: 1 } });
		socket.send(status(2, "main", [{ job: id, attempt: 1 }], 0));
		await socket.next();
		// Other repositories, installations, PRs and check heads cannot wake this job.
		await wake(env, 99, 5, "pull_request_review", { pull_request: { number: 2 } });
		await wake(env, 10, 99, "pull_request_review", { pull_request: { number: 2 } });
		await wake(env, 10, 5, "pull_request_review", { pull_request: { number: 3 } });
		await wake(env, 10, 5, "check_run", { check_run: { head_sha: commit, pull_requests: {} } });
		await delivery("check_run", { installation: { id: 5 }, repository: { id: 10 }, check_run: { head_sha: head } });
		expect(await socket.next()).toEqual({ type: "wake", job: id, attempt: 1 });
		await wake(env, 10, 5, "pull_request_review", { pull_request: { number: 2 } });
		expect(await socket.next()).toEqual({ type: "wake", job: id, attempt: 1 });
		for (const [event, action] of [
			["pull_request_review_thread", "resolved"],
			["pull_request_review_thread", "unresolved"],
			["pull_request_review_comment", "created"],
			["pull_request_review_comment", "edited"],
			["pull_request_review_comment", "deleted"],
		]) {
			expect(
				(
					await delivery(event!, {
						installation: { id: 5 },
						repository: { id: 10 },
						action,
						pull_request: { id: 201, number: 2 },
					})
				).status,
			).toBe(202);
			expect(await socket.next()).toEqual({ type: "wake", job: id, attempt: 1 });
		}
		await db.prepare("UPDATE jobs SET state='waiting' WHERE id=?").bind(id).run();
		await wake(env, 10, 5, "pull_request_review", { pull_request: { number: 2 } });
		socket.send(status(3, "main", [], 0));
		expect(await socket.next()).toMatchObject({ type: "reply", id: 3 });
	});
});
