// Host orchestration: PR code runs only through the configured sandbox.
import { authenticatedRead } from "./land-git";
import { startFixer, collectFixers, handbackRepeated } from "./land-fixer";
import { spawn } from "node:child_process";
import { createPrivateKey, createSign } from "node:crypto";
import {
	accessSync,
	constants,
	appendFileSync,
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
	build,
	commandEnvironment,
	eject,
	ejection,
	git,
	readRemote,
	type Overlap,
	type RemoteRead,
	type Plan,
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

/** Only this PR's squash changes need workflow write; no PR branch is moved. */
export function touchesWorkflows(root: string, parent: string, link: Chain["links"][number]): boolean {
	return git(root, ["diff", "--name-only", parent, link.commit, "--", ".github/workflows"]) !== "";
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

export interface Failure {
	plan: Plan;
	ejections: Plan["eject"];
	numbers: number[];
	log: string;
	tip: string;
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
	if (options.fixer && failure.numbers.length > 0) {
		const checkout = mkdtempSync(join(options.state, "fix-"));
		try {
			await startFixer(root, checkout, failure, options.fixer, options.state, deps);
		} catch (error) {
			rmSync(checkout, { recursive: true, force: true });
			throw error;
		}
	}
	rmSync(path);
	return output;
}

/** GitHub refuses comments over 65,536 characters. Escaping grows a character at most 5x (`&amp;`). */
const EXCERPT = 12_000;

/** The end of a log, escaped for `<pre>` and bounded so the ejection comment always posts. */
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
			allow: [405, 409],
		});
		const result = object(await response.json());
		if (response.ok && result.merged === true) return { sha: string(result.sha) };
		const pull = object(await (await github.request(path)).json());
		// A lost response or a manual merge is reconciled by rebuilding the remaining queue.
		if (pull.merged === true) return null;
		const detail = `GitHub refused ${path}: ${String(result.message)}`;
		if (pull.state !== "open") return { reason: "merge_refused", detail };
		if (
			previous !== head &&
			response.status === 409 &&
			(object(pull.head).sha === previous || object(pull.head).sha === head)
		) {
			if (attempt >= 3) throw new Error(`${detail}; prepared head has not propagated`);
			await github.pause(500 * 2 ** attempt);
			continue;
		}
		if (object(pull.head).sha !== head) return { reason: "head_moved", detail };
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
export async function serveBatch(
	root: string,
	plan: Plan,
	options: Pick<ServeOptions, "state" | "sandbox" | "fixer" | "timeout">,
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
	if (plan.queue.length === 0) return output;
	const screened = readScreened(options.state);
	const chain = await build(root, plan, read, (entry) => screened[entry.number] !== entry.enabledAt);
	// Each rejection is its own failure, so a fixer can repair it as it would a failed batch.
	for (const { entry, commit, findings } of chain.rejected) {
		const log = join(options.state, `check-${Date.now()}-${entry.number}.log`);
		writeFileSync(log, `${findings.join("\n")}\n`, { mode: 0o600 });
		const detail = `\`quest check\` fails with it squashed alone onto the base ${plan.base.sha}.\n\n<pre>${excerpt(findings.join("\n"))}</pre>\n`;
		save(join(options.state, "failure.json"), {
			plan,
			tip: commit,
			log,
			numbers: [entry.number],
			ejections: [ejection(entry, "failed_checks", detail)],
		} satisfies Failure);
		output.push(...(await resumeFailure(root, options, deps)));
	}
	output.push(...(await reportOverlaps(github, plan, options.state, chain.overlaps)));
	const conflict = chain.conflict;
	if (!conflict && chain.links.length === 0) return output;
	const log = join(options.state, `batch-${Date.now()}-${plan.queue[0].number}.log`);
	let failure: Failure | undefined;
	if (conflict) {
		writeFileSync(log, `Conflicts with the base: ${conflict.files.join(", ")}\n`);
		failure = {
			plan,
			tip: conflict.entry.head,
			numbers: [conflict.entry.number],
			log,
			ejections: [ejection(conflict.entry, "merge_conflict", excerpt(readFileSync(log, "utf8")))],
		};
	} else {
		const tip = chain.links.at(-1)!;
		const checkout = sandboxTree(root, options.state, tip.commit, chain.links.length);
		writeFileSync(log, "", { mode: 0o600 });
		let code: number;
		try {
			code = await new Promise<number>((done, reject) => {
				const child = spawn(options.sandbox, [checkout, plan.base.sha], {
					cwd: checkout,
					detached: true,
					env: { ...commandEnvironment(), QUEST_LAND_BASE: plan.base.sha },
					stdio: ["ignore", "pipe", "pipe"],
				});
				// A hung check would stall the queue: kill its whole process group at the deadline.
				const timer = setTimeout(() => {
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
		} finally {
			rmSync(checkout, { recursive: true });
		}
		if (code !== 0) {
			const tail = readFileSync(log, "utf8").trimEnd().split("\n").slice(-100).join("\n");
			failure = {
				plan,
				tip: tip.commit,
				log,
				numbers: chain.links.map(({ entry }) => entry.number),
				ejections: chain.links.map(({ entry }) =>
					ejection(
						entry,
						"failed_checks",
						`the batch check failed (exit ${code}).\n\n<pre>${excerpt(tail)}</pre>\n`,
					),
				),
			};
		} else {
			const [owner, repo] = plan.repository.split("/");
			const fresh = await resolvePreparedQueue(root, options.state, { owner, repo }, plan.base.ref, deps);
			for (const item of fresh.eject) await report(item);
			if (
				fresh.base.sha !== plan.base.sha ||
				chain.links.some(
					({ entry }) =>
						!fresh.queue.some(
							(now) =>
								now.number === entry.number &&
								now.head === entry.head &&
								now.enabledAt === entry.enabledAt,
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
						: new GitHub({ ...deps, token: await token(touchesWorkflows(root, parent, link)) });
				const result =
					"reason" in prepared ? prepared : await mergePinned(merge, path, prepared.head, link.entry.head);
				if (result === null) {
					forgetHeads(options.state, link.entry.number);
					return output;
				}
				let reason: "head_moved" | "merge_conflict" | "merge_refused" | "tree_mismatch";
				let detail: string;
				let remaining = chain.links.slice(index);
				if ("reason" in result) {
					reason = result.reason;
					detail = `${result.detail}; the rest of the batch was not merged`;
					if (reason === "tree_mismatch") {
						detail = `CRITICAL: ${detail}`;
						deps.warn(detail);
					}
				} else {
					const sha = result.sha;
					forgetHeads(options.state, link.entry.number);
					output.push(`landed ${link.entry.number} ${sha}`);
					const commit = object(
						await (await merge.request(`/repos/${plan.repository}/git/commits/${sha}`)).json(),
					);
					const parents = commit.parents;
					const actualParent =
						Array.isArray(parents) && parents.length ? string(object(parents[0]).sha) : null;
					if (actualParent !== expectedParent) {
						const message = `quest land: base moved before squash #${link.entry.number}: expected parent ${expectedParent}, got ${actualParent}; rebuilding the remaining queue`;
						appendFileSync(log, `${message}\n`);
						deps.warn(message);
						return output;
					}
					expectedParent = sha;
					const tree = string(object(commit.tree).sha);
					if (tree === link.tree) continue;
					reason = "tree_mismatch";
					detail = `CRITICAL: GitHub squash #${link.entry.number} at ${sha} has tree ${tree}, but the tested chain has ${link.tree}. Already merged PRs stay merged; the remaining batch was stopped`;
					remaining = chain.links.slice(index + 1);
					deps.warn(detail);
				}
				appendFileSync(log, `${detail}\n`);
				if (remaining.length)
					failure = {
						plan,
						tip: tip.commit,
						log,
						// A refusal is the repository's settings or rules, which the fixer cannot change.
						numbers: reason === "merge_refused" ? [] : remaining.map(({ entry }) => entry.number),
						ejections: remaining.map(({ entry }) => ejection(entry, reason, excerpt(detail))),
					};
				break;
			}
		}
	}
	if (failure) {
		save(join(options.state, "failure.json"), failure);
		output.push(...(await resumeFailure(root, options, deps)));
	}
	return output;
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

		await daemonLoop(async () => {
			for (const line of await collectFixers(trusted, options.state, deps, mint, undefined, read)) warn(line);
			for (const line of await resumeFailure(trusted, options, deps)) warn(line);
			const completed = await finishFallback(trusted, options.state, deps, mint, read);
			if (completed) warn(completed);
			const plan = await resolvePreparedQueue(trusted, options.state, repository, options.base, deps);
			const lines = await serveBatch(trusted, plan, options, deps, mint, read);
			for (const line of lines) warn(line);
			return lines.length > 0;
		}, deps);
	} finally {
		unlock();
	}
}
