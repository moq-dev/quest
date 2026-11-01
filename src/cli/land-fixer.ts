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
import { MERGE_LABEL } from "../core";
import { GitHub, type GitHubDependencies, object, string } from "./github";
import {
	baseRemote,
	commandEnvironment,
	contains,
	eject,
	ejection,
	git,
	tryGit,
	enqueue,
	type Entry,
	type Ejection,
	type Plan,
	type Reason,
} from "./land";
import { COMMENT_LIMIT, resolution, resolutionSection, type Resolution } from "./land-apply";
import { readFixResult, parseBaseFix, parseFixResult, type BaseFix, type FixResult } from "./land-fix";
import { readRemote, type RemoteRead } from "./land";
import { importFixer } from "./land-fixer-repository";
import { push, remoteHead } from "./land-head";
import { BASE_JOB, type Halt, haltNotice, readHalt, saveHalt } from "./land-halt";
import { isParked, parked } from "./land-park";
import { excerpt, type Failure } from "./land-serve";

class FixerRefusal extends Error {}
class BaseCheckError extends Error {}

/** The failure log's lines the fixer cited, first to last; the comment bounds them. */
function cited(log: string, [first, last]: [number, number]): string {
	if (!existsSync(log)) return "";
	return readFileSync(log, "utf8")
		.split("\n")
		.slice(first - 1, last)
		.join("\n")
		.trimEnd();
}

/** Read a bounded tail, retaining the complete per-job log for host diagnosis. */
function fixerLog(path: string): string {
	if (!existsSync(`${path}.log`)) return "";
	const fd = openSync(`${path}.log`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) return "";
		const buffer = Buffer.alloc(Math.min(stat.size, 16_384));
		const length = readSync(fd, buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length));
		return buffer.subarray(0, length).toString("utf8").trimEnd().split("\n").slice(-100).join("\n");
	} finally {
		closeSync(fd);
	}
}

/** A fixer process the daemon tracks across restarts, and how it ended. */
interface Process {
	checkout: string;
	started: number;
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
	/** PRs a handback is taking out of the queue, recorded before their auto-merge is disabled. */
	left?: number[];
	/** Validated fixes GitHub refused to publish, handed back for a maintainer to push. */
	resolutions?: Record<number, Resolution>;
	// Persist publication before moving a remote head; retries recognize only this exact head.
	published: number[];
}
/** A maintainer pick's fixer attempt; a fixed head's requeue keeps it as `requeued`. */
export interface Attempt {
	agent?: string;
	model?: string;
	pick: string;
	requeued?: string;
	head?: string;
	/**
	 * The job that blamed this pick, which spends its attempt, or false while it was only collateral of
	 * other PRs' failures. A record from before blame was tracked has none, and counts as spent.
	 */
	blamed?: string | false;
}
function save(path: string, data: unknown): void {
	writeFileSync(`${path}.new`, JSON.stringify(data), { mode: 0o600 });
	renameSync(`${path}.new`, path);
}
const attemptPath = (state: string, number: number) => join(state, `fix-attempt-${number}.json`);
export function attempt(state: string, number: number): Attempt | undefined {
	const path = attemptPath(state, number);
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Attempt) : undefined;
}
/** Whether `record` belongs to the pick `entry` is queued under: the pick itself, or the fixer's requeue of it. */
function samePick(record: Attempt | undefined, entry: Pick<Entry, "enabledAt">): record is Attempt {
	return record !== undefined && (record.pick === entry.enabledAt || record.requeued === entry.enabledAt);
}
/** Whether the pick already spent its attempt on a job other than `job`: only being blamed spends it. */
function spent(record: Attempt | undefined, entry: Pick<Entry, "enabledAt">, job?: string): boolean {
	return samePick(record, entry) && record.blamed !== false && (job === undefined || record.blamed !== job);
}
function identity(pid: number): string | undefined {
	try {
		return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[19]}`;
	} catch {
		return undefined;
	}
}
async function comment(
	github: GitHub,
	plan: Plan,
	entry: Pick<Entry, "number" | "enabledAt">,
	text: string,
	suffix: string,
	attribution = "Codex",
	log = "",
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
	const lead = `${attribution} land fixer: ${fixerText(text)}${log ? `\n\n<pre>${excerpt(log)}</pre>` : ""}`;
	const tail = `\n\n${marker}${reason ? `\n<!-- quest land: ${reason} -->` : ""}\n\n(written by ${attribution})`;
	const extra = section?.(COMMENT_LIMIT - lead.length - tail.length) ?? "";
	await github.request(path, { body: { body: `${lead}${extra}${tail}` } });
}

/** Queue eligibility can eject a previously requeued PR before building another batch. */
/** How many one-second pauses to wait for GitHub to show a pushed head. */
const SYNC_PAUSES = 60;

export async function handbackRepeated(
	state: string,
	plan: Plan,
	entry: Ejection | Entry,
	deps: GitHubDependencies,
): Promise<boolean> {
	const previous = attempt(state, entry.number);
	if (!spent(previous, entry)) return false;
	await comment(
		new GitHub(deps),
		plan,
		entry,
		"This maintainer pick already used its mechanical fix attempt. Run /quest-iterate to diagnose the repeated failure, then pick it again.",
		"handback",
		author(previous!),
	);
	return true;
}

/**
 * Park the failure's PRs and start one fixer job on them. A PR the gate already blames, as for a
 * conflict, whose pick spent its attempt is handed back instead. Returns what it did.
 */
export async function startFixer(
	root: string,
	checkout: string,
	failure: Failure,
	fixer: string,
	state: string,
	deps: GitHubDependencies,
): Promise<string[]> {
	const lines: string[] = [];
	const entries: Entry[] = [];
	const held = parked(state);
	for (const entry of failure.plan.queue.filter((item) => failure.numbers.includes(item.number))) {
		// failure.json may replay after launching this same job. It is not a second pick.
		if (isParked(held, entry)) continue;
		const previous = attempt(state, entry.number);
		if (failure.blame?.includes(entry.number) && spent(previous, entry)) {
			const detail =
				"this maintainer pick already used its mechanical fix attempt. Run /quest-iterate to diagnose the repeated failure, then pick it again";
			if (await eject(new GitHub(deps), failure.plan, ejection(entry, failure.reason ?? "failed_checks", detail)))
				lines.push(`handback ${entry.number}`);
			continue;
		}
		if (!samePick(previous, entry))
			save(attemptPath(state, entry.number), { pick: entry.enabledAt, blamed: false });
		entries.push(entry);
	}
	if (!entries.length) {
		rmSync(checkout, { recursive: true, force: true });
		return lines;
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
	for (const number of job.numbers) lines.push(`parked ${number}`);
	return lines;
}

/**
 * A standalone repository in `checkout` holding `refs` fetched from the daemon's, detached at
 * `start`. Returns the packs the fetch wrote, whose objects the daemon already has.
 */
function prepare(root: string, checkout: string, refs: string[], start: string): string[] {
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
	// A retry after a restart finds its own push already there.
	if ((await remoteHead(root, remote, ref, read)) !== result.head) {
		const pushed = await push(root, remote, base.sha, result.head, ref, token, "");
		if (pushed.status !== 0) throw new FixerRefusal(`fix push refused: ${pushed.stderr.trim()}`);
	}
	const github = new GitHub(deps);
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
async function launch(path: string, job: Process, fixer: string, log: string, numbers: number[]): Promise<void> {
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
			{ cwd: job.checkout, detached: true, env: commandEnvironment(), stdio: ["ignore", output, output] },
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
function settle(path: string, job: Process, deps: GitHubDependencies, timeout: number, read: () => void): boolean {
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
	} else if (deps.now() - job.started > timeout * 60_000) {
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
		throw new Error("off-limits fixer edit: protected set must equal pinned head or base merge result");
}

/** Contributor prose is quoted data, never GitHub markup, mentions, or issue-closing instructions. */
export function fixerText(text: string): string {
	const value = text
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
function author(result?: Pick<FixResult, "agent" | "model">): string {
	const agent = result?.agent ?? "Codex";
	const model = result?.model;
	return (
		[agent, model && model !== agent ? model : undefined]
			.filter(Boolean)
			.join(" / ")
			.replace(/[^a-zA-Z0-9 ._/-]/g, " ")
			.slice(0, 100) || "Codex"
	);
}
/** The PR body with the fix recorded in its `## Review` section; the line names the agent, and the author's text stays as written. */
function review(body: string, head: string, reason: string, attribution: string): string {
	const line = `mechanical fix by ${attribution}: ${fixerText(reason)} (head ${head})`;
	if (body.includes(line)) return body;
	const section = /^## Review[ \t]*\r?$/m.exec(body);
	if (!section) return `${body}\n\n## Review\n\n${line}`;
	const start = section.index + section[0].length;
	return `${body.slice(0, start)}\n\n${line}${body.slice(start)}`;
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

		try {
			output.push(...(await collectJob(root, state, path, job, deps, token, timeout, read, checkBase)));
		} catch (error) {
			// The gate's own base check failing to run is not the fixer's failure: retry it later.
			if (error instanceof BaseCheckError) {
				deps.warn(`quest land fixer: base check pending for ${name}: ${String(error.cause)}`);
				continue;
			}
			// Keep the first reason: a GitHub error while handing back a crash must not replace the crash.
			job.error ??= `fixer collection failed: ${String(error)}; run /quest-iterate`;
			try {
				save(path, job);
				output.push(...(await collectJob(root, state, path, job, deps, token, timeout, read)));
			} catch (failure) {
				deps.warn(`quest land fixer: handback pending for ${name}: ${String(failure)}`);
			}
		}
	}
	return output;
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
			() => (job.results = parseFixResult(readFixResult(job.checkout), job.numbers)),
		)
	)
		return output;
	const named = job.results?.some((result) => result.blame === true) ?? false;
	// The fixer could not say which PR broke the batch: check the base alone before anything else
	// happens to them. A PR's content cannot skip this, since only the gate runs it.
	if (job.parked && job.results && !job.error && !job.blame && !named && job.base === undefined) {
		if (!checkBase) return output;
		try {
			job.base = await checkBase(job.plan.base);
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
		const current = string(object(pull.head).sha);
		const queued = await github.graphql(
			"query($id: ID!) { node(id: $id) { ... on PullRequest { state autoMergeRequest { enabledAt } } } }",
			{ id: entry.id },
		);
		const auto = object(queued.node).autoMergeRequest;
		let previous = attempt(state, number)!;
		const head = result?.action === "fixed" ? result.head : entry.head;
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
		if (pull.state !== "open" || (current !== entry.head && !(job.published.includes(number) && current === head)))
			error = "PR closed or head moved while fixing; inspect and pick it again";
		const left = job.left?.includes(number) ?? false;
		// A parked PR keeps its auto-merge; one an older job's ejection left without it is requeued below.
		if (job.parked && queuedAs === null && !left)
			error ??= "PR left the queue while fixing; its result was not applied";
		else if (queuedAs !== null && queuedAs !== entry.enabledAt && !requeued)
			error = "PR was picked again while fixing; keeping the newer pick";
		// Only a blamed PR spends the pick's attempt; collateral of another PR's failure never does.
		if (blamed && spent(previous, entry, name))
			error ??=
				"This maintainer pick already used its mechanical fix attempt. Run /quest-iterate to diagnose the repeated failure, then pick it again";
		if (requeued) {
			save(attemptPath(state, number), { ...previous, requeued: queuedAs });
		} else if (!error && result?.action !== "handback") {
			if (blamed && previous.blamed !== name) {
				previous = { ...previous, blamed: name };
				save(attemptPath(state, number), previous);
			}
			try {
				if (result?.action === "fixed") {
					if (entry.repository !== job.plan.repository && !entry.maintainerCanModify)
						throw new FixerRefusal("fork does not allow maintainer edits");
					try {
						importFixer(root, state, job.checkout, `pr-${number}`, head, job.packs);
					} catch (error) {
						throw new FixerRefusal(String(error));
					}
					// Validate against the base the fixer was given, not the current one: other PRs may
					// land protected changes while the result waits, and the requeue re-merges anyway.
					await read(root, ["fetch", "--quiet", "--no-tags", baseRemote(job.plan), job.plan.base.sha]);
					try {
						validateFix(root, entry, head, job.plan.base.sha);
					} catch (error) {
						throw new FixerRefusal(String(error));
					}
				}
				if (!job.published.includes(number)) {
					job.published.push(number);
					save(path, job);
				}
				if (result?.action === "fixed" && current !== head) {
					const pushed = await push(
						root,
						`https://github.com/${entry.repository}.git`,
						entry.head,
						head,
						`refs/heads/${entry.branch}`,
						token,
					);
					if (pushed.status !== 0) {
						// GitHub refuses an App's push of a workflow change it lacks the permission for, and a
						// fork's branch rules may refuse any. The maintainer's own push may still pass.
						try {
							const ready = resolution(root, entry.head, job.plan.base.sha, head);
							if (ready) (job.resolutions ??= {})[number] = ready;
						} catch (error) {
							deps.warn(`quest land fixer: cannot hand back #${number}'s resolution: ${String(error)}`);
						}
						throw new FixerRefusal(`fixer push refused: ${pushed.stderr.trim()}`);
					}
				}

				if (result?.action === "fixed") {
					// GitHub shows a push a moment later. Wait for our own head; only a third head is a real move.
					let latest = object(await (await github.request(pullPath)).json());
					for (let wait = 0; object(latest.head).sha === entry.head && wait < SYNC_PAUSES; wait++) {
						await github.pause(1000);
						latest = object(await (await github.request(pullPath)).json());
					}
					if (object(latest.head).sha !== head) throw new FixerRefusal("head moved before Review update");
					await github.request(pullPath, {
						method: "PATCH",
						body: {
							body: review(
								typeof latest.body === "string" ? latest.body : "",
								head,
								result.reason,
								author(result),
							),
						},
					});
				}

				// A parked PR requeued unchanged is still queued as it was; anything else is pinned anew.
				if (queuedAs !== entry.enabledAt || head !== entry.head) {
					// Save intent before enabling, so a lost response can be reconciled after restart.
					save(attemptPath(state, number), { ...previous, ...actor, head });
					await enqueue(github, entry.id, head);
					const enabled = await github.graphql(
						"query($id: ID!) { node(id: $id) { ... on PullRequest { autoMergeRequest { enabledAt } } } }",
						{ id: entry.id },
					);
					const enabledAt = string(object(object(enabled.node).autoMergeRequest).enabledAt);
					save(attemptPath(state, number), { ...previous, ...actor, head, requeued: enabledAt });
				}
			} catch (failure) {
				if (!(failure instanceof FixerRefusal)) throw failure;
				error = `${String(failure)}; run /quest-iterate before picking it again`;
			}
		}
		if (!error && result?.action !== "handback") {
			// A PR that stayed queued needs no comment: its own fix, if any, is recorded in `## Review`.
			await github.request(`/repos/${job.plan.repository}/issues/${number}/labels`, {
				body: { labels: [MERGE_LABEL] },
			});
		}

		const handback = error !== undefined || result?.action === "handback";
		if (handback && blamed && !error && previous.blamed !== name)
			save(attemptPath(state, number), { ...previous, blamed: name });
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
			if (ours)
				await github.graphql(
					"mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }",
					{ id: entry.id },
				);
			await github.request(
				`/repos/${job.plan.repository}/issues/${number}/labels/${encodeURIComponent(MERGE_LABEL)}`,
				{ method: "DELETE", allow: [404] },
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
				!error && result?.action === "handback" && result.log && job.log
					? cited(job.log, result.log)
					: fixerLog(path),
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
