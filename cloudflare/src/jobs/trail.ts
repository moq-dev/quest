// A planning pull request's paper trail. The service renders the decision
// section from the job's recorded questions and answers, so it cannot be
// paraphrased or drift from what the maintainer chose. Prompts and answers are
// untrusted text: every piece appears only inside a code span, where GitHub
// renders no Markdown or HTML and links no mention, issue or commit reference,
// URL, or closing keyword.
import { type Answer, type Prompt, parseAnswer, parsePrompt } from "./prompt";
import type { Workflow } from "./store";

/** Brackets the service's section, which replaces any copy in the agent's body. */
export const START = "<!-- kix:decisions -->";
export const END = "<!-- /kix:decisions -->";
/** GitHub's limit on a pull request body, in characters. */
export const BODY_LIMIT = 65_536;

/** What a job's agent is told beyond the workflow's own skill, or null. */
export function instructions(workflow: Workflow): string | null {
	// kix may start ready quests on its own, so the job first checks the quest still deserves the slot.
	if (workflow === "start")
		return "Before implementing, check that this quest is still worth starting now: its problem may no longer be real, a later change may have made its plan wrong, or more urgent work may depend on its slot. If it is clearly worth starting, start without asking. If you doubt it, ask the maintainer one decision before changing anything, with these options and your recommendation: Start (implement it as planned), Skip (end without publishing anything), Deprioritize (move it to a later milestone with `quest mv` and deliver only that change), or Delete (abandon it with `quest rm`, edit the mentions it reports, and deliver only that change). Name what made you doubt it.";
	if (workflow !== "plan") return null;
	return "kix adds this pull request's decision record from the maintainer's recorded answers. Do not write the interview's questions, options, or answers into the pull request body; summarize the proposed quests instead. Still record each settled decision and its reason in the quest's Plan.";
}

/**
 * Untrusted text as one inline code span. Line breaks and control characters
 * become spaces, so the span cannot end its paragraph or start a line;
 * bidirectional controls are dropped so the text reads as stored. The fence is
 * longer than any backtick run inside, so the text cannot close it.
 */
export function code(value: string): string {
	const flat = value
		.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
		.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ");
	const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(longest + 1);
	// One space on each side is stripped when rendering, so a leading or trailing backtick stays literal.
	return `${fence} ${flat} ${fence}`;
}

/** One question's record: the prompt, every option with ✅ on each choice, and any free text. */
function question(ask: Prompt["questions"][number], reply: Answer["answers"][number]): string {
	const lines = [`- ${ask.header ? `${code(ask.header)} ` : ""}${code(ask.question)}`];
	for (const option of ask.options)
		lines.push(`  - ${reply.choices.includes(option.label) ? "✅" : "⬜"} ${code(option.label)}`);
	if (reply.text) lines.push(`  - ✍️ ${code(reply.text)}`);
	return lines.join("\n");
}

/** A stored question's prompt and answer, when it is an answered decision. */
function decision(stored: { prompt: unknown; answer: unknown }): { prompt: Prompt; answer: Answer } | null {
	try {
		const prompt = parsePrompt(stored.prompt);
		if (prompt.kind !== "decision") return null;
		return { prompt, answer: parseAnswer(prompt, stored.answer) };
	} catch {
		// Not a valid round, so there is nothing faithful to render.
		return null;
	}
}

/**
 * The decision section for a job's answered agent questions, oldest first, in
 * at most `budget` characters. Rounds past the budget are counted, not cut.
 * Null when there is nothing to record.
 */
export function render(questions: { prompt: unknown; answer: unknown }[], budget: number): string | null {
	const rounds = questions.map(decision).filter((round) => round !== null);
	if (!rounds.length) return null;
	const head = `${START}\n## Decisions\n\nRecorded by kix from the maintainer's answers.`;
	const blocks = rounds.map(
		({ prompt, answer }, i) =>
			`### Round ${i + 1}\n\n${prompt.questions.map((ask, j) => question(ask, answer.answers[j]!)).join("\n")}`,
	);
	const omitted = (n: number) => `_${n} more ${n === 1 ? "round is" : "rounds are"} in the job's record on kix._`;
	let section = head;
	for (const [i, block] of blocks.entries()) {
		const rest = blocks.length - i - 1;
		const tail = rest ? `\n\n${omitted(rest)}` : "";
		if (`${section}\n\n${block}${tail}\n${END}`.length > budget) {
			section += `\n\n${omitted(blocks.length - i)}`;
			break;
		}
		section += `\n\n${block}`;
	}
	section += `\n${END}`;
	return section.length > budget ? null : section;
}

/**
 * The agent's pull request body with the service's decision section: any
 * section the agent wrote is removed, and the rendered one is appended. A
 * section ends only at an end marker on its own line, which untrusted text
 * inside a code span can never start, or else at the end of the body.
 */
export function withDecisions(body: string, questions: { prompt: unknown; answer: unknown }[]): string {
	const own = body
		.replace(/<!-- kix:decisions -->[\s\S]*?(?:^<!-- \/kix:decisions -->$|(?![\s\S]))/gm, "")
		.replaceAll(END, "")
		.trimEnd();
	const section = render(questions, BODY_LIMIT - own.length - 2);
	return section ? (own ? `${own}\n\n${section}` : section) : own;
}
