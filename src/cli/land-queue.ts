// The watcher's own serial queue, for a base without GitHub's merge queue, such as a private repository on
// GitHub Team: test one pick at a time on top of the base in the repository's queue workflow, then land
// exactly the tested tree with the App.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	GitHub,
	type GitHubDependencies,
	object,
	type ObjectValue,
	type RequiredCheck,
	type Repository,
	requirements,
	string,
} from "../github/client";
import {
	baseRemote,
	eject,
	ejection,
	type Entry,
	git,
	type LandMethod,
	mergeBase,
	type Plan,
	type RemoteRead,
	requiredChecks,
	tryGit,
} from "./land";
import { LAND_CHECK } from "../github/land";
import { post } from "./land-fixer";
import { gitAuthentication } from "./land-git";
import {
	finishFallback,
	forgetHeads,
	landedCommit,
	landFallback,
	mergePinned,
	prepareHead,
	push,
	remoteHead,
	resolvePreparedQueue,
	touchesWorkflows,
} from "./land-head";
import {
	account,
	AFTER,
	because,
	type FailedJob,
	failingJobs,
	jobBlocks,
	jobsSection,
	listed,
	login,
	type QueuePick,
	type Removal,
	removalLog,
} from "./land-watch";
import { excerpt, save } from "./land-serve";
import { advanceFixes, type FixContext, isHeld, readPull, readRemoval, requeuedHeads } from "./land-watch-fix";

/** The check run each pick in the own queue carries, showing its place; informational, never a required context. */
export const QUEUE_CHECK = "quest queue";

/** Where a base's builds are pushed, outside the reserved `quest/` namespace, for the queue workflow to build. */
const queuePrefix = (base: string) => `quest-queue/${base}/`;

/** The branch PR `number`'s build on `base` is pushed to. */
export const queueBranch = (base: string, number: number) => `${queuePrefix(base)}${number}`;

/** What the own queue needs beyond the API: the daemon's private repository, its pushes, and its reads. */
export interface OwnQueue {
	root: string;
	state: string;
	method: LandMethod;
	/** Minutes a build may run before it is dropped as timed out. */
	timeout: number;
	token: (workflows: boolean) => Promise<string>;
	read: RemoteRead;
	/** Eject picks whose head is outside the repository before their build is pushed, for a private queue runner. */
	refuseForks?: boolean;
	/** Whether this process has pruned the queue branches an earlier one left behind. */
	pruned?: boolean;
}

type DropReason = "failed_checks" | "checks_timed_out" | "merge_conflict";

/** The pick under test, in `queue.json`, from its build's start until it lands, is dropped, or leaves the queue. */
interface Build {
	/** The pick as the queue resolved it when the build started; `approved` is the head under test. */
	entry: Entry;
	/** The pick it belongs to, which a drop hands the fixer. */
	pick: QueuePick;
	/** The base it is built on. */
	base: string;
	branch: string;
	/** The base merged into the pick, as pushed to `branch`; absent for a conflict. */
	test?: { commit: string; tree: string };
	started: string;
	/** A drop being recorded, so a restart finishes it: the fixer's removal, and the PR's comment and its jobs. */
	drop?: { removal: Removal; comment: string; blocks: string[] };
}

/** What a PR's queue check shows. */
type View = {
	status: "queued" | "in_progress" | "completed";
	conclusion?: "success" | "failure" | "neutral";
	title: string;
	summary: string;
	url?: string;
};

/** The queue check each PR last got, in `queue-checks.json`, so a pass writes only what changed. */
interface Shown {
	head: string;
	id: number;
	status: View["status"];
	title: string;
	summary: string;
	url?: string;
}

const buildPath = (state: string) => join(state, "queue.json");
const shownPath = (state: string) => join(state, "queue-checks.json");

function readBuild(state: string): Build | undefined {
	const path = buildPath(state);
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Build) : undefined;
}

/** One pass of the own queue, and the PRs it changed. `again` asks for the next pass at once, as after a landing. */
interface Pass {
	lines: string[];
	again: boolean;
}

/** The pass's GitHub, its repository's name, the App's login, and the queue's own settings. */
class Queue {
	readonly github: GitHub;
	readonly name: string;
	readonly remote: string;
	readonly lines: string[] = [];
	/** The PRs this pass dropped or tried to land, which its plan still lists as picks. */
	readonly ended = new Set<number>();
	/** Whether this pass tried to land a pick, which moves the base the next build needs. */
	landing = false;
	private shown: Record<number, Shown>;

	constructor(
		readonly repository: Repository,
		readonly base: string,
		readonly queue: OwnQueue,
		readonly deps: GitHubDependencies,
		readonly app: string,
		readonly fixing: boolean,
	) {
		this.github = new GitHub(deps);
		this.name = `${repository.owner}/${repository.repo}`;
		this.remote = baseRemote({ repository: this.name });
		const path = shownPath(queue.state);
		this.shown = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<number, Shown>) : {};
	}

	/** Show `view` on PR `number`'s head `head`, writing only a change, and a new check run once one completed. */
	async show(number: number, head: string, view: View): Promise<void> {
		const shown = this.shown[number];
		if (
			shown?.head === head &&
			shown.status === view.status &&
			shown.title === view.title &&
			shown.summary === view.summary &&
			shown.url === view.url
		)
			return;
		// A head the PR left, as for the queue's own base merge before it lands, keeps no unfinished check.
		if (shown && shown.head !== head && shown.status !== "completed")
			await this.github.request(`/repos/${this.name}/check-runs/${shown.id}`, {
				method: "PATCH",
				body: {
					status: "completed",
					conclusion: "neutral",
					output: { title: "Moved", summary: `This pull request's head moved to ${head}.` },
				},
			});
		const body = {
			status: view.status,
			...(view.conclusion ? { conclusion: view.conclusion } : {}),
			...(view.url ? { details_url: view.url } : {}),
			output: { title: view.title, summary: view.summary },
		};
		let id: number;
		if (shown?.head === head && shown.status !== "completed") {
			await this.github.request(`/repos/${this.name}/check-runs/${shown.id}`, { method: "PATCH", body });
			id = shown.id;
		} else {
			const response = await this.github.request(`/repos/${this.name}/check-runs`, {
				body: { name: QUEUE_CHECK, head_sha: head, ...body },
			});
			id = Number(object(await response.json()).id);
		}
		this.shown[number] = {
			head,
			id,
			status: view.status,
			title: view.title,
			summary: view.summary,
			...(view.url ? { url: view.url } : {}),
		};
		save(shownPath(this.queue.state), this.shown);
	}

	/** Complete the queue check of each PR that left the queue without an outcome, and forget completed ones. */
	async leave(open: Set<number>, why: string): Promise<void> {
		for (const [key, shown] of Object.entries(this.shown)) {
			const number = Number(key);
			if (open.has(number)) continue;
			if (shown.status !== "completed")
				await this.show(number, shown.head, {
					status: "completed",
					conclusion: "neutral",
					title: "Left the queue",
					summary: why,
				});
			delete this.shown[number];
			save(shownPath(this.queue.state), this.shown);
		}
	}

	/** Cancel every unfinished run on a build's branch, and delete the branch. */
	async clear(branch: string): Promise<void> {
		const runs = await listed(
			this.github,
			`/repos/${this.name}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=100`,
			"workflow_runs",
		);
		for (const run of runs.filter((item) => item.status !== "completed"))
			await this.github.request(`/repos/${this.name}/actions/runs/${Number(run.id)}/cancel`, {
				method: "POST",
				allow: [409],
			});
		await this.delete(`refs/heads/${branch}`);
	}

	/** Delete `ref` from the repository, leased to the commit it holds now, if it exists. */
	async delete(ref: string): Promise<void> {
		const sha = await remoteHead(this.queue.root, this.remote, ref, this.queue.read);
		if (sha === null) return;
		const deleted = tryGit(
			this.queue.root,
			["push", "--quiet", this.remote, `:${ref}`, `--force-with-lease=${ref}:${sha}`],
			{
				env: gitAuthentication(await this.queue.token(false)),
			},
		);
		if (deleted.status !== 0) throw new Error(`deleting ${ref} failed: ${deleted.stderr.trim()}`);
	}

	/** End `build`: its runs and branch go, its PR shows `view` on `head` if given, and the queue forgets it. */
	async end(build: Build, view?: View, head = build.entry.head): Promise<void> {
		await this.clear(build.branch);
		if (view) await this.show(build.entry.number, head, view);
		rmSync(buildPath(this.queue.state), { force: true });
	}

	/**
	 * Clear the queue branches of this base that no build holds, as a daemon that crashed between a push
	 * and its record leaves them, cancelling their runs so none holds the queue runner.
	 */
	async prune(keep?: string): Promise<void> {
		const prefix = `refs/heads/${queuePrefix(this.base)}`;
		const listing = await this.queue.read(this.queue.root, ["ls-remote", this.remote, `${prefix}*`]);
		for (const line of listing.split("\n").filter(Boolean)) {
			const ref = line.split("\t")[1];
			if (ref.startsWith(prefix) && ref !== `refs/heads/${keep}`)
				await this.clear(ref.slice("refs/heads/".length));
		}
	}

	/**
	 * The pick an armed PR belongs to: its arm, unless the App armed a head the watcher put back in the
	 * queue for a pick still going, which that arm continues.
	 */
	async pickOf(entry: Entry): Promise<QueuePick> {
		const data = await this.github.graphql(
			"query($id: ID!) { node(id: $id) { ... on PullRequest { autoMergeRequest { enabledAt enabledBy { login } } } } }",
			{ id: entry.id },
		);
		const request = object(data.node).autoMergeRequest;
		const by = request == null ? "" : login(object(request).enabledBy);
		const own = requeuedHeads(this.queue.state, entry.number);
		if (own && account(by) === this.app && own.heads.includes(entry.approved) && entry.enabledAt > own.pick)
			return { by, at: own.pick };
		return { by, at: entry.enabledAt };
	}

	/**
	 * Start testing `entry` on `plan`'s base: merge the base into the pick with the quest merge driver, as
	 * the land fixer merges a conflict, push it to the pick's queue branch for the queue workflow, and
	 * record it. A conflict the driver cannot merge drops the pick.
	 */
	async start(plan: Plan, entry: Entry): Promise<Build | undefined> {
		const { root, read, token } = this.queue;
		const build: Build = {
			entry,
			pick: await this.pickOf(entry),
			base: plan.base.sha,
			branch: queueBranch(this.base, entry.number),
			started: new Date(this.deps.now()).toISOString(),
		};
		await read(root, ["fetch", "--quiet", "--no-tags", this.remote, plan.base.sha, entry.approved]);
		const merged = mergeBase(root, entry.approved, plan.base.sha);
		if ("reason" in merged) {
			await this.drop(build, "merge_conflict", [], merged.detail);
			return undefined;
		}
		const ref = `refs/heads/${build.branch}`;
		// A branch an earlier build of this PR left behind, as before a crash, is replaced.
		const lease = (await remoteHead(root, this.remote, ref, read)) ?? "";
		const workflows =
			git(root, ["diff", "--name-only", plan.base.sha, merged.head, "--", ".github/workflows"]) !== "";
		const pushed = await push(this.github, root, {
			remote: this.remote,
			from: entry.approved,
			to: merged.head,
			ref,
			lease,
			token: (more) => token(more || workflows),
		});
		if (pushed.status !== 0) throw new Error(`pushing ${build.branch} failed: ${pushed.stderr.trim()}`);
		build.test = { commit: merged.head, tree: merged.tree };
		save(buildPath(this.queue.state), build);
		this.lines.push(`building ${entry.number} ${merged.head}`);
		return build;
	}

	/**
	 * Drop `build`'s pick, as GitHub's queue removes a PR: record it for the land fixer, disarm its
	 * auto-merge, and say why on the PR. The drop is recorded first, so a restart finishes it.
	 */
	async drop(build: Build, reason: DropReason, jobs: (FailedJob & { log: string })[], detail = ""): Promise<void> {
		const at = new Date(this.deps.now()).toISOString();
		const { entry } = build;
		const number = entry.number;
		const head = entry.head;
		const log = removalLog(
			this.queue.state,
			number,
			at,
			`The queue removed ${entry.url} at ${head} for ${reason}, on ${this.base} at ${build.base}.${detail ? `\n\n${detail}` : ""}`,
			jobs,
		);
		const fixed: Entry = { ...entry, enabledAt: build.pick.at, approved: head };
		const removal: Removal = {
			event: `queue ${number} ${at}`,
			at,
			number,
			url: entry.url,
			reason,
			actor: this.app,
			head,
			current: head,
			pick: build.pick,
			verdict: "fix",
			jobs: jobs.map(({ log: _, ...job }) => job),
			log,
			failure: {
				plan: { repository: this.name, base: { ref: this.base, sha: build.base }, queue: [fixed], eject: [] },
				ejections: [],
				numbers: [number],
				log,
				tip: head,
				reason: reason === "merge_conflict" ? "merge_conflict" : "failed_checks",
				blame: [number],
			},
		};
		const blocks = jobBlocks(jobs);
		const missing =
			jobs.length === 0 && reason !== "merge_conflict"
				? "\n\nThe watcher found no failing job in the queue build's runs."
				: "";
		const comment = `quest land watch: the queue removed this pull request at ${head} because ${because(reason, this.app, this.base, "queue")} (\`${reason}\`).${AFTER.fix(head, this.fixing)}${missing}`;
		build.drop = { removal, comment, blocks };
		this.ended.add(number);
		save(buildPath(this.queue.state), build);
		await this.finishDrop(build);
	}

	/** Finish recording `build`'s drop; each step is safe to repeat after a restart. */
	async finishDrop(build: Build): Promise<void> {
		const { removal, comment, blocks } = build.drop!;
		const number = removal.number;
		// A newer removal's record, as one the fixer took since, stays.
		if ((readRemoval(this.queue.state, number)?.at ?? "") <= removal.at)
			save(join(this.queue.state, `removal-${number}.json`), removal);
		const pull = await readPull(this.github, build.entry.id);
		const request = pull.autoMergeRequest == null ? null : object(pull.autoMergeRequest);
		if (pull.state === "OPEN" && request !== null && string(request.enabledAt) === build.entry.enabledAt)
			await this.github.graphql(
				"mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }",
				{ id: build.entry.id },
			);
		await post(
			this.github,
			{ repository: this.name },
			{ number, enabledAt: removal.pick.at },
			comment,
			`removed ${removal.event}`,
			"quest land watch",
			undefined,
			(room) => jobsSection(blocks, room),
		);
		await this.end(build, {
			status: "completed",
			conclusion: "failure",
			title: "Removed from the queue",
			summary: `The queue removed this pull request for \`${removal.reason}\`; its comment says what happens next.`,
		});
		this.lines.push(`removed ${number} ${removal.reason}`);
	}

	/**
	 * Land `build`'s passing pick through `quest land serve`'s landing path: lease-push the base merge to
	 * the PR, merge it with GitHub's merge API pinned to that head, and verify the landed tree is the tested
	 * one, or fast-forward the base to the tested commit when the PR's branch refuses the push.
	 */
	async land(build: Build, plan: Plan, entry: Entry): Promise<void> {
		const { root, state, method, token, read } = this.queue;
		const number = entry.number;
		this.ended.add(number);
		this.landing = true;
		const test = build.test!;
		const prepared = await prepareHead(root, state, plan, entry, build.base, test.tree, this.deps, token, read);
		if ("fallback" in prepared) {
			// The tested tree, landed onto the tested base as GitHub's merge API would.
			const parents = method === "merge" ? [build.base, entry.approved] : [build.base];
			const commit = git(root, ["commit-tree", test.tree, ...parents.flatMap((parent) => ["-p", parent])], {
				input: `${entry.title} (#${number})`,
			});
			const done = await landFallback(root, state, plan, entry, commit, build.base, this.deps, token, read);
			return this.fallen(build, done);
		}
		if ("reason" in prepared) return this.refused(build, plan, entry, prepared.reason, prepared.detail);
		const merge = new GitHub({
			...this.deps,
			token: await token(touchesWorkflows(root, build.base, test.commit, build.base, prepared.head)),
		});
		const result = await mergePinned(
			merge,
			`/repos/${this.name}/pulls/${number}`,
			method,
			prepared.head,
			entry.head,
		);
		if (result === null) {
			// GitHub shows it merged, as after a lost response: nothing is left to land.
			forgetHeads(state, number);
			this.lines.push(`merged ${number}`);
			return this.end(build, {
				status: "completed",
				conclusion: "success",
				title: "Merged",
				summary: "GitHub shows this pull request merged.",
			});
		}
		if ("reason" in result) return this.refused(build, plan, entry, result.reason, result.detail);
		forgetHeads(state, number);
		const landed = await landedCommit(merge, this.name, method, result.sha, test.tree, prepared.head);
		// The ruleset leaves the watcher the base's only writer, so a moved parent is an admin's bypass.
		if (landed.parent !== build.base)
			this.deps.warn(
				`quest land watch: the base moved before ${method} #${number}: expected parent ${build.base}, got ${landed.parent}`,
			);
		if (landed.faults.length > 0)
			this.deps.warn(
				`CRITICAL: GitHub ${method} #${number} at ${result.sha} ${landed.faults.join(", and ")}. It stays merged`,
			);
		this.lines.push(`landed ${number} ${result.sha}`);
		await this.end(build, landedView(result.sha), prepared.head);
	}

	/** Settle a fallback landing, finished or not. */
	async fallen(build: Build, done: string | null): Promise<void> {
		if (done) this.lines.push(done);
		if (done?.startsWith("landed ")) return this.end(build, landedView(done.split(" ")[2]));
		// The base moved or the pick left the queue: the next pass rebuilds or forgets it. A refused push
		// ejected the PR, with its comment.
		return this.end(
			build,
			done?.startsWith("ejected ")
				? {
						status: "completed",
						conclusion: "failure",
						title: "Removed from the queue",
						summary: "GitHub refused the push of the tested commit to the base.",
					}
				: undefined,
		);
	}

	/** Settle a landing GitHub refused, or one that found the pick changed. */
	async refused(build: Build, plan: Plan, entry: Entry, reason: string, detail: string): Promise<void> {
		this.lines.push(`refused ${entry.number} ${reason}`);
		// A conflict with a head that holds the tested base comes from a base that moved since: rebuild.
		if (reason === "merge_conflict") return this.end(build);
		// A writer's push ends the pick; the next pass ejects it for the moved head.
		if (reason === "head_moved")
			return this.end(build, {
				status: "completed",
				conclusion: "neutral",
				title: "Left the queue",
				summary: detail,
			});
		if (reason === "tree_mismatch") this.deps.warn(`CRITICAL: ${detail}`);
		await eject(
			this.github,
			plan,
			ejection(entry, reason === "tree_mismatch" ? "tree_mismatch" : "merge_refused", excerpt(detail)),
		);
		forgetHeads(this.queue.state, entry.number);
		await this.end(build, {
			status: "completed",
			conclusion: "failure",
			title: "Removed from the queue",
			summary: excerpt(detail),
		});
	}

	/** Where `build`'s required checks stand on its test commit, and the runs on its branch. */
	async status(build: Build, required: RequiredCheck[]) {
		const commit = build.test!.commit;
		const checks = await requiredChecks(this.github, this.repository, commit, required);
		const runs = (
			await listed(
				this.github,
				`/repos/${this.name}/actions/runs?head_sha=${commit}&per_page=100`,
				"workflow_runs",
			)
		).filter((run) => run.head_branch === build.branch);
		return { ...checks, runs };
	}
}

/** Whether `pull`'s head is outside `repository`: in a fork, or in one since deleted. */
const isFork = (pull: ObjectValue, repository: string): boolean =>
	pull.headRepository == null ||
	string(object(pull.headRepository).nameWithOwner).toLowerCase() !== repository.toLowerCase();

const landedView = (sha: string): View => ({
	status: "completed",
	conclusion: "success",
	title: "Landed",
	summary: `The queue landed this pull request as ${sha}.`,
});

const ordinal = (index: number, count: number) => `Position ${index + 1} of ${count}`;

/**
 * One pass of the own queue over `base`: finish a drop or a fallback landing a restart interrupted,
 * eject picks GitHub's own records rule out, advance the build in progress (land it once its required
 * checks pass on the test commit, drop it for the land fixer once one fails or it runs past its timeout,
 * rebuild it on a moved base), start the next pick when none builds, and show each pick its place.
 * With a fixer, it then advances the fixer's rounds, which put fixed picks back by arming auto-merge.
 */
export async function ownPass(
	repository: Repository,
	base: string,
	queue: OwnQueue,
	deps: GitHubDependencies,
	fix?: FixContext,
): Promise<Pass> {
	const github = new GitHub(deps);
	const app = account(string(object((await github.graphql("query { viewer { login } }", {})).viewer).login));
	const own = new Queue(repository, base, queue, deps, app, fix !== undefined);
	const { state } = queue;
	let build = readBuild(state);
	let again = false;
	if (build?.drop) {
		await own.finishDrop(build);
		build = undefined;
		again = true;
	}
	if (!queue.pruned) {
		await own.prune(build?.branch);
		queue.pruned = true;
	}
	const fallen = await finishFallback(queue.root, state, deps, queue.token, queue.read);
	if (fallen && build && fallen.split(" ")[1] === String(build.entry.number)) {
		await own.fallen(build, fallen);
		build = undefined;
		again = true;
	} else if (fallen) own.lines.push(fallen);

	const required = (await requirements(github, repository, base)).checks.filter((check) => check.name !== LAND_CHECK);
	if (required.length === 0)
		throw new Error(
			`${own.name}'s ${base} requires no check besides ${LAND_CHECK}, so the queue has no build result to wait for`,
		);
	const plan = await resolvePreparedQueue(queue.root, state, repository, { base, method: queue.method }, deps);
	for (const item of plan.eject) {
		if (await eject(github, plan, item)) own.lines.push(`ejected ${item.number} ${item.reason}`);
		forgetHeads(state, item.number);
	}
	const held = new Set<number>();
	for (const entry of plan.queue) {
		const pull = await readPull(github, entry.id);
		if (isHeld(pull)) held.add(entry.number);
		// Read fresh, since a deleted fork's head shows as no repository, which the plan reads as the base's.
		else if (queue.refuseForks && isFork(pull, own.name)) {
			const item = ejection(entry, "fork_head", "fork pull requests cannot use the private runner");
			if (await eject(github, plan, item)) own.lines.push(`ejected ${entry.number} fork_head`);
			forgetHeads(state, entry.number);
			own.ended.add(entry.number);
			await own.show(entry.number, entry.head, {
				status: "completed",
				conclusion: "failure",
				title: "Removed from the queue",
				summary: "Fork pull requests cannot use the private runner.",
			});
		}
	}

	if (build) {
		const tested = build;
		const entry = plan.queue.find(
			(item) =>
				item.number === tested.entry.number &&
				item.enabledAt === tested.entry.enabledAt &&
				item.approved === tested.entry.approved,
		);
		if (entry && own.ended.has(entry.number)) {
			// Ejected above, which showed why.
			await own.end(build);
			build = undefined;
			again = true;
		} else if (!entry || held.has(entry.number)) {
			// The pick ended: a person disarmed it, a writer pushed, it closed, or another session holds it,
			// which leaves it armed for when the hold clears.
			await own.end(build, {
				status: "completed",
				conclusion: "neutral",
				title: "Left the queue",
				summary: entry ? "Another session holds this pull request." : "The pick ended while it was building.",
			});
			own.lines.push(`left ${build.entry.number}`);
			build = undefined;
			again = true;
		} else if (plan.base.sha !== build.base) {
			// The base moved: build the pick again on the new base, as no attempt of its own.
			await own.clear(build.branch);
			own.lines.push(`rebuilding ${entry.number} on ${plan.base.sha}`);
			build = await own.start(plan, entry);
			again ||= build === undefined;
		} else {
			const status = await own.status(build, required);
			const url = status.runs.map((run) => string(run.html_url)).at(0);
			if (status.failing.length > 0) {
				await own.drop(build, "failed_checks", await failingJobs(github, own.name, status.runs, false));
				build = undefined;
				again = true;
			} else if (status.pending.length > 0) {
				if (deps.now() - Date.parse(build.started) >= queue.timeout * 60_000) {
					await own.drop(build, "checks_timed_out", await failingJobs(github, own.name, status.runs, true));
					build = undefined;
					again = true;
				} else
					await own.show(entry.number, entry.head, {
						status: "in_progress",
						title: `Building on ${base}`,
						summary: `The queue is building this pull request merged with ${base} at ${build.base}, waiting on ${status.pending.map((name) => `\`${name}\``).join(", ")}.`,
						...(url ? { url } : {}),
					});
			} else {
				await own.land(build, plan, entry);
				build = undefined;
				again = true;
			}
		}
	}

	// After a landing, the next pick waits for the next pass, which reads the base it moved to, and
	// rebuilds first a pick whose landing found the base moved.
	if (!build && !own.landing) {
		for (const entry of plan.queue) {
			if (held.has(entry.number) || own.ended.has(entry.number)) continue;
			build = await own.start(plan, entry);
			if (build) break;
			again = true;
		}
	}

	const open = new Set<number>();
	const picks = plan.queue.filter((entry) => !held.has(entry.number) && !own.ended.has(entry.number));
	for (const entry of plan.queue) {
		if (own.ended.has(entry.number)) continue;
		open.add(entry.number);
		if (entry.number === build?.entry.number) {
			if (own.lines.some((line) => line.startsWith(`building ${entry.number} `)))
				await own.show(entry.number, entry.head, {
					status: "in_progress",
					title: `Building on ${base}`,
					summary: `The queue is building this pull request merged with ${base} at ${build.base}.`,
				});
			continue;
		}
		await own.show(
			entry.number,
			entry.head,
			held.has(entry.number)
				? {
						status: "queued",
						title: "Held",
						summary: "Another session holds this pull request; it keeps its place until the hold clears.",
					}
				: {
						status: "queued",
						title: ordinal(picks.indexOf(entry), picks.length),
						summary: `The queue tests one pull request at a time on top of ${base}, in the order they were picked; ${picks.indexOf(entry)} ahead of this one.`,
					},
		);
	}
	// A pick waiting on its own required checks or an approval shows what, so the wait is never silent.
	for (const waiting of plan.waiting ?? []) {
		open.add(waiting.number);
		const waits = [
			...waiting.pending.map((name) => `the required check or workflow \`${name}\` to pass`),
			...(waiting.approval ? [`an approving review, which ${base} requires`] : []),
		];
		await own.show(waiting.number, waiting.head, {
			status: "queued",
			title: "Waiting",
			summary: `It keeps its place and joins the queue once nothing is left to wait for: ${waits.join(", ")}.`,
		});
	}
	await own.leave(open, "The pick ended: its auto-merge was disabled, or it closed.");
	if (fix)
		own.lines.push(
			...(await advanceFixes(own.name, plan.base, state, fix, deps, { kind: "own", method: queue.method })),
		);
	return { lines: own.lines, again };
}

/**
 * Leave the own queue once the base has GitHub's merge queue: finish a drop a restart interrupted, end
 * the build in progress, and complete every queue check. A pass that finds no own queue state does nothing.
 */
export async function leaveOwnQueue(
	repository: Repository,
	base: string,
	queue: OwnQueue,
	deps: GitHubDependencies,
	fixing: boolean,
): Promise<string[]> {
	const build = readBuild(queue.state);
	if (!build && !existsSync(shownPath(queue.state))) return [];
	const github = new GitHub(deps);
	const app = account(string(object((await github.graphql("query { viewer { login } }", {})).viewer).login));
	const own = new Queue(repository, base, queue, deps, app, fixing);
	if (build?.drop) await own.finishDrop(build);
	else if (build) await own.end(build);
	await own.leave(new Set(), `${base} lands through GitHub's merge queue now.`);
	rmSync(shownPath(queue.state), { force: true });
	return [...own.lines, "left the own queue"];
}
