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
	rmSync,
	writeFileSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import { MERGE_LABEL } from "../core";
import { GitHub, type GitHubDependencies, object, string } from "./github";
import {
	baseRemote,
	commandEnvironment,
	contains,
	git,
	tryGit,
	enqueue,
	type Entry,
	type Ejection,
	type Plan,
} from "./land";
import { readFixResult, parseFixResult, type FixResult } from "./land-fix";
import { readRemote, type RemoteRead } from "./land";
import { importFixer } from "./land-fixer-repository";
import { push } from "./land-head";
import { excerpt, type Failure } from "./land-serve";

class FixerRefusal extends Error {}

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

interface Job {
	checkout: string;
	plan: Plan;
	numbers: number[];
	started: number;
	terminating?: number;
	pid?: number;
	identity?: string;
	/** The launching daemon's process identity, to tell a restart from a crash. */
	daemon?: string;
	/** Packs fetched from the daemon's repository at launch; their objects are already there. */
	packs?: string[];
	results?: FixResult[];
	error?: string;
	handbacks?: Record<number, string>;
	// Persist publication before moving a remote head; retries recognize only this exact head.
	published: number[];
}
interface Attempt {
	agent?: string;
	model?: string;
	pick: string;
	requeued?: string;
	head?: string;
}
function save(path: string, data: unknown): void {
	writeFileSync(`${path}.new`, JSON.stringify(data), { mode: 0o600 });
	renameSync(`${path}.new`, path);
}
const attemptPath = (state: string, number: number) => join(state, `fix-attempt-${number}.json`);
function attempt(state: string, number: number): Attempt | undefined {
	const path = attemptPath(state, number);
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Attempt) : undefined;
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
	await github.request(path, {
		body: {
			body: `${attribution} land fixer: ${fixerText(text)}${log ? `\n\n<pre>${excerpt(log)}</pre>` : ""}\n\n${marker}\n\n(written by ${attribution})`,
		},
	});
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
	if (!previous || (previous.pick !== entry.enabledAt && previous.requeued !== entry.enabledAt)) return false;
	await comment(
		new GitHub(deps),
		plan,
		entry,
		"This maintainer pick already used its mechanical fix attempt. Run /quest-iterate to diagnose the repeated failure, then pick it again.",
		"handback",
		author(previous),
	);
	return true;
}

export async function startFixer(
	root: string,
	checkout: string,
	failure: Failure,
	fixer: string,
	state: string,
	deps: GitHubDependencies,
): Promise<void> {
	const entries: Entry[] = [];
	for (const entry of failure.plan.queue.filter((item) => failure.numbers.includes(item.number))) {
		// failure.json may replay after launching or collecting this same job. It is not a second pick.
		const previous = attempt(state, entry.number);
		if (
			previous?.pick === entry.enabledAt &&
			(previous.requeued ||
				readdirSync(state).some((name) => {
					if (!/^fix-job-.*\.json$/.test(name)) return false;
					const job = JSON.parse(readFileSync(join(state, name), "utf8")) as Job;
					return (
						job.numbers.includes(entry.number) &&
						job.plan.queue.some(
							(item) => item.number === entry.number && item.enabledAt === entry.enabledAt,
						)
					);
				}))
		)
			continue;

		if (await handbackRepeated(state, failure.plan, entry, deps)) {
			continue;
		} else {
			save(attemptPath(state, entry.number), { pick: entry.enabledAt });
			entries.push(entry);
		}
	}
	if (!entries.length) {
		rmSync(checkout, { recursive: true, force: true });
		return;
	}
	git(checkout, ["init", "--quiet"]);
	git(checkout, [
		"fetch",
		"--quiet",
		"--no-tags",
		"--no-write-fetch-head",
		root,
		`${failure.tip}:refs/heads/batch`,
		`${failure.plan.base.sha}:refs/heads/base`,
		...entries.map((entry) => `${entry.head}:refs/heads/pr-${entry.number}`),
	]);
	git(checkout, ["config", "user.name", "quest fixer"]);
	git(checkout, ["config", "user.email", "quest-fixer@localhost"]);
	git(checkout, ["checkout", "--quiet", "--detach", failure.tip]);
	const path = join(state, `fix-job-${checkout.split("/").at(-1)}.json`);
	const job: Job = {
		checkout,
		plan: failure.plan,
		numbers: entries.map((entry) => entry.number),
		started: deps.now(),
		daemon: identity(process.pid),
		packs: readdirSync(join(checkout, ".git", "objects", "pack")).filter((name) => name.endsWith(".pack")),
		published: [],
	};
	save(path, job);
	// The supervisor survives a daemon restart and atomically records the wrapper's exit status.
	// Its state path is never passed to the wrapper or mounted in its container.
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
				failure.log,
				...job.numbers.map(String),
			],
			{ cwd: checkout, detached: true, env: commandEnvironment(), stdio: ["ignore", output, output] },
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

/** New commits descend from the pin. Protected content/modes at the head must match the pin or its merge with `base`, the base the fixer was given. */
export function validateFix(root: string, entry: Entry, head: string, base: string): void {
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
): Promise<string[]> {
	const output: string[] = [];
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
			output.push(...(await collectJob(root, state, path, job, deps, token, timeout, read)));
		} catch (error) {
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
): Promise<string[]> {
	const github = new GitHub(deps);
	const output: string[] = [];
	if (!job.results && !job.error) {
		// A restart stops the daemon's whole unit, fixers included, unless the host keeps them running.
		const daemon = identity(process.pid);
		const restarted = job.daemon && daemon && job.daemon !== daemon ? "; the daemon restarted while it ran" : "";
		if (existsSync(`${path}.exit`)) {
			const code = readFileSync(`${path}.exit`, "utf8");
			if (job.terminating !== undefined) job.error = "fixer timed out; run /quest-iterate";
			else if (code !== "0") job.error = `fixer ${exited(code)}${restarted}; run /quest-iterate`;
			else
				try {
					job.results = parseFixResult(readFixResult(job.checkout), job.numbers);
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
				return output;
			}
			if (deps.now() - job.terminating < 10_000) return output;
			if (job.pid && job.identity && identity(job.pid) === job.identity) {
				try {
					process.kill(-job.pid, "SIGKILL");
				} catch {}
			}
			job.error = "fixer timed out; run /quest-iterate to diagnose and retry";
		}
		// Without a launch identity (an unreadable /proc), only its exit status or the timeout can end the job.
		else if (!job.identity || (job.pid && identity(job.pid) === job.identity)) return output;
		else job.error = `fixer stopped without recording an exit status${restarted}; run /quest-iterate`;
		save(path, job);
	}
	while (job.numbers.length) {
		const number = job.numbers[0];
		const entry = job.plan.queue.find((entry) => entry.number === number)!;
		const result = job.results?.find((item) => item.number === number);
		let error = job.handbacks?.[number] ?? job.error;
		const pullPath = `/repos/${job.plan.repository}/pulls/${number}`;
		const pull = object(await (await github.request(pullPath)).json());
		const current = string(object(pull.head).sha);
		const queued = await github.graphql(
			"query($id: ID!) { node(id: $id) { ... on PullRequest { state autoMergeRequest { enabledAt } } } }",
			{ id: entry.id },
		);
		const auto = object(queued.node).autoMergeRequest;
		const previous = attempt(state, number)!;
		const head = result?.action === "fixed" ? result.head : entry.head;
		const actor = { agent: result?.agent, model: result?.model };
		if (previous.pick !== entry.enabledAt)
			error = "fixer was superseded by a newer maintainer pick; keeping its work untouched";
		// Never displace a newer maintainer pick, closed PR, or writer's commit.
		if (pull.state !== "open" || (current !== entry.head && !(job.published.includes(number) && current === head)))
			error = "PR closed or head moved while fixing; inspect and pick it again";
		if (auto != null) {
			if (
				job.published.includes(number) &&
				current === head &&
				previous.head === head &&
				(!previous.requeued || previous.requeued === object(auto).enabledAt)
			) {
				save(attemptPath(state, number), { ...previous, requeued: string(object(auto).enabledAt) });
			} else error = "PR was picked again while fixing; keeping the newer pick";
		} else if (!error && result?.action !== "handback") {
			try {
				if (result?.action === "fixed") {
					if (entry.repository !== job.plan.repository && !entry.maintainerCanModify)
						throw new FixerRefusal("fork does not allow maintainer edits");
					try {
						importFixer(root, state, job.checkout, number, head, job.packs);
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
					if (pushed.status !== 0) throw new FixerRefusal(`fixer push refused: ${pushed.stderr.trim()}`);
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

				// Save intent before enabling, so a lost response can be reconciled after restart.
				save(attemptPath(state, number), { ...previous, ...actor, head });
				await enqueue(github, entry.id, head);
				const enabled = await github.graphql(
					"query($id: ID!) { node(id: $id) { ... on PullRequest { autoMergeRequest { enabledAt } } } }",
					{ id: entry.id },
				);
				const enabledAt = string(object(object(enabled.node).autoMergeRequest).enabledAt);
				save(attemptPath(state, number), { ...previous, ...actor, head, requeued: enabledAt });
			} catch (failure) {
				if (!(failure instanceof FixerRefusal)) throw failure;
				error = `${String(failure)}; run /quest-iterate before picking it again`;
			}
		}
		if (!error && result?.action !== "handback") {
			await github.request(`/repos/${job.plan.repository}/issues/${number}/labels`, {
				body: { labels: [MERGE_LABEL] },
			});
			if (result?.action === "requeue")
				await comment(
					github,
					job.plan,
					entry,
					// The reason says why: another PR in the batch, or a flaky check worth a follow-up.
					`Requeued unchanged: ${result.reason.slice(0, 200)}`,
					"requeue",
					author(result),
				);
		}

		if (
			error &&
			auto != null &&
			job.published.includes(number) &&
			previous.head === head &&
			(!previous.requeued || previous.requeued === object(auto).enabledAt)
		) {
			await github.graphql(
				"mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }",
				{ id: entry.id },
			);
			await github.request(
				`/repos/${job.plan.repository}/issues/${number}/labels/${encodeURIComponent(MERGE_LABEL)}`,
				{ method: "DELETE", allow: [404] },
			);
		}

		if (error) {
			job.handbacks ??= {};
			job.handbacks[number] = error;
			save(path, job);
		}

		if (error || result?.action === "handback")
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
				fixerLog(path),
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
