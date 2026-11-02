// Publishing a job's work as the GitHub App. A runner sends file changes as
// data; the service checks them against the job's workflow, commits them to
// the job's one branch, and opens or updates its pull request. Nothing a runner
// sends is executed, and runners never receive GitHub credentials.
import { isQuest } from "quest/core";
import {
	type Branch,
	BranchChanged,
	type Change,
	GitHubService,
	PublicationBlocked,
	type GitHubRepository,
	type MergeMethod,
} from "../github/service";
import { id, text } from "./protocol";
import * as store from "./store";
import { JobError, onPull, type Runner, type Workflow } from "./store";
import { withDecisions } from "./trail";

/** Bounds one request's GitHub writes: inline text costs no extra request, other files one each. */
export const LIMITS = { changes: 500, bytes: 16 * 1024 * 1024, request: 24 * 1024 * 1024 };

export type Publication = {
	job: string;
	attempt: number;
	/** The commit the changes build on: the job's branch head, or null before the branch exists. */
	head: string | null;
	/** The agent session to resume if the publication needs a decision. */
	session: string | null;
	message: string | null;
	changes: Change[];
	/**
	 * A commit of the branch's upstream base that the changes merge in: they
	 * become a merge commit of `head` and it, relative to its files.
	 */
	merge: string | null;
	/** Existing head pointers carried into a tree built relative to the merged-in commit. */
	submodules: { path: string; sha: string }[];
	pull: { title: string; body: string; draft: boolean } | null;
	/** A merge job lands its pull request at the published head, with the merge method its instructions name. */
	land: { method: MergeMethod | null } | null;
};

/** Whether `path` names a file inside a work tree, never Git's own directory. */
export function validPath(path: string) {
	return (
		path.length <= 1024 &&
		!/[\x00-\x1f\x7f\\]/.test(path) &&
		path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git")
	);
}

const WORKFLOWS = "Changing GitHub Actions workflows needs the workflows permission, which the App does not request";

/**
 * Why `workflow` may not publish `path`, or null when it may. A refusal
 * becomes a maintainer decision rather than silently dropping the change.
 */
export function refusal(workflow: Workflow, path: string, merging = false): string | null {
	// A merge publication's changes are relative to the merged-in commit, so commit() checks its workflows instead.
	if (!merging && (path === ".github/workflows" || path.startsWith(".github/workflows/"))) return WORKFLOWS;
	if (workflow === "bootstrap" && path !== "flake.nix" && path !== "flake.lock")
		return "A devShell bootstrap publishes only flake.nix and flake.lock";
	if (workflow === "plan" && !(path.startsWith("quest/") && isQuest(path)))
		return "Planning publishes only quest files";
	return null;
}

function base64(value: string) {
	if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new JobError("Invalid base64 content");
	return new Uint8Array(Buffer.from(value, "base64"));
}

/** Parse a runner's publication request. Every field is untrusted input. */
export function parsePublication(body: Record<string, unknown>): Publication {
	const job = id(body.job);
	const attempt = body.attempt;
	if (!job || typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1)
		throw new JobError("Job and attempt required");
	if (body.head !== null && !(typeof body.head === "string" && /^[a-f0-9]{40}$/.test(body.head)))
		throw new JobError("The commit the changes build on is required, or null for a new branch");
	const session = body.session === undefined ? null : text(body.session, 200);
	if (body.session !== undefined && !session) throw new JobError("Invalid session");
	const list = body.changes ?? [];
	if (!Array.isArray(list) || list.length > LIMITS.changes)
		throw new JobError(`At most ${LIMITS.changes} changes per publication`);
	let bytes = 0;
	const changes = list.map((item: Record<string, unknown> | null): Change => {
		const path = item?.path;
		if (typeof path !== "string" || !validPath(path)) throw new JobError("Invalid change path");
		const { executable, symlink } = item!;
		if (executable !== undefined && typeof executable !== "boolean") throw new JobError("Invalid executable flag");
		if (symlink !== undefined && typeof symlink !== "boolean") throw new JobError("Invalid symlink flag");
		if (executable && symlink) throw new JobError("A symlink cannot be executable");
		if (item!.content !== null && typeof item!.content !== "string")
			throw new JobError("Change content must be base64, or null to delete");
		const content = item!.content === null ? null : base64(item!.content as string);
		bytes += content?.length ?? 0;
		// A symlink's content is its target. Submodules have no representation here.
		return { path, content, mode: symlink ? "120000" : executable ? "100755" : "100644" };
	});
	if (bytes > LIMITS.bytes) throw new JobError("Publication too large");
	if (new Set(changes.map((change) => change.path)).size !== changes.length)
		throw new JobError("Duplicate change path");
	if (body.merge !== undefined && !(typeof body.merge === "string" && /^[a-f0-9]{40}$/.test(body.merge)))
		throw new JobError("The merged commit must be a full SHA");
	const merge = (body.merge as string | undefined) ?? null;
	const submodules = body.submodules ?? [];
	if (
		!Array.isArray(submodules) ||
		submodules.length > LIMITS.changes ||
		!submodules.every(
			(item) =>
				item &&
				typeof item.path === "string" &&
				validPath(item.path) &&
				typeof item.sha === "string" &&
				/^[a-f0-9]{40}$/.test(item.sha),
		)
	)
		throw new JobError("Invalid submodule paths");
	if (submodules.length && !merge) throw new JobError("Only a merge carries existing submodule pointers");
	if (
		new Set([...changes.map((change) => change.path), ...submodules.map((item) => item.path)]).size !==
		changes.length + submodules.length
	)
		throw new JobError("Duplicate change path");
	const message = changes.length || merge ? text(body.message, 64 * 1024) : null;
	if ((changes.length || merge) && !message) throw new JobError("Commit message required");
	let land: Publication["land"] = null;
	if (body.land !== undefined) {
		const method = (body.land as Record<string, unknown> | null)?.method;
		if (method !== undefined && method !== "merge" && method !== "squash" && method !== "rebase")
			throw new JobError("Land with the merge, squash, or rebase method");
		land = { method: (method as MergeMethod | undefined) ?? null };
	}
	let pull: Publication["pull"] = null;
	if (body.pull !== undefined) {
		const input = body.pull as Record<string, unknown> | null;
		const title = text(input?.title, 256);
		const description = input?.body;
		if (
			!title ||
			typeof description !== "string" ||
			description.length > 60_000 ||
			(input!.draft !== undefined && typeof input!.draft !== "boolean")
		)
			throw new JobError("Pull request title and body required");
		pull = { title, body: description, draft: input!.draft !== false };
	}
	if (!changes.length && !merge && !pull && !land) throw new JobError("Nothing to publish");
	return {
		job,
		attempt,
		head: body.head as string | null,
		session,
		message,
		changes,
		merge,
		submodules: submodules as Publication["submodules"],
		pull,
		land,
	};
}

/**
 * The publication builds on a head the job's branch has moved past, such as
 * when the reply to an earlier publication was lost. The runner continues from `head`.
 */
export class HeadMoved extends JobError {
	constructor(readonly head: string | null) {
		super(`The job's branch is at ${head ?? "no commit yet"}; continue from it`);
	}
}

/** A pause on a decision; `asked` is false for a retry of one already asked. */
type Decision = { decision: string; cancel: boolean; asked: boolean };
type Published = {
	head: string | null;
	pull?: { number: number; url: string; draft: boolean };
	/** A merge job's landing: merged at once, or queued or auto-merging. */
	landed?: { merged: boolean };
};

const DECISION = "Publishing this work needs a maintainer's decision";

/** The number of a `pulls/<n>` target. */
export function pullOf(target: string) {
	return Number(target.match(/^pulls\/(\d{1,15})$/)?.[1] ?? Number.NaN);
}

/** Pause the attempt on a decision the maintainer must make before this can publish. */
async function decide(db: D1Database, runner: Runner, input: Publication, prompt: unknown): Promise<Decision> {
	const { question, cancel, asked } = await store.ask(
		db,
		runner,
		input.job,
		input.attempt,
		{
			kind: "publication",
			summary: DECISION,
			session: input.session,
			prompt,
		},
		Date.now(),
	);
	return { decision: question, cancel, asked };
}

/**
 * The job's branch head, unless the branch is not where the job left it. A
 * commit whose outcome went unrecorded is adopted first, so an interrupted
 * publication is never mistaken for someone else's write.
 */
async function verify(db: D1Database, job: store.Publishing, input: Publication, branch: Branch) {
	const current = await branch.head();
	let head = job.head;
	if (current !== head && job.pending && current === job.pending) {
		await store.adopt(db, job.id, head, job.pending, Date.now());
		head = current;
	}
	if (current !== head)
		throw new BranchChanged(
			head === null
				? `${branch.repository.owner}/${branch.repository.name} already has the branch ${job.branch} from earlier work.`
				: `The branch ${job.branch} changed outside this job.`,
		);
	if (input.head !== head) throw new HeadMoved(head);
	return head;
}

/** Commit the changes on the verified `head` of the job's branch. */
async function commit(
	db: D1Database,
	runner: Runner,
	job: store.Publishing,
	input: Publication,
	branch: Branch,
	head: string | null,
): Promise<string> {
	if (input.merge && !(await branch.based(input.merge)))
		throw new JobError("A merge commit may only merge in a commit its upstream base branch already holds");
	const parent = head ?? job.revision;
	const next = await branch.commit(parent, input.changes, input.message!, input.merge ?? undefined, input.submodules);
	// GitHub checks a merge commit's workflow changes against the head it updates, its first parent.
	if (input.merge && (await branch.workflows(parent)) !== (await branch.workflows(next)))
		throw new PublicationBlocked(`Merging changes the pull request's workflows. ${WORKFLOWS}.`);
	// Check the fence again immediately before the write that makes the commit visible.
	await store.claim(db, runner, job.id, job.attempt, head, next, Date.now());
	// A failure here leaves the claim pending; the next publication finds out whether it landed.
	const landed = await branch.move(head, next);
	await store.settle(db, job.id, next, landed, Date.now());
	if (!landed) throw new JobError("The job's branch moved; continue from its new head");
	return next;
}

/** Publish a running attempt's changes and pull request, or pause it on a decision. */
export async function publish(env: Env, runner: Runner, input: Publication): Promise<Published | Decision> {
	const db = env.DB;
	const job = await store.publishing(db, runner, input.job, input.attempt);
	if (input.pull && onPull(job.workflow))
		throw new JobError("Work on a pull request updates its head and opens no pull request");
	if (input.land && job.workflow !== "merge") throw new JobError("Only a merge job lands its pull request");
	const refused = [
		...input.changes.flatMap((change) => {
			const reason = refusal(job.workflow, change.path, !!input.merge);
			return reason ? [{ path: change.path, reason }] : [];
		}),
	];
	if (refused.length) return decide(db, runner, input, { type: "publication", refused });
	const github = new GitHubService(env);
	const upstream: GitHubRepository = { owner: job.owner, name: job.name, id: job.repository };
	let head: string | null;
	try {
		// A pull request opens from the branch, so a delivery alone still checks where it is.
		head = await github.contribute(upstream, job.actor, job, async (branch) => {
			const head = await verify(db, job, input, branch);
			return input.changes.length || input.merge ? commit(db, runner, job, input, branch, head) : head;
		});
	} catch (error) {
		if (!(error instanceof PublicationBlocked)) throw error;
		// Only a job's own upstream branch is kix's to reset; a pull request's own head is not.
		const restart = error instanceof BranchChanged && !onPull(job.workflow);
		const moved =
			error instanceof BranchChanged && job.workflow === "merge" && job.head !== null && job.pending === null
				? await github.contribute(upstream, job.actor, job, (branch) => branch.head())
				: null;
		const continuation =
			moved && moved !== job.head ? { head: moved, from: job.head!, revision: job.revision } : null;
		return decide(db, runner, input, {
			type: "publication",
			blocked: error.message,
			...(restart && { restart }),
			...(continuation && { continuation }),
		});
	}
	if (input.land) {
		// The attempt may have ended, or been asked to stop, while the branch was written.
		const current = await store.publishing(db, runner, input.job, input.attempt);
		if (current.cancel) throw new JobError("The maintainer stopped this job, so it does not land");
		try {
			const landed = await github.landPullRequest(upstream, current.actor, pullOf(current.target), {
				head: head!,
				hold: current.hold,
				method: input.land.method,
			});
			return { head, landed };
		} catch (error) {
			if (!(error instanceof PublicationBlocked)) throw error;
			return decide(db, runner, input, { type: "publication", blocked: error.message });
		}
	}
	if (!input.pull) return { head };
	if (!head) throw new JobError("Publish the job's changes before opening its pull request");
	// The attempt may have ended, or been asked to stop, while the branch was written.
	const current = await store.publishing(db, runner, input.job, input.attempt);
	// Planning PRs always await maintainer review; so does work that was asked to stop.
	const draft = input.pull.draft || current.workflow === "plan" || current.cancel === 1;
	// A planning pull request's decision record comes from the answers kix recorded, not the agent.
	const body =
		current.workflow === "plan"
			? withDecisions(input.pull.body, await store.decisions(db, job.id))
			: input.pull.body;
	const pull = await github.deliver(upstream, current.actor, current, { ...input.pull, body, draft });
	await store.delivered(db, job.id, pull.number);
	return { head, pull };
}

/**
 * Start a job over after a publication found its own upstream branch changed
 * or left by earlier work: replace the job with a fresh one at its revision,
 * then reset the branch there. The new job's delivery adopts the branch's
 * pull request if it is still open, and otherwise opens another.
 */
export async function restart(
	env: Env,
	user: string,
	upstream: GitHubRepository,
	job: Omit<store.Job, "result"> & { questions: store.Question[] },
	question: string,
) {
	// The requester may start over in place of another maintainer's answer that awaits approval.
	const open = job.questions.find(
		(q) =>
			q.id === question &&
			q.approvedAt === null &&
			(q.answer === null || user === job.actor) &&
			q.attempt === job.attempt,
	);
	const offered = open?.kind === "publication" && (open.prompt as { restart?: unknown } | null)?.restart === true;
	if (job.state !== "waiting" || onPull(job.workflow) || !offered)
		throw new JobError("Only a job whose own branch changed can start over");
	// The answering maintainer's authority is rechecked before anything changes.
	return new GitHubService(env).contribute(upstream, user, job, async (branch) => {
		// Claim the decision before the reset discards commits, so a concurrent answer or cancel wins cleanly.
		const created = await store.restart(env.DB, job.id, question, user, job.revision, Date.now());
		try {
			await branch.reset(job.revision);
		} catch (error) {
			// The new job waits to start over again; one a runner already took finds the branch changed when it publishes.
			await store.hold(
				env.DB,
				created,
				{
					summary: DECISION,
					prompt: {
						type: "publication",
						blocked: `Starting over did not reset the branch ${job.branch}.`,
						restart: true,
					},
				},
				Date.now(),
			);
			throw error;
		}
		return created;
	});
}

/** Revalidate a selected moved head without changing GitHub or granting it trust. */
export async function validateContinuation(
	env: Env,
	user: string,
	repo: GitHubRepository,
	job: Omit<store.Job, "result"> & { questions: store.Question[] },
	question: store.Question,
	continuation: store.Continuation,
) {
	store.continuationOf(question.prompt, { continue: continuation.head });
	if (
		job.workflow !== "merge" ||
		job.state !== "waiting" ||
		question.kind !== "publication" ||
		question.attempt !== job.attempt ||
		question.approvedAt !== null ||
		job.head !== continuation.from ||
		job.revision !== continuation.revision ||
		job.pending !== null
	)
		throw new JobError("This continuation is no longer current");
	await new GitHubService(env).contribute(repo, user, job, async (branch) => {
		if ((await branch.head()) !== continuation.head)
			throw new JobError("The pull request head changed again; refresh and review it");
	});
}
