// Pin bumps: the source repository's watcher keeps each target repository's flake input on the source at the
// source's base, through one bot PR per target that lands like any other PR there.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { checksState } from "../github/checks";
import {
	array,
	GitHub,
	type GitHubDependencies,
	object,
	type ObjectValue,
	type Repository,
	requirements,
	string,
} from "./github";
import { land } from "./hold";
import { commandEnvironment, contexts, git, type RemoteRead } from "./land";
import { push, remoteHead } from "./land-head";
import { Refusal } from "./start";
import { excerpt, save } from "./land-serve";

/** The one branch each target's bump PR uses. */
export const BUMP_BRANCH = "quest-bump";

/** A target's bump of the source commit `sha`, in `bump.json`, so a pass repeats nothing already done. */
interface Bump {
	sha: string;
	pr?: number;
	/** The head the bump pushed. */
	head?: string;
	/**
	 * `done`: the target pins `sha`, or its PR is in the target's queue and the target's own gate and fixer
	 * take it from here. `waiting`: findings `quest check --fix` cannot resolve, left for a maintainer.
	 * `checking`: no check is required on the target's base, so the bump waits for every check on its
	 * head to pass before landing. `failed`: such a check failed, left for a maintainer.
	 */
	status: "done" | "waiting" | "checking" | "failed";
}

/** The commands a bump runs outside this process. */
export interface BumpTools {
	/** Lock `input` in the flake at `checkout` to `url`, with `token` reading GitHub. */
	lock(checkout: string, input: string, url: string, token: string): void;
	/** The `quest` executable of the source at `sha`. */
	quest(sha: string, token: string): string;
	/** Run `quest` with `args` on the repository at `checkout`. */
	run(quest: string, checkout: string, args: string[]): { status: number | null; output: string };
}

/** One target's GitHub access: API calls, pushes, and authenticated fetches, each with a token for that target alone. */
export interface BumpConnection {
	/** The target's Git URL. */
	remote: string;
	deps: GitHubDependencies;
	token: (workflows: boolean) => Promise<string>;
	read: RemoteRead;
}

export interface BumpContext {
	source: Repository;
	targets: Repository[];
	state: string;
	connect: (target: Repository) => BumpConnection;
	/** A read-only token for the source, which the tools fetch from GitHub. */
	reader: () => Promise<string>;
	tools: BumpTools;
}

/** The installation permissions a target's bump API calls need: `land` reads the base's protection, and an ungated bump the head's checks and workflow runs. */
export const BUMP_PERMISSIONS = {
	contents: "write",
	pull_requests: "write",
	merge_queues: "write",
	actions: "read",
	administration: "read",
	checks: "read",
	statuses: "read",
} as const;

/** Workflow run conclusions that do not fail. */
const PASSING = ["success", "neutral", "skipped"];

const name = (repository: Repository) => `${repository.owner}/${repository.repo}`;

/** The root input of `lock` that locks `source` on GitHub, and its locked and URL-pinned revisions. */
export function questInput(lock: ObjectValue, source: Repository): { input: string; locked: string; pinned?: string } {
	const nodes = object(lock.nodes);
	const inputs = object(object(nodes[string(lock.root)]).inputs ?? {});
	const matches = Object.entries(inputs).flatMap(([input, node]) => {
		// A follows path names another node's input, not a lock of its own.
		if (typeof node !== "string") return [];
		const entry = object(nodes[node]);
		const locked = object(entry.locked ?? {});
		const original = object(entry.original ?? {});
		const same = (value: unknown, expected: string) =>
			typeof value === "string" && value.toLowerCase() === expected.toLowerCase();
		if (locked.type !== "github" || !same(locked.owner, source.owner) || !same(locked.repo, source.repo)) return [];
		return [
			{
				input,
				locked: string(locked.rev),
				...(typeof original.rev === "string" ? { pinned: original.rev } : {}),
			},
		];
	});
	if (matches.length !== 1)
		throw new Error(
			`flake.lock has ${matches.length} root inputs locking github:${name(source)}, where a bump needs exactly one`,
		);
	return matches[0];
}

/**
 * `flake` with the revision dropped from the source's URL, so flake.lock alone pins the input and each
 * bump is a lock-only change. The URL must appear exactly once.
 */
export function unpin(flake: string, source: Repository, rev: string): string {
	const url = `github:${name(source)}/${rev}`;
	// GitHub names are case-insensitive, as `questInput` matches them.
	const pattern = new RegExp(`"${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "gi");
	const found = flake.match(pattern)?.length ?? 0;
	if (found !== 1) throw new Error(`flake.nix names "${url}" ${found} times, where a bump can unpin exactly one`);
	return flake.replace(pattern, `"github:${name(source)}"`);
}

/**
 * Refuse a checkout with a tracked symlink that leaves it or dangles: the tools write through symlinks,
 * which would let the target's tree overwrite the daemon's own files.
 */
export function contained(checkout: string): void {
	const root = realpathSync(checkout);
	const entries = git(checkout, ["ls-files", "--stage", "-z"]).split("\0").filter(Boolean);
	for (const entry of entries) {
		// The path is everything after the first tab, which a file name may itself contain.
		const tab = entry.indexOf("\t");
		const meta = entry.slice(0, tab);
		const file = entry.slice(tab + 1);
		if (!meta.startsWith("120000 ")) continue;
		let target: string;
		try {
			target = realpathSync(join(checkout, file));
		} catch {
			throw new Error(`${file} is a symlink to nothing, which a bump refuses to write through`);
		}
		const outside = relative(root, target);
		if (outside === ".." || outside.startsWith(`..${sep}`) || isAbsolute(outside))
			throw new Error(`${file} is a symlink out of the repository, which a bump refuses to write through`);
	}
}

/** The bump PR's body, with a `## Waiting` item for findings, and the recorded review skip. */
export function bumpBody(options: {
	source: Repository;
	input: string;
	from: string;
	to: string;
	unpinned: boolean;
	changed: string[];
	findings?: string;
}): string {
	const { source, input, from, to } = options;
	const lines = [
		`Bumps the \`${input}\` input, github:${name(source)}, from \`${from.slice(0, 7)}\` to \`${to.slice(0, 7)}\`: https://github.com/${name(source)}/compare/${from}...${to}`,
	];
	if (options.unpinned)
		lines.push("", "It drops the revision from the input's URL in flake.nix, so flake.lock alone pins it.");
	const extra = options.changed.filter((path) => path !== "flake.lock" && path !== "flake.nix");
	lines.push(
		"",
		extra.length === 0
			? "`quest init` and `quest check --fix` with the new quest changed nothing else."
			: `\`quest init\` and \`quest check --fix\` with the new quest changed ${extra.map((path) => `\`${path}\``).join(", ")}.`,
	);
	if (options.findings !== undefined)
		lines.push(
			"",
			"## Waiting",
			"",
			"- Maintainer: `quest check` with the new quest reports findings `--fix` cannot resolve. Fix them on this branch and land it; the next bump replaces this branch's tree.",
			"",
			`<pre>${excerpt(options.findings.trimEnd())}</pre>`,
		);
	lines.push(
		"",
		"## Review",
		"",
		"Skipped: pin bump, no repository code changed; CI's quest check is the gate.",
		"",
		"Opened by `quest land watch`, which replaces this branch with each newer bump.",
	);
	return `${lines.join("\n")}\n`;
}

function readBumps(state: string): Record<string, Bump> {
	const path = join(state, "bump.json");
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, Bump>) : {};
}

/**
 * Bump every target to `sha`, the source's base, and land each bump. A target's failure does not stop
 * the others; the pass throws once all have run, so the daemon reports it and retries.
 */
export async function bumpPass(context: BumpContext, sha: string): Promise<string[]> {
	const bumps = readBumps(context.state);
	const output: string[] = [];
	const failures: string[] = [];
	for (const target of context.targets) {
		const key = name(target);
		if (bumps[key]?.sha === sha && bumps[key].status !== "checking") continue;
		try {
			const connection = context.connect(target);
			// Each step is recorded before the next, so a failed landing never pushes the bump again.
			if (bumps[key]?.sha !== sha) {
				bumps[key] = await bump(context, target, sha, connection, output);
				save(join(context.state, "bump.json"), bumps);
			}
			if (bumps[key].status === "checking") {
				bumps[key] = await settle(target, bumps[key], connection, output);
				save(join(context.state, "bump.json"), bumps);
			}
		} catch (error) {
			failures.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (failures.length > 0) throw new Error(`bump failed for ${failures.join("; ")}`);
	return output;
}

/** Bump `target` to `sha`: push the bump to its branch and open or update its PR, unqueued. */
async function bump(
	context: BumpContext,
	target: Repository,
	sha: string,
	connection: BumpConnection,
	output: string[],
): Promise<Bump> {
	const github = new GitHub(connection.deps);
	const path = `/repos/${name(target)}`;
	const repository = object(await (await github.request(path)).json());
	const base = string(repository.default_branch);
	const baseSha = string(
		object(object(await (await github.request(`${path}/git/ref/heads/${encodeURIComponent(base)}`)).json()).object)
			.sha,
	);
	const [open] = await github.all(
		`${path}/pulls?state=open&head=${encodeURIComponent(`${target.owner}:${BUMP_BRANCH}`)}&per_page=100`,
	);
	const lock = object(await (await github.request(`${path}/contents/flake.lock?ref=${baseSha}`)).json());
	const found = questInput(
		object(JSON.parse(Buffer.from(string(lock.content), "base64").toString("utf8"))),
		context.source,
	);
	if (found.locked === sha) {
		if (open) {
			await github.request(`${path}/issues/${Number(open.number)}/comments`, {
				body: {
					body: `quest land watch: ${base} already pins ${name(context.source)} at ${sha}, so this bump is no longer needed.`,
				},
			});
			await github.request(`${path}/pulls/${Number(open.number)}`, {
				method: "PATCH",
				body: { state: "closed" },
			});
			output.push(`bump closed ${name(target)} ${Number(open.number)}`);
		}
		return { sha, status: "done" };
	}

	const remote = connection.remote;
	const ref = `refs/heads/${BUMP_BRANCH}`;
	mkdirSync(join(context.state, "bump"), { recursive: true, mode: 0o700 });
	// A bare cache per target keeps the base's whole history, which `quest check --fix` reads for deleted
	// quests, and makes each later bump's fetch incremental. Its refs keep the fetched commits.
	const cache = join(context.state, "bump", "repos", `${target.owner}-${target.repo}.git`);
	if (!existsSync(join(cache, "HEAD"))) {
		mkdirSync(cache, { recursive: true, mode: 0o700 });
		git(cache, ["init", "--quiet", "--bare"]);
	}
	const checkout = mkdtempSync(join(context.state, "bump", "checkout-"));
	try {
		await connection.read(cache, ["fetch", "--quiet", "--no-tags", remote, `+${baseSha}:refs/bump/base`]);
		git(checkout, ["init", "--quiet"]);
		writeFileSync(
			join(checkout, ".git", "objects", "info", "alternates"),
			`${join(realpathSync(cache), "objects")}\n`,
		);
		git(checkout, ["checkout", "--quiet", "--detach", baseSha]);
		contained(checkout);
		// The open PR's head stays in the branch's history; a branch left by a merged or closed PR is replaced.
		const previous = open ? string(object(open.head).sha) : "";
		const lease = previous || ((await remoteHead(checkout, remote, ref, connection.read)) ?? "");
		if (lease) await connection.read(cache, ["fetch", "--quiet", "--no-tags", remote, `+${lease}:refs/bump/lease`]);

		const reader = await context.reader();
		if (found.pinned !== undefined) {
			const flake = join(checkout, "flake.nix");
			writeFileSync(flake, unpin(readFileSync(flake, "utf8"), context.source, found.pinned));
		}
		context.tools.lock(checkout, found.input, `github:${name(context.source)}/${sha}`, reader);
		const locked = questInput(
			object(JSON.parse(readFileSync(join(checkout, "flake.lock"), "utf8"))),
			context.source,
		);
		if (locked.locked !== sha || locked.pinned !== undefined)
			throw new Error(
				`locking ${found.input} left it at ${locked.locked}${locked.pinned ? ", pinned in flake.nix" : ""}`,
			);
		const quest = context.tools.quest(sha, reader);
		const init = context.tools.run(quest, checkout, ["init"]);
		if (init.status !== 0) throw new Error(`quest init failed: ${init.output.trim()}`);
		const check = context.tools.run(quest, checkout, ["check", "--fix"]);
		const findings = check.status === 0 ? undefined : check.output;

		git(checkout, ["add", "--all"]);
		const tree = git(checkout, ["write-tree"]);
		const changed = git(checkout, ["diff", "--cached", "--name-only", baseSha]).split("\n").filter(Boolean);
		const title = `chore: bump quest to ${sha.slice(0, 7)}`;
		// A newer bump merges the open PR's head with the base, with the fresh bump as its tree, so the
		// branch only moves forward and the squash lands just the bump.
		const parents = previous ? ["-p", previous, "-p", baseSha] : ["-p", baseSha];
		const commit = git(checkout, ["commit-tree", tree, ...parents, "-m", title], { env: IDENTITY });

		const id = open ? string(open.node_id) : undefined;
		// GitHub keeps auto-merge armed across a push, which would land the new head unchecked by this pass.
		if (id && open!.auto_merge != null)
			await github.graphql(
				"mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }",
				{ id },
			);
		if (open) {
			// The PR may have merged or closed during the Nix work, leaving its branch for the lease to match.
			const now = object(await (await github.request(`${path}/pulls/${Number(open.number)}`)).json());
			if (now.state !== "open")
				throw new Error(
					`bump PR ${Number(open.number)} closed while the bump was prepared; the next pass starts over`,
				);
		}
		const pushed = await push(github, checkout, {
			remote,
			from: baseSha,
			to: commit,
			ref,
			lease,
			token: connection.token,
		});
		if (pushed.status !== 0) throw new Error(`push failed: ${pushed.stderr.trim()}`);

		const body = bumpBody({
			source: context.source,
			input: found.input,
			from: found.locked,
			to: sha,
			unpinned: found.pinned !== undefined,
			changed,
			findings,
		});
		const draft = findings !== undefined;
		let number: number;
		if (open) {
			number = Number(open.number);
			// A target whose default branch moved gets its open bump retargeted, since the bump is built on the new one.
			const retarget = string(object(open.base).ref) === base ? {} : { base };
			await github.request(`${path}/pulls/${number}`, { method: "PATCH", body: { title, body, ...retarget } });
			if (open.draft !== draft)
				await github.graphql(
					`mutation($id: ID!) { ${draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview"}(input: { pullRequestId: $id }) { clientMutationId } }`,
					{ id: id! },
				);
		} else {
			const pull = await github.request(`${path}/pulls`, {
				body: { title, head: BUMP_BRANCH, base, body, draft },
			});
			number = Number(object(await pull.json()).number);
		}
		output.push(`bump ${name(target)} ${number} ${sha}${draft ? " waiting" : ""}`);
		return { sha, pr: number, head: commit, status: draft ? "waiting" : "checking" };
	} finally {
		rmSync(checkout, { recursive: true, force: true });
	}
}

const IDENTITY = {
	GIT_AUTHOR_NAME: "moq-bot",
	GIT_AUTHOR_EMAIL: "moq-bot@users.noreply.github.com",
	GIT_COMMITTER_NAME: "moq-bot",
	GIT_COMMITTER_EMAIL: "moq-bot@users.noreply.github.com",
};

/**
 * Land a bump whose head is `record.head`. A base that requires checks, or has a merge queue, gates the
 * PR itself, so it is queued at once. Nothing gates any other base, where landing would merge at once,
 * so the bump first waits for every check on its head to pass, and then merges directly when the
 * repository has no auto-merge, as on a private repository on GitHub Free.
 */
async function settle(target: Repository, record: Bump, connection: BumpConnection, output: string[]): Promise<Bump> {
	const github = new GitHub(connection.deps);
	const path = `/repos/${name(target)}`;
	const pr = record.pr!;
	const head = record.head!;
	const pull = object(await (await github.request(`${path}/pulls/${pr}`)).json());
	if (pull.state !== "open") return { ...record, status: "done" };
	const shown = string(object(pull.head).sha);
	if (shown !== head) {
		// GitHub can show the old head briefly after the push; any other head is someone else's, such as the target's fixer.
		const comparison = object(await (await github.request(`${path}/compare/${shown}...${head}`)).json());
		return comparison.status === "ahead" ? record : { ...record, status: "done" };
	}
	const needs = await requirements(github, target, string(object(pull.base).ref));
	const gated = needs.checks.length > 0 || needs.rules.some((rule) => rule.type === "merge_queue");
	let direct = false;
	const fail = async (why: string) => {
		await github.request(`${path}/issues/${pr}/comments`, {
			body: { body: `quest land watch: ${why}, so this bump waits for a maintainer to fix and land it.` },
		});
		output.push(`bump failed ${name(target)} ${pr}`);
		return { ...record, status: "failed" as const };
	};
	if (!gated) {
		// A workflow's later jobs report only once they start, and a queued workflow may have no check run yet,
		// so Actions is judged by its workflow runs. Another app's suite that never ran a check stays queued
		// forever, and counts for nothing.
		const runs = object(await (await github.request(`${path}/actions/runs?head_sha=${head}&per_page=100`)).json());
		const all = array(runs.workflow_runs);
		const suites = object(await (await github.request(`${path}/commits/${head}/check-suites?per_page=100`)).json());
		const listed = array(suites.check_suites);
		if (Number(runs.total_count) > all.length || Number(suites.total_count) > listed.length)
			throw new Error(`${head} has more workflow runs or check suites than one page, more than a bump reads`);
		const workflows = latestRuns(all);
		// The check runs of a replaced workflow run, such as one a newer run cancelled, are replaced with it.
		const replaced = new Set(
			all
				.filter((run) => !workflows.includes(run) && run.check_suite_id != null)
				.map((run) => Number(run.check_suite_id)),
		);
		const found = (await contexts(github, target, head)).filter((context) => {
			const suite = object(context.checkSuite ?? {}).databaseId;
			return suite == null || !replaced.has(Number(suite));
		});
		const state = found.length === 0 ? "PENDING" : checksState(found);
		if (state === "FAILURE") return fail(`a check failed on its head ${head}`);
		if (workflows.some((run) => run.status === "completed" && !PASSING.includes(String(run.conclusion))))
			return fail(`a workflow failed on its head ${head}`);
		const running =
			workflows.some((run) => run.status !== "completed") ||
			listed.some(
				(suite) =>
					object(suite.app ?? {}).slug !== "github-actions" &&
					Number(suite.latest_check_runs_count) > 0 &&
					suite.status !== "completed",
			);
		if (state === "PENDING" || running) return record;
		direct = object(await (await github.request(path)).json()).allow_auto_merge !== true;
	}
	try {
		// The bump PR is this process's own commit of version files, so it has no quest to check.
		await land({ ...target, number: pr }, { sha: head, direct, check: async () => [] }, connection.deps);
	} catch (error) {
		if (!(error instanceof Refusal)) throw error;
		return fail(`landing it was refused: ${error.message}`);
	}
	output.push(`bump landing ${name(target)} ${pr}`);
	return { ...record, status: "done" };
}

/**
 * The workflow runs on a head that still count: each workflow's latest run per event. A cancelled run
 * also yields to a newer run of its workflow from another event, as when push and pull_request share a
 * `cancel-in-progress` concurrency group, so a run a newer one replaced counts as replaced, not failed.
 */
export function latestRuns(runs: ObjectValue[]): ObjectValue[] {
	return runs.filter((run) => {
		const newer = runs.filter(
			(other) => other.workflow_id === run.workflow_id && Number(other.id) > Number(run.id),
		);
		if (newer.some((other) => other.event === run.event)) return false;
		return !(run.conclusion === "cancelled" && newer.length > 0);
	});
}

/** The tools on the host: Nix locks the input and builds the source's quest; its commands get no credentials. */
export function hostTools(source: Repository, state: string): BumpTools {
	const environment = (token: string) => ({
		...commandEnvironment(),
		HOME: join(state, "bump"),
		XDG_CACHE_HOME: join(state, "bump", "cache"),
		NIX_CONFIG: `access-tokens = github.com=${token}`,
	});
	const nix = (cwd: string, args: string[], token: string) => {
		const result = spawnSync("nix", ["--extra-experimental-features", "nix-command flakes", ...args], {
			cwd,
			encoding: "utf8",
			env: environment(token),
			maxBuffer: 1 << 30,
		});
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(`nix ${args.join(" ")} failed: ${result.stderr.trim()}`);
		return result.stdout.trim();
	};
	const built = new Map<string, string>();
	return {
		lock: (checkout, input, url, token) => {
			nix(checkout, ["flake", "lock", "--override-input", input, url], token);
		},
		quest: (sha, token) => {
			let path = built.get(sha);
			// `--no-link` roots nothing, so Nix's garbage collection may remove a cached build before a retry.
			if (path === undefined || !existsSync(path)) {
				path = join(
					nix(state, ["build", "--no-link", "--print-out-paths", `github:${name(source)}/${sha}`], token),
					"bin",
					"quest",
				);
				built.set(sha, path);
			}
			return path;
		},
		run: (quest, checkout, args) => {
			// Bun reads bunfig.toml, whose preload runs code, from its working directory: never the target's.
			const trusted = join(state, "bump", "run");
			mkdirSync(trusted, { recursive: true, mode: 0o700 });
			const result = spawnSync(quest, ["--root", checkout, ...args], {
				cwd: trusted,
				encoding: "utf8",
				env: { ...commandEnvironment(), HOME: join(state, "bump"), NO_COLOR: "1" },
				maxBuffer: 1 << 30,
			});
			if (result.error) throw result.error;
			return { status: result.status, output: `${result.stdout}${result.stderr}` };
		},
	};
}

/** Fail at startup, not on the first bump, when the host cannot run one. */
export function checkTools(): void {
	const nix = spawnSync("nix", ["--version"], { encoding: "utf8" });
	if (nix.error || nix.status !== 0) throw new Error("quest land watch --bump requires nix on PATH");
}
