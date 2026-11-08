// The kix job protocol as a runner speaks it. The Worker's
// `cloudflare/src/jobs/protocol.ts` is the authority; these are the fields the
// runner reads and writes. Everything the hub sends is checked before use.

export type Workflow = "plan" | "start" | "iterate" | "merge" | "delete" | "bootstrap";

/** Whether a workflow lands its pull request: a merge, or a delete that repurposes a quest's pull request first. */
export function lands(workflow: Workflow) {
	return workflow === "merge" || workflow === "delete";
}
export type Outcome = "completed" | "failed" | "cancelled" | "limited";

export interface Attempt {
	job: string;
	attempt: number;
}

export interface Option {
	label: string;
	description?: string;
	recommended?: boolean;
}
export interface Ask {
	header?: string;
	question: string;
	options: Option[];
	multiple?: boolean;
}
export interface Prompt {
	kind: "decision" | "permission";
	questions: Ask[];
}

/** A question the job asked in an earlier attempt, with the maintainer's answer once given. */
export interface Question {
	id: string;
	attempt: number;
	kind: "agent" | "account" | "publication";
	prompt: unknown;
	answer: unknown;
	/**
	 * When the job's requester, this runner's owner, approved the answer:
	 * their own answers as given, another maintainer's once they approve it.
	 */
	approvedAt?: number | null;
}

/** The job an `assign` carries: its record and its project. */
export interface Job {
	id: string;
	attempt: number;
	workflow: Workflow;
	target: string;
	/** The commit the job builds on, such as the default branch when it was authorized. */
	revision: string;
	branch: string;
	/** Trusted revisions only, until runners build untrusted heads' devShells in a VM. */
	trusted: number;
	account: string | null;
	/** The agent session to resume on this runner and account. */
	session: string | null;
	/** The job branch's head, which a new attempt continues from; null before its first publication. */
	head: string | null;
	pull: number | null;
	/** The upstream repository. */
	owner: string;
	name: string;
	events: { attempt: number; kind: string; body: unknown }[];
	questions: Question[];
}

export type Push =
	| { type: "assign"; job: Job; instructions: string | null }
	| { type: "cancel"; job: string; attempt: number }
	| { type: "wake"; job: string; attempt: number };

export interface AccountReport {
	id: string;
	provider: string;
	kind: "subscription" | "api-key";
	label: string;
	limited: boolean;
}

export type Message =
	| { type: "status"; accounts: AccountReport[]; attempts: Attempt[]; slots: number }
	| ({ type: "checkpoint"; summary: string; session: string | null } & Attempt)
	| ({ type: "question"; summary: string; session: string; prompt: Prompt } & Attempt)
	| ({ type: "output"; seq: number; text: string } & Attempt)
	| ({ type: "result"; outcome: Outcome; summary: string; result?: unknown } & Attempt);

/** The hub's verdict on each attempt a status listed. */
export type Action = Attempt & { action: "continue" | "cancel" | "stop" };

/** The longest summary kix stores. */
export const SUMMARY = 4000;

const record = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const ID = /^[a-zA-Z0-9_-]{1,64}$/;
const SHA = /^[0-9a-f]{40}$/;

/** Read one hub push, or null for anything else (replies are matched elsewhere). */
export function parsePush(value: unknown): Push | null {
	const body = record(value);
	if (body?.type === "cancel" || body?.type === "wake") {
		if (
			typeof body.job !== "string" ||
			!ID.test(body.job) ||
			!Number.isSafeInteger(body.attempt) ||
			(body.attempt as number) < 1
		)
			return null;
		return { type: body.type, job: body.job, attempt: body.attempt as number };
	}
	if (body?.type !== "assign") return null;
	const job = record(body.job);
	const workflows = ["plan", "start", "iterate", "merge", "delete", "bootstrap"];
	if (
		!job ||
		typeof job.id !== "string" ||
		!ID.test(job.id) ||
		!Number.isSafeInteger(job.attempt) ||
		!workflows.includes(job.workflow as string) ||
		typeof job.target !== "string" ||
		typeof job.revision !== "string" ||
		!SHA.test(job.revision) ||
		(job.head !== null && !(typeof job.head === "string" && SHA.test(job.head))) ||
		typeof job.owner !== "string" ||
		!/^[\w.-]+$/.test(job.owner) ||
		typeof job.name !== "string" ||
		!/^[\w.-]+$/.test(job.name)
	)
		return null;
	return {
		type: "assign",
		instructions: typeof body.instructions === "string" ? body.instructions : null,
		job: {
			id: job.id,
			attempt: job.attempt as number,
			workflow: job.workflow as Workflow,
			target: job.target,
			revision: job.revision,
			branch: typeof job.branch === "string" ? job.branch : "",
			trusted: job.trusted === 1 || job.trusted === true ? 1 : 0,
			account: typeof job.account === "string" ? job.account : null,
			session: typeof job.session === "string" ? job.session : null,
			head: job.head as string | null,
			pull: typeof job.pull === "number" ? job.pull : null,
			owner: job.owner,
			name: job.name,
			events: Array.isArray(job.events) ? (job.events as Job["events"]) : [],
			questions: Array.isArray(job.questions) ? (job.questions as Question[]) : [],
		},
	};
}

/** `text` cut to `max` characters, marking the cut. */
export function clip(text: string, max = SUMMARY): string {
	const trimmed = text.trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
