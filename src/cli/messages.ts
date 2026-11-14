// `quest messages`: the messages a person typed to their agents on this host, and their answers to agents' blocking
// questions, and nothing an agent or harness wrote. Each source marks its sender: T3 Code's state for the sessions it
// drives, Claude Code's `origin` for the rest of its sessions, and Codex's content provenance for its interactive ones.
// Answers come from each harness's own log, which keeps the question's options. Output goes to stdout only.
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { discoveryEnv } from "./git";
import { githubRepository } from "./github";

/**
 * Visit each line of the file at `path`, reading it in bounded chunks since logs reach gigabytes. The last line is
 * marked incomplete when no newline ends it, as while its session is still writing it. Reading stops once `visit`
 * returns false.
 */
function eachLine(path: string, visit: (line: string, complete: boolean) => boolean | void): void {
	const fd = openSync(path, "r");
	try {
		const chunk = Buffer.alloc(1 << 22);
		let rest = Buffer.alloc(0);
		for (let read = readSync(fd, chunk); read > 0; read = readSync(fd, chunk)) {
			const data = rest.length ? Buffer.concat([rest, chunk.subarray(0, read)]) : chunk.subarray(0, read);
			let start = 0;
			for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
				if (end > start && visit(data.toString("utf8", start, end), true) === false) return;
				start = end + 1;
			}
			rest = Buffer.from(data.subarray(start));
		}
		if (rest.length) visit(rest.toString("utf8"), false);
	} finally {
		closeSync(fd);
	}
}

/**
 * One JSON record of a log line, or null for an incomplete last line. With `skip`, a complete line that is not JSON,
 * such as a partial record a crashed write left mid-file, is counted through it and read as null instead of failing.
 */
function parseLine(path: string, line: string, complete: boolean, skip?: () => void): Record<string, unknown> | null {
	try {
		return JSON.parse(line) as Record<string, unknown>;
	} catch (error) {
		if (!complete) return null;
		if (skip) {
			skip();
			return null;
		}
		throw new Error(`${path} has a line that is not JSON: ${(error as Error).message}`);
	}
}

/** Claude Code's session logs by session ID, from each config directory Claude Code uses, once each. */
function claudeLogs(deps: { env: NodeJS.ProcessEnv; home: string }): Map<string, string> {
	const configured = deps.env.CLAUDE_CONFIG_DIR?.split(",")
		.map((dir) => dir.trim())
		.filter(Boolean);
	const dirs = configured?.length ? configured : [join(deps.home, ".config", "claude"), join(deps.home, ".claude")];
	const logs = new Map<string, string>();
	for (const dir of dirs) {
		const projects = join(dir, "projects");
		if (!existsSync(projects)) continue;
		for (const project of readdirSync(projects, { withFileTypes: true })) {
			if (!project.isDirectory()) continue;
			for (const file of readdirSync(join(projects, project.name)))
				if (file.endsWith(".jsonl") && !logs.has(file.slice(0, -6)))
					logs.set(file.slice(0, -6), join(projects, project.name, file));
		}
	}
	return logs;
}

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
	/** Told, on stderr, of each Claude Code session whose malformed lines were skipped. */
	warn?: (line: string) => void;
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

/** How Claude Code opens the turn loading a skill, whether typed as a slash command or called as a tool. */
const CLAUDE_SKILL = /^\s*Base directory for this skill: (?:.*\/)?([^/\n]+?)\/?[ \t]*$/m;

/** The skill a Claude Code record loads, if any; built-in commands such as `/compact` load none. */
function claudeSkill(record: Record<string, unknown>): string | null {
	const content = (record.message as { content?: unknown } | undefined)?.content;
	if (record.type !== "user" || record.isMeta !== true || !Array.isArray(content)) return null;
	for (const block of content) {
		const name = typeof block?.text === "string" ? CLAUDE_SKILL.exec(block.text)?.[1] : undefined;
		if (name) return name;
	}
	return null;
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
	skip?: () => void,
): Entry[] {
	const entries: Entry[] = [];
	let skill: string | null = null;
	eachLine(path, (line, complete) => {
		// Only these lines can hold a typed turn, a skill, or an answer, so the far larger rest are never parsed.
		if (!line.includes('"human"') && !line.includes("Base directory for this skill") && !line.includes('"answers"'))
			return;
		const record = parseLine(path, line, complete, skip);
		if (!record || record.isSidechain === true) return;
		const result = record.toolUseResult as Record<string, unknown> | undefined;
		const human = (record.origin as { kind?: unknown } | undefined)?.kind === "human";
		skill = claudeSkill(record) ?? skill;
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
	const asked = new Map<string, CodexQuestion[] | null>();
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
			const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
			// A question before the window is read only for an answer inside it, so a shape quest no longer
			// knows there leaves that answer unread rather than failing the window.
			let questions: CodexQuestion[] | null = null;
			try {
				questions = codexQuestions(path, item.arguments);
			} catch (error) {
				if (!(at < since)) throw error;
			}
			asked.set(item.call_id as string, questions);
			if (item.name === "request_user_input") pending.add(item.call_id as string);
			return;
		}
		const result = item.type === "function_call_output" && pending.delete(item.call_id as string);
		if (!result && item.role !== "user") return;
		const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
		if (Number.isNaN(at)) throw new Error(`${path} has a user turn without a timestamp`);
		const base = { time: new Date(at).toISOString(), harness: "codex", repository: where, session: session! };
		/** Records the answers a turn part carries, if it is a question reply. */
		const replies = (text: string): boolean => {
			const reply = CODEX_REPLY.exec(text);
			if (!reply) return false;
			let each: Record<string, unknown>[];
			try {
				each = JSON.parse(reply[1]!);
				if (!Array.isArray(each)) throw new Error();
			} catch {
				throw new Error(`${path} has a question reply in a shape quest does not know`);
			}
			for (const one of each) {
				let ref: unknown;
				try {
					ref = JSON.parse(one?.questionItemId as string);
				} catch {}
				if (!Array.isArray(ref) || typeof one.answer !== "string")
					throw new Error(`${path} has a question reply in a shape quest does not know`);
				const questions = asked.get(ref[1] as string);
				// A question before the window in a shape quest no longer knows was left unread above.
				if (questions === null) continue;
				const q = questions?.[ref[2] as number];
				if (!q) throw new Error(`${path} has an answer to a question its log does not hold`);
				entries.push(answer({ ...base, skill }, q.question, q.header, q.options, [one.answer]));
			}
			return true;
		};
		if (result) {
			const questions = asked.get(item.call_id as string);
			if (at < since || !questions) return;
			let output: unknown;
			try {
				output = JSON.parse(item.output as string);
			} catch {
				// A cancelled or failed call returns an error message, not answers: the person gave none.
				return;
			}
			const given = (output as { answers?: unknown } | null)?.answers as Record<string, { answers?: unknown }>;
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
		// Turns before the window, and in sessions whose typed turns T3 Code records, are read only for the skill
		// they load, so their provenance need not be one quest knows.
		if (at < since || !typed) {
			const sources = (
				(item.internal_chat_message_metadata_passthrough as Record<string, unknown> | undefined)
					?.content_item_metadata as unknown[] | undefined
			)?.map((each) => (each as { provenance?: { type?: unknown } } | null)?.provenance?.type);
			content.forEach((part, i) => {
				if (typeof part?.text !== "string") return;
				if (sources?.[i] === "skills") skill = codexSkill(part.text) ?? skill;
				else if (at >= since) replies(part.text);
			});
			return;
		}
		const meta = item.internal_chat_message_metadata_passthrough as Record<string, unknown> | undefined;
		const provenance = meta?.content_item_metadata;
		let sources: unknown[];
		if (Array.isArray(provenance)) {
			sources = provenance.map((each) => (each as { provenance?: { type?: unknown } } | null)?.provenance?.type);
		} else {
			// Codex 0.162's TUI marks each part with a kind instead. A compaction replays earlier turns, already read
			// where they were typed, with every kind unknown; a part whose kind says nothing otherwise cannot be told
			// apart.
			const kinds = meta?.content_item_kinds;
			if (!Array.isArray(kinds) || kinds.length === 0 || kinds.includes("unknown")) {
				if (Array.isArray(kinds) && kinds.length > 0 && kinds.every((kind) => kind === "unknown")) return;
				throw new Error(
					`${path} has a user turn without Codex's provenance, so typed text cannot be told apart`,
				);
			}
			sources = kinds.map((kind) => {
				if (kind === "user.text") return "user";
				if (CODEX_INJECTED.has(kind as string)) return "harness";
				throw new Error(`${path} has a user turn with an unknown provenance: ${String(kind)}`);
			});
		}
		if (sources.length !== content.length)
			throw new Error(`${path} has a user turn whose provenance does not cover each part`);
		const unknown = sources.find((type) => !CODEX_SOURCES.has(type as string));
		if (unknown !== undefined || sources.includes(undefined))
			throw new Error(`${path} has a user turn with an unknown provenance: ${String(unknown)}`);
		const texts: string[] = [];
		content.forEach((part, i) => {
			if (typeof part?.text !== "string") return;
			if (sources[i] === "skills") skill = codexSkill(part.text) ?? skill;
			if (sources[i] === "user" && !replies(part.text)) texts.push(part.text);
		});
		const text = texts.join("\n").trim();
		if (typed && at >= since && text !== "") entries.push({ kind: "message", ...base, text });
	});
	return entries;
}

/** The skill a Codex `skills` turn part loads. */
function codexSkill(text: string): string | null {
	return /<name>\s*([^<]+?)\s*<\/name>/.exec(text)?.[1] ?? null;
}

/** Who Codex says wrote a part of a user turn: the person, or the instructions, harness, or skill it added. */
const CODEX_SOURCES = new Set(["user", "agents_md", "harness", "skills"]);

/** The content kinds Codex 0.162 gives the parts it adds to a user turn, never typed by the person. */
const CODEX_INJECTED = new Set([
	"agents_md.instructions",
	"environments.environment_context",
	"multi_agent.role_instructions",
	"multi_agent.mode_instructions",
	"host_skills.instructions",
	"permissions.instructions",
	"collaboration_mode.instructions",
	"generic.developer_instructions",
	"tools.deferred_namespaces",
	"plugins.recommendations",
	"model.base_instructions",
]);

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
	for (const [session, path] of claudeLogs(deps)) {
		if (statSync(path).mtimeMs < from) continue;
		let skipped = 0;
		found.push(...readClaudeMessages(path, session, from, repository, () => skipped++));
		if (skipped)
			deps.warn?.(`skipped ${skipped} malformed line${skipped === 1 ? "" : "s"} in session ${session} (${path})`);
	}
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
