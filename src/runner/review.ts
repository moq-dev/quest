// The runner's own review of a head its job published: the other vendor's
// model reviews it with `quest review`, through the runner's pool of that
// vendor's accounts, run by the runner process outside the agent's sandbox, in
// a checkout the agent cannot reach. kix then records the
// round as the App's `quest review` check run on that commit, which its land
// gate counts as a review, so the agent can neither skip nor fake it.
import { delimiter, dirname } from "node:path";

import type { HarnessName } from "../cli/agent";
import { type Finding, type Round, review } from "../cli/review";
import { baseEnvironment } from "./adapter";
import { type Account, type Pool, POOL_PROVIDER, type Seat } from "./home";
import type { Endpoint } from "./proxy";
import type { Workspace } from "./workspace";

/** A head the runner cannot review, such as for want of a reviewer; its landing needs a person's approval. */
export class Unreviewable extends Error {}

/** Who reviews a job's heads, and the environment their CLI runs in. */
export interface Reviewer {
	/** The reviewer CLI, which is also the pool it reviews with. */
	harness: HarnessName & Pool;
	env: NodeJS.ProcessEnv;
}

/** The runner's pools as a review needs them. */
export interface Pools {
	accounts: Account[];
	/** When each limited seat or pool resets. */
	limits: Record<string, number>;
	/** The pool's CLI home, which keeps the review's session across rounds. */
	home(pool: Pool): string;
	proxy: Pick<Endpoint, "origin" | "key">;
}

const PRODUCT: Record<Pool, string> = { claude: "Claude Code", codex: "Codex" };

/**
 * The reviewer for a job on `seat`: Codex for a job on Anthropic's models,
 * else Claude Code, each through the CLI the runner pins, if any, and through
 * the runner's CLIProxyAPI with the pool of the reviewer's vendor, in a home
 * that keeps the review's session and no login.
 */
export function reviewerFor(seat: Seat, pools: Pools, env: NodeJS.ProcessEnv, now = Date.now()): Reviewer {
	const harness: Pool = seat.provider === POOL_PROVIDER.claude ? "codex" : "claude";
	if (!pools.accounts.some((account) => account.cli === harness))
		throw new Unreviewable(
			`this runner has no ${PRODUCT[harness]} account to review with; add one with \`quest runner account add ${harness}\``,
		);
	const until = pools.limits[harness] ?? 0;
	if (until > now)
		throw new Unreviewable(`the ${PRODUCT[harness]} pool is limited until ${new Date(until).toISOString()}`);
	// `quest review` finds its CLI on PATH, so the pinned one's directory goes first.
	const pinned = harness === "codex" ? env.QUEST_RUNNER_CODEX : env.QUEST_RUNNER_CLAUDE;
	// No ambient credential, gateway, or login: the review reaches only the pool.
	const {
		CLAUDE_CONFIG_DIR: _claude,
		CODEX_HOME: _codex,
		OPENAI_BASE_URL: _gateway,
		...base
	}: NodeJS.ProcessEnv = {
		...baseEnvironment(env),
		...(pinned && { PATH: [dirname(pinned), env.PATH].filter(Boolean).join(delimiter) }),
	};
	const { origin, key } = pools.proxy;
	return {
		harness,
		env:
			harness === "codex"
				? { ...base, OPENAI_BASE_URL: `${origin}/v1`, CODEX_API_KEY: key, CODEX_HOME: pools.home("codex") }
				: {
						...base,
						ANTHROPIC_BASE_URL: origin,
						ANTHROPIC_AUTH_TOKEN: key,
						CLAUDE_CONFIG_DIR: pools.home("claude"),
					},
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
