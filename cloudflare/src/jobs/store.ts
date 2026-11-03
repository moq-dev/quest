// Durable job coordination: one authorized attempt owns a job at a time.
//
// D1 is the record. Each owner's RunnerHub Durable Object holds their
// runners' live connections and drives these functions; every runner write
// names its (job, attempt) and only lands while that attempt is current. An
// assignment increments the attempt, so a runner that went offline and
// returns after its job was reassigned is fenced out.

/** A disconnected runner's running jobs move to another runner after this long. */
export const GRACE = 2 * 60_000;

export type Workflow = "plan" | "start" | "iterate" | "merge" | "bootstrap";

/** Whether a workflow works on an open pull request's own head branch, rather than opening one. */
export function onPull(workflow: Workflow) {
	return workflow === "iterate" || workflow === "merge";
}
export type JobState = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";
export type Outcome = "completed" | "failed" | "cancelled" | "limited";
export type Platform = "linux" | "darwin";

export class JobError extends Error {}

export type Runner = { id: string; owner: string; name: string; platform: Platform; vm: number };
export type AccountReport = {
	id: string;
	provider: string;
	kind: "subscription" | "api-key";
	label: string;
	limited: boolean;
};
export type Attempt = { job: string; attempt: number };
export type Job = {
	id: string;
	repository: number;
	workflow: Workflow;
	target: string;
	revision: string;
	branch: string;
	actor: string;
	trusted: number;
	pinRunner: string | null;
	pinAccount: string | null;
	state: JobState;
	attempt: number;
	runner: string | null;
	account: string | null;
	session: string | null;
	/** While its runner is disconnected, when the running attempt moves. */
	lease: number | null;
	cancel: number;
	summary: string | null;
	result: string | null;
	/** The commit the job's branch holds; null until its first publication. */
	head: string | null;
	/** A commit whose branch update may be in flight, and since when. */
	pending: string | null;
	pendingAt: number | null;
	/** The pull request this job delivered. */
	pull: number | null;
	/** The failed job this retry continues. */
	continues: string | null;
	/** A merge job's `quest:kix` label: the timeline event that added it, until kix releases it. */
	hold: string | null;
	/** A new plan's request: the maintainer's idea, and pasted context the agent reads as untrusted. */
	idea: string | null;
	context: string | null;
	createdAt: number;
	updatedAt: number;
};
export type QuestionKind = "agent" | "account" | "publication";
export type Question = {
	id: string;
	attempt: number;
	kind: QuestionKind;
	prompt: unknown;
	answer: unknown;
	answeredBy: string | null;
	askedAt: number;
	answeredAt: number | null;
	/** When the job's requester approved the answer; their own answers are approved as given. */
	approvedAt: number | null;
};
export type Event = { attempt: number; kind: string; body: unknown; at: number };
/** A connected runner's account, as routing sees it. */
export type Offer = {
	runner: string;
	account: string;
	platform: Platform;
	vm: number;
	/** Whether the runner has a free job slot. */
	free: boolean;
	limited: boolean;
};

/** A runner token's stored form: its SHA-256 in lowercase hex. */
export async function digest(token: string) {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Register a machine for `owner`. The token is shown once; only its hash is kept. */
export async function createRunner(
	db: D1Database,
	owner: string,
	name: string,
	platform: Platform,
	vm: boolean,
	now: number,
) {
	const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
	const id = await registerRunner(db, owner, name, platform, vm, await digest(token), now);
	return { id, token };
}

/**
 * Register a machine that made its own token and sent only its hash, as
 * `quest runner login` does, so the token never leaves the machine. Approving
 * the same hash again returns the same runner; another owner's is refused.
 */
export async function registerRunner(
	db: D1Database,
	owner: string,
	name: string,
	platform: Platform,
	vm: boolean,
	tokenHash: string,
	now: number,
) {
	const [, row] = await db.batch([
		db
			.prepare(
				"INSERT INTO runners(id,owner,name,tokenHash,platform,vm,createdAt) VALUES(?,?,?,?,?,?,?) ON CONFLICT(tokenHash) DO NOTHING",
			)
			.bind(crypto.randomUUID(), owner, name, tokenHash, platform, vm ? 1 : 0, now),
		db.prepare("SELECT id,owner FROM runners WHERE tokenHash=?").bind(tokenHash),
	]);
	const runner = row!.results[0] as { id: string; owner: string };
	if (runner.owner !== owner) throw new JobError("This runner is already connected to another account");
	return runner.id;
}

/**
 * Move one of the owner's accounts a place earlier or later in their
 * preference order, which routing follows across all of their runners.
 */
export async function moveAccount(
	db: D1Database,
	owner: string,
	runner: string,
	account: string,
	direction: "up" | "down",
) {
	const { results } = await db
		.prepare(
			"SELECT a.runner,a.id FROM runner_accounts a JOIN runners r ON r.id=a.runner WHERE r.owner=? ORDER BY a.rank,a.runner,a.id",
		)
		.bind(owner)
		.all<{ runner: string; id: string }>();
	const from = results.findIndex((a) => a.runner === runner && a.id === account);
	if (from < 0) throw new JobError("Account not found");
	const to = direction === "up" ? from - 1 : from + 1;
	if (to < 0 || to >= results.length) return;
	[results[from], results[to]] = [results[to]!, results[from]!];
	// Ranks are renumbered in the new order, so ties from concurrent reports cannot hide the move.
	await db.batch(
		results.map((a, i) =>
			db.prepare("UPDATE runner_accounts SET rank=? WHERE runner=? AND id=?").bind(i + 1, a.runner, a.id),
		),
	);
}

export async function authenticate(db: D1Database, token: string): Promise<Runner | null> {
	return db
		.prepare("SELECT id,owner,name,platform,vm FROM runners WHERE tokenHash=?")
		.bind(await digest(token))
		.first<Runner>();
}

/** The owner's runners and accounts; `online` is the hub's live connections. */
export async function listRunners(db: D1Database, owner: string, online: Set<string>) {
	const [runners, accounts] = await db.batch([
		db.prepare("SELECT id,name,platform,vm,seenAt FROM runners WHERE owner=? ORDER BY createdAt,id").bind(owner),
		db
			.prepare(
				"SELECT a.runner,a.id,a.provider,a.kind,a.label,a.rank,a.limited FROM runner_accounts a JOIN runners r ON r.id=a.runner WHERE r.owner=? ORDER BY a.rank,a.runner,a.id",
			)
			.bind(owner),
	]);
	type Row = { id: string; name: string; platform: Platform; vm: number; seenAt: number | null };
	type Account = {
		runner: string;
		id: string;
		provider: string;
		kind: string;
		label: string;
		rank: number;
		limited: number;
	};
	return (runners!.results as Row[]).map((runner) => ({
		...runner,
		online: online.has(runner.id),
		accounts: (accounts!.results as Account[]).filter((account) => account.runner === runner.id),
	}));
}

/** What a statement that may end jobs returns, for `ended`. */
const ending = "id,workflow,state,hold";

/** The merge jobs a statement `RETURNING ${ending}` ended while they still held their pull request. */
function ended(result: D1Result): string[] {
	return (result.results as Pick<Job, "id" | "workflow" | "state" | "hold">[])
		.filter((job) => job.workflow === "merge" && job.hold !== null && job.state === "cancelled")
		.map((job) => job.id);
}

const fence = "EXISTS(SELECT 1 FROM jobs WHERE id=? AND attempt=? AND runner=? AND state='running')";

/**
 * A connected runner's status: its current accounts and the attempts it is
 * running. Listing an attempt acknowledges its assignment. Says which
 * reported attempts to continue, cancel, or stop because they are no longer
 * this runner's. An acknowledged attempt the status omits was lost, so it
 * moves now; an unacknowledged one may still be on its way. Also returns
 * the merge jobs this cancelled that still hold their pull request.
 */
export async function report(
	db: D1Database,
	runner: Runner,
	accounts: AccountReport[],
	attempts: Attempt[],
	now: number,
) {
	const reported = JSON.stringify(accounts);
	const running = JSON.stringify(attempts);
	const listed =
		"(id,attempt) IN (SELECT json_extract(value,'$.job'),json_extract(value,'$.attempt') FROM json_each(?))";
	const results = await db.batch([
		db.prepare("UPDATE runners SET seenAt=? WHERE id=?").bind(now, runner.id),
		db
			.prepare(
				"DELETE FROM runner_accounts WHERE runner=? AND id NOT IN (SELECT json_extract(value,'$.id') FROM json_each(?))",
			)
			.bind(runner.id, reported),
		// New accounts join the end of the owner's preference order, in reported order.
		db
			.prepare(
				`INSERT INTO runner_accounts(runner,id,provider,kind,label,limited,rank)
 SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.provider'),json_extract(value,'$.kind'),json_extract(value,'$.label'),json_extract(value,'$.limited'),
  (SELECT COALESCE(MAX(a.rank),0) FROM runner_accounts a JOIN runners r ON r.id=a.runner WHERE r.owner=?)+key+1
 FROM json_each(?) WHERE true
 ON CONFLICT(runner,id) DO UPDATE SET provider=excluded.provider,kind=excluded.kind,label=excluded.label,limited=excluded.limited`,
			)
			.bind(runner.id, runner.owner, reported),
		db
			.prepare(
				`UPDATE jobs SET state=CASE WHEN cancel=1 THEN 'cancelled' ELSE 'queued' END,lease=NULL,updatedAt=? WHERE runner=? AND state='running' AND delivered=1 AND NOT ${listed} RETURNING ${ending}`,
			)
			.bind(now, runner.id, running),
		db
			.prepare(`UPDATE jobs SET delivered=1 WHERE runner=? AND state='running' AND delivered=0 AND ${listed}`)
			.bind(runner.id, running),
		db
			.prepare(
				"SELECT id,attempt,runner,state,cancel FROM jobs WHERE id IN (SELECT json_extract(value,'$.job') FROM json_each(?))",
			)
			.bind(running),
	]);
	const rows = results.at(-1)!.results as Pick<Job, "id" | "attempt" | "runner" | "state" | "cancel">[];
	return {
		attempts: attempts.map(({ job, attempt }) => {
			const row = rows.find((r) => r.id === job);
			const owned = row && row.attempt === attempt && row.runner === runner.id && row.state === "running";
			return { job, attempt, action: !owned ? "stop" : row.cancel ? "cancel" : "continue" } as const;
		}),
		ended: ended(results[3]!),
	};
}

/**
 * Pick where a job runs: its pins, trust, and paused session narrow the
 * offers, which arrive in the owner's account preference order. Returns null
 * while the right runner is busy or offline.
 */
export function route(job: Job, offers: Offer[]): Offer | null {
	const eligible = offers.filter(
		(offer) =>
			(!job.pinRunner || offer.runner === job.pinRunner) &&
			(!job.pinAccount || offer.account === job.pinAccount) &&
			(job.trusted || (offer.platform === "linux" && offer.vm)),
	);
	// Resume a paused session where it lives while that runner is online;
	// another runner would start an unrelated agent instead.
	if (job.session) {
		const home = eligible.find((offer) => offer.runner === job.runner && offer.account === job.account);
		if (home) return home.free && !home.limited ? home : null;
	}
	return eligible.find((offer) => offer.free && !offer.limited) ?? null;
}

/** Whether a queued PR job's current head is still trusted. */
export type Verify = (job: Pick<Job, "repository" | "target" | "revision" | "head" | "trusted">) => Promise<boolean>;

export type Claimed = NonNullable<Awaited<ReturnType<typeof readJob>>> & { owner: string; name: string };

/**
 * Reconcile an owner's jobs with their connected runners and free slots.
 * A running job has a lease exactly while its runner is disconnected; an
 * expired lease moves the job. Then queued work is assigned. Returns what to
 * send each runner, the merge jobs it cancelled that still hold their pull
 * request, and when to run again. Every assignment its runner has
 * not acknowledged is sent again, since a delivery can be lost after the
 * claim commits. Until acknowledged, an assignment holds one of the runner's
 * reported free slots, which it could not count yet.
 */
export async function dispatch(
	db: D1Database,
	owner: string,
	slots: Map<string, number>,
	now: number,
	verify: Verify = async () => false,
) {
	const connected = JSON.stringify([...slots.keys()]);
	const [, , cancelled, , candidates, offers, cancels, pending] = await db.batch([
		db
			.prepare(
				"UPDATE jobs SET lease=NULL WHERE actor=? AND state='running' AND lease IS NOT NULL AND runner IN (SELECT value FROM json_each(?))",
			)
			.bind(owner, connected),
		db
			.prepare(
				"UPDATE jobs SET lease=? WHERE actor=? AND state='running' AND lease IS NULL AND runner NOT IN (SELECT value FROM json_each(?))",
			)
			.bind(now + GRACE, owner, connected),
		// An abandoned attempt that was asked to cancel stops rather than moving.
		db
			.prepare(
				`UPDATE jobs SET state='cancelled',lease=NULL,updatedAt=? WHERE actor=? AND state='running' AND cancel=1 AND lease<=? RETURNING ${ending}`,
			)
			.bind(now, owner, now),
		db
			.prepare(
				"UPDATE jobs SET state='queued',lease=NULL,updatedAt=? WHERE actor=? AND state='running' AND lease<=?",
			)
			.bind(now, owner, now),
		// A paused project starts and continues nothing new, and a merge job starts once it holds its pull request.
		db
			.prepare(
				`SELECT j.* FROM jobs j JOIN github_projects p ON p.id=j.repository
 WHERE j.actor=? AND p.state='enabled' AND j.cancel=0 AND j.state='queued' AND (j.workflow<>'merge' OR j.hold IS NOT NULL)
 ORDER BY j.createdAt,j.id`,
			)
			.bind(owner),
		db
			.prepare(
				`SELECT a.runner,a.id AS account,r.platform,r.vm,a.limited FROM runner_accounts a JOIN runners r ON r.id=a.runner
 WHERE r.owner=? AND r.id IN (SELECT value FROM json_each(?)) ORDER BY a.rank,a.runner,a.id`,
			)
			.bind(owner, connected),
		db
			.prepare(
				"SELECT id AS job,attempt,runner FROM jobs WHERE actor=? AND state='running' AND cancel=1 AND runner IN (SELECT value FROM json_each(?))",
			)
			.bind(owner, connected),
		db
			.prepare(
				"SELECT runner,COUNT(*) AS n FROM jobs WHERE actor=? AND state='running' AND delivered=0 GROUP BY runner",
			)
			.bind(owner),
	]);
	const free = new Map(slots);
	for (const { runner, n } of pending!.results as { runner: string; n: number }[])
		if (free.has(runner)) free.set(runner, free.get(runner)! - n);
	type Row = Omit<Offer, "free" | "limited"> & { limited: number };
	const accounts = offers!.results as Row[];
	// The attempt and head each claim verified. A publication can still move the
	// head after the claim, so the read below checks any other head again.
	const verified = new Map<string, { attempt: number; head: string | null }>();
	const revoked: (Attempt & { runner: string })[] = [];
	// Every queued job is considered, so unroutable older ones cannot starve newer ones.
	for (const job of candidates!.results as Job[]) {
		if (![...free.values()].some((n) => n > 0)) break;
		if (onPull(job.workflow)) {
			job.trusted = (await verify(job)) ? 1 : 0;
			await db
				.prepare("UPDATE jobs SET trusted=? WHERE id=? AND state='queued' AND attempt=? AND head IS ?")
				.bind(job.trusted, job.id, job.attempt, job.head)
				.run();
		}
		const chosen = route(
			job,
			accounts.map((o) => ({ ...o, free: (free.get(o.runner) ?? 0) > 0, limited: !!o.limited })),
		);
		if (!chosen) continue;
		const [update] = await db.batch([
			db
				.prepare(
					`UPDATE jobs SET state='running',attempt=attempt+1,runner=?,account=?,session=CASE WHEN runner=? AND account=? THEN session END,lease=NULL,delivered=0,updatedAt=?
 WHERE id=? AND attempt=? AND head IS ? AND trusted=? AND cancel=0 AND state='queued' AND EXISTS(SELECT 1 FROM github_projects WHERE id=jobs.repository AND state='enabled')`,
				)
				.bind(
					chosen.runner,
					chosen.account,
					chosen.runner,
					chosen.account,
					now,
					job.id,
					job.attempt,
					job.head,
					job.trusted,
				),
			// changes() is the update above, so only the pass that moved the job records it.
			db
				.prepare(
					"INSERT INTO job_events(job,attempt,kind,body,at) SELECT id,attempt,'claimed',json_object('runner',runner,'account',account),? FROM jobs WHERE changes()=1 AND id=? AND attempt=? AND runner=?",
				)
				.bind(now, job.id, job.attempt + 1, chosen.runner),
		]);
		// The job or its project changed underneath this pass; the next one sees it.
		if (update!.meta.changes !== 1) continue;
		if (onPull(job.workflow)) verified.set(job.id, { attempt: job.attempt + 1, head: job.head });
		free.set(chosen.runner, free.get(chosen.runner)! - 1);
	}
	const undelivered = await db
		.prepare(
			`SELECT j.id,j.runner,p.owner,p.name FROM jobs j JOIN github_projects p ON p.id=j.repository
 WHERE j.actor=? AND j.state='running' AND j.delivered=0 AND j.cancel=0 AND j.runner IN (SELECT value FROM json_each(?)) ORDER BY j.createdAt,j.id`,
		)
		.bind(owner, connected)
		.all<{ id: string; runner: string; owner: string; name: string }>();
	const assign: { runner: string; job: Claimed }[] = [];
	for (const { id, runner, ...project } of undelivered.results) {
		const job = await readJob(db, id);
		if (!job || job.state !== "running" || job.cancel) continue;
		const checked = verified.get(job.id);
		if (onPull(job.workflow) && (checked?.attempt !== job.attempt || checked.head !== job.head)) {
			const trusted = (await verify(job)) ? 1 : 0;
			const machine = accounts.find((offer) => offer.runner === runner);
			const eligible = trusted || (machine?.platform === "linux" && machine.vm);
			const update = await db
				.prepare(
					"UPDATE jobs SET trusted=?,state=? WHERE id=? AND attempt=? AND head IS ? AND cancel=0 AND state='running' AND delivered=0",
				)
				.bind(trusted, eligible ? "running" : "queued", job.id, job.attempt, job.head)
				.run();
			if (update.meta.changes !== 1) continue;
			if (!eligible) {
				revoked.push({ runner, job: job.id, attempt: job.attempt });
				continue;
			}
			job.trusted = trusted;
		}
		assign.push({ runner, job: { ...job, ...project } });
	}
	const wake = await db
		.prepare("SELECT MIN(lease) AS at FROM jobs WHERE actor=? AND state='running' AND lease IS NOT NULL")
		.bind(owner)
		.first<{ at: number | null }>();
	return {
		assign,
		cancel: [...(cancels!.results as (Attempt & { runner: string })[]), ...revoked],
		ended: ended(cancelled!),
		wake: revoked.length ? now : (wake?.at ?? null),
	};
}

/** Record a checkpoint summary from the current attempt. */
export async function checkpoint(
	db: D1Database,
	runner: Runner,
	job: string,
	attempt: number,
	summary: string,
	session: string | null,
	now: number,
) {
	const [, update] = await db.batch([
		// A retried checkpoint repeats the job's latest event, which it does not record again.
		db
			.prepare(
				`INSERT INTO job_events(job,attempt,kind,body,at) SELECT ?,?,'summary',json_quote(?),? WHERE ${fence}
 AND NOT EXISTS(SELECT 1 FROM job_events WHERE rowid=(SELECT MAX(rowid) FROM job_events WHERE job=?) AND attempt=? AND kind='summary' AND body=json_quote(?))`,
			)
			.bind(job, attempt, summary, now, job, attempt, runner.id, job, attempt, summary),
		db
			.prepare(
				"UPDATE jobs SET summary=?,session=COALESCE(?,session),updatedAt=? WHERE id=? AND attempt=? AND runner=? AND state='running' RETURNING cancel",
			)
			.bind(summary, session, now, job, attempt, runner.id),
	]);
	const row = update!.results[0] as { cancel: number } | undefined;
	if (!row) throw new JobError("Attempt is no longer current");
	return { cancel: !!row.cancel };
}

/**
 * Pause the current attempt on a question, keeping its session to resume.
 * A job already asked to cancel stops instead.
 */
export async function ask(
	db: D1Database,
	runner: Runner,
	job: string,
	attempt: number,
	input: { kind?: QuestionKind; summary: string; session: string | null; prompt: unknown },
	now: number,
) {
	const id = crypto.randomUUID();
	const [question, , update] = await db.batch([
		db
			.prepare(
				`INSERT INTO job_questions(id,job,attempt,kind,prompt,askedAt) SELECT ?,?,?,?,?,? WHERE ${fence} ON CONFLICT(job,attempt) DO NOTHING`,
			)
			.bind(id, job, attempt, input.kind ?? "agent", JSON.stringify(input.prompt), now, job, attempt, runner.id),
		db
			.prepare(
				`INSERT INTO job_events(job,attempt,kind,body,at) SELECT ?,?,'summary',json_quote(?),? WHERE ${fence}`,
			)
			.bind(job, attempt, input.summary, now, job, attempt, runner.id),
		db
			.prepare(
				"UPDATE jobs SET state=CASE WHEN cancel=1 THEN 'cancelled' ELSE 'waiting' END,summary=?,session=COALESCE(?,session),lease=NULL,updatedAt=? WHERE id=? AND attempt=? AND runner=? AND state='running' AND EXISTS(SELECT 1 FROM job_questions WHERE id=?) RETURNING cancel",
			)
			.bind(input.summary, input.session, now, job, attempt, runner.id, id),
	]);
	if (question!.meta.changes === 1)
		return { question: id, cancel: !!(update!.results[0] as { cancel: number }).cancel, asked: true };
	// An identical retry after the first request landed; anything else is refused.
	const existing = await db
		.prepare(
			"SELECT q.id,j.cancel FROM job_questions q JOIN jobs j ON j.id=q.job WHERE q.job=? AND q.attempt=? AND q.kind=? AND q.prompt=? AND j.summary=? AND j.session IS COALESCE(?,j.session) AND j.attempt=? AND j.runner=?",
		)
		.bind(
			job,
			attempt,
			input.kind ?? "agent",
			JSON.stringify(input.prompt),
			input.summary,
			input.session,
			attempt,
			runner.id,
		)
		.first<{ id: string; cancel: number }>();
	if (!existing) throw new JobError("Attempt is no longer current");
	return { question: existing.id, cancel: !!existing.cancel, asked: false };
}

/**
 * Finish the current attempt. An account limit pauses the job with a
 * decision instead of moving it to another account. A requested cancel wins
 * over whatever the runner reports, keeping its partial result. Returns the
 * job's new state, or null for a retry of a report that already landed.
 */
export async function finish(
	db: D1Database,
	runner: Runner,
	job: string,
	attempt: number,
	input: { outcome: Outcome; summary: string; result: unknown },
	now: number,
) {
	const body = JSON.stringify({ outcome: input.outcome, summary: input.summary });
	const stored = input.result === undefined ? null : JSON.stringify(input.result);
	const statements = [
		db
			.prepare(`INSERT INTO job_events(job,attempt,kind,body,at) SELECT ?,?,'result',?,? WHERE ${fence}`)
			.bind(job, attempt, body, now, job, attempt, runner.id),
	];
	if (input.outcome === "limited") {
		statements.push(
			db
				.prepare(
					`UPDATE runner_accounts SET limited=1 WHERE runner=? AND id=(SELECT account FROM jobs WHERE id=?) AND ${fence}`,
				)
				.bind(runner.id, job, job, attempt, runner.id),
			db
				.prepare(
					`INSERT INTO job_questions(id,job,attempt,kind,prompt,askedAt) SELECT ?,id,attempt,'account',json_object('runner',runner,'account',account),? FROM jobs WHERE id=? AND attempt=? AND runner=? AND state='running' AND cancel=0 ON CONFLICT(job,attempt) DO NOTHING`,
				)
				.bind(crypto.randomUUID(), now, job, attempt, runner.id),
		);
	}
	statements.push(
		db
			.prepare(
				"UPDATE jobs SET state=CASE WHEN cancel=1 THEN 'cancelled' ELSE ? END,summary=?,result=?,lease=NULL,updatedAt=? WHERE id=? AND attempt=? AND runner=? AND state='running' RETURNING state",
			)
			.bind(
				input.outcome === "limited" ? "waiting" : input.outcome,
				input.summary,
				stored,
				now,
				job,
				attempt,
				runner.id,
			),
	);
	const results = await db.batch(statements);
	const finished = results.at(-1)!.results[0] as { state: JobState } | undefined;
	if (finished) return finished.state;
	// An identical retry after the first report landed is accepted; anything else is refused.
	const landed = await db
		.prepare(
			"SELECT 1 FROM job_events e JOIN jobs j ON j.id=e.job WHERE e.job=? AND e.attempt=? AND e.kind='result' AND e.body=? AND j.result IS ? AND j.attempt=? AND j.runner=?",
		)
		.bind(job, attempt, body, stored, attempt, runner.id)
		.first();
	if (!landed) throw new JobError("Attempt is no longer current");
	return null;
}

/** How long an unrecorded branch update blocks another publication of the same job. */
export const PENDING = 2 * 60_000;

export type Publishing = Job & { owner: string; name: string; project: "enabled" | "paused" };

/** The job a publication is for, only while the publishing attempt is current. */
export async function publishing(db: D1Database, runner: Runner, job: string, attempt: number) {
	const row = await db
		.prepare(
			"SELECT j.*,p.owner,p.name,p.state AS project FROM jobs j JOIN github_projects p ON p.id=j.repository WHERE j.id=? AND j.attempt=? AND j.runner=? AND j.state='running'",
		)
		.bind(job, attempt, runner.id)
		.first<Publishing>();
	if (!row) throw new JobError("Attempt is no longer current");
	return row;
}

/** Record a pending commit that the branch shows landed after all. */
export async function adopt(db: D1Database, job: string, head: string | null, pending: string, now: number) {
	await db
		.prepare(
			"UPDATE jobs SET head=pending,pending=NULL,pendingAt=NULL,updatedAt=? WHERE id=? AND head IS ? AND pending=?",
		)
		.bind(now, job, head, pending)
		.run();
}

/**
 * Reserve the branch update to `commit`, immediately before making it: only
 * while the attempt is current, the branch is where the job last saw it, and
 * no other update of it may still be in flight.
 */
export async function claim(
	db: D1Database,
	runner: Runner,
	job: string,
	attempt: number,
	head: string | null,
	commit: string,
	now: number,
) {
	const result = await db
		.prepare(
			"UPDATE jobs SET pending=?,pendingAt=?,updatedAt=? WHERE id=? AND attempt=? AND runner=? AND state='running' AND head IS ? AND (pending IS NULL OR pendingAt<=?)",
		)
		.bind(commit, now, now, job, attempt, runner.id, head, now - PENDING)
		.run();
	if (result.meta.changes !== 1)
		throw new JobError("Attempt is no longer current, or another publication of this job is in flight");
}

/** Record whether the reserved branch update landed. The branch's head follows it either way. */
export async function settle(db: D1Database, job: string, commit: string, landed: boolean, now: number) {
	await db
		.prepare(
			landed
				? "UPDATE jobs SET head=pending,pending=NULL,pendingAt=NULL,updatedAt=? WHERE id=? AND pending=?"
				: "UPDATE jobs SET pending=NULL,pendingAt=NULL,updatedAt=? WHERE id=? AND pending=?",
		)
		.bind(now, job, commit)
		.run();
}

/**
 * The answered agent questions behind the job's pull request, oldest first,
 * for its decision record: the job's own, and those of each failed job it
 * continues as a retry, whether or not that job opened the pull request.
 */
export async function decisions(db: D1Database, job: string) {
	const { results } = await db
		.prepare(
			`WITH RECURSIVE chain(id) AS (SELECT ? UNION SELECT j.continues FROM jobs j JOIN chain c ON j.id=c.id WHERE j.continues IS NOT NULL)
 SELECT q.prompt,q.answer FROM chain JOIN job_questions q ON q.job=chain.id
 WHERE q.kind='agent' AND q.approvedAt IS NOT NULL ORDER BY q.askedAt,q.rowid`,
		)
		.bind(job)
		.all<{ prompt: string; answer: string }>();
	return results.map((row) => ({
		prompt: JSON.parse(row.prompt) as unknown,
		answer: JSON.parse(row.answer) as unknown,
	}));
}

/** Remember the pull request a job delivered, so later deliveries update it. */
export async function delivered(db: D1Database, job: string, pull: number) {
	await db.prepare("UPDATE jobs SET pull=? WHERE id=?").bind(pull, job).run();
}

export type NewJob = Pick<Job, "repository" | "workflow" | "target" | "revision" | "branch" | "actor"> & {
	trusted: boolean;
	pinRunner?: string | null;
	pinAccount?: string | null;
	idea?: string | null;
	context?: string | null;
};

/** Create a job, or return the active job already doing the same work. */
export async function createJob(db: D1Database, input: NewJob, now: number) {
	if (input.pinAccount && !input.pinRunner) throw new JobError("Pin an account together with its runner");
	// Routing needs both pins to match one reported account, or the job never runs.
	const pinnable =
		"(? IS NULL OR EXISTS(SELECT 1 FROM runners r WHERE r.id=? AND r.owner=? AND (?=1 OR (r.platform='linux' AND r.vm=1)) AND (? IS NULL OR EXISTS(SELECT 1 FROM runner_accounts a WHERE a.runner=r.id AND a.id=?))))";
	const runner = input.pinRunner ?? null;
	const account = input.pinAccount ?? null;
	const trusted = input.trusted ? 1 : 0;
	const pin = [runner, runner, input.actor, trusted, account, account];
	const id = crypto.randomUUID();
	// The insert checks the project and pins again, since a pause or a
	// runner's status can commit after the request read them. Iterating on or
	// merging a pull request continues its existing head branch. Retrying a target
	// whose latest job failed continues that job's branch and pull request
	// where it left them, as a reassigned attempt would, and records which
	// job it continues.
	const [insert, active, enabled, pinned] = await db.batch([
		db
			.prepare(
				`INSERT OR IGNORE INTO jobs(id,repository,workflow,target,revision,branch,head,pending,pendingAt,pull,continues,idea,context,actor,trusted,pinRunner,pinAccount,state,createdAt,updatedAt)
 SELECT ?,p.id,?,?,?,?,COALESCE(?,f.head),f.pending,f.pendingAt,f.pull,f.id,COALESCE(?,f.idea),COALESCE(?,f.context),?,?,?,?,'queued',?,? FROM github_projects p
 LEFT JOIN jobs f ON ?=0 AND f.state='failed' AND f.branch=? AND f.id=(SELECT id FROM jobs WHERE repository=p.id AND target=? ORDER BY createdAt DESC,id LIMIT 1)
 WHERE p.id=? AND p.state='enabled' AND ${pinnable}`,
			)
			.bind(
				id,
				input.workflow,
				input.target,
				input.revision,
				input.branch,
				onPull(input.workflow) ? input.revision : null,
				input.idea ?? null,
				input.context ?? null,
				input.actor,
				trusted,
				runner,
				account,
				now,
				now,
				onPull(input.workflow) ? 1 : 0,
				input.branch,
				input.target,
				input.repository,
				...pin,
			),
		db
			.prepare("SELECT id FROM jobs WHERE repository=? AND target=? AND state IN ('queued','running','waiting')")
			.bind(input.repository, input.target),
		db.prepare("SELECT 1 FROM github_projects WHERE id=? AND state='enabled'").bind(input.repository),
		db.prepare(`SELECT ${pinnable} AS ok`).bind(...pin),
	]);
	if (insert!.meta.changes === 1) return { id, created: true };
	if (!enabled!.results.length) throw new JobError("Contributions are paused");
	if (!(pinned!.results[0] as { ok: number }).ok) throw new JobError("Pinned runner or account unavailable");
	const found = active!.results[0] as { id: string } | undefined;
	if (!found) throw new JobError("Job changed; try again");
	return { id: found.id, created: false };
}

export async function readJob(db: D1Database, id: string) {
	const [job, events, questions] = await db.batch([
		db.prepare("SELECT * FROM jobs WHERE id=?").bind(id),
		db.prepare("SELECT attempt,kind,body,at FROM job_events WHERE job=? ORDER BY rowid").bind(id),
		db
			.prepare(
				"SELECT id,attempt,kind,prompt,answer,answeredBy,askedAt,answeredAt,approvedAt FROM job_questions WHERE job=? ORDER BY askedAt,rowid",
			)
			.bind(id),
	]);
	const row = job!.results[0] as Job | undefined;
	if (!row) return null;
	return jobView(row, events!.results as Event[], questions!.results as Question[]);
}

function jobView(row: Job, events: Event[], questions: Question[]) {
	const json = (value: string | null): unknown => (value === null ? null : JSON.parse(value));
	return {
		...row,
		result: json(row.result),
		events: events.map((e) => ({ ...e, body: json(e.body as string) })),
		questions: questions.map((q) => ({
			...q,
			prompt: json(q.prompt as string),
			answer: json(q.answer as string | null),
		})),
	};
}

/** Hydrate a selection in three snapshot queries, without multiplying events by questions. */
async function readJobs(db: D1Database, select: string, ...parameters: (string | number)[]) {
	const [jobs, events, questions] = await db.batch([
		db.prepare(select).bind(...parameters),
		db
			.prepare(
				`WITH selected AS (${select}) SELECT e.job,e.attempt,e.kind,e.body,e.at
				FROM job_events e JOIN selected j ON j.id=e.job ORDER BY e.rowid`,
			)
			.bind(...parameters),
		db
			.prepare(
				`WITH selected AS (${select}) SELECT q.job,q.id,q.attempt,q.kind,q.prompt,q.answer,q.answeredBy,q.askedAt,q.answeredAt,q.approvedAt
				FROM job_questions q JOIN selected j ON j.id=q.job ORDER BY q.askedAt,q.rowid`,
			)
			.bind(...parameters),
	]);
	const byJob = <T extends { job: string }>(rows: T[]) => {
		const grouped = new Map<string, Omit<T, "job">[]>();
		for (const { job, ...row } of rows) {
			if (!grouped.has(job)) grouped.set(job, []);
			grouped.get(job)!.push(row);
		}
		return grouped;
	};
	const eventRows = byJob(events!.results as (Event & { job: string })[]);
	const questionRows = byJob(questions!.results as (Question & { job: string })[]);
	return (jobs!.results as Job[]).map((row) =>
		jobView(row, eventRows.get(row.id) ?? [], questionRows.get(row.id) ?? []),
	);
}

export async function listJobs(db: D1Database, repository: number) {
	return readJobs(db, "SELECT * FROM jobs WHERE repository=? ORDER BY createdAt DESC,id LIMIT 50", repository);
}

export type Published = Pick<Job, "branch" | "head" | "pending" | "pull">;

/** Where the target's latest job left its branch and pull request, when that job failed: what a retry continues. */
export async function failed(db: D1Database, repository: number, target: string) {
	const latest = await db
		.prepare(
			"SELECT state,branch,head,pending,pull FROM jobs WHERE repository=? AND target=? ORDER BY createdAt DESC,id LIMIT 1",
		)
		.bind(repository, target)
		.first<Published & Pick<Job, "state">>();
	return latest?.state === "failed" ? latest : null;
}

/** Whether a job on `target` is queued, running, or waiting, and so may still push to it. */
export async function active(db: D1Database, repository: number, target: string) {
	return !!(await db
		.prepare(
			"SELECT 1 FROM jobs WHERE repository=? AND target=? AND state IN ('queued','running','waiting') LIMIT 1",
		)
		.bind(repository, target)
		.first());
}

/**
 * The inbox's jobs, newest first: each target's latest job, however old, when
 * it awaits a decision (queued, running, waiting, or failed) or its target is
 * one of the `observed` issues, pull requests, or ready quests.
 */
export async function listInboxJobs(db: D1Database, repository: number, observed: string[]) {
	return readJobs(
		db,
		`SELECT * FROM jobs j WHERE repository=?1
				AND NOT EXISTS(SELECT 1 FROM jobs n WHERE n.repository=?1 AND n.target=j.target AND (n.createdAt>j.createdAt OR (n.createdAt=j.createdAt AND n.id<j.id)))
				AND (state IN ('queued','running','waiting','failed') OR target IN (SELECT value FROM json_each(?2)))
			ORDER BY createdAt DESC,id`,
		repository,
		JSON.stringify(observed),
	);
}

/** The most follow-ups a delivery suggests, and the longest one, in characters. */
export const FOLLOWUPS = { count: 20, length: 1000 };
/** Unplanned follow-up offers last 30 days from the job's completed result. */
export const FOLLOWUP_AGE = 30 * 24 * 60 * 60_000;

/** The follow-ups a completed job's result suggests: untrusted agent text, so only well-formed ones count. */
export function followupsOf(result: unknown): string[] {
	const list = (result as { followups?: unknown } | null)?.followups;
	if (!Array.isArray(list)) return [];
	return list
		.filter((item): item is string => typeof item === "string" && !!item.trim() && item.length <= FOLLOWUPS.length)
		.map((item) => item.trim())
		.slice(0, FOLLOWUPS.count);
}

/** A job that delivered suggested follow-ups, which a "plan these?" decision offers until it is planned. */
export type Followups = Pick<Job, "id" | "workflow" | "target" | "summary" | "pull"> & {
	completedAt: number;
	followups: string[];
};

// The result event is immutable; publication and hold metadata can change jobs.updatedAt later.
const completedAt = `(SELECT MIN(e.at) FROM job_events e WHERE e.job=j.id AND e.attempt=j.attempt
 AND e.kind='result' AND json_extract(e.body,'$.outcome')='completed')`;

/** Recent completed jobs whose follow-ups were not planned: each one's plan target is `plans/<job>`. */
const unplanned = `state='completed' AND json_array_length(result,'$.followups')>0
 AND ${completedAt}>?
 AND NOT EXISTS(SELECT 1 FROM jobs n WHERE n.repository=j.repository AND n.target='plans/'||j.id)`;

/** The project's "plan these?" decisions, newest first. */
export async function listFollowups(db: D1Database, repository: number, now = Date.now()): Promise<Followups[]> {
	const { results } = await db
		.prepare(
			`SELECT id,workflow,target,summary,pull,result,${completedAt} AS completedAt FROM jobs j WHERE repository=? AND ${unplanned} ORDER BY completedAt DESC,id`,
		)
		.bind(repository, now - FOLLOWUP_AGE)
		.all<Omit<Followups, "followups"> & { result: string }>();
	return results.flatMap(({ result, ...job }) => {
		const followups = followupsOf(JSON.parse(result));
		return followups.length ? [{ ...job, followups }] : [];
	});
}

/** The request a "plan these?" decision starts its interview from, or null once it was planned. */
export async function followupRequest(db: D1Database, repository: number, job: string, now = Date.now()) {
	const row = await db
		.prepare(`SELECT workflow,target,summary,result FROM jobs j WHERE id=? AND repository=? AND ${unplanned}`)
		.bind(job, repository, now - FOLLOWUP_AGE)
		.first<Pick<Job, "workflow" | "target" | "summary"> & { result: string }>();
	const followups = row ? followupsOf(JSON.parse(row.result)) : [];
	if (!row || !followups.length) return null;
	// The follow-ups and summary are agent text, so they are context, not the maintainer's words.
	const context = [
		"A finished job suggested these follow-ups:",
		followups.map((item) => `- ${item.replaceAll("\n", " ")}`).join("\n"),
		...(row.summary ? [`Its summary: ${row.summary}`] : []),
	].join("\n\n");
	return { idea: `Plan the follow-ups that the ${row.workflow} job on ${row.target} suggested.`, context };
}

/**
 * The jobs agent cards show, newest first: each target's latest job while it
 * is queued, running, or waiting, or once ended while the pull request it
 * delivered is one of the `open` ones and no later job works on that pull request.
 */
export async function listActivityJobs(db: D1Database, repository: number, open: number[]) {
	return readJobs(
		db,
		`SELECT * FROM jobs j WHERE repository=?1
				AND NOT EXISTS(SELECT 1 FROM jobs n WHERE n.repository=?1 AND n.target=j.target AND (n.createdAt>j.createdAt OR (n.createdAt=j.createdAt AND n.id<j.id)))
				AND (state IN ('queued','running','waiting') OR (pull IN (SELECT value FROM json_each(?2))
					AND NOT EXISTS(SELECT 1 FROM jobs n WHERE n.repository=?1 AND n.target='pulls/'||j.pull AND n.id<>j.id AND n.createdAt>=j.createdAt)))
			ORDER BY createdAt DESC,id`,
		repository,
		JSON.stringify(open),
	);
}

type Pin = { runner: string; account: string };

/** The account an account decision chose. */
function pinOf(kind: QuestionKind, reply: unknown): Pin | null {
	if (kind !== "account") return null;
	const choice = reply as { runner?: unknown; account?: unknown } | null;
	if (typeof choice?.runner !== "string" || typeof choice.account !== "string")
		throw new JobError("Choose one of the job owner's accounts that can run it");
	return { runner: choice.runner, account: choice.account };
}

/** Whether the chosen account is still on its runner; the runner may drop it at any time. */
const pinned = "(? IS NULL OR EXISTS(SELECT 1 FROM runner_accounts WHERE runner=? AND id=?))";

export type Continuation = { head: string; from: string; revision: string };

/** A continuation names only the exact branch version offered by the service's publication decision. */
export function continuationOf(prompt: unknown, reply: unknown): Continuation | null {
	const head = (reply as { continue?: unknown } | null)?.continue;
	if (head === undefined) return null;
	const offer = (prompt as { continuation?: Continuation } | null)?.continuation;
	if (
		!offer ||
		head !== offer.head ||
		![offer.head, offer.from, offer.revision].every((sha) => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha))
	)
		throw new JobError("This continuation is no longer offered; review the new head again");
	return offer;
}

/**
 * Requeue a job whose question was just approved at `now`, in the same batch
 * as the approval. An account decision pins the chosen account and starts a
 * new session from the job's summaries.
 */
function resume(
	db: D1Database,
	job: string,
	question: string,
	pin: Pin | null,
	now: number,
	continuation: Continuation | null = null,
) {
	const approved = "EXISTS(SELECT 1 FROM job_questions WHERE id=? AND approvedAt=?)";
	if (continuation)
		return [
			db
				.prepare(
					`UPDATE jobs SET state='queued',head=?,revision=?,trusted=0,updatedAt=? WHERE id=? AND state='waiting' AND head=? AND revision=? AND pending IS NULL AND ${approved}`,
				)
				.bind(
					continuation.head,
					continuation.head,
					now,
					job,
					continuation.from,
					continuation.revision,
					question,
					now,
				),
		];
	if (!pin)
		return [
			db
				.prepare(`UPDATE jobs SET state='queued',updatedAt=? WHERE id=? AND state='waiting' AND ${approved}`)
				.bind(now, job, question, now),
		];
	return [
		// Choosing the limited account again is the maintainer's explicit retry.
		db
			.prepare(
				`UPDATE runner_accounts SET limited=0 WHERE runner=? AND id=? AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND state='waiting') AND ${approved}`,
			)
			.bind(pin.runner, pin.account, job, question, now),
		db
			.prepare(
				`UPDATE jobs SET state='queued',pinRunner=?,pinAccount=?,session=NULL,updatedAt=? WHERE id=? AND state='waiting' AND ${approved}`,
			)
			.bind(pin.runner, pin.account, now, job, question, now),
	];
}

/**
 * Answer the job's open question once. The job's requester, whose runner
 * runs it, resumes it at once. Until the job sandbox ships, another
 * maintainer's answer waits for the requester to approve it, since the
 * agent acts on it with the requester's machine and credentials; the
 * requester may answer it themselves instead. Returns whether it resumed.
 */
export async function answer(db: D1Database, job: string, question: string, user: string, reply: unknown, now: number) {
	const open = await db
		.prepare(
			"SELECT q.kind,q.prompt,j.actor,j.trusted FROM job_questions q JOIN jobs j ON j.id=q.job WHERE q.id=? AND q.job=? AND q.approvedAt IS NULL AND (q.answer IS NULL OR j.actor=?) AND q.attempt=j.attempt AND j.state='waiting'",
		)
		.bind(question, job, user)
		.first<{ kind: QuestionKind; prompt: string; actor: string; trusted: number }>();
	if (!open) throw new JobError("Question is no longer open");
	const continuation = open.kind === "publication" ? continuationOf(JSON.parse(open.prompt), reply) : null;
	const guard = continuation
		? " AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND head=? AND revision=? AND pending IS NULL)"
		: "";
	const pin = pinOf(open.kind, reply);
	if (
		pin &&
		!(await db
			.prepare(
				"SELECT 1 FROM runner_accounts a JOIN runners r ON r.id=a.runner WHERE a.runner=? AND a.id=? AND r.owner=? AND (?=1 OR (r.platform='linux' AND r.vm=1))",
			)
			.bind(pin.runner, pin.account, open.actor, open.trusted)
			.first())
	)
		throw new JobError("Choose one of the job owner's accounts that can run it");
	const own = user === open.actor;
	const statements = [
		db
			.prepare(
				`UPDATE job_questions SET answer=?,answeredBy=?,answeredAt=?,approvedAt=? WHERE id=? AND job=? AND approvedAt IS NULL
 AND (answer IS NULL OR ?=(SELECT actor FROM jobs WHERE id=?)) AND attempt=(SELECT attempt FROM jobs WHERE id=? AND state='waiting') AND ${pinned}${guard}`,
			)
			.bind(
				JSON.stringify(reply),
				user,
				now,
				own ? now : null,
				question,
				job,
				user,
				job,
				job,
				pin?.runner ?? null,
				pin?.runner ?? null,
				pin?.account ?? null,
				...(continuation ? [job, continuation.from, continuation.revision] : []),
			),
		...(own ? resume(db, job, question, pin, now, continuation) : []),
	];
	const results = await db.batch(statements);
	if (results[0]!.meta.changes !== 1)
		throw new JobError(pin ? "Question is no longer open or the account is gone" : "Question is no longer open");
	return { resumed: own };
}

/** The job's requester approves another maintainer's answer, which resumes the job. */
export async function approve(db: D1Database, job: string, question: string, user: string, now: number) {
	const pending = await db
		.prepare(
			"SELECT q.kind,q.prompt,q.answer,j.actor FROM job_questions q JOIN jobs j ON j.id=q.job WHERE q.id=? AND q.job=? AND q.answer IS NOT NULL AND q.approvedAt IS NULL AND q.attempt=j.attempt AND j.state='waiting'",
		)
		.bind(question, job)
		.first<{ kind: QuestionKind; prompt: string; answer: string; actor: string }>();
	if (!pending) throw new JobError("No answer awaits approval");
	if (pending.actor !== user) throw new JobError("Only the job's requester can approve another maintainer's answer");
	const continuation =
		pending.kind === "publication" ? continuationOf(JSON.parse(pending.prompt), JSON.parse(pending.answer)) : null;
	const guard = continuation
		? " AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND head=? AND revision=? AND pending IS NULL)"
		: "";
	const pin = pinOf(pending.kind, JSON.parse(pending.answer));
	const results = await db.batch([
		db
			.prepare(
				`UPDATE job_questions SET approvedAt=? WHERE id=? AND job=? AND answer=? AND approvedAt IS NULL AND attempt=(SELECT attempt FROM jobs WHERE id=? AND state='waiting' AND actor=?) AND ${pinned}${guard}`,
			)
			.bind(
				now,
				question,
				job,
				pending.answer,
				job,
				user,
				pin?.runner ?? null,
				pin?.runner ?? null,
				pin?.account ?? null,
				...(continuation ? [job, continuation.from, continuation.revision] : []),
			),
		...resume(db, job, question, pin, now, continuation),
	]);
	if (results[0]!.meta.changes !== 1)
		throw new JobError(pin ? "No answer awaits approval, or the account is gone" : "No answer awaits approval");
}

/** How a publication decision records that the maintainer chose to start over. */
export const RESTART = { restart: true } as const;

/**
 * Answer a waiting job's publication decision by starting over: the job ends,
 * and a new one on the same target and revision queues from `head`, the
 * commit its branch is then reset to, with a new agent session and none of the
 * old job's answers. The new job's later creation also means a pull request
 * closed before now is not mistaken for one it delivered. Like an answer, it
 * may replace another maintainer's answer only when the requester starts over.
 * It needs no approval: the new job runs the requester's own request.
 */
export async function restart(db: D1Database, job: string, question: string, user: string, head: string, now: number) {
	const id = crypto.randomUUID();
	const answered = "EXISTS(SELECT 1 FROM job_questions WHERE id=? AND answeredBy=? AND answeredAt=?)";
	const [update] = await db.batch([
		db
			.prepare(
				`UPDATE job_questions SET answer=?,answeredBy=?,answeredAt=?,approvedAt=? WHERE id=? AND job=? AND kind='publication' AND approvedAt IS NULL
 AND (answer IS NULL OR ?=(SELECT actor FROM jobs WHERE id=?)) AND attempt=(SELECT attempt FROM jobs WHERE id=? AND state='waiting')`,
			)
			.bind(JSON.stringify(RESTART), user, now, now, question, job, user, job, job),
		db
			.prepare(`UPDATE jobs SET state='cancelled',updatedAt=? WHERE id=? AND state='waiting' AND ${answered}`)
			.bind(now, job, question, user, now),
		db
			.prepare(
				`INSERT INTO jobs(id,repository,workflow,target,revision,branch,head,idea,context,actor,trusted,pinRunner,pinAccount,state,createdAt,updatedAt)
 SELECT ?,repository,workflow,target,revision,branch,?,idea,context,actor,trusted,pinRunner,pinAccount,'queued',?,? FROM jobs WHERE id=? AND state='cancelled' AND ${answered}`,
			)
			.bind(id, head, now, now, job, question, user, now),
	]);
	if (update!.meta.changes !== 1) throw new JobError("Question is no longer open");
	return id;
}

/**
 * Pause a queued job that has not run yet on a publication decision, such as
 * a restart whose branch reset failed. A job a runner already took is left alone.
 */
export async function hold(db: D1Database, job: string, input: { summary: string; prompt: unknown }, now: number) {
	const id = crypto.randomUUID();
	await db.batch([
		db
			.prepare(
				"INSERT INTO job_questions(id,job,attempt,kind,prompt,askedAt) SELECT ?,id,attempt,'publication',?,? FROM jobs WHERE id=? AND attempt=0 AND state='queued' AND cancel=0",
			)
			.bind(id, JSON.stringify(input.prompt), now, job),
		db
			.prepare(
				"UPDATE jobs SET state='waiting',summary=?,updatedAt=? WHERE id=? AND state='queued' AND EXISTS(SELECT 1 FROM job_questions WHERE id=?)",
			)
			.bind(input.summary, now, job, id),
	]);
}

/**
 * Record the acquired `quest:kix` label even if the job was stopped meanwhile,
 * so the sweep can recover a failed immediate release. Returns whether the job
 * is still queued and may start.
 */
export async function held(db: D1Database, job: string, token: string) {
	const row = await db
		.prepare("UPDATE jobs SET hold=? WHERE id=? AND workflow='merge' AND (hold IS NULL OR hold=?) RETURNING state")
		.bind(token, job, token)
		.first<{ state: JobState }>();
	// Retain a stopped job's token too, so a failed immediate release remains recoverable.
	return row?.state === "queued";
}

/** A merge job's hold on its pull request is over. */
export async function released(db: D1Database, job: string, token: string) {
	await db.prepare("UPDATE jobs SET hold=NULL WHERE id=? AND hold=?").bind(job, token).run();
}

/** The ended merge jobs on `target` that still hold its pull request, such as one whose landing is queued. */
export async function holding(db: D1Database, repository: number, target: string) {
	const { results } = await db
		.prepare(
			"SELECT id,hold FROM jobs WHERE repository=? AND target=? AND workflow='merge' AND hold IS NOT NULL AND state NOT IN ('queued','running','waiting')",
		)
		.bind(repository, target)
		.all<{ id: string; hold: string }>();
	return results;
}

/**
 * Stop a job. Queued, waiting, and never-acknowledged jobs stop now; a
 * running attempt is asked to cancel and reports its partial result.
 */
export async function cancel(db: D1Database, job: string, user: string, now: number) {
	const [, stopped, asked] = await db.batch([
		db
			.prepare(
				"INSERT INTO job_events(job,attempt,kind,body,at) SELECT id,attempt,'cancel',json_object('by',?),? FROM jobs WHERE id=? AND state IN ('queued','running','waiting') AND cancel=0",
			)
			.bind(user, now, job),
		db
			.prepare(
				"UPDATE jobs SET state='cancelled',lease=NULL,updatedAt=? WHERE id=? AND (state IN ('queued','waiting') OR (state='running' AND delivered=0))",
			)
			.bind(now, job),
		db.prepare("UPDATE jobs SET cancel=1,updatedAt=? WHERE id=? AND state='running'").bind(now, job),
	]);
	if (stopped!.meta.changes + asked!.meta.changes === 0) throw new JobError("Job already finished");
}
