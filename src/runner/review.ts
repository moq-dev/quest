// The runner's own review of a head its job published: the other vendor's
// model reviews it with `quest review`, run by the runner process outside the
// agent's sandbox, in a checkout the agent cannot reach. kix then records the
// round as the App's `quest review` check run on that commit, which its land
// gate counts as a review, so the agent can neither skip nor fake it.
import { delimiter, dirname } from "node:path";

import type { HarnessName } from "../cli/agent";
import { type Finding, type Round, review } from "../cli/review";
import type { Account } from "./home";
import type { Workspace } from "./workspace";

/** The vendor whose model each reviewer CLI runs, in the provider names runner accounts report. */
export const VENDOR: Record<HarnessName, string> = { claude: "anthropic", codex: "openai" };

/** A head the runner cannot review, such as for want of a reviewer; its landing needs a person's approval. */
export class Unreviewable extends Error {}

/** Who reviews a job's heads, and the environment their CLI runs in. */
export interface Reviewer {
	harness: HarnessName;
	env: NodeJS.ProcessEnv;
}

/**
 * The reviewer for a job on `account`: Codex for a job on Anthropic's models,
 * else Claude Code, each through the CLI the runner pins, if any. Claude Code
 * reviews with one of this runner's Claude Code accounts that is not limited.
 * Runners hold no Codex accounts, so Codex reviews with the login of the user
 * running the runner (`CODEX_HOME`, or Codex's default), as `quest review`
 * does locally.
 */
export function reviewerFor(
	account: Account,
	accounts: Account[],
	home: (account: Account) => string,
	env: NodeJS.ProcessEnv,
	now = Date.now(),
): Reviewer {
	// `quest review` finds its CLI on PATH, so the pinned one's directory goes first.
	const pin = (pinned: string | undefined): NodeJS.ProcessEnv =>
		pinned ? { PATH: [dirname(pinned), env.PATH].filter(Boolean).join(delimiter) } : {};
	if (account.provider === VENDOR.claude)
		return { harness: "codex", env: { ...env, ...pin(env.QUEST_RUNNER_CODEX) } };
	const claude = accounts.find(
		(a) => a.adapter === "claude" && a.provider === VENDOR.claude && (a.limitedUntil ?? 0) <= now,
	);
	if (!claude) throw new Unreviewable("this runner has no Claude Code account free to review with");
	return {
		harness: "claude",
		env: { ...env, CLAUDE_CONFIG_DIR: home(claude), ...pin(env.QUEST_RUNNER_CLAUDE) },
	};
}

export interface ReviewRequest {
	workspace: Workspace;
	/** The published head to review. */
	head: string;
	reviewer: Reviewer;
	/** The job's branch, whose quest, if any, sizes the review; kix names it, never the head. */
	branch: string;
	/** The agent's fixes and refutations of the last round's findings. */
	responses?: string;
	/** Stops the review when its attempt stops. */
	signal?: AbortSignal;
}

/** Review `head` as `quest review` would on its branch, resuming the job's review session. */
export async function reviewHead(request: ReviewRequest): Promise<Round> {
	request.signal?.throwIfAborted();
	const { root, base } = await request.workspace.reviewCheckout(request.head);
	return review(
		{
			root,
			base,
			fetched: true,
			harness: request.reviewer.harness,
			sizeBranch: request.branch,
			responses: request.responses,
			signal: request.signal,
		},
		{ env: request.reviewer.env },
	);
}

/** A round's findings as the agent reads them, each with its location and severity. */
export function formatFindings(findings: Finding[]): string {
	return findings
		.map(
			(f, i) =>
				`${i + 1}. [${f.severity}] ${f.line === null ? f.file : `${f.file}:${f.line}`}: ${f.title}\n${f.body}`,
		)
		.join("\n\n");
}
