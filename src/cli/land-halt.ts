// A halted queue: the base fails its check alone, so nothing lands until a check of it passes.
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitHub, object } from "./github";
import type { Plan } from "./land";

/**
 * A red base the queue is halted on. While the base fixer works on it, its outcome is pending: then
 * it records the fix proposed as a PR, or else a notice on the issue that says the queue is halted.
 */
export interface Halt {
	sha: string;
	/** The halt's issue, kept open across red bases until one passes. */
	issue?: number;
	/** The issue says this base is red too, which ends a fix attempt on it. */
	noticed?: boolean;
	/** The PR proposing the base fixer's fix for this base. */
	fix?: { number: number; branch: string };
}
const HALT = "halt.json";

export function readHalt(state: string): Halt | undefined {
	const path = join(state, HALT);
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Halt) : undefined;
}

export function saveHalt(state: string, halt: Halt): void {
	const path = join(state, HALT);
	writeFileSync(`${path}.new`, JSON.stringify(halt), { mode: 0o600 });
	renameSync(`${path}.new`, path);
}

/** Base fixer jobs are `fix-base-*.json`, apart from the PR jobs that park PRs. */
export const BASE_JOB = /^fix-base-.*\.json$/;

/** Whether a base fixer job is working on `sha`. */
export function fixing(state: string, sha: string): boolean {
	return readdirSync(state).some((name) => {
		if (!BASE_JOB.test(name)) return false;
		try {
			return (JSON.parse(readFileSync(join(state, name), "utf8")) as { base: Plan["base"] }).base.sha === sha;
		} catch {
			return false; // Collection reports an unreadable job.
		}
	});
}

/**
 * Say the queue is halted on `base` because `cause`: open the issue, or comment on the one a red
 * base before it opened. `output` is the base's failing log, ready to post.
 */
export async function haltNotice(
	github: GitHub,
	state: string,
	repository: string,
	base: Plan["base"],
	cause: string,
	output: string,
): Promise<void> {
	const halt = readHalt(state) ?? { sha: base.sha };
	if (halt.issue !== undefined) {
		await github.request(`/repos/${repository}/issues/${halt.issue}/comments`, {
			body: {
				body: `${base.ref} fails its check alone at ${base.sha} too. ${cause}${output && `\n\n${output}`}`,
			},
		});
		saveHalt(state, { ...halt, noticed: true });
		return;
	}
	const response = await github.request(`/repos/${repository}/issues`, {
		body: {
			title: `quest land: ${base.ref} fails its own check, so the queue is halted`,
			body: `quest land checked ${base.ref} alone at ${base.sha}, as when a failing batch's fixer blames none of its pull requests, and it fails its check. ${cause} No pull request is blamed or ejected for it. The queue is halted: queued pull requests keep their auto-merge and their place, and nothing lands until a check of ${base.ref} passes. The gate checks it again whenever it moves, and closes this issue then.${output && `\n\n${output}`}\n\n<!-- quest land: halted -->`,
		},
	});
	saveHalt(state, { ...halt, issue: Number(object(await response.json()).number), noticed: true });
}

/** Close a fix PR the base no longer needs, saying `why`, and delete its branch. */
export async function closeFix(github: GitHub, repository: string, fix: Halt["fix"] & {}, why: string) {
	const path = `/repos/${repository}/pulls/${fix.number}`;
	const pull = object(await (await github.request(path)).json());
	if (pull.state === "open") {
		await github.request(`/repos/${repository}/issues/${fix.number}/comments`, { body: { body: why } });
		await github.request(path, { method: "PATCH", body: { state: "closed" } });
	}
	// GitHub may already have deleted a merged PR's branch.
	await github.request(`/repos/${repository}/git/refs/heads/${fix.branch}`, { method: "DELETE", allow: [404, 422] });
}

/** A passing check of a moved base resumes a halted queue: close its issue and any fix it no longer needs. */
export async function resume(github: GitHub, state: string, repository: string, base: Plan["base"]): Promise<void> {
	const halt = readHalt(state);
	if (!halt) return;
	const passed = `${base.ref} passes its check at ${base.sha}, so the queue resumed.`;
	if (halt.fix) await closeFix(github, repository, halt.fix, passed);
	if (halt.issue !== undefined) {
		const issue = `/repos/${repository}/issues/${halt.issue}`;
		await github.request(`${issue}/comments`, { body: { body: passed } });
		await github.request(issue, { method: "PATCH", body: { state: "closed" } });
	}
	rmSync(join(state, HALT));
}
