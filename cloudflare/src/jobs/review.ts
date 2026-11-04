// A runner's review of a head its job published. The runner process, outside
// the agent's sandbox, runs `quest review` with the other vendor's model and
// reports the round here; kix records it as the App's `quest review` check run
// on that commit, which its land gate counts (`src/github/review.ts`). Every
// field is untrusted input: the findings are model text, and only the job's
// current attempt may report on the head kix itself last published for it.
import { GitHubService } from "../github/service";
import { id, text } from "./protocol";
import * as store from "./store";
import { JobError, type Runner } from "./store";

/** The vendor whose model each reviewer CLI runs, in the provider names runner accounts report. */
export const VENDOR = { claude: "anthropic", codex: "openai" } as const;
type Harness = keyof typeof VENDOR;
const SEVERITIES = ["high", "medium", "low"] as const;

export type Finding = {
	file: string;
	line: number | null;
	severity: (typeof SEVERITIES)[number];
	title: string;
	body: string;
};
export type ReviewReport = {
	job: string;
	attempt: number;
	head: string;
	reviewer: Harness;
	model: string;
	effort: string;
	round: number;
	/** The round's 0 to 10 readiness score and its rationale; runners from before scores existed send neither. */
	score?: number;
	rationale?: string;
	findings: Finding[];
};

/** Bounds a report: GitHub keeps at most 65,535 characters of a check run's text. */
export const REVIEW_LIMITS = { findings: 100, title: 300, body: 8000, rationale: 8000 };

const count = (value: unknown, min: number) =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= min ? value : null;

/** Parse a runner's review report, or throw a JobError the runner can read. */
export function parseReview(body: Record<string, unknown>): ReviewReport {
	const job = id(body.job);
	const attempt = count(body.attempt, 1);
	if (!job || !attempt) throw new JobError("Job and attempt required");
	if (typeof body.head !== "string" || !/^[a-f0-9]{40}$/.test(body.head))
		throw new JobError("The reviewed head must be a full SHA");
	const reviewer = body.reviewer;
	if (reviewer !== "claude" && reviewer !== "codex") throw new JobError("The reviewer is claude or codex");
	const model = text(body.model, 100);
	const effort = text(body.effort, 50);
	const round = count(body.round, 1);
	if (!model || !effort || !round) throw new JobError("The reviewer's model, effort, and round are required");
	let scored: Pick<ReviewReport, "score" | "rationale"> = {};
	if (body.score !== undefined || body.rationale !== undefined) {
		const score = count(body.score, 0);
		const rationale = text(body.rationale, REVIEW_LIMITS.rationale);
		if (score === null || score > 10 || !rationale)
			throw new JobError("A score is an integer from 0 to 10 with a rationale");
		scored = { score, rationale };
	}
	if (!Array.isArray(body.findings) || body.findings.length > REVIEW_LIMITS.findings)
		throw new JobError(`At most ${REVIEW_LIMITS.findings} findings per review`);
	const findings = body.findings.map((item: Record<string, unknown> | null): Finding => {
		const file = text(item?.file, 1024);
		const title = text(item?.title, REVIEW_LIMITS.title);
		const detail = typeof item?.body === "string" && item.body.length <= REVIEW_LIMITS.body ? item.body : null;
		const line = item?.line === null ? null : count(item?.line, 1);
		const severity = SEVERITIES.find((s) => s === item?.severity);
		if (!file || !title || detail === null || (item?.line !== null && line === null) || !severity)
			throw new JobError("Each finding needs a file, line or null, severity, title, and body");
		return { file, line, severity, title, body: detail };
	});
	return { job, attempt, head: body.head, reviewer, model, effort, round, ...scored, findings };
}

/** Untrusted text inside a fence no run of backticks in it can close. */
function fenced(value: string) {
	const longest = Math.max(2, ...(value.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(longest + 1);
	return `${fence}text\n${value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")}\n${fence}`;
}

/**
 * The check run's output: a title with the findings count and any score, a
 * summary naming the reviewer, and the score's rationale and the findings as
 * plain text.
 */
export function checkOutput(report: ReviewReport) {
	const n = report.findings.length;
	const counted = n ? `${n} finding${n === 1 ? "" : "s"}` : "No findings";
	const title = report.score === undefined ? counted : `${counted}, scored ${report.score}/10`;
	const summary = `A kix runner reviewed this commit with \`quest review\`: ${report.reviewer}, ${report.model} at ${report.effort} effort, round ${report.round}.`;
	const findings = report.findings.map((f) =>
		fenced(`${f.severity} ${f.line === null ? f.file : `${f.file}:${f.line}`} ${f.title}\n\n${f.body}`),
	);
	let text = report.rationale === undefined ? "" : fenced(`score ${report.score}/10: ${report.rationale}`);
	for (const [i, finding] of findings.entries()) {
		const next = `${text}${text ? "\n\n" : ""}${finding}`;
		// GitHub refuses a check run's text past 65,535 characters.
		if (next.length > 60_000) {
			text += `\n\n${findings.length - i} more not shown.`;
			break;
		}
		text = next;
	}
	return { title, summary, ...(text && { text }) };
}

/**
 * Record a review the job's current attempt reports as the App's
 * `quest review` check run, passing only when the round found nothing. Only a
 * head kix published for the job counts, the one its branch holds now, and
 * only a review by another vendor's model than the job's account ran.
 */
export async function recordReview(env: Env, runner: Runner, report: ReviewReport) {
	const job = await store.publishing(env.DB, runner, report.job, report.attempt);
	if (job.pending !== null) throw new JobError("A publication of this job is still in flight; review its head after");
	if (report.head !== job.head || job.head === job.revision)
		throw new JobError("kix records a review only of the head this job last published");
	const account = await env.DB.prepare("SELECT provider FROM runner_accounts WHERE runner=? AND id=?")
		.bind(runner.id, job.account)
		.first<{ provider: string }>();
	if (!account) throw new JobError("kix no longer knows the account this job runs on, so it cannot tell its vendor");
	if (account.provider === VENDOR[report.reviewer])
		throw new JobError("A review counts only from another vendor's model than the one the job runs on");
	const conclusion = report.findings.length ? "failure" : "success";
	await new GitHubService(env).writeReviewCheck({ owner: job.owner, name: job.name, id: job.repository }, job.actor, {
		head: report.head,
		conclusion,
		output: checkOutput(report),
	});
	return { conclusion };
}
