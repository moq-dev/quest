// Starting ready work without a click: a maintainer who opts a project in
// lends it their runners, and whenever one of their slots frees, kix starts
// the next unclaimed ready quest in `quest unblocked` order, as
// `/quest-spawn` does locally. Each start is an ordinary start job, so the
// agent's first step still checks the quest is worth the slot and turns a
// doubtful one into a decision.

import { questBranch, unblocked, parse } from "quest/core";
import { GitHubError, NotMaintainer, GitHubService, refName, type Enrollment } from "../github/service";
import { type ProjectState, readState, startable } from "../github/state";
import * as store from "./store";
import { JobError } from "./store";

/** A milestone directory under `quest/`, such as `m0`. */
const MILESTONE = /^m\d{1,4}$/;

/** A maintainer's opt-in on one project: every milestone, or only those named. */
export type Autostart = { milestones: string[] | null };

/** FNV-1a: a short, stable version for a quest's text, which an inbox skip records. */
export function digest(text: string) {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
	return (hash >>> 0).toString(16);
}

/** Parse a form's milestone list, such as `m0, m1`; empty means every milestone. */
export function milestones(value: unknown): string[] | null {
	if (value === undefined || value === "") return null;
	if (typeof value !== "string") throw new JobError("Invalid milestones");
	const names = [...new Set(value.split(/[\s,]+/).filter(Boolean))];
	if (names.length > 32 || names.some((name) => !MILESTONE.test(name)))
		throw new JobError("Name milestones like m0, m1");
	return names.length ? names : null;
}

/** A start job for `target`, when observations show it ready and unclaimed. */
export function startJob(state: ProjectState, target: unknown, failed: store.Published | null) {
	if (typeof target !== "string" || !startable(state, target, failed))
		throw new JobError("Only ready, unclaimed quests on the default branch can start");
	const branch = questBranch(target);
	if (!refName(branch)) throw new JobError("Rename the quest so its path can be a branch name");
	return { workflow: "start" as const, target, revision: state.project.commit, branch, trusted: true };
}

/**
 * The quests to start next on one project, best first: ready and unclaimed
 * in `quest unblocked` order, within the opted-in milestones, and never a
 * quest that already had a job, so a skipped, cancelled, or failed start
 * waits for the maintainer instead of rerunning, nor one the maintainer
 * skipped in the inbox at its current text.
 */
export function candidates(state: ProjectState, scope: Autostart, taken: Set<string>, skipped: Set<string>) {
	const { available, documents } = state.project;
	if (!available) return [];
	let ranked: string[];
	try {
		ranked = unblocked(documents.map((d) => parse(d.path, d.content))).map((quest) => quest.path);
	} catch {
		// A tree `quest check` rejects has no ranking; its board says why.
		return [];
	}
	const text = new Map(documents.map((d) => [d.path, d.content]));
	return ranked.filter(
		(path) =>
			available.includes(path) &&
			covers(scope, path) &&
			!taken.has(path) &&
			!skipped.has(`${path}\n${digest(text.get(path) ?? "")}`),
	);
}

/** Take one item from each queue in turn, so one busy project cannot starve another. */
function interleave<T>(queues: T[][]): T[] {
	const out: T[] = [];
	for (let i = 0; queues.some((queue) => i < queue.length); i++)
		for (const queue of queues) if (i < queue.length) out.push(queue[i]!);
	return out;
}

/**
 * The owner's opt-ins on enabled projects, the one they started work on least
 * recently first, so projects take turns across passes even when each pass
 * fills a single slot. A membership's end deletes its opt-in.
 */
export async function optIns(db: D1Database, owner: string) {
	const { results } = await db
		.prepare(
			`SELECT p.id,p.owner,p.name,p.state,a.milestones FROM autostart a JOIN github_projects p ON p.id=a.repository
 WHERE a.user=? AND p.state='enabled'
 ORDER BY COALESCE((SELECT MAX(createdAt) FROM jobs WHERE repository=p.id AND actor=a.user AND workflow='start'),0),a.createdAt,p.id`,
		)
		.bind(owner)
		.all<Enrollment & { milestones: string | null }>();
	return results.map(({ milestones, ...project }) => ({
		project,
		scope: { milestones: milestones ? (JSON.parse(milestones) as string[]) : null },
	}));
}

/** The owner's opt-in on one project, or null. */
export async function read(db: D1Database, repository: number, user: string): Promise<Autostart | null> {
	const row = await db
		.prepare("SELECT milestones FROM autostart WHERE repository=? AND user=?")
		.bind(repository, user)
		.first<{ milestones: string | null }>();
	return row ? { milestones: row.milestones ? JSON.parse(row.milestones) : null } : null;
}

/** Whether an opt-in covers `quest`'s milestone; `createJob` checks the same in SQL. */
function covers(scope: Autostart, quest: string) {
	return !scope.milestones || scope.milestones.includes(quest.split("/")[1]!);
}

/** Opt a project in for `user`'s runners, or out with `null`. */
export async function save(db: D1Database, repository: number, user: string, scope: Autostart | null, now: number) {
	if (!scope) {
		await db.prepare("DELETE FROM autostart WHERE repository=? AND user=?").bind(repository, user).run();
		return;
	}
	await db
		.prepare(
			"INSERT INTO autostart(repository,user,milestones,createdAt) VALUES(?,?,?,?) ON CONFLICT(repository,user) DO UPDATE SET milestones=excluded.milestones",
		)
		.bind(repository, user, scope.milestones ? JSON.stringify(scope.milestones) : null, now)
		.run();
}

/**
 * Start up to `free` quests across the owner's opted-in projects, from stored
 * observations first, then each through the same current GitHub checks as a
 * maintainer's own start. Returns how many jobs it created.
 */
export async function autostart(env: Env, owner: string, free: number) {
	if (free <= 0) return 0;
	const opted = await optIns(env.DB, owner);
	if (!opted.length) return 0;
	const queues = await Promise.all(
		opted.map(async ({ project, scope }) => {
			const [state, jobs, skips] = await Promise.all([
				readState(env.DB, project),
				env.DB.prepare("SELECT DISTINCT target FROM jobs WHERE repository=?")
					.bind(project.id)
					.all<{ target: string }>(),
				env.DB.prepare(
					"SELECT item,skipped FROM inbox_items WHERE user=? AND repository=? AND skipped IS NOT NULL",
				)
					.bind(owner, project.id)
					.all<{ item: string; skipped: string }>(),
			]);
			if (!state) return [];
			const taken = new Set(jobs.results.map((row) => row.target));
			const skipped = new Set(skips.results.map((row) => `${row.item}\n${row.skipped}`));
			return candidates(state, scope, taken, skipped).map((target) => ({ project, target }));
		}),
	);
	const github = new GitHubService(env);
	// A project that cannot take a start now, such as one without a flake, is not asked again this pass.
	const refused = new Set<number>();
	let started = 0;
	for (const { project, target } of interleave(queues)) {
		if (started >= free) break;
		if (refused.has(project.id)) continue;
		try {
			// The skip check at insertion compares the quest's text as GitHub has it now.
			let version = "";
			const { job, enabled, flake } = await github.jobSource(project, owner, (state) => {
				version = digest(state.project.documents.find((d) => d.path === target)?.content ?? "");
				return startJob(state, target, null);
			});
			if (!enabled || !flake) {
				refused.add(project.id);
				continue;
			}
			// The insert rechecks the opt-in, which may have ended or narrowed while this pass read GitHub,
			// and the quest's own exclusions, since a skip or another pass's job may have committed meanwhile.
			const created = await store.createJob(
				env.DB,
				{
					...job,
					repository: project.id,
					actor: owner,
					pinRunner: null,
					pinAccount: null,
					automatic: { version },
				},
				Date.now(),
			);
			if (created.created) started++;
		} catch (error) {
			if (error instanceof NotMaintainer) {
				// Lost authority ends the opt-in: it lent runners to a project its owner no longer maintains.
				await save(env.DB, project.id, owner, null, Date.now());
				refused.add(project.id);
			} else if (error instanceof store.NotOptedIn) refused.add(project.id);
			else if (error instanceof JobError) continue;
			else if (error instanceof GitHubError) refused.add(project.id);
			else throw error;
		}
	}
	return started;
}

/** Wake every hub with an opt-in, so quests that became ready since the last runner event start. */
export async function sweep(env: Env) {
	const { results } = await env.DB.prepare(
		"SELECT DISTINCT a.user FROM autostart a JOIN github_projects p ON p.id=a.repository WHERE p.state='enabled'",
	).all<{ user: string }>();
	// One failing hub must not stop the others, or the scheduled retention after the sweep.
	const settled = await Promise.allSettled(
		results.map(({ user }) => env.RUNNERS.get(env.RUNNERS.idFromName(user)).dispatch(user)),
	);
	for (const outcome of settled)
		if (outcome.status === "rejected")
			console.error({
				event: "autostart_sweep_failed",
				name: outcome.reason instanceof Error ? outcome.reason.name : "unknown",
			});
}
