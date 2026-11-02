import { type Context, Hono } from "hono";
import { questBranch } from "quest/core";
import { createAuth } from "../auth";
import * as push from "../push/notify";
import { GitHubError, GitHubService, refName, type Stopped } from "../github/service";
import { type ProjectState, type Pull, startable } from "../github/state";
import { INBOX_HEADER, RUNNER_HEADER } from "./hub";
import * as landing from "./landing";
import * as output from "./output";
import { formAnswer, parseAnswer, parsePrompt } from "./prompt";
import { data, id, text } from "./protocol";
import { HeadMoved, LIMITS, parsePublication, publish, pullOf, restart, validateContinuation } from "./publish";
import * as store from "./store";
import { JobError } from "./store";

type Bindings = { Bindings: Env };
export const jobs = new Hono<Bindings>();

async function json(c: Context): Promise<Record<string, unknown>> {
	try {
		const body = await c.req.json();
		if (body && typeof body === "object" && !Array.isArray(body)) return body;
	} catch {}
	throw new JobError("JSON object required");
}

/** Whether a request came from an HTML form, such as the decision inbox, rather than the JSON API. */
export function fromForm(c: Context) {
	return /^(application\/x-www-form-urlencoded|multipart\/form-data)\b/.test(c.req.header("Content-Type") ?? "");
}
type Form = Record<string, string | File | (string | File)[]>;
/** A JSON body, or a form's non-empty text fields. */
async function input(c: Context): Promise<{ body: Record<string, unknown>; form: Form | null }> {
	if (!fromForm(c)) return { body: await json(c), form: null };
	const form = await c.req.parseBody({ all: true });
	const body = Object.fromEntries(Object.entries(form).filter(([, v]) => typeof v === "string" && v !== ""));
	return { body, form };
}
/** Answer the JSON API, or move a form on to the next decision. */
function reply(c: Context, form: Form | null, done: Done, body: unknown, status: 200 | 201 = 200) {
	if (form) return c.redirect(nextURL(done), 303);
	return body === null ? c.body(null, 204) : c.json(body, status);
}
export function inboxURL(repository: number, target: string) {
	return `/inbox?${new URLSearchParams({ project: String(repository), item: target })}`;
}
/** What an inbox form just recorded, which the next decision's page notes. */
export type Done = "answer" | "approve" | "start" | "stop" | "skip" | "merge";
/**
 * The inbox's next active decision, or its empty state, after a form recorded
 * one. The item acted on stays reachable from its list, with its earlier answers.
 */
export function nextURL(done: Done) {
	return `/inbox?${new URLSearchParams({ done })}`;
}

/** The default branch has no flake for the job's devShell; a bootstrap job can add one. */
export class BootstrapRequired extends JobError {
	constructor() {
		super("A flake devShell is required; start a bootstrap job to add one");
	}
}

/** The owner's hub, which holds their runners' connections and routes their jobs. */
export function hub(env: Env, owner: string) {
	return env.RUNNERS.get(env.RUNNERS.idFromName(owner));
}

/** Dispatch for everyone with queued work on a project that resumed, since no runner event may follow. */
export async function resume(env: Env, repository: number) {
	const { results } = await env.DB.prepare("SELECT DISTINCT actor FROM jobs WHERE repository=? AND state='queued'")
		.bind(repository)
		.all<{ actor: string }>();
	await Promise.all(results.map(({ actor }) => hub(env, actor).dispatch(actor)));
}

/** Stop the running attempts of a disconnected project, whose job records are already gone. */
export async function stop(env: Env, attempts: Stopped[]) {
	const actors = new Map<string, Stopped[]>();
	for (const a of attempts) actors.set(a.actor, [...(actors.get(a.actor) ?? []), a]);
	await Promise.all([...actors].map(([actor, list]) => hub(env, actor).stop(list)));
}

// A runner authenticates with the token its owner registered it with, then
// holds one live connection to its owner's hub. Runner requests carry no
// cookies, so they need no origin check.
async function machine(c: Context<Bindings>) {
	const token = c.req.header("Authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
	return (token && (await store.authenticate(c.env.DB, token))) || null;
}
// The machine a token registered, which `quest runner login` polls until the owner approves it.
jobs.get("/api/runner", async (c) => {
	c.header("Cache-Control", "no-store");
	const runner = await machine(c);
	if (!runner) return c.json({ error: "Runner token required" }, 401);
	const { id, name, platform, vm } = runner;
	return c.json({ id, name, platform, vm: vm === 1 });
});
jobs.get("/api/runner/connect", async (c) => {
	const runner = await machine(c);
	if (!runner) return c.json({ error: "Runner token required" }, 401);
	if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "WebSocket required" }, 426);
	const headers = new Headers(c.req.raw.headers);
	headers.delete("Authorization");
	headers.delete(INBOX_HEADER);
	headers.set(RUNNER_HEADER, JSON.stringify(runner));
	const upgraded = await hub(c.env, runner.owner).fetch(new Request(c.req.raw, { headers }));
	// Rewrap so shared middleware can still set headers on the upgrade.
	return new Response(null, {
		status: upgraded.status,
		webSocket: upgraded.webSocket,
		headers: new Headers(upgraded.headers),
	});
});

// A running attempt publishes its work over HTTPS rather than its connection,
// so slow GitHub writes never hold up the hub's other runner messages.
jobs.post("/api/runner/publish", async (c) => {
	const runner = await machine(c);
	if (!runner) return c.json({ error: "Runner token required" }, 401);
	const length = Number(c.req.header("Content-Length"));
	if (!Number.isSafeInteger(length) || length > LIMITS.request)
		return c.json({ error: `A Content-Length of at most ${LIMITS.request} bytes is required` }, 413);
	const input = parsePublication(await json(c));
	let result: Awaited<ReturnType<typeof publish>>;
	try {
		result = await publish(c.env, runner, input);
	} catch (error) {
		// The runner reconciles with the branch's head rather than failing its attempt.
		if (error instanceof HeadMoved) return c.json({ error: error.message, head: error.head }, 409);
		throw error;
	}
	if (!("decision" in result)) return c.json(result);
	await hub(c.env, runner.owner).dispatch(runner.owner);
	if (result.asked && !result.cancel) c.executionCtx.waitUntil(push.job(c.env, input.job, "publication"));
	const { decision, cancel } = result;
	return c.json({ decision, cancel }, 202);
});

// The current attempt of a job on an issue or pull request reads its target
// as the App, with the requester's current authority: runners hold no GitHub
// credentials, and the job record keeps only the target's number. A new
// plan's attempt reads the request it started from.
jobs.get("/api/runner/context", async (c) => {
	const runner = await machine(c);
	if (!runner) return c.json({ error: "Runner token required" }, 401);
	const job = id(c.req.query("job"));
	const attempt = Number(c.req.query("attempt"));
	if (!job || !Number.isSafeInteger(attempt) || attempt < 1) throw new JobError("Job and attempt required");
	const current = await store.publishing(c.env.DB, runner, job, attempt);
	c.header("Cache-Control", "no-store");
	// A new plan's request is kix's own record: the maintainer's idea and what they pasted.
	if (PLAN.test(current.target)) return c.json({ kind: "plan", idea: current.idea, context: current.context });
	return c.json(
		await new GitHubService(c.env).readTarget(
			{ owner: current.owner, name: current.name, id: current.repository },
			current.actor,
			current.target,
		),
	);
});

// A signed-in user registers their own machines and sees their presence.
async function signedIn(c: Context<Bindings>) {
	const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
	if (!session) throw new GitHubError("Sign in required");
	return session.user.id;
}
jobs.use("/api/runners", async (c, next) => {
	if (c.req.method === "POST" && c.req.header("Origin") !== new URL(c.env.AUTH_URL).origin)
		return c.json({ error: "Invalid origin" }, 403);
	await next();
});
jobs.get("/api/runners", async (c) => {
	c.header("Cache-Control", "no-store");
	const owner = await signedIn(c);
	const online = new Set(await hub(c.env, owner).online());
	return c.json({ runners: await store.listRunners(c.env.DB, owner, online) });
});
jobs.post("/api/runners", async (c) => {
	const owner = await signedIn(c);
	const body = await json(c);
	const name = text(body.name, 100);
	if (
		!name ||
		(body.platform !== "linux" && body.platform !== "darwin") ||
		(body.vm !== undefined && typeof body.vm !== "boolean")
	)
		throw new JobError("Name and platform required");
	c.header("Cache-Control", "no-store");
	return c.json(await store.createRunner(c.env.DB, owner, name, body.platform, body.vm === true, Date.now()), 201);
});

// Every maintainer action rechecks current GitHub authority, not just the page load.
async function maintained(c: Context<Bindings>) {
	const user = await signedIn(c);
	const github = new GitHubService(c.env);
	const repo = await github.enrolledProject(c.req.param("owner")!, c.req.param("repository")!, user);
	if (!repo) throw new GitHubError("Project is not enrolled");
	return { user, repo, github };
}
async function owned(c: Context<Bindings>) {
	const { user, repo } = await maintained(c);
	const job = await store.readJob(c.env.DB, c.req.param("job")!);
	if (!job || job.repository !== repo.id) throw new JobError("Job not found");
	return { user, repo, job };
}

const base = "/projects/github/:owner/:repository/jobs";
jobs.get(base, async (c) => {
	const { repo } = await maintained(c);
	c.header("Cache-Control", "no-store");
	return c.json({ jobs: await store.listJobs(c.env.DB, repo.id) });
});

type Plan = Omit<store.NewJob, "repository" | "actor" | "pinRunner" | "pinAccount">;

/** A new interview's target, `plans/<id>`. */
const PLAN = /^plans\/([0-9a-f-]{36})$/;

/** The longest idea and pasted context a new plan takes, in characters as the inbox form counts them. */
export const PLAN_LIMITS = { idea: 4000, context: 64_000 };

/** What a new interview starts from: the maintainer's idea and optional pasted context. */
type PlanRequest = { idea: string; context: string | null };

/** Optional text, with a form's CRLF line breaks counted as one character, limited by length. */
function words(value: unknown, max: number, name: string): string | null {
	if (value === undefined) return null;
	if (typeof value !== "string") throw new JobError(`Invalid ${name}`);
	const text = value.replaceAll("\r\n", "\n").trim();
	if (text.length > max) throw new JobError(`Keep the ${name} to at most ${max} characters`);
	return text || null;
}

/**
 * What a new planning interview starts from. A new plan takes the
 * maintainer's idea and optional pasted context, which the agent reads as
 * untrusted. Planning a finished job's follow-ups takes them from that job's
 * result, never from the request. A retry keeps its failed job's request,
 * and planning an issue needs none.
 */
async function planRequest(
	db: D1Database,
	repository: number,
	body: Record<string, unknown>,
	failed: store.Published | null,
): Promise<PlanRequest | null> {
	const idea = words(body.idea, PLAN_LIMITS.idea, "idea");
	const context = words(body.context, PLAN_LIMITS.context, "context");
	if (body.target === undefined) return idea ? { idea, context } : null;
	if (idea || context) throw new JobError("Only a new plan takes an idea");
	const plan = typeof body.target === "string" ? body.target.match(PLAN)?.[1] : undefined;
	if (!plan || failed) return null;
	const request = await store.followupRequest(db, repository, plan);
	if (!request) throw new JobError("Nothing is left to plan here");
	return request;
}

/**
 * Resolve a requested workflow and target against current observations.
 * `failed` is the target's failed latest job, whose pull request a retry
 * continues rather than counting it as another claim.
 */
function resolve(
	workflow: unknown,
	target: unknown,
	state: ProjectState,
	failed: store.Published | null,
	request: PlanRequest | null,
): Plan {
	const commit = state.project.commit;
	const open = (kind: "issue" | "pull", prefix: string) =>
		state.activity.find(
			(item) =>
				item.kind === kind &&
				`${prefix}/${item.number}` === target &&
				!item.missing &&
				item.data?.state === "OPEN",
		);
	if (workflow === "start") {
		if (typeof target !== "string" || !startable(state, target, failed))
			throw new JobError("Only ready, unclaimed quests on the default branch can start");
		const branch = questBranch(target);
		if (!refName(branch)) throw new JobError("Rename the quest so its path can be a branch name");
		return { workflow, target, revision: commit, branch, trusted: true };
	}
	if (workflow === "plan") {
		// A new interview gets its own target. Retrying a failed one keeps it and
		// its request; planning a finished job's follow-ups targets that job's ID.
		const plan = typeof target === "string" ? target.match(PLAN)?.[1] : undefined;
		if (target === undefined || plan) {
			if (!request && !failed) throw new JobError("Describe what to plan");
			const id = plan ?? crypto.randomUUID();
			return {
				workflow,
				target: `plans/${id}`,
				revision: commit,
				branch: `plan/${id.slice(0, 8)}`,
				trusted: true,
				...request,
			};
		}
		const issue = open("issue", "issues");
		if (!issue) throw new JobError("Plan an open issue or start a new plan");
		const n = issue.number;
		return { workflow, target: `issues/${n}`, revision: commit, branch: `plan/issue-${n}`, trusted: true };
	}
	if (workflow === "iterate" || workflow === "merge") {
		const pull = open("pull", "pulls");
		if (!pull)
			throw new JobError(workflow === "merge" ? "Merge an open pull request" : "Iterate on an open pull request");
		const data = pull.data as Pull;
		if (workflow === "merge" && data.isDraft)
			throw new JobError("Mark the draft ready for review before merging it");
		// jobSource verifies every commit's provenance before creating this job.
		return {
			workflow,
			target: `pulls/${pull.number}`,
			revision: data.headRefOid,
			branch: data.headRefName,
			trusted: false,
		};
	}
	if (workflow === "bootstrap")
		return { workflow, target: "devshell", revision: commit, branch: "kix/devshell", trusted: true };
	throw new JobError("Unknown workflow");
}

/**
 * Authorize one workflow on one target. Planning, implementation, and
 * iteration are separate requests; arriving issues and PRs only observe.
 */
jobs.post(base, async (c) => {
	const { user, repo, github } = await maintained(c);
	const { body, form } = await input(c);
	// A form names a runner's account as one `pin` choice, `runner:account`.
	const [runner, account] = typeof body.pin === "string" ? body.pin.split(":") : [body.runner, body.account];
	const pinRunner = runner === undefined ? null : id(runner);
	const pinAccount = account === undefined ? null : id(account);
	if ((runner !== undefined && !pinRunner) || (account !== undefined && !pinAccount))
		throw new JobError("Invalid runner or account");
	const failed =
		(body.workflow === "start" || body.workflow === "plan") && typeof body.target === "string"
			? await store.failed(c.env.DB, repo.id, body.target)
			: null;
	const request = body.workflow === "plan" ? await planRequest(c.env.DB, repo.id, body, failed) : null;
	const { job, enabled, flake } = await github.jobSource(repo, user, (state) =>
		resolve(body.workflow, body.target, state, failed, request),
	);
	// A decision binds the revision the maintainer saw, such as a pull request's head.
	if (body.revision !== undefined && body.revision !== job.revision)
		throw new JobError("This changed on GitHub since you looked; review it again");
	if (!enabled) throw new JobError("Contributions are paused");
	if (job.workflow === "bootstrap") {
		if (flake) throw new JobError("The default branch already has a flake");
	} else if (!flake) {
		if (store.onPull(job.workflow)) throw new JobError("The pull request's head has no flake devShell");
		throw new BootstrapRequired();
	}
	const created = await store.createJob(
		c.env.DB,
		{ ...job, repository: repo.id, actor: user, pinRunner, pinAccount },
		Date.now(),
	);
	// A new merge job holds its pull request before it runs, as a local `quest iterate` would.
	if (created.created && job.workflow === "merge") {
		const pull = pullOf(job.target);
		let token: string;
		let recorded: boolean;
		try {
			token = await github.holdPullRequest(repo, user, pull);
			recorded = await store.held(c.env.DB, created.id, token);
		} catch (error) {
			await store.cancel(c.env.DB, created.id, user, Date.now());
			await hub(c.env, user).dispatch(user);
			throw error;
		}
		// A stop that came first found no hold to release, so the label goes back now.
		if (!recorded && (await github.releasePullRequest(repo, pull, token)))
			await store.released(c.env.DB, created.id, token);
	}
	await hub(c.env, user).dispatch(user);
	return reply(c, form, "start", created, created.created ? 201 : 200);
});

jobs.post(`${base}/:job/answer`, async (c) => {
	const { user, repo, job } = await owned(c);
	const { body, form } = await input(c);
	const question = job.questions.find((q) => q.id === id(body.question));
	// A form's Start over button, or `restart: true` from the JSON API.
	if (question && body.restart !== undefined) {
		if (body.restart !== (form ? "1" : true)) throw new JobError("Invalid restart");
		const created = await restart(c.env, user, repo, job, question.id);
		await hub(c.env, job.actor).dispatch(job.actor);
		return reply(c, form, "start", { id: created }, 201);
	}
	let continuation: store.Continuation | null = null;
	if (question && body.continue !== undefined) {
		if (body.continue !== (form ? "1" : true)) throw new JobError("Invalid continuation");
		continuation = store.continuationOf(question.prompt, { continue: body.head });
		if (!continuation) throw new JobError("Choose the offered head");
		await validateContinuation(c.env, user, repo, job, question, continuation);
	}
	const answer = continuation
		? { continue: continuation.head }
		: question && (form ? formReply(question, form) : body.answer);
	if (!question || answer === undefined) throw new JobError("Question and answer required");
	const { resumed } = await store.answer(
		c.env.DB,
		job.id,
		question.id,
		user,
		// An agent's answer must fit its prompt; the store checks an account choice against the owner's accounts.
		question.kind === "agent"
			? parseAnswer(parsePrompt(question.prompt), answer)
			: question.kind === "publication"
				? continuation
					? answer
					: publicationReply(answer)
				: data(answer, 1024),
		Date.now(),
	);
	// Jobs run on their requester's runners, whoever answers; an answer awaiting approval still refreshes open inboxes.
	await hub(c.env, job.actor).dispatch(job.actor);
	if (!resumed) c.executionCtx.waitUntil(push.job(c.env, job.id, "approval"));
	return reply(c, form, "answer", null);
});

// Until the job sandbox ships, another maintainer's answer resumes the job
// only once its requester, whose runner acts on it, approves it.
jobs.post(`${base}/:job/approve`, async (c) => {
	const { user, repo, job } = await owned(c);
	const { body, form } = await input(c);
	const question = id(body.question);
	if (!question) throw new JobError("Question required");
	const pending = job.questions.find((item) => item.id === question);
	const continuation = pending?.kind === "publication" ? store.continuationOf(pending.prompt, pending.answer) : null;
	if (continuation) await validateContinuation(c.env, user, repo, job, pending!, continuation);
	await store.approve(c.env.DB, job.id, question, user, Date.now());
	await hub(c.env, job.actor).dispatch(job.actor);
	return reply(c, form, "approve", null);
});

/** The longest reply to a publication decision, in characters as the inbox form counts them. */
export const PUBLICATION_REPLY = 1000;

/**
 * A publication decision's answer is the maintainer's own words, limited by
 * length rather than encoding. Forms submit line breaks as CRLF but count them
 * as one character, so they are normalized first.
 */
function publicationReply(answer: unknown) {
	if (typeof answer !== "string" || !answer.trim()) throw new JobError("Reply in your own words");
	const text = answer.replaceAll("\r\n", "\n");
	if (text.length > PUBLICATION_REPLY) throw new JobError(`Reply in at most ${PUBLICATION_REPLY} characters`);
	return text;
}

/** An inbox form's answer: the chosen options, a publication reply's text, or the chosen `runner:account`. */
function formReply(question: store.Question, form: Form) {
	if (question.kind === "agent") return formAnswer(parsePrompt(question.prompt), form);
	if (question.kind === "publication") return typeof form.text === "string" ? form.text : undefined;
	const [runner, account] = typeof form.account === "string" ? form.account.split(":") : [];
	return runner && account ? { runner, account } : undefined;
}

jobs.post(`${base}/:job/cancel`, async (c) => {
	const { user, job } = await owned(c);
	await store.cancel(c.env.DB, job.id, user, Date.now());
	await hub(c.env, job.actor).dispatch(job.actor);
	// A running attempt reports its cancellation later, which releases its hold then.
	await landing.ended(c.env, job.id);
	return reply(c, fromForm(c) ? {} : null, "stop", null);
});

// Raw output stays behind a per-request maintainer check; summaries are the default view.
jobs.get(`${base}/:job/output`, async (c) => {
	const { job } = await owned(c);
	// `after=<attempt>.<seq>` continues from a previous page's `next`.
	const after = c.req.query("after");
	const cursor = after?.match(/^(\d{1,15})\.(\d{1,15})$/);
	if (after !== undefined && !cursor) throw new JobError("Invalid output cursor");
	c.header("Cache-Control", "no-store");
	return c.json(
		await output.read(c.env, job.id, cursor ? { attempt: Number(cursor[1]), seq: Number(cursor[2]) } : null),
	);
});
