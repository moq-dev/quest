// `quest messages`: the messages a person typed to their agents on this host, and their answers to agents' blocking
// questions, and nothing an agent or harness wrote. Each source marks its sender: T3 Code's state for the sessions it
// drives, Claude Code's `origin` for the rest of its sessions, and Codex's content provenance for its interactive ones.
// Answers come from each harness's own log, which keeps the question's options. Output goes to stdout only.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { discoveryEnv } from "./git";
import { githubRepository } from "./github";
import { claudeLogs, eachLine, parseLine } from "./usage";

/** One message a person typed. */
export interface Message {
	kind: "message";
	/** ISO 8601 UTC. */
	time: string;
	/** `claude`, `codex`, or the agent T3 Code names; null when T3 Code recorded no agent for the turn. */
	harness: string | null;
	/** `owner/repo` of the checkout's GitHub `origin`, else the directory the session ran in. */
	repository: string;
	/** The harness's own session ID, or null when T3 Code recorded none. */
	session: string | null;
	text: string;
}

/** One question an agent asked and blocked on, with the person's answer. */
export interface Answer {
	kind: "answer";
	/** ISO 8601 UTC, when the answer came back. */
	time: string;
	harness: string;
	repository: string;
	session: string;
	/** The skill the session last ran before asking, when its log names one. */
	skill: string | null;
	/** The question's short label, when the harness has one. */
	header: string | null;
	question: string;
	options: string[];
	/** The options the agent marked `(Recommended)`. */
	recommended: string[];
	/** The options picked, or the person's own words when they typed an answer instead. */
	picked: string[];
}

/** What `quest messages` prints. */
export type Entry = Message | Answer;

export interface MessagesDependencies {
	env: NodeJS.ProcessEnv;
	home: string;
}

/** T3 Code drives these sessions and records who sent each message, so they are read from its state instead. */
const T3_CLAUDE = "t3-code";
const T3_CODEX = "T3 Code";

/** Wrappers Claude Code puts on a typed turn that hold output or a button's canned prompt, not the person's words. */
const CLAUDE_OUTPUT =
	/^<(bash-input|bash-stdout|bash-stderr|local-command-stdout|local-command-stderr|local-command-caveat|create-pr-command)>/;

/** The typed text of a Claude Code user turn: reminders the harness added dropped, a slash command as typed. */
export function claudeText(content: unknown): string | null {
	let text: string;
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		if (content.some((block) => block?.type === "tool_result")) return null;
		text = content
			.filter((block) => block?.type === "text" && typeof block.text === "string")
			.map((block) => block.text as string)
			.join("\n");
	} else return null;
	text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
	const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
	if (command) {
		const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? "";
		text = `${command[1]!.trim()} ${args.trim()}`;
	}
	text = text.trim();
	return text === "" || CLAUDE_OUTPUT.test(text) ? null : text;
}

/** The repository of the directory `dir`: its checkout's GitHub `origin`, else the directory itself. */
function repositories(): (dir: string) => string {
	const cache = new Map<string, string>();
	return (dir) => {
		let name = cache.get(dir);
		if (name === undefined) {
			const url = existsSync(dir)
				? spawnSync("git", ["-C", dir, "remote", "get-url", "origin"], {
						encoding: "utf8",
						env: discoveryEnv(),
					})
				: null;
			const repo = url?.status === 0 ? githubRepository(url.stdout.trim()) : null;
			name = repo ? `${repo.owner}/${repo.repo}` : dir;
			cache.set(dir, name);
		}
		return name;
	};
}

/** Files under `dir` with `.jsonl` names written since `since`, recursively; a log untouched since holds nothing newer. */
function logsSince(dir: string, since: number): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return logsSince(path, since);
		return entry.name.endsWith(".jsonl") && statSync(path).mtimeMs >= since ? [path] : [];
	});
}

/** Options an agent marks recommended end with this, as the quest skills and harness prompts ask. */
const RECOMMENDED = /\(recommended\)\s*$/i;

/** The answer entries for one question, given its options and what was picked. */
function answer(
	base: Omit<Answer, "kind" | "question" | "header" | "options" | "recommended" | "picked">,
	question: string,
	header: string | null,
	options: string[],
	picked: string[],
): Answer {
	return {
		kind: "answer",
		...base,
		header,
		question,
		options,
		recommended: options.filter((option) => RECOMMENDED.test(option)),
		picked,
	};
}

/** The skill a slash command or `Skill` call in a Claude Code record runs, if any. */
function claudeSkill(record: Record<string, unknown>, human: boolean): string | null {
	const content = (record.message as { content?: unknown } | undefined)?.content;
	if (record.type === "user") {
		if (!human) return null;
		const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
		const command = /<command-name>\/?([^<]+?)\s*<\/command-name>/.exec(text);
		return command ? command[1]! : null;
	}
	if (!Array.isArray(content)) return null;
	let skill: string | null = null;
	for (const block of content)
		if (block?.type === "tool_use" && block.name === "Skill" && typeof block.input?.skill === "string")
			skill = block.input.skill;
	return skill;
}

/**
 * A Claude Code log's typed turns, outside sessions T3 Code drives, and its answers to `AskUserQuestion`, in every
 * session, since T3 Code keeps no question's options. A sub-agent's turns are never a person's.
 */
export function readClaudeMessages(
	path: string,
	session: string,
	since: number,
	repository: (dir: string) => string,
): Entry[] {
	const entries: Entry[] = [];
	let skill: string | null = null;
	eachLine(path, (line, complete) => {
		// Only these lines can hold a typed turn, a skill, or an answer, so the far larger rest are never parsed.
		if (!line.includes('"human"') && !line.includes('"Skill"') && !line.includes('"answers"')) return;
		const record = parseLine(path, line, complete);
		if (!record || record.isSidechain === true) return;
		const result = record.toolUseResult as Record<string, unknown> | undefined;
		const human = (record.origin as { kind?: unknown } | undefined)?.kind === "human";
		skill = claudeSkill(record, human) ?? skill;
		const asked = record.type === "user" && Array.isArray(result?.questions) && result.answers !== undefined;
		if (!asked && (record.type !== "user" || !human)) return;
		const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
		if (Number.isNaN(at)) throw new Error(`${path} has a user record without a timestamp`);
		if (at < since) return;
		if (typeof record.cwd !== "string") throw new Error(`${path} has a user record without a directory`);
		const base = {
			time: new Date(at).toISOString(),
			harness: "claude",
			repository: repository(record.cwd),
			session,
		};
		if (asked) {
			const answers = result!.answers as Record<string, unknown>;
			if (typeof answers !== "object" || answers === null)
				throw new Error(`${path} has answers in a shape quest does not know`);
			for (const q of result!.questions as Record<string, unknown>[]) {
				const options = Array.isArray(q?.options)
					? q.options.map((o) => (o as { label?: unknown })?.label)
					: null;
				if (typeof q?.question !== "string" || !options?.every((o): o is string => typeof o === "string"))
					throw new Error(`${path} has a question in a shape quest does not know`);
				const given = answers[q.question];
				// A question the person left unanswered has no entry.
				if (given === undefined) continue;
				const picked = typeof given === "string" ? [given] : given;
				if (!Array.isArray(picked) || !picked.every((p) => typeof p === "string"))
					throw new Error(`${path} has an answer in a shape quest does not know`);
				entries.push(
					answer(
						{ ...base, skill },
						q.question,
						typeof q.header === "string" ? q.header : null,
						options,
						picked,
					),
				);
			}
			return;
		}
		if (record.entrypoint === T3_CLAUDE || record.isMeta === true) return;
		const text = claudeText((record.message as { content?: unknown } | undefined)?.content);
		if (text !== null) entries.push({ kind: "message", ...base, text });
	});
	return entries;
}

/** Codex's tools that block on a person's answer: the first returns it, the second has it sent as a later turn. */
const CODEX_ASK = new Set(["request_user_input", "request_user_input_async"]);

/** The turn part carrying answers to `request_user_input_async`, as Codex's client sends them. */
const CODEX_REPLY = /^\s*<send_user_message_question_reply>([\s\S]*)<\/send_user_message_question_reply>\s*$/;

/** One question Codex asked: its ID for `request_user_input`'s answers, and its options. */
interface CodexQuestion {
	id: string | null;
	question: string;
	header: string | null;
	options: string[];
}

/** The questions in a Codex question call's arguments, failing on a shape quest does not know. */
function codexQuestions(path: string, args: unknown): CodexQuestion[] {
	const parsed = typeof args === "string" ? (JSON.parse(args) as { questions?: unknown }) : null;
	if (!Array.isArray(parsed?.questions)) throw new Error(`${path} has a Codex question call without questions`);
	return parsed.questions.map((q: Record<string, unknown>) => {
		const question = q?.question ?? q?.title;
		const options = ((q?.options ?? []) as unknown[]).map((o) =>
			typeof o === "string" ? o : (o as { label?: unknown } | null)?.label,
		);
		if (typeof question !== "string" || !options.every((o): o is string => typeof o === "string"))
			throw new Error(`${path} has a Codex question in a shape quest does not know`);
		return {
			id: typeof q.id === "string" ? q.id : null,
			question,
			header: typeof q.header === "string" ? q.header : null,
			options,
		};
	});
}

/**
 * A Codex rollout's typed turns, in sessions a person runs, and its answers to Codex's blocking questions, in those
 * and the sessions T3 Code drives, since T3 Code keeps no question's options. Headless (`exec`) sessions and
 * sub-agents take only machine-written prompts.
 */
export function readCodexMessages(path: string, since: number, repository: (dir: string) => string): Entry[] {
	const entries: Entry[] = [];
	let session: string | undefined;
	let typed = false;
	let where = "";
	let skill: string | null = null;
	const asked = new Map<string, CodexQuestion[]>();
	// `request_user_input` calls whose output holds the answers.
	const pending = new Set<string>();
	eachLine(path, (line, complete) => {
		if (session === undefined) {
			const meta = parseLine(path, line, complete);
			const payload = meta?.payload as Record<string, unknown> | undefined;
			if (meta?.type !== "session_meta" || typeof payload?.id !== "string")
				throw new Error(`${path} does not start with a Codex session_meta record`);
			if (typeof payload.source !== "string" || payload.source === "exec") return false;
			typed = payload.originator !== T3_CODEX;
			session = payload.id;
			const url = (payload.git as Record<string, unknown> | undefined)?.repository_url;
			const repo = typeof url === "string" ? githubRepository(url) : null;
			if (repo) where = `${repo.owner}/${repo.repo}`;
			else if (typeof payload.cwd === "string") where = repository(payload.cwd);
			else throw new Error(`${path} names no directory`);
			return true;
		}
		const output = /"call_id"\s*:\s*"([^"]+)"/.exec(line)?.[1];
		const user = /"role"\s*:\s*"user"/.test(line);
		if (!user && !line.includes("request_user_input") && !(output !== undefined && pending.has(output))) return;
		const record = parseLine(path, line, complete);
		const item = record?.payload as Record<string, unknown> | undefined;
		if (record?.type !== "response_item" || !item) return;
		if (item.type === "function_call" && CODEX_ASK.has(item.name as string)) {
			asked.set(item.call_id as string, codexQuestions(path, item.arguments));
			if (item.name === "request_user_input") pending.add(item.call_id as string);
			return;
		}
		const result = item.type === "function_call_output" && pending.delete(item.call_id as string);
		if (!result && item.role !== "user") return;
		const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
		if (Number.isNaN(at)) throw new Error(`${path} has a user turn without a timestamp`);
		const base = { time: new Date(at).toISOString(), harness: "codex", repository: where, session: session! };
		if (result) {
			const questions = asked.get(item.call_id as string)!;
			if (at < since) return;
			let given: Record<string, { answers?: unknown }> | undefined;
			try {
				given = (JSON.parse(item.output as string) as { answers?: typeof given }).answers;
			} catch {}
			if (typeof given !== "object" || given === null)
				throw new Error(`${path} has a Codex question's answers in a shape quest does not know`);
			for (const q of questions) {
				const picked = q.id === null ? undefined : given[q.id]?.answers;
				if (picked === undefined) continue;
				if (!Array.isArray(picked) || !picked.every((p) => typeof p === "string"))
					throw new Error(`${path} has a Codex answer in a shape quest does not know`);
				entries.push(answer({ ...base, skill }, q.question, q.header, q.options, picked));
			}
			return;
		}
		const content = Array.isArray(item.content) ? item.content : [];
		const meta = item.internal_chat_message_metadata_passthrough as Record<string, unknown> | undefined;
		const provenance = meta?.content_item_metadata;
		if (!Array.isArray(provenance)) {
			// A compaction replays earlier turns, already read where they were typed, without their provenance.
			const kinds = meta?.content_item_kinds;
			if (Array.isArray(kinds) && kinds.length > 0 && kinds.every((kind) => kind === "unknown")) return;
			throw new Error(`${path} has a user turn without Codex's provenance, so typed text cannot be told apart`);
		}
		const sources = provenance.map(
			(each) => (each as { provenance?: { type?: unknown } } | null)?.provenance?.type,
		);
		if (sources.length !== content.length)
			throw new Error(`${path} has a user turn whose provenance does not cover each part`);
		const unknown = sources.find((type) => !CODEX_SOURCES.has(type as string));
		if (unknown !== undefined || sources.includes(undefined))
			throw new Error(`${path} has a user turn with an unknown provenance: ${String(unknown)}`);
		const texts: string[] = [];
		content.forEach((part, i) => {
			if (typeof part?.text !== "string") return;
			if (sources[i] === "skills") skill = /<name>\s*([^<]+?)\s*<\/name>/.exec(part.text)?.[1] ?? skill;
			if (sources[i] !== "user") return;
			const reply = CODEX_REPLY.exec(part.text);
			if (!reply) return texts.push(part.text);
			if (at < since) return;
			for (const each of JSON.parse(reply[1]!) as Record<string, unknown>[]) {
				const ref =
					typeof each?.questionItemId === "string" ? (JSON.parse(each.questionItemId) as unknown[]) : null;
				const q = Array.isArray(ref) ? asked.get(ref[1] as string)?.[ref[2] as number] : undefined;
				if (!q || typeof each.answer !== "string")
					throw new Error(`${path} has an answer to a question its log does not hold`);
				entries.push(answer({ ...base, skill }, q.question, q.header, q.options, [each.answer]));
			}
		});
		const text = texts.join("\n").trim();
		if (typed && at >= since && text !== "") entries.push({ kind: "message", ...base, text });
	});
	return entries;
}

/** Who Codex says wrote a part of a user turn: the person, or the instructions, harness, or skill it added. */
const CODEX_SOURCES = new Set(["user", "agents_md", "harness", "skills"]);

/** T3 Code's agent names, as the harness names `quest usage` reports. */
const T3_DRIVERS: Record<string, string> = { claudeAgent: "claude", codex: "codex" };

/**
 * The messages a person typed through T3 Code: those it records as created by the user from its web or mobile
 * client. Agents' relays, notifications, and scheduled prompts are created by an agent or carry their task, and a
 * structured question's answer comes from its server.
 */
export function readT3Messages(path: string, since: number, repository: (dir: string) => string): Message[] {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const rows = db
			.prepare(
				`SELECT m.message_id AS id, m.created_at AS at, m.payload_json AS payload,
					pt.payload_json AS provider, p.workspace_root AS root
				FROM orchestration_v2_projection_messages m
				LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = m.run_id
				LEFT JOIN orchestration_v2_projection_provider_threads pt ON pt.provider_thread_id = r.provider_thread_id
				LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id
				LEFT JOIN projection_projects p ON p.project_id = t.project_id
				WHERE m.role = 'user' AND m.created_at >= ?
				ORDER BY m.created_at`,
			)
			.all(new Date(since).toISOString()) as {
			id: string;
			at: string;
			payload: string;
			provider: string | null;
			root: string | null;
		}[];
		return rows.flatMap((row) => {
			const payload = JSON.parse(row.payload) as Record<string, unknown>;
			if (payload.createdBy === "agent") return [];
			if (payload.createdBy !== "user")
				throw new Error(`T3 Code message ${row.id} names an unknown sender: ${String(payload.createdBy)}`);
			if (payload.creationSource === "server" || payload.scheduledTaskId !== undefined) return [];
			if (payload.creationSource !== "web" && payload.creationSource !== "mobile")
				throw new Error(
					`T3 Code message ${row.id} comes from an unknown client: ${String(payload.creationSource)}`,
				);
			if (typeof payload.text !== "string") throw new Error(`T3 Code message ${row.id} has no text`);
			if (row.root === null) throw new Error(`T3 Code message ${row.id} belongs to no project`);
			const native = row.provider === null ? null : (JSON.parse(row.provider) as Record<string, unknown>);
			const ref = native?.nativeThreadRef as { nativeId?: unknown } | null | undefined;
			const driver = typeof native?.driver === "string" ? native.driver : null;
			const text = payload.text.trim();
			if (text === "") return [];
			return [
				{
					kind: "message" as const,
					time: new Date(row.at).toISOString(),
					harness: driver === null ? null : (T3_DRIVERS[driver] ?? driver),
					repository: repository(row.root),
					session: typeof ref?.nativeId === "string" ? ref.nativeId : null,
					text,
				},
			];
		});
	} finally {
		db.close();
	}
}

/**
 * Every message a person typed to an agent on this host since `since`, a `YYYY-MM-DD` local date, and every answer
 * they gave an agent's question, oldest first.
 */
export function messages(since: string, deps: MessagesDependencies): Entry[] {
	const from = new Date(`${since}T00:00:00`).getTime();
	const repository = repositories();
	const found: Entry[] = [];
	for (const [session, path] of claudeLogs(deps))
		if (statSync(path).mtimeMs >= from) found.push(...readClaudeMessages(path, session, from, repository));
	const codex = deps.env.CODEX_HOME || join(deps.home, ".codex");
	const threads = new Set<string>();
	for (const path of [
		...logsSince(join(codex, "sessions"), from),
		...logsSince(join(codex, "archived_sessions"), from),
	]) {
		// An archived rollout can still sit in the sessions tree too; its file name ends with its thread ID.
		const thread = /([0-9a-f-]{36})\.jsonl$/.exec(path)?.[1] ?? path;
		if (threads.has(thread)) continue;
		threads.add(thread);
		found.push(...readCodexMessages(path, from, repository));
	}
	const t3 = deps.env.T3CODE_HOME || join(deps.home, ".t3");
	if (existsSync(t3)) {
		const state = join(t3, "userdata", "statev2.sqlite");
		if (!existsSync(state))
			throw new Error(
				`T3 Code is installed at ${t3} but keeps no state at ${state}, where quest reads its messages`,
			);
		found.push(...readT3Messages(state, from, repository));
	}
	return found.sort((a, b) => a.time.localeCompare(b.time));
}

/** The entries as plain lines: a header per entry, then its text, or an answer's question and picks, indented. */
export function messageLines(found: Entry[]): string[] {
	return found.flatMap((m) => {
		const head = `${m.time} ${m.harness ?? "-"} ${m.repository} ${m.session ?? "-"}`;
		const indent = (text: string) => text.split("\n").map((line) => `  ${line}`.trimEnd());
		if (m.kind === "message") return [head, ...indent(m.text)];
		return [
			`${head} answer ${m.skill ?? "-"}`,
			...indent(m.header === null ? m.question : `[${m.header}] ${m.question}`),
			`  recommended: ${m.recommended.join(" | ") || "-"}`,
			`  picked: ${m.picked.join(" | ")}`,
		];
	});
}
