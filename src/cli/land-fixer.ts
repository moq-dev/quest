// Trusted host side: durable background jobs, validation, and credentialed publication.
import { spawn } from "node:child_process";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	openSync,
	readSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import { reviewSection } from "../core";
import { GitHub, type GitHubDependencies, type ObjectValue, object, string } from "./github";
import { baseRemote, commandEnvironment, contains, git, tryGit, type Entry, type Plan, type Reason } from "./land";
import { COMMENT_LIMIT, resolution, type Resolution } from "./land-apply";
import { CAUSES, type Cause, signature, type FixResult } from "./land-fix";
import type { RemoteRead } from "./land";
import { importFixer } from "./land-fixer-repository";
import { push } from "./land-head";
import { excerpt } from "./land-daemon";
import type { Carried } from "./signals";

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
/** A refusal because a finding or decision holds the head, which `quest status` reports as `unanswered_signal`. */
export class SignalRefusal extends FixerRefusal {}
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
const carryPath = (state: string, number: number, head: string) => join(state, `carry-${number}-${head}.json`);
/**
 * What the fixer's `head` of PR `number` carries from the pick it replaces: the heads its rounds replaced, with the
 * pins the gate's base merges stood on, and when the pick was made. Its own record, written once when a round puts the
 * head back, outlives handbacks, holds, and removals, since the person who picks the head again has answered nothing;
 * a head no round put back, such as a writer's push, carries nothing.
 */
export function carriedBy(state: string, number: number, head: string): Carried | undefined {
	const path = carryPath(state, number, head);
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Carried) : undefined;
}
/** Record what the head `round` put back carries, unless a record already holds it: a carry is never rewritten. */
export function saveCarry(
	state: string,
	number: number,
	pick: string,
	round: Pick<Round, "before" | "after" | "pin">,
): void {
	const after = round.after;
	if (!after || !Number.isFinite(Date.parse(pick))) return;
	const path = carryPath(state, number, after);
	if (existsSync(path)) return;
	// The heads it replaced, a gate merge's pin included, may carry an earlier pick's signals, which picking them
	// again answered none of. An unchanged requeue of a gate merge still carries its pin's.
	const replaced = round.pin ? [round.before, round.pin] : [round.before];
	const earlier = replaced.flatMap((head) => carriedBy(state, number, head) ?? []);
	const heads = [...new Set([...earlier.flatMap((carry) => carry.heads), ...replaced])].filter(
		(head) => head !== after,
	);
	if (heads.length === 0) return;
	const picked = [pick, ...earlier.map((carry) => carry.picked)].reduce((a, b) =>
		Date.parse(b) < Date.parse(a) ? b : a,
	);
	save(path, { heads, picked } satisfies Carried);
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
	saveCarry(state, number, record.pick, round);
	save(historyPath(state, number), next);
	return next;
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
 * A standalone repository in `checkout` holding `refs` fetched from the daemon's, with `base` as both `base` and
 * `origin/<base>`, detached at it. Returns the packs the fetch wrote, whose objects the daemon already has.
 */
export function prepare(root: string, checkout: string, refs: string[], base: { ref: string; sha: string }): string[] {
	// The checkout has no remote, so checks that diff against `origin/<base>` find the base the round works on.
	refs = [...refs, `${base.sha}:refs/heads/base`, `${base.sha}:refs/remotes/origin/${base.ref}`];
	git(checkout, ["init", "--quiet"]);
	// No background gc or maintenance may rewrite objects while the daemon imports the fixer's result.
	git(checkout, ["config", "gc.auto", "0"]);
	git(checkout, ["config", "maintenance.auto", "false"]);
	git(checkout, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", root, ...refs]);
	git(checkout, ["config", "user.name", "quest fixer"]);
	git(checkout, ["config", "user.email", "quest-fixer@localhost"]);
	git(checkout, ["checkout", "--quiet", "--detach", base.sha]);
	return readdirSync(join(checkout, ".git", "objects", "pack")).filter((name) => name.endsWith(".pack"));
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

/** Passes in a row that fail to collect the same PR before it is set aside, so its job's other PRs go on. */
export const COLLECTION_ATTEMPTS = 3;

/** An exit status as a cause: a signal by name (143 is SIGTERM), or a crash with its code (101 is a Rust panic). */
function exited(code: string): string {
	const signal = Object.entries(osConstants.signals).find(([, number]) => 128 + number === Number(code))?.[0];
	return signal ? `stopped by ${signal} (exit ${code})` : `crashed (exit ${code})`;
}
