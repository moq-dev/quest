// Trusted host side: durable background jobs, validation, and credentialed publication.
import { spawn } from "node:child_process";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	mkdtempSync,
	openSync,
	readSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { basename, join } from "node:path";
import { reviewSection } from "../core";
import { GitHub, type GitHubDependencies, type ObjectValue, object, string } from "./github";
import {
	baseRemote,
	commandEnvironment,
	contains,
	git,
	tryGit,
	enqueue,
	type Entry,
	type Plan,
	type Reason,
} from "./land";
import { COMMENT_LIMIT, resolution, resolutionSection, type Resolution } from "./land-apply";
import {
	CAUSES,
	type Cause,
	readFixResult,
	signature,
	parseBaseFix,
	knownFlaky,
	parseFixResult,
	type BaseFix,
	type FixResult,
} from "./land-fix";
import { readRemote, type RemoteRead } from "./land";
import { importFixer } from "./land-fixer-repository";
import { isPrepared, push, remoteHead } from "./land-head";
import { BASE_JOB, type Halt, haltNotice, readHalt, saveHalt } from "./land-halt";
import { isParked, parked } from "./land-park";
import { excerpt, type Failure } from "./land-serve";
import { type Carried, describe, readSignals } from "./signals";

/**
 * Why a fixer's result cannot be published, which hands its PR back. A push GitHub refused, or a fix
 * that edits protected paths, carries the validated resolution, for `quest land apply` to rebuild.
 */
export class FixerRefusal extends Error {
	constructor(
		message: string,
		readonly resolution?: Resolution,
	) {
		super(message);
	}
}
class BaseCheckError extends Error {}
/** A fix that edits protected paths beyond what the base merge carries: only a maintainer's push lands it. */
export class ProtectedEdit extends Error {}

/**
 * The failure log a handback quotes: the lines the fixer cited, else the tail of the gate's failing
 * output, so a fixer that failed for its own reasons still shows why the gate dropped the PR. The
 * fixer's own output stays in its job log on the host; the comment's reason names its error.
 */
export function handbackLog(log: string, lines?: [number, number]): string {
	if (!lines) return readLog(log, "tail").trimEnd().split("\n").slice(-100).join("\n");
	if (!existsSync(log)) return "";
	const [first, last] = lines;
	return readFileSync(log, "utf8")
		.split("\n")
		.slice(first - 1, last)
		.join("\n")
		.trimEnd();
}

/** Read a bounded window of a log, or "" when it is missing or not a regular file. */
function readLog(path: string, window: "head" | "tail"): string {
	if (!path || !existsSync(path)) return "";
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) return "";
		const buffer = Buffer.alloc(Math.min(stat.size, 16_384));
		const length = readSync(fd, buffer, 0, buffer.length, window === "head" ? 0 : stat.size - buffer.length);
		return buffer.subarray(0, length).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

/**
 * A wrapper that queues for a shared launcher prints this line, followed by the Unix time in
 * seconds, once the launcher admits the job. Only the first one counts: the agent's own output
 * starts after admission, so it cannot forge an earlier one.
 */
export const ADMITTED = "quest land fixer: admitted";

/**
 * The run gets `timeout` minutes from its admission, so a fixer queued for a shared launcher's slot
 * keeps its whole run. Waiting counts against a total of twice that from the spawn, which also
 * bounds a launcher that never admits the job and a wrapper that never reports admission.
 */
function deadline(path: string, job: Process, now: number, timeout: number): number {
	if (job.admitted === undefined) {
		const match = new RegExp(`^${ADMITTED} (\\d{1,15})$`, "m").exec(readLog(`${path}.log`, "head"));
		if (match) {
			// Kept within [started, now], so a wrong clock or a forged line cannot move it out of the run.
			job.admitted = Math.min(Math.max(Number(match[1]) * 1000, job.started), now);
			save(path, job);
		}
	}
	const total = job.started + 2 * timeout * 60_000;
	return job.admitted === undefined ? total : Math.min(job.admitted + timeout * 60_000, total);
}

/** A fixer process the daemon tracks across restarts, and how it ended. */
export interface Process {
	checkout: string;
	started: number;
	/** When the wrapper reported the launcher admitted it; unset while queued or for a wrapper that never reports. */
	admitted?: number;
	terminating?: number;
	pid?: number;
	identity?: string;
	/** The launching daemon's process identity, to tell a restart from a crash. */
	daemon?: string;
	/** Packs fetched from the daemon's repository at launch; their objects are already there. */
	packs?: string[];
	error?: string;
}

interface Job extends Process {
	plan: Plan;
	/** The PRs this job parks until each one's result is collected; see `parked`. */
	numbers: number[];
	/** Set on every job since parking: its PRs never left the queue. An older job's PRs were ejected first. */
	parked?: boolean;
	/** Why its PRs failed, for the marker `quest status` reads when a handback takes one out of the queue. */
	reason?: Reason;
	/** The failure log the fixer read, which a handback's comment quotes. */
	log?: string;
	/** The PRs the gate itself blamed, as for a conflict; absent when the fixer must say which PR broke the batch. */
	blame?: number[];
	/** When the fixer blamed none: whether the base alone passed its check. */
	base?: boolean;
	results?: FixResult[];
	handbacks?: Record<number, string>;
	/** Passes that failed to collect each PR, so one that keeps failing is set aside rather than holding up the rest. */
	failures?: Record<number, number>;
	/** PRs a handback is taking out of the queue, recorded before their auto-merge is disabled. */
	left?: number[];
	/** Validated fixes GitHub refused to publish, handed back for a maintainer to push. */
	resolutions?: Record<number, Resolution>;
	// Persist publication before moving a remote head; retries recognize only this exact head.
	published: number[];
}
/**
 * How a round ended: a fixer commit (`fixed`), a clean base merge with no fixer edit (`merged`), no new
 * commit for a failure the fixer found no cause of outside the PR (`unchanged`), an unchanged re-enqueue
 * for the cause it named (`flaky`, `base`, or `environment`), or a handback.
 */
export type Outcome = "fixed" | "merged" | "unchanged" | Cause | "handback";

/** One failure a pick was blamed for, and what came of it. */
export interface Round {
	/** The fixer job that ran it: collecting the same job again replaces its round rather than adding one. */
	job: string;
	outcome: Outcome;
	/** The head that failed. */
	before: string;
	/** The pin `before` stood on, when it was the gate's base merge on that pin rather than the pin itself. */
	pin?: string;
	/** The head the round put back in the queue or published, which a fix or merge moves; a handback may keep it. */
	after?: string;
	/** The failure's signature: what failed, so a recurrence after a fix can be told from a new failure. */
	failure: string;
	/** The stop rule that handed the PR back. */
	rule?: StopRule;
}

/**
 * A maintainer pick's history of fixer rounds; a fixed head's requeue keeps the pick as `requeued`.
 * A record without `rounds`, written before rounds were kept, starts a fresh history.
 */
export interface History {
	agent?: string;
	model?: string;
	pick: string;
	requeued?: string;
	head?: string;
	rounds: Round[];
}
function save(path: string, data: unknown): void {
	writeFileSync(`${path}.new`, JSON.stringify(data), { mode: 0o600 });
	renameSync(`${path}.new`, path);
}
export const historyPath = (state: string, number: number) => join(state, `fix-attempt-${number}.json`);
export function history(state: string, number: number): History | undefined {
	const path = historyPath(state, number);
	if (!existsSync(path)) return undefined;
	const record = JSON.parse(readFileSync(path, "utf8")) as Omit<History, "rounds"> & { rounds?: Round[] };
	return { ...record, rounds: record.rounds ?? [] };
}
/**
 * What the fixer's `head` of PR `number` carries from the pick it replaces: the heads its rounds replaced up to the
 * round that put `head` back in the queue, with the pins the gate's base merges stood on, and when the pick was made.
 * A handback leaves the carry, since the person who picks the head again has answered nothing; a head no round put
 * back, such as a writer's push, carries nothing.
 */
export function carriedBy(state: string, number: number, head: string): Carried | undefined {
	const record = history(state, number);
	if (!record || !Number.isFinite(Date.parse(record.pick))) return undefined;
	let end = record.rounds.length;
	while (end > 0 && record.rounds[end - 1]!.after !== head) end--;
	if (end === 0) return undefined;
	return {
		heads: record.rounds.slice(0, end).flatMap((round) => (round.pin ? [round.before, round.pin] : [round.before])),
		picked: record.pick,
	};
}
/** What each of `pulls`' heads carries from a pick the land fixer replaced, by number. */
export function carriedOf(state: string, pulls: ObjectValue[]): Map<number, Carried> {
	return new Map(
		pulls.flatMap((pull) => {
			const carried = carriedBy(state, Number(pull.number), string(pull.headRefOid));
			return carried ? [[Number(pull.number), carried] as const] : [];
		}),
	);
}

/** Record `round` in `record`, replacing the same job's earlier one, and save it as PR `number`'s history. */
export function saveRound(state: string, number: number, record: History, round: Round): History {
	const next = { ...record, rounds: [...record.rounds.filter((item) => item.job !== round.job), round] };
	save(historyPath(state, number), next);
	return next;
}
/** Whether `record` belongs to the pick `entry` is queued under: the pick itself, or the fixer's requeue of it. */
function samePick(record: History | undefined, entry: Pick<Entry, "enabledAt">): record is History {
	return record !== undefined && (record.pick === entry.enabledAt || record.requeued === entry.enabledAt);
}

/**
 * Why a pick stops being fixed while each round still changes something: a round with no new commit
 * for a failure with no cause outside the PR (`unchanged`), the failure a fix addressed recurring right
 * after it (`repeated`), or `REQUEUE_LIMIT` unchanged re-enqueues in a row, whatever their causes
 * (`requeued`).
 */
export type StopRule = "unchanged" | "repeated" | "requeued";
/**
 * The unchanged re-enqueues in a row that hand a PR back, so a real nondeterministic bug in it, or a
 * base or runner that keeps failing it, reaches a person.
 */
export const REQUEUE_LIMIT = 3;
const requeue = (outcome: Outcome): outcome is Cause => (CAUSES as readonly string[]).includes(outcome);

/**
 * The stop rule `round` fires after `rounds`, the pick's earlier rounds, if any. A re-enqueue resets
 * neither of the other rules: the failure a fix addressed recurring after flaky rounds is still a
 * repeat. A fixer's own handback needs no rule.
 */
export function stopRule(rounds: Round[], round: Pick<Round, "outcome" | "failure">): StopRule | undefined {
	if (round.outcome === "handback") return undefined;
	if (round.outcome === "unchanged") return "unchanged";
	const last = rounds.filter((item) => !requeue(item.outcome)).at(-1);
	if (
		(last?.outcome === "fixed" || last?.outcome === "merged") &&
		signature(last.failure) === signature(round.failure)
	)
		return "repeated";
	if (!requeue(round.outcome)) return undefined;
	let streak = 1;
	for (let index = rounds.length - 1; index >= 0 && requeue(rounds[index].outcome); index--) streak++;
	return streak >= REQUEUE_LIMIT ? "requeued" : undefined;
}

/**
 * A handback's reason, naming the stop rule `round` fired; a requeue limit names the last round's cause.
 * Worded so `fixerText` quotes it unchanged.
 */
export function stopReason(rule: StopRule, round: Pick<Round, "outcome" | "failure">): string {
	switch (rule) {
		case "unchanged":
			return "stop rule (no new commit): the fixer's round produced no new commit and named no cause outside the pull request";
		case "repeated":
			return `stop rule (repeated failure): ${round.failure} failed again right after the round that addressed it`;
		case "requeued":
			return `stop rule (requeue limit): the failure was requeued unchanged ${REQUEUE_LIMIT} times in a row, last ${
				round.outcome === "base"
					? "because the base fails it too; the base may need a fix"
					: round.outcome === "environment"
						? "because the runner's environment fails it; the runner may need a fix"
						: "judged flaky; it may be a real nondeterministic bug"
			}`;
	}
}

/**
 * A conflict's signature names the base it conflicts with, so a conflict after the base moved is a new
 * failure rather than a repeat, and a PR that keeps conflicting with a busy base keeps being fixed.
 */
export function conflictFailure(base: string): string {
	return `merge conflict with ${base}`;
}
export function identity(pid: number): string | undefined {
	try {
		return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[19]}`;
	} catch {
		return undefined;
	}
}
/** Post `content` once per pick and kind: a retry finds the bot's own marker and posts nothing. */
export async function post(
	github: GitHub,
	plan: Pick<Plan, "repository">,
	entry: Pick<Entry, "number" | "enabledAt">,
	content: string,
	suffix: string,
	attribution: string,
	reason?: Reason,
	section?: (room: number) => string,
): Promise<void> {
	const path = `/repos/${plan.repository}/issues/${entry.number}/comments`;
	const marker = `<!-- quest land fixer: ${entry.enabledAt} ${suffix} -->`;
	const login = string(object((await github.graphql("query { viewer { login } }", {})).viewer).login);
	if (
		(await github.all(`${path}?per_page=100`)).some(
			(item) => item.user != null && object(item.user).login === login && string(item.body).includes(marker),
		)
	)
		return;
	const tail = `\n\n${marker}${reason ? `\n<!-- quest land: ${reason} -->` : ""}\n\n(written by ${attribution})`;
	const extra = section?.(COMMENT_LIMIT - content.length - tail.length) ?? "";
	await github.request(path, { body: { body: `${content}${extra}${tail}` } });
}
export async function comment(
	github: GitHub,
	plan: Pick<Plan, "repository">,
	entry: Pick<Entry, "number" | "enabledAt">,
	text: string,
	suffix: string,
	attribution = "Codex",
	log = "",
	reason?: Reason,
	section?: (room: number) => string,
): Promise<void> {
	const content = `${attribution} land fixer: ${fixerText(text)}${log ? `\n\n<pre>${excerpt(redactTokens(log))}</pre>` : ""}`;
	await post(github, plan, entry, content, suffix, attribution, reason, section);
}

/** How many one-second pauses to wait for GitHub to show a pushed head. */
const SYNC_PAUSES = 60;

/**
 * Park the failure's PRs and start one fixer job on them; the stop rules are applied as it is
 * collected, once its outcome and the failure's signature are known. Returns what it did.
 */
export async function startFixer(
	root: string,
	checkout: string,
	failure: Failure,
	fixer: string,
	state: string,
	deps: GitHubDependencies,
): Promise<string[]> {
	const entries: Entry[] = [];
	const held = parked(state);
	for (const entry of failure.plan.queue.filter((item) => failure.numbers.includes(item.number))) {
		// failure.json may replay after launching this same job. It is not a second pick.
		if (isParked(held, entry)) continue;
		if (!samePick(history(state, entry.number), entry))
			save(historyPath(state, entry.number), { pick: entry.enabledAt, rounds: [] } satisfies History);
		entries.push(entry);
	}
	if (!entries.length) {
		rmSync(checkout, { recursive: true, force: true });
		return [];
	}
	const packs = prepare(
		root,
		checkout,
		[
			`${failure.tip}:refs/heads/batch`,
			`${failure.plan.base.sha}:refs/heads/base`,
			...entries.map((entry) => `${entry.head}:refs/heads/pr-${entry.number}`),
		],
		// Start at the base, never the batch: the agent loads its instructions and tooling only from code
		// already landed, and inspects the PRs through their branches.
		failure.plan.base.sha,
	);
	const path = join(state, `fix-job-${checkout.split("/").at(-1)}.json`);
	const job: Job = {
		checkout,
		plan: failure.plan,
		numbers: entries.map((entry) => entry.number),
		parked: true,
		reason: failure.reason,
		log: failure.log,
		...(failure.blame ? { blame: failure.blame } : {}),
		started: deps.now(),
		daemon: identity(process.pid),
		packs,
		published: [],
	};
	await launch(path, job, fixer, failure.log, job.numbers);
	return job.numbers.map((number) => `parked ${number}`);
}

/**
 * A standalone repository in `checkout` holding `refs` fetched from the daemon's, detached at
 * `start`. Returns the packs the fetch wrote, whose objects the daemon already has.
 */
export function prepare(root: string, checkout: string, refs: string[], start: string): string[] {
	git(checkout, ["init", "--quiet"]);
	// No background gc or maintenance may rewrite objects while the daemon imports the fixer's result.
	git(checkout, ["config", "gc.auto", "0"]);
	git(checkout, ["config", "maintenance.auto", "false"]);
	git(checkout, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", root, ...refs]);
	git(checkout, ["config", "user.name", "quest fixer"]);
	git(checkout, ["config", "user.email", "quest-fixer@localhost"]);
	git(checkout, ["checkout", "--quiet", "--detach", start]);
	return readdirSync(join(checkout, ".git", "objects", "pack")).filter((name) => name.endsWith(".pack"));
}

/** A fixer job on the base alone, which fails its check with no PR applied. */
interface BaseJob extends Process {
	repository: string;
	base: Plan["base"];
	/** The base's failing check log, which the fixer reads and a halt notice quotes. */
	log: string;
	result?: BaseFix;
}

/**
 * Start the fixer on a base that fails its check alone, with only its `base` branch. Its fix is
 * proposed as a PR for a maintainer to merge; without one, the queue's halt gets an issue.
 */
export async function startBaseFixer(
	root: string,
	state: string,
	repository: string,
	base: Plan["base"],
	log: string,
	fixer: string,
	deps: Pick<GitHubDependencies, "now">,
): Promise<void> {
	const checkout = mkdtempSync(join(state, "fix-"));
	try {
		const packs = prepare(root, checkout, [`${base.sha}:refs/heads/base`], base.sha);
		const job: BaseJob = {
			checkout,
			repository,
			base,
			log,
			started: deps.now(),
			daemon: identity(process.pid),
			packs,
		};
		await launch(join(state, `fix-base-${basename(checkout)}.json`), job, fixer, log, []);
	} catch (error) {
		rmSync(checkout, { recursive: true, force: true });
		throw error;
	}
}

/**
 * Publish a finished base job's outcome while the queue is still halted on its base: its fix as a
 * PR, or else the halt's issue. A job whose base the queue moved past is discarded.
 */
async function collectBaseJob(
	root: string,
	state: string,
	path: string,
	job: BaseJob,
	deps: GitHubDependencies,
	token: (workflows: boolean) => Promise<string>,
	timeout: number,
	read: RemoteRead,
): Promise<string[]> {
	if (
		!job.result &&
		!job.error &&
		!settle(path, job, deps, timeout, () => (job.result = parseBaseFix(readFixResult(job.checkout))))
	)
		return [];
	const output: string[] = [];
	const halt = readHalt(state);
	if (halt?.sha === job.base.sha && !halt.fix && !halt.noticed) {
		const github = new GitHub(deps);
		const result = job.result;
		let error = job.error?.replace(/; run \/quest-iterate.*$/, "");
		if (!error && result?.action === "fixed") {
			try {
				const fix = await proposeFix(root, state, job, result, deps, token, read);
				saveHalt(state, { ...halt, fix });
				if (halt.issue !== undefined)
					await github.request(`/repos/${job.repository}/issues/${halt.issue}/comments`, {
						body: {
							body: `${job.base.ref} fails its check alone at ${job.base.sha} too. The land fixer proposes a mechanical fix in #${fix.number}.`,
						},
					});
				output.push(`proposed ${fix.number}`);
			} catch (failure) {
				if (!(failure instanceof FixerRefusal)) throw failure;
				error = failure.message;
			}
		}
		const cause = error
			? `The land fixer could not propose a fix: ${error}.`
			: result?.action === "handback"
				? `The land fixer could not fix it mechanically: ${fixerText(result.diagnosis)}. Recommendation: ${fixerText(result.recommendation)}.`
				: undefined;
		if (cause) {
			const log = existsSync(job.log) ? readFileSync(job.log, "utf8").trimEnd() : "";
			await haltNotice(github, state, job.repository, job.base, cause, log && `<pre>${excerpt(log)}</pre>`);
			output.push(`halted ${job.base.sha}`);
		}
	}
	rmSync(job.checkout, { recursive: true, force: true });
	rmSync(`${path}.exit`, { force: true });
	rmSync(path);
	return output;
}

/** Push a base fix to its own branch, as validated as a PR's, and open it as a PR, once. */
async function proposeFix(
	root: string,
	state: string,
	job: BaseJob,
	result: BaseFix & { action: "fixed" },
	deps: GitHubDependencies,
	token: (workflows: boolean) => Promise<string>,
	read: RemoteRead,
): Promise<NonNullable<Halt["fix"]>> {
	const { base, repository } = job;
	await read(root, ["fetch", "--quiet", "--no-tags", baseRemote({ repository }), base.sha]);
	try {
		importFixer(root, state, job.checkout, "base", result.head, job.packs);
		// The fix may not edit protected paths: they must stay as the base has them.
		validateFix(root, { head: base.sha }, result.head, base.sha);
	} catch (error) {
		throw new FixerRefusal(String(error));
	}
	const branch = `quest-land/fix-${base.sha.slice(0, 12)}`;
	const remote = `https://github.com/${repository}.git`;
	const ref = `refs/heads/${branch}`;
	const github = new GitHub(deps);
	// A retry after a restart finds its own push already there.
	if ((await remoteHead(root, remote, ref, read)) !== result.head) {
		const pushed = await push(github, root, { remote, from: base.sha, to: result.head, ref, lease: "", token });
		if (pushed.status !== 0) throw new FixerRefusal(`fix push refused: ${pushed.stderr.trim()}`);
	}
	const head = `${repository.split("/")[0]}:${branch}`;
	const [open] = await github.all(`/repos/${repository}/pulls?head=${encodeURIComponent(head)}&state=open`);
	if (open) return { number: Number(open.number), branch };
	const attribution = author(result);
	const log = existsSync(job.log) ? readFileSync(job.log, "utf8").trimEnd() : "";
	const response = await github.request(`/repos/${repository}/pulls`, {
		body: {
			title: `quest land: fix ${base.ref}, which fails its own check`,
			head,
			base: base.ref,
			body: `${base.ref} fails its own check at ${base.sha}, so quest land halted its queue. Its land fixer proposes this mechanical fix: ${fixerText(result.reason)}\n\nMerge it as an administrator: the queue resumes once a check of the new ${base.ref} passes. If ${base.ref} passes without it first, quest land closes this pull request.${log ? `\n\n<pre>${excerpt(log)}</pre>` : ""}${review("", result.head, result.reason, attribution)}\n\n(written by ${attribution})`,
		},
	});
	return { number: Number(object(await response.json()).number), branch };
}

/**
 * Save `job`, then start the fixer wrapper on it under a supervisor that survives a daemon restart
 * and atomically records the wrapper's exit status. Its state path is never passed to the wrapper
 * or mounted in its container.
 */
export async function launch(
	path: string,
	job: Process,
	fixer: string,
	log: string,
	numbers: number[],
	env: NodeJS.ProcessEnv = {},
): Promise<void> {
	save(path, job);
	const output = openSync(
		`${path}.log`,
		constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
		0o600,
	);
	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(
			"sh",
			[
				"-c",
				`trap ':' TERM; status=$1; shift; "$@"; code=$?; printf "%s" "$code" > "$status.new"; mv "$status.new" "$status"`,
				"quest-fixer",
				`${path}.exit`,
				fixer,
				log,
				...numbers.map(String),
			],
			{
				cwd: job.checkout,
				detached: true,
				env: { ...commandEnvironment(), ...env },
				stdio: ["ignore", output, output],
			},
		);
	} finally {
		closeSync(output);
	}
	try {
		await new Promise<void>((done, reject) => {
			child.once("spawn", done);
			child.once("error", reject);
		});
		job.pid = child.pid;
		job.identity = identity(child.pid!);
	} catch (error) {
		job.error = `fixer launch failed: ${String(error)}`;
	}
	save(path, job);
	child.unref();
}

/** Whether the fixer process ended, recording its error or, on a clean exit, reading its result with `read`. */
export function settle(
	path: string,
	job: Process,
	deps: GitHubDependencies,
	timeout: number,
	read: () => void,
): boolean {
	// A restart stops the daemon's whole unit, fixers included, unless the host keeps them running.
	const daemon = identity(process.pid);
	const restarted = job.daemon && daemon && job.daemon !== daemon ? "; the daemon restarted while it ran" : "";
	if (existsSync(`${path}.exit`)) {
		const code = readFileSync(`${path}.exit`, "utf8");
		if (job.terminating !== undefined) job.error = "fixer timed out; run /quest-iterate";
		else if (code !== "0") job.error = `fixer ${exited(code)}${restarted}; run /quest-iterate`;
		else
			try {
				read();
			} catch (error) {
				job.error = `invalid fixer result: ${String(error)}; run /quest-iterate`;
			}
	} else if (deps.now() > deadline(path, job, deps.now(), timeout)) {
		if (job.terminating === undefined) {
			job.terminating = deps.now();
			if (job.pid && job.identity && identity(job.pid) === job.identity) {
				try {
					process.kill(-job.pid, "SIGTERM");
				} catch {}
			}
			save(path, job);
			return false;
		}
		if (deps.now() - job.terminating < 10_000) return false;
		if (job.pid && job.identity && identity(job.pid) === job.identity) {
			try {
				process.kill(-job.pid, "SIGKILL");
			} catch {}
		}
		job.error = "fixer timed out; run /quest-iterate to diagnose and retry";
	}
	// Without a launch identity (an unreadable /proc), only its exit status or the timeout can end the job.
	else if (!job.identity || (job.pid && identity(job.pid) === job.identity)) return false;
	else job.error = `fixer stopped without recording an exit status${restarted}; run /quest-iterate`;
	save(path, job);
	return true;
}

/** New commits descend from the pin. Protected content/modes at the head must match the pin or its merge with `base`, the base the fixer was given. */
export function validateFix(root: string, entry: Pick<Entry, "head">, head: string, base: string): void {
	if (!contains(root, entry.head, head) || head === entry.head)
		throw new Error("fixed head must descend from the pinned PR head");
	for (const commit of git(root, ["rev-list", head, `^${entry.head}`, `^${base}`])
		.split("\n")
		.filter(Boolean)) {
		if (!contains(root, entry.head, commit)) throw new Error("new fixer commit is not on top of pinned head");
	}

	const protectedPath = (path: string) =>
		["flake.nix", "flake.lock", "shell.nix", "default.nix", ".gitmodules", ".envrc", "nix", ".github"].some(
			(prefix) => path === prefix || path.startsWith(`${prefix}/`),
		);
	const merged = tryGit(root, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", entry.head, base]);
	if (merged.status !== 0 && merged.status !== 1) throw new Error("cannot compute protected merge result");
	const [tree, ...conflicts] = merged.stdout.split("\0");
	if (!/^[a-f0-9]{40}$/.test(tree)) throw new Error("invalid protected merge tree");
	const entries = (ref: string) => git(root, ["ls-tree", "-rz", ref]).split("\0").filter(Boolean);
	const maps = [head, entry.head, tree].map(entries);
	const gitlinks = new Set(
		maps.flatMap((list) =>
			list.filter((line) => line.startsWith("160000 ")).map((line) => line.slice(line.indexOf("\t") + 1)),
		),
	);
	const protectedEntry = (line: string) => {
		const path = line.slice(line.indexOf("\t") + 1);
		return protectedPath(path) || gitlinks.has(path);
	};
	const sets = maps.map((list) => list.filter(protectedEntry).sort().join("\0"));
	const protectedConflict = conflicts.some((path) => protectedPath(path) || gitlinks.has(path));
	if (sets[0] !== sets[1] && (protectedConflict || sets[0] !== sets[2]))
		throw new ProtectedEdit("off-limits fixer edit: protected set must equal pinned head or base merge result");
}

/** Anything the fixer writes may echo a token it read; GitHub tokens never reach a post. */
export function redactTokens(text: string): string {
	return text.replace(/\b(?:gh[oprsu]_|github_pat_)[A-Za-z0-9_]{20,}/g, "[redacted token]");
}

/**
 * The fixer's own Markdown comment, quoted under its name. It cannot carry a hidden marker, so it never
 * passes for the daemon's handback, ejection, or apply comments, and it mentions no one.
 */
export function fixerMarkdown(text: string): string {
	let value = redactTokens(text);
	// Removing one opener can join the text around it into another.
	while (value.includes("<!--")) value = value.replaceAll("<!--", "");
	return value
		.replaceAll("@", "[at]")
		.split(/\r?\n|\r/)
		.map((line) => `> ${line}`)
		.join("\n");
}

/** Contributor prose is quoted data, never GitHub markup, mentions, or issue-closing instructions. */
export function fixerText(text: string): string {
	const value = redactTokens(text)
		.replaceAll("<!--", "")
		.slice(0, 500)
		.replaceAll("@", "[at]")
		.replace(/\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b/gi, (word) => `${word.slice(0, 2)}·${word.slice(2)}`)
		.replaceAll("<", "&lt;")
		.replaceAll("#", "&#35;")
		.replaceAll("`", "&#96;")
		.replace(/[\r\n\u0000-\u001f\u007f]/g, " ");
	return `\`${value}\``;
}
/** The fixer's harness, model, and effort, as a PR's `## Models` record names a session. */
export function author(result?: Pick<FixResult, "agent" | "model" | "effort">): string {
	const agent = result?.agent ?? "Codex";
	const model = result?.model;
	return (
		[agent, model && model !== agent ? model : undefined, result?.effort && `${result.effort} effort`]
			.filter(Boolean)
			.join(", ")
			.replace(/[^a-zA-Z0-9 ,._/-]/g, " ")
			.slice(0, 100) || "Codex"
	);
}
/** The PR body with the fix recorded in its `## Review` section; the line names the agent, and the author's text stays as written. */
export function review(body: string, head: string, reason: string, attribution: string): string {
	const line = `mechanical fix by ${attribution}: ${fixerText(reason)} (head ${head})`;
	if (body.includes(line)) return body;
	const section = reviewSection(body);
	if (!section) return `${body}\n\n## Review\n\n${line}`;
	return `${body.slice(0, section.start)}\n\n${line}${body.slice(section.start)}`;
}

/** Who made each mechanical fix that `review` recorded in `body`'s `## Review` section, in its order there. */
export function fixes(body: string): string[] {
	const section = reviewSection(body);
	if (!section) return [];
	return [...body.slice(section.start, section.end).matchAll(/^mechanical fix by ([^:\n]+): /gm)].map((m) => m[1]!);
}

/**
 * The ready commit a handback carries for a validated `head` the daemon cannot publish on `entry`'s PR,
 * while the PR stands at its pinned head: `quest land apply` rebuilds only on the head the fixer worked
 * from.
 */
function ready(
	root: string,
	plan: Pick<Plan, "base">,
	entry: Pick<Entry, "number" | "head">,
	standing: string,
	head: string,
	warn: (message: string) => void,
	cause?: Resolution["cause"],
): Resolution | undefined {
	if (standing !== entry.head) return undefined;
	try {
		return resolution(root, entry.head, plan.base.sha, head, cause);
	} catch (error) {
		warn(`quest land fixer: cannot hand back #${entry.number}'s resolution: ${String(error)}`);
		return undefined;
	}
}

/**
 * Check a fixer's `fixed` head before publishing it on `entry`'s PR: a fork must allow maintainer
 * edits, the head's objects are imported from the fixer's `checkout`, and it must descend from the
 * pinned head and keep the protected paths, judged against the base the fixer was given rather than
 * the current one, since other PRs may land protected changes while the result waits. A fix that edits
 * them is refused with its resolution, for a maintainer to review and push with `quest land apply`,
 * when the PR stands at `entry`'s pinned head.
 */
export async function importFix(
	root: string,
	state: string,
	plan: Pick<Plan, "repository" | "base">,
	entry: Pick<Entry, "number" | "head" | "repository" | "maintainerCanModify">,
	checkout: string,
	packs: string[] | undefined,
	head: string,
	read: RemoteRead,
	standing: string,
	warn: (message: string) => void,
): Promise<void> {
	if (entry.repository !== plan.repository && !entry.maintainerCanModify)
		throw new FixerRefusal("fork does not allow maintainer edits");
	try {
		importFixer(root, state, checkout, `pr-${entry.number}`, head, packs);
	} catch (error) {
		throw new FixerRefusal(String(error));
	}
	await read(root, ["fetch", "--quiet", "--no-tags", baseRemote(plan), plan.base.sha]);
	try {
		validateFix(root, entry, head, plan.base.sha);
	} catch (error) {
		throw new FixerRefusal(
			String(error),
			error instanceof ProtectedEdit ? ready(root, plan, entry, standing, head, warn, "protected") : undefined,
		);
	}
}

/**
 * Publish `head` on `entry`'s PR in place of `standing`, the head it stands at: lease-push it, unless
 * the PR is already at it (`current`), wait for GitHub to show it, and record it as a mechanical fix
 * in the PR body's Review. A refused push throws a `FixerRefusal` carrying the resolution when `head`
 * merges `plan`'s base on the pinned head, for `quest land apply`.
 */
export async function publishHead(
	github: GitHub,
	root: string,
	plan: Pick<Plan, "repository" | "base">,
	entry: Pick<Entry, "number" | "head" | "repository" | "branch">,
	standing: string,
	current: string,
	head: string,
	deps: GitHubDependencies,
	token: (workflows: boolean) => Promise<string>,
	record: { reason: string; attribution: string },
): Promise<void> {
	const pullPath = `/repos/${plan.repository}/pulls/${entry.number}`;
	if (current !== head) {
		const pushed = await push(github, root, {
			remote: `https://github.com/${entry.repository}.git`,
			from: entry.head,
			to: head,
			ref: `refs/heads/${entry.branch}`,
			lease: standing,
			token,
		});
		if (pushed.status !== 0) {
			// GitHub refuses an App's push of a workflow change it lacks the permission for, and a fork's
			// branch rules may refuse any. The maintainer's own push may still pass.
			throw new FixerRefusal(
				`fixer push refused: ${pushed.stderr.trim()}`,
				ready(root, plan, entry, standing, head, deps.warn),
			);
		}
	}
	// GitHub shows a push a moment later. Wait for our own head; only a third head is a real move.
	let latest = object(await (await github.request(pullPath)).json());
	for (let wait = 0; object(latest.head).sha === standing && wait < SYNC_PAUSES; wait++) {
		await github.pause(1000);
		latest = object(await (await github.request(pullPath)).json());
	}
	if (object(latest.head).sha !== head) throw new FixerRefusal("head moved before Review update");
	await github.request(pullPath, {
		method: "PATCH",
		body: {
			body: review(typeof latest.body === "string" ? latest.body : "", head, record.reason, record.attribution),
		},
	});
}

export async function collectFixers(
	root: string,
	state: string,
	deps: GitHubDependencies,
	token: (workflows: boolean) => Promise<string>,
	timeout = 60,
	read: RemoteRead = readRemote,
	checkBase?: (base: Plan["base"]) => Promise<boolean>,
): Promise<string[]> {
	const output: string[] = [];
	for (const name of readdirSync(state).filter((name) => BASE_JOB.test(name))) {
		const path = join(state, name);
		try {
			const job = JSON.parse(readFileSync(path, "utf8")) as BaseJob;
			output.push(...(await collectBaseJob(root, state, path, job, deps, token, timeout, read)));
		} catch (error) {
			// The queue stays halted on its base meanwhile; nothing else waits on this job.
			deps.warn(`quest land fixer: base fix pending for ${name}: ${String(error)}`);
		}
	}
	for (const name of readdirSync(state).filter((name) => /^fix-job-.*\.json$/.test(name))) {
		const path = join(state, name);
		let job: Job;
		try {
			job = JSON.parse(readFileSync(path, "utf8")) as Job;
		} catch (error) {
			deps.warn(`quest land fixer: unreadable job ${name}: ${String(error)}`);
			continue;
		}
		// A job saved before the gate had a method squashed.
		job.plan.method ??= "squash";

		// The first try checks the base if it must; a retry only hands back, so it never checks it.
		const failed = new Set<number>();
		for (let retry = false; ; retry = true) {
			try {
				output.push(
					...(await collectJob(
						root,
						state,
						path,
						job,
						deps,
						token,
						timeout,
						read,
						retry ? undefined : checkBase,
					)),
				);
				break;
			} catch (error) {
				// The gate's own base check failing to run is not the fixer's failure: retry it later.
				if (error instanceof BaseCheckError) {
					deps.warn(`quest land fixer: base check pending for ${name}: ${String(error.cause)}`);
					break;
				}
				const aside = failCollection(job, error, failed);
				save(path, job);
				if (aside !== undefined) {
					deps.warn(
						`quest land fixer: set aside ${aside} from ${name} after ${COLLECTION_ATTEMPTS} failed collections: ${String(error)}`,
					);
					output.push(`set aside ${aside}`);
				} else if (retry) {
					deps.warn(`quest land fixer: handback pending for ${name}: ${String(error)}`);
					break;
				}
			}
		}
	}
	return output;
}

/** Passes in a row that fail to collect the same PR before it is set aside, so its job's other PRs go on. */
export const COLLECTION_ATTEMPTS = 3;

/**
 * Record a failure collecting `job` against the PR it was working on, its first PR left: that PR alone
 * is handed back with it, and its job's other PRs keep their own results. A reason already recorded,
 * such as a crash's, still wins. A PR that keeps failing, as when GitHub refuses its handback, is set
 * aside: it leaves the job, so it rejoins batches as GitHub still queues it, and its number is returned.
 */
function failCollection(job: Job, error: unknown, failed: Set<number>): number | undefined {
	const reason = `fixer collection failed: ${String(error)}; run /quest-iterate`;
	const number = job.numbers[0];
	if (number === undefined) {
		job.error ??= reason;
		return undefined;
	}
	if (!job.error) (job.handbacks ??= {})[number] ??= reason;
	// A pass's retry of the same PR is not another failed collection.
	const failures = (job.failures ??= {});
	if (!failed.has(number)) failures[number] = (failures[number] ?? 0) + 1;
	failed.add(number);
	if (failures[number] < COLLECTION_ATTEMPTS) return undefined;
	job.numbers.shift();
	return number;
}

/** An exit status as a cause: a signal by name (143 is SIGTERM), or a crash with its code (101 is a Rust panic). */
function exited(code: string): string {
	const signal = Object.entries(osConstants.signals).find(([, number]) => 128 + number === Number(code))?.[0];
	return signal ? `stopped by ${signal} (exit ${code})` : `crashed (exit ${code})`;
}

async function collectJob(
	root: string,
	state: string,
	path: string,
	job: Job,
	deps: GitHubDependencies,
	token: (workflows: boolean) => Promise<string>,
	timeout: number,
	read: RemoteRead,
	checkBase?: (base: Plan["base"]) => Promise<boolean>,
): Promise<string[]> {
	const github = new GitHub(deps);
	const output: string[] = [];
	if (
		!job.results &&
		!job.error &&
		!settle(
			path,
			job,
			deps,
			timeout,
			() => (job.results = parseFixResult(readFixResult(job.checkout), job.numbers, knownFlaky(job.checkout))),
		)
	)
		return output;
	const named = job.results?.some((result) => result.blame === true) ?? false;
	// The fixer could not say which PR broke the batch: check the base alone before anything else
	// happens to them. A PR's content cannot skip this, since only the gate runs it.
	if (job.parked && job.results && !job.error && !job.blame && !named && job.base === undefined) {
		if (!checkBase) return output;
		try {
			// This job's base may be stale. While a halt stands, never let it replace that halt or close
			// its fix: the queue is halted anyway, so the job's PRs go back unchecked.
			job.base = readHalt(state) ? false : await checkBase(job.plan.base);
		} catch (error) {
			throw new BaseCheckError("base check failed to run", { cause: error });
		}
		save(path, job);
	}
	// A red base halted the queue: the batch's PRs did nothing wrong, so all of them go back unchanged.
	if (job.base === false) {
		for (const number of job.numbers) output.push(`released ${number}`);
		job.numbers = [];
	}
	const name = basename(path);
	while (job.numbers.length) {
		const number = job.numbers[0];
		const entry = job.plan.queue.find((entry) => entry.number === number)!;
		const result = job.results?.find((item) => item.number === number);
		// The gate's blame, else the fixer's; when the fixer named none and the base passed, every PR.
		// An older job's PRs were ejected and keep its rules.
		const blamed =
			job.parked === true &&
			(job.blame ? job.blame.includes(number) : named ? result?.blame === true : job.base === true);
		let error = job.handbacks?.[number] ?? job.error;
		const pullPath = `/repos/${job.plan.repository}/pulls/${number}`;
		const pull = object(await (await github.request(pullPath)).json());
		// A PR merged while the fixer ran has landed: there is nothing to apply, hand back, or take out
		// of the queue, and GitHub refuses to disable a merged PR's auto-merge, which it still reports.
		if (pull.merged === true) {
			output.push(`merged ${number}`);
			job.numbers.shift();
			save(path, job);
			continue;
		}
		const current = string(object(pull.head).sha);
		const queued = await github.graphql(
			"query($id: ID!) { node(id: $id) { ... on PullRequest { state autoMergeRequest { enabledAt } } } }",
			{ id: entry.id },
		);
		const auto = object(queued.node).autoMergeRequest;
		let previous = history(state, number)!;
		// The head the PR stands at: its pinned head, or the gate's own base merge on it for this pick, as
		// when the gate pushed that merge and then failed to land it (moq-dev/quest#342). The gate's merge is
		// known only from its private record, never from its forgeable author or message.
		const standing =
			current !== entry.head && isPrepared(root, state, { ...entry, head: current }) ? current : entry.head;
		const head = result?.action === "fixed" ? result.head : standing;
		const actor = { agent: result?.agent, model: result?.model };
		const queuedAs = auto == null ? null : string(object(auto).enabledAt);
		// This collection already enabled auto-merge again on the fixed head, before a restart.
		const requeued =
			queuedAs !== null &&
			queuedAs !== entry.enabledAt &&
			job.published.includes(number) &&
			current === head &&
			previous.head === head &&
			(!previous.requeued || previous.requeued === queuedAs);
		if (!samePick(previous, entry))
			error = "fixer was superseded by a newer maintainer pick; keeping its work untouched";
		// Never displace a newer maintainer pick, closed PR, or writer's commit.
		if (pull.state !== "open" || (current !== standing && !(job.published.includes(number) && current === head)))
			error = "PR closed or head moved while fixing; inspect and pick it again";
		const left = job.left?.includes(number) ?? false;
		// A parked PR keeps its auto-merge; one an older job's ejection left without it is requeued below.
		if (job.parked && queuedAs === null && !left)
			error ??= "PR left the queue while fixing; its result was not applied";
		else if (queuedAs !== null && queuedAs !== entry.enabledAt && !requeued)
			error = "PR was picked again while fixing; keeping the newer pick";
		// Only a blamed PR's failure is a round of its pick; collateral of another PR's failure never is. A
		// conflict names its base; otherwise the fixer names the failure, or the gate's one check step does.
		let round: Round | undefined;
		if (blamed && !error) {
			const failure =
				job.reason === "merge_conflict"
					? conflictFailure(job.plan.base.sha)
					: (result?.failure ?? job.reason ?? "failed_checks");
			// A PR requeued unchanged fails for the cause the fixer named, flaky when it named none, unless the
			// gate itself blamed it, as for a conflict that is still there: a blamed PR the fixer named is never
			// requeued.
			const outcome: Outcome =
				result?.action === "fixed"
					? "fixed"
					: result?.action === "requeue"
						? job.blame
							? "unchanged"
							: (result.cause ?? "flaky")
						: "handback";
			const rule = stopRule(
				previous.rounds.filter((item) => item.job !== name),
				{ outcome, failure },
			);
			if (rule) error = stopReason(rule, { outcome, failure });
			// The gate's merge stood on the pin: either the plan's head is that merge, or the merge is newer than it.
			const pinned = [entry.approved, entry.head].find((pin) => pin !== standing);
			const pin = pinned ? { pin: pinned } : {};
			round = rule
				? { job: name, outcome: "handback", before: standing, ...pin, failure, rule }
				: {
						job: name,
						outcome,
						before: standing,
						...pin,
						failure,
						...(outcome === "handback" ? {} : { after: head }),
					};
			previous = saveRound(state, number, previous, round);
		}
		if (requeued) {
			save(historyPath(state, number), { ...previous, requeued: queuedAs });
		} else if (!error && result?.action !== "handback") {
			try {
				if (result?.action === "fixed")
					await importFix(
						root,
						state,
						job.plan,
						entry,
						job.checkout,
						job.packs,
						head,
						read,
						standing,
						deps.warn,
					);
				if (!job.published.includes(number)) {
					job.published.push(number);
					save(path, job);
				}
				// The fix descends from the pin, not from a gate merge the PR stands at: it replaces that
				// merge, as the gate replaces its own, since building on it would revert the newer base it
				// merged. The lease still refuses any writer's commit.
				if (result?.action === "fixed")
					await publishHead(github, root, job.plan, entry, standing, current, head, deps, token, {
						reason: result.reason,
						attribution: author(result),
					});

				// The fix read no finding or decision on the pick it replaces, so those still hold it.
				if (head !== entry.head) {
					const [owner, repo] = job.plan.repository.split("/");
					const carried = carriedBy(state, number, head);
					const held = (
						await readSignals(
							github,
							{ owner: owner!, repo: repo! },
							[number],
							carried && new Map([[number, carried]]),
						)
					).get(number)!;
					if (held.head !== head) throw new FixerRefusal("head moved before it was re-enqueued");
					if (held.signals.length > 0)
						throw new FixerRefusal(`its head is held by ${describe(held.signals)}`);
				}
				// A parked PR requeued unchanged is still queued as it was; anything else is pinned anew.
				if (queuedAs !== entry.enabledAt || head !== entry.head) {
					// Save intent before enabling, so a lost response can be reconciled after restart.
					save(historyPath(state, number), { ...previous, ...actor, head });
					await enqueue(github, entry.id, head, job.plan.method);
					const enabled = await github.graphql(
						"query($id: ID!) { node(id: $id) { ... on PullRequest { autoMergeRequest { enabledAt } } } }",
						{ id: entry.id },
					);
					const enabledAt = string(object(object(enabled.node).autoMergeRequest).enabledAt);
					save(historyPath(state, number), { ...previous, ...actor, head, requeued: enabledAt });
				}
			} catch (failure) {
				if (!(failure instanceof FixerRefusal)) throw failure;
				if (failure.resolution) (job.resolutions ??= {})[number] = failure.resolution;
				error = `${String(failure)}; run /quest-iterate before picking it again`;
			}
		}
		// The fixer's own note goes first, so the daemon's outcome comment follows it.
		if (result?.comment)
			await post(
				github,
				job.plan,
				entry,
				`${author(result)} land fixer note:\n\n${fixerMarkdown(result.comment)}`,
				"note",
				author(result),
			);

		const handback = error !== undefined || result?.action === "handback";
		// A refused fix or requeue ends the round in a handback after all.
		if (handback && round && round.outcome !== "handback") {
			// It keeps `after`: a head it published carries this pick's signals when picked again.
			saveRound(state, number, history(state, number)!, { ...round, outcome: "handback" });
		}
		if (error) {
			// Before leaving the queue, so a restart keeps this reason rather than finding it left.
			job.handbacks ??= {};
			job.handbacks[number] = error;
			save(path, job);
		}
		// A handback takes the PR out of the queue, as parked or as this collection requeued it, never a
		// newer pick, even when a retry finds it already left once.
		const ours = queuedAs !== null && (queuedAs === entry.enabledAt || requeued);
		const leaves = handback && (ours || (left && queuedAs === null));
		if (leaves) {
			if (!left) {
				job.left = [...(job.left ?? []), number];
				save(path, job);
			}
			// A closed PR is out of the queue already, and GitHub refuses to disable its auto-merge.
			if (ours && pull.state === "open")
				await github.graphql(
					"mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }",
					{ id: entry.id },
				);
		}

		if (handback)
			await comment(
				github,
				job.plan,
				entry,
				error
					? `${error.slice(0, 300)}. Recommendation: run /quest-iterate before picking it again.`
					: result?.action === "handback"
						? `${result.diagnosis.slice(0, 200)}. Recommendation: ${result.recommendation.slice(0, 200)}`
						: "missing result; run /quest-iterate",
				"handback",
				author(result),
				handbackLog(job.log ?? "", !error && result?.action === "handback" ? result.log : undefined),
				// The marker `quest status` reads, now that no ejection comment precedes this one.
				job.parked && leaves ? (job.reason ?? "failed_checks") : undefined,
				error && job.resolutions?.[number]
					? (room) => resolutionSection(number, job.resolutions![number], room)
					: undefined,
			);
		output.push(`${error || result?.action === "handback" ? "handback" : "requeued"} ${number}`);
		job.numbers.shift();
		save(path, job);
	}
	rmSync(job.checkout, { recursive: true, force: true });
	rmSync(`${path}.exit`, { force: true });
	rmSync(path);
	return output;
}
