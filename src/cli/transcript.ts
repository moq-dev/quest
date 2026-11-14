// What a session's own transcript on this host adds to its record: the first quest skill it ran, which gives its
// role, and how long each blocking question waited on a person. No prompt or reply text leaves this module.
import { CODEX_ASK, CODEX_REPLY, claudeSkill, codexSkill, eachLine, parseLine } from "./messages";

/** What a transcript says about its session. */
export interface TranscriptFacts {
	/** The first `quest-*` skill it loaded, without the prefix's harness path, as `quest-start`. */
	skill: string | null;
	/** Each blocking question, from when it was asked to when the person answered or dismissed it, epoch ms. */
	questions: { start: number; end: number }[];
}

const time = (record: Record<string, unknown>, path: string): number => {
	const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
	if (Number.isNaN(at)) throw new Error(`${path} has a record without a timestamp`);
	return at;
};

/**
 * The facts of the session whose transcript files token-max listed. A question still open at the end of the
 * transcript has no wait yet; the next record, sent when the session stops again, holds it.
 */
export function transcriptFacts(harness: string, files: string[]): TranscriptFacts {
	const facts: TranscriptFacts = { skill: null, questions: [] };
	for (const path of files) {
		if (harness === "claude") readClaude(path, facts);
		else if (harness === "codex") readCodex(path, facts);
		else throw new Error(`quest cannot read a ${harness} transcript`);
	}
	facts.questions.sort((a, b) => a.start - b.start);
	return facts;
}

const firstQuestSkill = (facts: TranscriptFacts, skill: string | null) => {
	if (facts.skill === null && skill?.startsWith("quest-")) facts.skill = skill;
};

function readClaude(path: string, facts: TranscriptFacts): void {
	const asked = new Map<string, number>();
	eachLine(path, (line, complete) => {
		const ask = line.includes('"AskUserQuestion"');
		if (!ask && !line.includes("Base directory for this skill") && !line.includes('"tool_use_id"')) return;
		const record = parseLine(path, line, complete);
		if (!record) return;
		// A sub-agent's own file marks every record a sidechain, so only the file tells whose it is.
		const isMeta = { ...record, isSidechain: undefined };
		firstQuestSkill(facts, claudeSkill(isMeta));
		const content = (record.message as { content?: unknown } | undefined)?.content;
		if (!Array.isArray(content)) return;
		for (const block of content as Record<string, unknown>[]) {
			if (record.type === "assistant" && block?.type === "tool_use" && block.name === "AskUserQuestion")
				asked.set(String(block.id), time(record, path));
			else if (record.type === "user" && block?.type === "tool_result") {
				const start = asked.get(String(block.tool_use_id));
				if (start === undefined) continue;
				asked.delete(String(block.tool_use_id));
				facts.questions.push({ start, end: time(record, path) });
			}
		}
	});
}

function readCodex(path: string, facts: TranscriptFacts): void {
	const asked = new Map<string, number>();
	eachLine(path, (line, complete) => {
		const call = /"call_id"\s*:\s*"([^"]+)"/.exec(line)?.[1];
		const relevant =
			line.includes("request_user_input") ||
			line.includes("send_user_message_question_reply") ||
			line.includes('"skills"') ||
			(call !== undefined && asked.has(call));
		if (!relevant) return;
		const record = parseLine(path, line, complete);
		const item = record?.payload as Record<string, unknown> | undefined;
		if (record?.type !== "response_item" || !item) return;
		if (item.type === "function_call" && CODEX_ASK.has(item.name as string)) {
			asked.set(String(item.call_id), time(record, path));
			return;
		}
		if (item.type === "function_call_output" && item.call_id !== undefined) {
			const start = asked.get(String(item.call_id));
			// The async variant's output only acknowledges the question; its answer arrives as a later turn.
			if (start === undefined || item.output === undefined || isAcknowledgement(item.output)) return;
			asked.delete(String(item.call_id));
			facts.questions.push({ start, end: time(record, path) });
			return;
		}
		if (item.role !== "user" || !Array.isArray(item.content)) return;
		const sources = (
			(item.internal_chat_message_metadata_passthrough as Record<string, unknown> | undefined)
				?.content_item_metadata as unknown[] | undefined
		)?.map((each) => (each as { provenance?: { type?: unknown } } | null)?.provenance?.type);
		(item.content as Record<string, unknown>[]).forEach((part, i) => {
			if (typeof part?.text !== "string") return;
			if (sources?.[i] === "skills") firstQuestSkill(facts, codexSkill(part.text));
			const reply = CODEX_REPLY.exec(part.text);
			if (!reply) return;
			let each: unknown;
			try {
				each = JSON.parse(reply[1]!);
			} catch {
				throw new Error(`${path} has a question reply in a shape quest does not know`);
			}
			if (!Array.isArray(each)) throw new Error(`${path} has a question reply in a shape quest does not know`);
			const calls = new Set<string>();
			for (const one of each) {
				try {
					const ref = JSON.parse((one as { questionItemId?: string })?.questionItemId ?? "");
					if (Array.isArray(ref) && typeof ref[1] === "string") calls.add(ref[1]);
				} catch {
					throw new Error(`${path} has a question reply in a shape quest does not know`);
				}
			}
			for (const id of calls) {
				const start = asked.get(id);
				if (start === undefined) continue;
				asked.delete(id);
				facts.questions.push({ start, end: time(record, path) });
			}
		});
	});
}

/** Whether a Codex question call's output only says the question was sent, as `request_user_input_async` returns. */
function isAcknowledgement(output: unknown): boolean {
	if (typeof output !== "string") return false;
	try {
		const parsed = JSON.parse(output) as Record<string, unknown> | null;
		return parsed !== null && typeof parsed === "object" && !("answers" in parsed);
	} catch {
		// A cancelled or failed call returns an error message: the person was not waited on further.
		return false;
	}
}
