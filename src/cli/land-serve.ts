// Host orchestration: PR code runs only through the configured sandbox.
import { authenticatedRead } from "./land-git";
import { startFixer, startBaseFixer, collectFixers, handbackRepeated } from "./land-fixer";
import { closeFix, fixing, haltNotice, readHalt, resume, saveHalt } from "./land-halt";
import { batchable } from "./land-park";
import { spawn } from "node:child_process";
import { createPrivateKey, createSign } from "node:crypto";
import {
	accessSync,
	constants,
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { GitHub, type GitHubDependencies, type Repository, object, string } from "./github";
import { forgetHeads, prepareHead, resolvePreparedQueue, landFallback, finishFallback } from "./land-head";
import {
	type BatchPolicy,
	baseRemote,
	build,
	commandEnvironment,
	eject,
	ejection,
	git,
	readRemote,
	type Overlap,
	type RemoteRead,
	type Plan,
	type Reason,
} from "./land";

export interface ServeOptions {
	base?: string;
	/** Empty for the default, `defaultState`. */
	state: string;
	sandbox: string;
	fixer?: string;
	appId: string;
	/** Minutes the sandbox may run before the batch fails. */
	timeout: number;
}

/** Mint a short-lived token for this repository, never the installation's other repositories. */
export async function installationToken(
	repository: Repository,
	options: Pick<ServeOptions, "appId">,
	permissions: Record<string, "read" | "write">,
	deps: Pick<GitHubDependencies, "fetch" | "now">,
): Promise<string> {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const now = Math.floor(deps.now() / 1000);
	const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: options.appId })}`;
	const signature = createSign("RSA-SHA256").update(payload).sign(readFileSync(keyPath())).toString("base64url");
	const request = async (path: string, body?: unknown) => {
		const response = await deps.fetch(`https://api.github.com${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				Authorization: `Bearer ${payload}.${signature}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "quest",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!response.ok) throw new Error(`GitHub App request failed: HTTP ${response.status}`);
		return object(await response.json());
	};
	const installation = await request(`/repos/${repository.owner}/${repository.repo}/installation`);
	return string(
		(
			await request(`/app/installations/${Number(installation.id)}/access_tokens`, {
				repositories: [repository.repo],
				permissions,
			})
		).token,
	);
}

type Chain = Awaited<ReturnType<typeof build>>;
function save(path: string, value: unknown): void {
	writeFileSync(`${path}.new`, JSON.stringify(value), { mode: 0o600 });
	renameSync(`${path}.new`, path);
}

/**
 * The merge needs workflow write when this PR's squash changes a workflow, or when any commit the PR
 * brings changes one: GitHub refuses an App's merge of a PR whose commits touch workflows, such as a
 * merge of a base that changed one, whether the gate or the author made it.
 */
export function touchesWorkflows(
	root: string,
	parent: string,
	link: Chain["links"][number],
	base: string,
	head: string,
): boolean {
	if (git(root, ["diff", "--name-only", parent, link.commit, "--", ".github/workflows"]) !== "") return true;
	// `-m` also lists a merge commit's changes against each parent, so a merged-in workflow change counts.
	return git(root, ["log", "-m", "--format=", "--name-only", `${base}..${head}`, "--", ".github/workflows"]) !== "";
}

/** A fresh bare repository with no config, objects, or alternates inherited from the user's checkout. */
export function privateRepository(state: string): string {
	const path = join(state, "repository.git");
	if (!existsSync(path)) {
		mkdirSync(path, { mode: 0o700 });
		git(path, ["init", "--bare", "--quiet"]);
		git(path, ["config", "user.name", "moq-bot"]);
		git(path, ["config", "user.email", "moq-bot@users.noreply.github.com"]);
	}
	return path;
}

/**
 * A standalone shallow clone from the tested tip through its base: `HEAD` is the commit being checked, so tools that need a
 * repository work. It has no remote and no alternates, so nothing in it links back to the daemon's
 * repository, and a checkout ignores `export-ignore` and `export-subst`, so a PR cannot hide files.
 */
function sandboxTree(root: string, state: string, tip: string, links: number): string {
	const checkout = mkdtempSync(join(state, "check-"));
	// A shallow fetch needs a ref; this one lives only for the fetch.
	const ref = "refs/quest-land/check";
	git(root, ["update-ref", ref, tip]);
	try {
		git(checkout, ["init", "--quiet"]);
		git(checkout, ["fetch", "--quiet", "--no-tags", `--depth=${links + 1}`, `file://${root}`, ref]);
		git(checkout, ["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
	} finally {
		git(root, ["update-ref", "-d", ref]);
	}
	return checkout;
}

/** The App key's path, never in argv, where any process could read it from /proc. */
export function keyPath(): string {
	const path =
		process.env.QUEST_LAND_KEY ||
		(process.env.CREDENTIALS_DIRECTORY ? join(process.env.CREDENTIALS_DIRECTORY, "github-app-key") : undefined);
	if (!path) throw new Error("set QUEST_LAND_KEY or provide the github-app-key systemd credential");
	return path;
}

/** systemd's StateDirectory, or the XDG state home, outside any checkout a sandbox might mount. */
export function defaultState(repository: Repository): string {
	const home =
		process.env.STATE_DIRECTORY ??
		join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "quest-land");
	return join(home, `${repository.owner}-${repository.repo}`);
}

/** Refresh before expiry and retry a revoked token once; callers never retain an expired token. */
export function apiDependencies(
	mint: () => Promise<string>,
	base: Omit<GitHubDependencies, "token">,
): GitHubDependencies {
	let cached: { token: string; until: number } | undefined;
	return {
		...base,
		token: "quest-api",
		fetch: (async (input, init) => {
			// A merge's fresh, PR-scoped token must not be replaced by the cached queue token.
			const authorization = new Headers(init?.headers).get("Authorization");
			if (authorization && authorization !== "Bearer quest-api") return base.fetch(input, init);
			const request = async () => {
				if (!cached || base.now() >= cached.until)
					cached = { token: await mint(), until: base.now() + 50 * 60_000 };
				const headers = new Headers(init?.headers);
				headers.set("Authorization", `Bearer ${cached.token}`);
				return base.fetch(input, { ...init, headers });
			};
			let response = await request();
			if (response.status === 401) {
				cached = undefined;
				response = await request();
			}
			return response;
		}) as typeof fetch,
	};
}

/**
 * A failure the gate hands on: PRs it ejects, and PRs it parks for the fixer. A parked PR stays
 * queued with its auto-merge and sits out batches while its fixer job runs (see `parked`).
 */
export interface Failure {
	plan: Plan;
	ejections: Plan["eject"];
	/** The PRs the fixer works on, parked until each one's result is collected. */
	numbers: number[];
	log: string;
	tip: string;
	/** Why the parked PRs failed, which a handback records for `quest status`. */
	reason?: Reason;
	/** The PRs the gate itself blames, as for a conflict; absent when the fixer must say which PR broke a batch. */
	blame?: number[];
	/** The fixer job started, so a replay after a restart never starts a second one. */
	launched?: boolean;
}

/** Finish a failed batch even when the daemon died halfway through its ejections. */
export async function resumeFailure(
	root: string,
	options: Pick<ServeOptions, "state" | "fixer">,
	deps: GitHubDependencies,
): Promise<string[]> {
	const path = join(options.state, "failure.json");
	if (!existsSync(path)) return [];
	const failure = JSON.parse(readFileSync(path, "utf8")) as Failure;
	const github = new GitHub(deps);
	const output: string[] = [];
	while (failure.ejections.length) {
		const item = failure.ejections[0];
		if (await eject(github, failure.plan, item)) output.push(`ejected ${item.number} ${item.reason}`);
		forgetHeads(options.state, item.number);
		failure.ejections.shift();
		save(path, failure);
	}
	if (options.fixer && failure.numbers.length > 0 && !failure.launched) {
		// A launch lost to a crash leaves its PRs unparked, so they only rejoin batches.
		failure.launched = true;
		save(path, failure);
		const checkout = mkdtempSync(join(options.state, "fix-"));
		try {
			output.push(...(await startFixer(root, checkout, failure, options.fixer, options.state, deps)));
		} catch (error) {
			rmSync(checkout, { recursive: true, force: true });
			throw error;
		}
	}
	rmSync(path);
	return output;
}

/** Record a failure and act on it: park its PRs for the fixer, or eject them when there is none. */
async function fail(
	root: string,
	options: Pick<ServeOptions, "state" | "fixer">,
	deps: GitHubDependencies,
	failure: Omit<Failure, "ejections" | "numbers"> & { entries: Plan["queue"]; detail: string },
): Promise<string[]> {
	const { entries, detail, ...rest } = failure;
	const reason = failure.reason ?? "failed_checks";
	save(join(options.state, "failure.json"), {
		...rest,
		numbers: entries.map((entry) => entry.number),
		ejections: options.fixer ? [] : entries.map((entry) => ejection(entry, reason, detail)),
	} satisfies Failure);
	return resumeFailure(root, options, deps);
}

/** GitHub refuses comments over 65,536 characters. Escaping grows a character at most 5x (`&amp;`). */
const EXCERPT = 12_000;

/** The end of a log, escaped for `<pre>` and bounded so the comment always posts. */
export function excerpt(tail: string): string {
	const cut = tail.length > EXCERPT ? `…${tail.slice(-EXCERPT)}` : tail;
	return cut.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

/** Queued PRs already screened for conflicts with those ahead: PR number to the queue time screened. */
function readScreened(state: string): Record<number, string> {
	const path = join(state, "screened.json");
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<number, string>) : {};
}

/**
 * Comment on each newly screened PR that conflicts with PRs queued ahead of it, so its author can
 * resolve that before its turn, and remember it as screened until it is queued again.
 */
async function reportOverlaps(github: GitHub, plan: Plan, state: string, overlaps: Overlap[]): Promise<string[]> {
	const screened = readScreened(state);
	// A PR that left the queue is screened again once it is queued again, at a new queue time.
	const kept: Record<number, string> = Object.fromEntries(
		plan.queue.flatMap((entry) => (entry.number in screened ? [[entry.number, screened[entry.number]]] : [])),
	);
	const output: string[] = [];
	for (const { entry, ahead } of overlaps) {
		if (ahead.length > 0) {
			const list = ahead.map(
				(conflict) =>
					`- [#${conflict.entry.number}](${conflict.entry.url}): ${conflict.files.map((file) => `<code>${excerpt(file)}</code>`).join(", ")}`,
			);
			await github.request(`/repos/${plan.repository}/issues/${entry.number}/comments`, {
				body: {
					body: `quest land: this pull request conflicts with ${ahead.length === 1 ? "a pull request" : "pull requests"} queued ahead of it, in these files:\n\n${list.join("\n")}\n\nOnce one of them lands, this one conflicts with the base and is ejected when its turn comes. Resolve the overlap before then, such as by coordinating with that author, or by merging the base once it lands.`,
				},
			});
			output.push(`overlap ${entry.number} ${ahead.map((conflict) => conflict.entry.number).join(",")}`);
		}
		kept[entry.number] = entry.enabledAt;
		save(join(state, "screened.json"), kept);
	}
	save(join(state, "screened.json"), kept);
	return output;
}

/**
 * How long after its pick a PR may wait on pending required checks before its author is told which.
 * Twice the default check deadline (`--timeout`), so a slow but running CI rarely trips it.
 */
export const STALLED_AFTER = 2 * 60 * 60_000;

/**
 * Comment once per pick on each PR still waiting on required checks `STALLED_AFTER` its pick, naming
 * them: a check that never reports, such as one whose workflow skips the PR, would otherwise hold it
 * in the queue without a word.
 */
async function reportStalled(github: GitHub, plan: Plan, state: string, now: number): Promise<string[]> {
	const path = join(state, "stalled.json");
	const told = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<number, string>) : {};
	// Only picks still queued are remembered; a new pick is told again.
	const kept: Record<number, string> = Object.fromEntries(
		[...plan.queue, ...(plan.waiting ?? [])].flatMap((entry) =>
			told[entry.number] === entry.enabledAt ? [[entry.number, entry.enabledAt]] : [],
		),
	);
	const output: string[] = [];
	for (const waiting of plan.waiting ?? []) {
		if (kept[waiting.number] === waiting.enabledAt || now - Date.parse(waiting.enabledAt) < STALLED_AFTER) continue;
		const list = waiting.pending.map((name) => `- <code>${excerpt(name)}</code>`).join("\n");
		await github.request(`/repos/${plan.repository}/issues/${waiting.number}/comments`, {
			body: {
				body: `quest land: this pull request is queued, but ${waiting.pending.length === 1 ? "a required check is" : "required checks are"} still pending on its head ${STALLED_AFTER / 3_600_000} hours after it was picked:\n\n${list}\n\nIt keeps its place and joins a batch once they pass. A check that never reports, such as one whose workflow does not run on this pull request, holds it here: run that check, or ask a maintainer to change the checks ${plan.base.ref} requires.`,
			},
		});
		kept[waiting.number] = waiting.enabledAt;
		save(path, kept);
		output.push(`stalled ${waiting.number} ${waiting.pending.join(",")}`);
	}
	save(path, kept);
	return output;
}

type MergeResult =
	{ sha: string } | { reason: "head_moved" | "merge_conflict" | "merge_refused"; detail: string } | null;

/**
 * Retry only GitHub's pending mergeability or base refresh. Any other refusal, such as squash being
 * disabled or a rule the bot cannot bypass, would refuse every round after a full check, so it ejects.
 */
async function mergePinned(github: GitHub, path: string, head: string, previous = head): Promise<MergeResult> {
	for (let attempt = 0; ; attempt++) {
		const response = await github.request(`${path}/merge`, {
			method: "PUT",
			body: { merge_method: "squash", sha: head },
			allow: [403, 405, 409],
		});
		// The client waits out a rate limit; any other 403 is GitHub refusing this PR, which stops this PR
		// alone rather than failing the whole batch on every retry.
		const result = object(await response.json());
		if (response.ok && result.merged === true) return { sha: string(result.sha) };
		const pull = object(await (await github.request(path)).json());
		// A lost response or a manual merge is reconciled by rebuilding the remaining queue.
		if (pull.merged === true) return null;
		const detail = `GitHub refused ${path}: ${String(result.message)}`;
		if (pull.state !== "open") return { reason: "merge_refused", detail };
		// Right after the gate's own push, GitHub can still report the pin as the head and refuse the merge
		// for it: a 409, or a 405 when the pin conflicts with the base that push merged. Neither is a writer.
		const current = object(pull.head).sha;
		if (previous !== head && (current === previous || (response.status === 409 && current === head))) {
			if (attempt >= 3) throw new Error(`${detail}; prepared head has not propagated`);
			await github.pause(500 * 2 ** attempt);
			continue;
		}
		if (current !== head) return { reason: "head_moved", detail };
		if (pull.mergeable === false || pull.mergeable_state === "dirty") return { reason: "merge_conflict", detail };
		if (pull.mergeable === null || /base branch was modified/i.test(String(result.message))) {
			if (attempt >= 3) throw new Error(`${detail}; mergeability did not settle`);
			await github.pause(500 * 2 ** attempt);
			continue;
		}
		return { reason: "merge_refused", detail };
	}
}

/** One batch: check once, then squash through GitHub in order, verifying each resulting tree. */
const POLICY = "batch-policy.json";

/** The next batch's order and size; a missing or unreadable record starts oldest-first at full size. */
export function readPolicy(state: string): BatchPolicy {
	try {
		const data = JSON.parse(readFileSync(join(state, POLICY), "utf8")) as { order?: unknown; size?: unknown };
		const order = data.order === "newest" ? "newest" : "oldest";
		const size = typeof data.size === "number" && data.size >= 1 ? Math.floor(data.size) : Number.POSITIVE_INFINITY;
		return { order, size };
	} catch {
		return { order: "oldest", size: Number.POSITIVE_INFINITY };
	}
}

/** After a checked batch of `checked` PRs: flip the order, halve on failure, and grow by one on success. */
function nextPolicy(state: string, policy: BatchPolicy, checked: number, passed: boolean): void {
	const size = passed ? checked + 1 : Math.max(1, Math.floor(checked / 2));
	save(join(state, POLICY), { order: policy.order === "oldest" ? "newest" : "oldest", size });
}

/** What a batch may do while its check runs. */
export interface BatchOptions extends Pick<ServeOptions, "state" | "sandbox" | "fixer" | "timeout"> {
	/** Collect finished fixer jobs while a check runs, so their PRs join the next batch at once. */
	collect?: () => Promise<void>;
}

/** How often a running check pauses to collect finished fixer jobs. */
const COLLECT_EVERY = 60_000;

/** The line a check prints to name a module that failed, which the gate reruns once on the same tip. */
const FAILED_MODULE = /^quest-land-failed: (.+)$/gm;
/** The line the gate writes into a check's log before rerunning it. */
export const RERUN_MARKER = "quest land: rerunning";

/**
 * The modules the check named as failed, in order and once each. A name is check output, so it is
 * bounded: printable, at most 200 characters, and at most 50 of them.
 */
export function failedModules(output: string): string[] {
	const names = [...output.matchAll(FAILED_MODULE)]
		.map((match) => match[1].trim())
		.filter((name) => name && name.length <= 200 && !/[\u0000-\u001f\u007f]/.test(name));
	return [...new Set(names)].slice(0, 50);
}

/** A check's outcome: whether it passed, and when only its rerun passed, the modules that flaked. */
export interface Checked {
	code: number;
	/** Set when the first run failed and its rerun on the same tip passed: the modules it named, if any. */
	flaky?: string[];
}

/**
 * Check `tip`, and when it fails, rerun the modules it names once on the same tip before anyone is
 * blamed: a failure that passes on the rerun is flaky. The log keeps both runs. A check that ran past
 * its deadline is not rerun, since a rerun would spend the whole deadline again.
 */
async function check(
	root: string,
	options: BatchOptions,
	tip: string,
	links: number,
	base: string,
	log: string,
): Promise<Checked> {
	const first = await runSandbox(root, options, tip, links, base, log);
	if (first.code === 0 || first.timedOut) return { code: first.code };
	const modules = failedModules(readFileSync(log, "utf8"));
	appendFileSync(
		log,
		`\n${RERUN_MARKER} ${modules.length ? modules.join(", ") : "the whole check"} once on the same tip\n`,
	);
	const rerun = await runSandbox(root, options, tip, links, base, log, modules);
	return rerun.code === 0 ? { code: 0, flaky: modules } : { code: first.code };
}

/**
 * Run the sandbox on `tip`, `links` commits above `base`, writing its output to `log`. A rerun appends
 * to the log and names the modules to rerun in `QUEST_LAND_RERUN`, one per line.
 */
async function runSandbox(
	root: string,
	options: BatchOptions,
	tip: string,
	links: number,
	base: string,
	log: string,
	rerun?: string[],
): Promise<{ code: number; timedOut: boolean }> {
	const checkout = sandboxTree(root, options.state, tip, links);
	if (!rerun) writeFileSync(log, "", { mode: 0o600 });
	let timedOut = false;
	let collecting: Promise<void> | undefined;
	const collector = options.collect
		? setInterval(() => {
				collecting ??= options.collect!().finally(() => (collecting = undefined));
			}, COLLECT_EVERY)
		: undefined;
	try {
		const code = await new Promise<number>((done, reject) => {
			const child = spawn(options.sandbox, [checkout, base], {
				cwd: checkout,
				detached: true,
				env: {
					...commandEnvironment(),
					QUEST_LAND_BASE: base,
					...(rerun?.length ? { QUEST_LAND_RERUN: rerun.join("\n") } : {}),
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			// A hung check would stall the queue: kill its whole process group at the deadline.
			const timer = setTimeout(() => {
				timedOut = true;
				appendFileSync(log, `\nquest land: the check ran past ${options.timeout} minutes and was killed\n`);
				try {
					process.kill(-child.pid!, "SIGKILL");
				} catch {}
			}, options.timeout * 60_000);
			child.stdout.on("data", (data: Buffer) => appendFileSync(log, data));
			child.stderr.on("data", (data: Buffer) => appendFileSync(log, data));
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("close", (status) => {
				clearTimeout(timer);
				done(status ?? 1);
			});
		});
		return { code, timedOut };
	} finally {
		clearInterval(collector);
		// The batch goes on only after a collection in flight finishes, never beside it.
		await collecting;
		rmSync(checkout, { recursive: true });
	}
}

/** Logs of checks that passed only on their rerun, waiting for a fixer job to disable what flaked. */
const FLAKY = "flaky.json";

function readFlaky(state: string): string[] {
	const path = join(state, FLAKY);
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as string[]) : [];
}

/**
 * A check of `tip` that passed only on its rerun. With a fixer, its log is kept as `flaky-*.log`, a name
 * that tells the fixer to disable the flaky test, until the next round starts that job on the base as it
 * then is, which includes the batch that just landed. Returns the line that reports it.
 */
function flaked(options: Pick<ServeOptions, "state" | "fixer">, log: string, tip: string, modules: string[]): string {
	if (options.fixer) {
		const kept = join(options.state, `flaky-${Date.now()}-${tip.slice(0, 12)}.log`);
		copyFileSync(log, kept);
		save(join(options.state, FLAKY), [...readFlaky(options.state), kept]);
	}
	return `flaky ${tip} ${modules.length ? modules.join(", ") : "check"}`;
}

/** Start a fixer job on each recorded flake, which proposes a PR that disables the flaky test and queues it. */
async function disableFlaky(
	root: string,
	plan: Plan,
	options: Pick<ServeOptions, "state" | "fixer">,
	deps: GitHubDependencies,
	read: RemoteRead,
): Promise<void> {
	const pending = readFlaky(options.state);
	if (!pending.length) return;
	if (options.fixer) await read(root, ["fetch", "--quiet", "--no-tags", baseRemote(plan), plan.base.sha]);
	while (pending.length) {
		const log = pending.shift()!;
		// Forgotten before the launch: a crash loses this flake's PR rather than opening two.
		save(join(options.state, FLAKY), pending);
		if (options.fixer)
			await startBaseFixer(root, options.state, plan.repository, plan.base, log, options.fixer, deps, "flaky");
	}
}

/**
 * Check the base alone, as when the fixer cannot tell which PR broke a batch. A red base halts the
 * queue, and no PR is blamed for it. The fixer then works on the base alone, and its fix is proposed
 * as a PR; without a fixer, an issue says the queue is halted. Returns whether the base passed.
 */
export async function checkBase(
	root: string,
	repository: string,
	base: Plan["base"],
	options: BatchOptions,
	deps: GitHubDependencies,
	read: RemoteRead = readRemote,
): Promise<boolean> {
	// Already halted on this base: another failing batch on it needs no second check or fix.
	if (readHalt(options.state)?.sha === base.sha) return false;
	await read(root, ["fetch", "--quiet", "--no-tags", baseRemote({ repository }), base.sha]);
	const log = join(options.state, `base-${Date.now()}-${base.sha.slice(0, 12)}.log`);
	const checked = await check(root, options, base.sha, 0, base.sha, log);
	if (checked.flaky) deps.warn(flaked(options, log, base.sha, checked.flaky));
	if (checked.code === 0) return true;
	const github = new GitHub(deps);
	const halt = readHalt(options.state);
	// A fix proposed for an earlier red base is superseded: the fixer proposes one for this base.
	if (halt?.fix)
		await closeFix(
			github,
			repository,
			halt.fix,
			`${base.ref} moved to ${base.sha}, which still fails its check alone, so quest land closes this fix and tries again on the new base.`,
		);
	saveHalt(options.state, { sha: base.sha, ...(halt?.issue === undefined ? {} : { issue: halt.issue }) });
	if (options.fixer) {
		await startBaseFixer(root, options.state, repository, base, log, options.fixer, deps);
		return false;
	}
	await haltNotice(
		github,
		options.state,
		repository,
		base,
		"No land fixer is configured to propose a fix.",
		`<pre>${excerpt(readFileSync(log, "utf8").trimEnd())}</pre>`,
	);
	return false;
}

export async function serveBatch(
	root: string,
	plan: Plan,
	options: BatchOptions,
	deps: GitHubDependencies,
	token: (workflows: boolean) => Promise<string>,
	read: RemoteRead = readRemote,
): Promise<string[]> {
	mkdirSync(options.state, { recursive: true, mode: 0o700 });
	const github = new GitHub(deps);
	const output: string[] = [];
	const report = async (item: Plan["eject"][number]) => {
		if (await eject(github, plan, item)) output.push(`ejected ${item.number} ${item.reason}`);
		forgetHeads(options.state, item.number);
	};
	for (const item of plan.eject) {
		await report(item);
		await handbackRepeated(options.state, plan, item, deps);
	}
	output.push(...(await reportStalled(github, plan, options.state, deps.now())));
	await disableFlaky(root, plan, options, deps, read);
	// A halted queue waits for its base to move, then resumes once the new base passes alone, even
	// with no PR ready to batch, so its issue and any fix it no longer needs are closed at once.
	const halt = readHalt(options.state);
	if (halt) {
		if (halt.sha === plan.base.sha) {
			// A crash between the halt and its fixer's launch leaves nothing to end the attempt.
			if (!halt.fix && !halt.noticed && !fixing(options.state, halt.sha))
				await haltNotice(
					github,
					options.state,
					plan.repository,
					plan.base,
					"The land fixer's job on it was lost.",
					"",
				);
			return output;
		}
		if (!(await checkBase(root, plan.repository, plan.base, options, deps, read))) return output;
		await resume(github, options.state, plan.repository, plan.base);
	}
	// Parked PRs sit out until their fixer job is collected; the rest keep their places.
	const batch = batchable(options.state, plan);
	if (batch.queue.length === 0) return output;
	const screened = readScreened(options.state);
	const policy = readPolicy(options.state);
	const chain = await build(root, batch, read, (entry) => screened[entry.number] !== entry.enabledAt, policy);
	// Each rejection is its own failure, blamed on its PR, so a fixer can repair it as it would a failed batch.
	for (const { entry, commit, findings } of chain.rejected) {
		const log = join(options.state, `check-${Date.now()}-${entry.number}.log`);
		writeFileSync(log, `${findings.join("\n")}\n`, { mode: 0o600 });
		output.push(
			...(await fail(root, options, deps, {
				plan: batch,
				tip: commit,
				log,
				entries: [entry],
				blame: [entry.number],
				reason: "failed_checks",
				detail: `\`quest check\` fails with it squashed alone onto the base ${plan.base.sha}.\n\n<pre>${excerpt(findings.join("\n"))}</pre>\n`,
			})),
		);
	}
	output.push(...(await reportOverlaps(github, plan, options.state, chain.overlaps)));
	const conflict = chain.conflict;
	if (!conflict && chain.links.length === 0) return output;
	const log = join(options.state, `batch-${Date.now()}-${batch.queue[0].number}.log`);
	if (conflict) {
		writeFileSync(log, `Conflicts with the base: ${conflict.files.join(", ")}\n`);
		output.push(
			...(await fail(root, options, deps, {
				plan: batch,
				tip: conflict.entry.head,
				log,
				entries: [conflict.entry],
				blame: [conflict.entry.number],
				reason: "merge_conflict",
				detail: excerpt(readFileSync(log, "utf8")),
			})),
		);
		return output;
	}
	const tip = chain.links.at(-1)!;
	const { code, flaky } = await check(root, options, tip.commit, chain.links.length, plan.base.sha, log);
	// A flaky failure is no PR's fault: the batch passed, and lands.
	nextPolicy(options.state, policy, chain.links.length, code === 0);
	if (flaky) output.push(flaked(options, log, tip.commit, flaky));
	if (code !== 0) {
		// The fixer reads the failure first and says which PR broke the batch; until then, all of them
		// sit out. Without a fixer, the whole batch is ejected.
		output.push(
			...(await fail(root, options, deps, {
				plan: batch,
				tip: tip.commit,
				log,
				entries: chain.links.map(({ entry }) => entry),
				reason: "failed_checks",
				detail: `the batch check failed (exit ${code}), and failed again when quest land reran it on the same tip.\n\n<pre>${excerpt(readFileSync(log, "utf8").trimEnd())}</pre>\n`,
			})),
		);
		return output;
	}
	const [owner, repo] = plan.repository.split("/");
	const fresh = await resolvePreparedQueue(root, options.state, { owner, repo }, plan.base.ref, deps);
	for (const item of fresh.eject) await report(item);
	if (
		fresh.base.sha !== plan.base.sha ||
		chain.links.some(
			({ entry }) =>
				!fresh.queue.some(
					(now) =>
						now.number === entry.number && now.head === entry.head && now.enabledAt === entry.enabledAt,
				),
		)
	)
		return output;
	let expectedParent = plan.base.sha;
	for (const [index, link] of chain.links.entries()) {
		const parent = index === 0 ? plan.base.sha : chain.links[index - 1].commit;
		const path = `/repos/${plan.repository}/pulls/${link.entry.number}`;
		const prepared = await prepareHead(
			root,
			options.state,
			plan,
			link.entry,
			expectedParent,
			link.tree,
			token,
			read,
		);
		if ("fallback" in prepared) {
			const completed = await landFallback(
				root,
				options.state,
				plan,
				link.entry,
				link.commit,
				expectedParent,
				deps,
				token,
				read,
			);
			if (completed) output.push(completed);
			if (!completed?.startsWith("landed ")) return output;
			expectedParent = completed.split(" ")[2];
			continue;
		}
		const merge =
			"reason" in prepared
				? new GitHub(deps)
				: new GitHub({
						...deps,
						token: await token(touchesWorkflows(root, parent, link, plan.base.sha, prepared.head)),
					});
		const result = "reason" in prepared ? prepared : await mergePinned(merge, path, prepared.head, link.entry.head);
		if (result === null) {
			forgetHeads(options.state, link.entry.number);
			return output;
		}
		if ("reason" in result) {
			// Only this PR failed to land. The rest of the batch passed its check and stays queued,
			// to be rebuilt on the new base.
			const detail = `${result.detail}; the rest of the batch stays queued`;
			appendFileSync(log, `${detail}\n`);
			if (result.reason === "merge_conflict") {
				output.push(
					...(await fail(root, options, deps, {
						plan: batch,
						tip: tip.commit,
						log,
						entries: [link.entry],
						blame: [link.entry.number],
						reason: "merge_conflict",
						detail: excerpt(detail),
					})),
				);
				return output;
			}
			// A prepared tree that differs from the tested one is the gate's own fault, for a maintainer to judge.
			const reported = result.reason === "tree_mismatch" ? `CRITICAL: ${detail}` : detail;
			if (reported !== detail) deps.warn(reported);
			return output.concat(
				await stop(root, options, deps, batch, [ejection(link.entry, result.reason, excerpt(reported))]),
			);
		}
		const sha = result.sha;
		forgetHeads(options.state, link.entry.number);
		output.push(`landed ${link.entry.number} ${sha}`);
		const commit = object(await (await merge.request(`/repos/${plan.repository}/git/commits/${sha}`)).json());
		const parents = commit.parents;
		const actualParent = Array.isArray(parents) && parents.length ? string(object(parents[0]).sha) : null;
		if (actualParent !== expectedParent) {
			const message = `quest land: base moved before squash #${link.entry.number}: expected parent ${expectedParent}, got ${actualParent}; rebuilding the remaining queue`;
			appendFileSync(log, `${message}\n`);
			deps.warn(message);
			return output;
		}
		expectedParent = sha;
		const tree = string(object(commit.tree).sha);
		if (tree === link.tree) continue;
		// The squash is already merged, so there is nothing to eject. The rest of the batch stays queued and
		// is rebuilt and checked on the base as it now is, like after a moved base.
		const detail = `CRITICAL: GitHub squash #${link.entry.number} at ${sha} has tree ${tree}, but the tested chain has ${link.tree}. It stays merged; the rest of the batch stays queued, to be rebuilt on the new base`;
		deps.warn(detail);
		appendFileSync(log, `${detail}\n`);
		return output;
	}
	return output;
}

/**
 * Eject PRs that cannot land as tested, such as a moved head, a merge GitHub refuses, or a tree
 * mismatch. The fixer cannot repair these: a writer moved the head, or the repository's settings refuse.
 */
async function stop(
	root: string,
	options: Pick<ServeOptions, "state" | "fixer">,
	deps: GitHubDependencies,
	plan: Plan,
	ejections: Plan["eject"],
): Promise<string[]> {
	save(join(options.state, "failure.json"), { plan, ejections, numbers: [], log: "", tip: "" } satisfies Failure);
	return resumeFailure(root, options, deps);
}

/** An OS lock disappears even after SIGKILL. Its holder exits when our pipe closes. */
export async function lockCheckout(path: string): Promise<() => void> {
	const child = spawn("flock", ["--nonblock", path, "sh", "-c", "printf locked; cat >/dev/null"], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	await new Promise<void>((done, reject) => {
		child.stdout.once("data", () => done());
		child.once("error", reject);
		child.once("exit", () => reject(new Error("another quest land serve holds this checkout (or flock failed)")));
	});
	return () => child.stdin.end();
}

/** Every linked worktree resolves to the same lock in the common git directory. */
export function lockRepository(root: string): Promise<() => void> {
	return lockCheckout(
		join(git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "quest-land.lock"),
	);
}

/** Retry a failed batch independently of the lifetime of the daemon. */
export async function daemonLoop(
	iteration: () => Promise<boolean>,
	deps: Pick<GitHubDependencies, "sleep" | "warn">,
	stopped = () => false,
): Promise<void> {
	let backoff = 1000;
	while (!stopped()) {
		let delay = 0;
		try {
			const active = await iteration();
			backoff = 1000;
			if (!active) delay = 60_000;
		} catch (error) {
			deps.warn(
				`quest land: ${error instanceof Error ? error.message : String(error)}; retrying in ${backoff / 1000}s`,
			);
			delay = backoff;
			backoff = Math.min(backoff * 2, 60_000);
		}
		if (delay) await deps.sleep(delay);
	}
}

export async function serve(
	root: string,
	repository: Repository,
	options: ServeOptions,
	warn: (text: string) => void,
): Promise<void> {
	if (!options.sandbox) throw new Error("quest land serve requires --sandbox");
	options.state = resolve(root, options.state || defaultState(repository));
	mkdirSync(options.state, { recursive: true, mode: 0o700 });
	// These are startup configuration failures; transient network/batch failures below are recoverable.
	createPrivateKey(readFileSync(keyPath()));
	accessSync(options.sandbox, constants.X_OK);
	if (options.fixer) accessSync(options.fixer, constants.X_OK);
	// One daemon per checkout's repository and per state directory, whichever two daemons would share.
	const unlockRepository = await lockRepository(root);
	const unlockState = await lockCheckout(join(options.state, "lock")).catch((error: unknown) => {
		unlockRepository();
		throw error;
	});
	const unlock = () => {
		unlockState();
		unlockRepository();
	};
	try {
		const trusted = privateRepository(options.state);

		const mint = (workflows: boolean) =>
			installationToken(
				repository,
				options,
				{ contents: "write", pull_requests: "write", ...(workflows ? { workflows: "write" as const } : {}) },
				{ fetch, now: Date.now },
			);
		const read = authenticatedRead(() =>
			installationToken(repository, options, { contents: "read" }, { fetch, now: Date.now }),
		);
		const deps = apiDependencies(
			() =>
				installationToken(
					repository,
					options,
					{
						contents: "write",
						pull_requests: "write",
						issues: "write",
						administration: "read",
						checks: "read",
						statuses: "read",
					},
					{ fetch, now: Date.now },
				),
			{ fetch, now: Date.now, sleep, warn },
		);

		const name = `${repository.owner}/${repository.repo}`;
		const batch: BatchOptions = {
			...options,
			// Between collections a check may run for most of an hour; a finished fixer's PRs need not wait for it.
			collect: async () => {
				try {
					for (const line of await collectFixers(trusted, options.state, deps, mint, undefined, read))
						warn(line);
				} catch (error) {
					warn(`quest land fixer: collection during a check failed: ${String(error)}`);
				}
			},
		};
		await daemonLoop(async () => {
			// Without `collect`: this check runs inside a collection, which must not start another.
			const checkCollected = (base: Plan["base"]) => checkBase(trusted, name, base, options, deps, read);
			for (const line of await collectFixers(trusted, options.state, deps, mint, undefined, read, checkCollected))
				warn(line);
			for (const line of await resumeFailure(trusted, options, deps)) warn(line);
			const completed = await finishFallback(trusted, options.state, deps, mint, read);
			if (completed) warn(completed);
			const plan = await resolvePreparedQueue(trusted, options.state, repository, options.base, deps);
			const lines = await serveBatch(trusted, plan, batch, deps, mint, read);
			for (const line of lines) warn(line);
			return lines.length > 0;
		}, deps);
	} finally {
		unlock();
	}
}
