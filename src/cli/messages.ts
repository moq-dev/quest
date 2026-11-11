// `quest messages`: the messages a person typed to their agents on this host, and nothing an agent or harness wrote.
// Each source marks its sender: T3 Code's state for the sessions it drives, Claude Code's `origin` for the rest of
// its sessions, and Codex's content provenance for its interactive ones. Output goes to stdout only.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { discoveryEnv } from "./git";
import { githubRepository } from "./github";
import { claudeLogs, eachLine, parseLine } from "./usage";

/** One message a person typed. */
export interface Message {
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

/** Typed turns in a Claude Code log: the ones Claude Code marks as a human's, outside sessions T3 Code drives. */
export function readClaudeMessages(
	path: string,
	session: string,
	since: number,
	repository: (dir: string) => string,
): Message[] {
	const messages: Message[] = [];
	eachLine(path, (line, complete) => {
		// Only a human's turn names that origin, so the far larger tool and reply lines are never parsed.
		if (!line.includes('"human"')) return;
		const record = parseLine(path, line, complete);
		if (record?.type !== "user" || (record.origin as { kind?: unknown } | undefined)?.kind !== "human") return;
		if (record.entrypoint === T3_CLAUDE || record.isMeta === true || record.isSidechain === true) return;
		const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
		if (Number.isNaN(at)) throw new Error(`${path} has a typed turn without a timestamp`);
		if (at < since) return;
		const text = claudeText((record.message as { content?: unknown } | undefined)?.content);
		if (text === null) return;
		if (typeof record.cwd !== "string") throw new Error(`${path} has a typed turn without a directory`);
		messages.push({
			time: new Date(at).toISOString(),
			harness: "claude",
			repository: repository(record.cwd),
			session,
			text,
		});
	});
	return messages;
}

/**
 * Typed turns in a Codex rollout: the content Codex marks as the user's, in a session a person runs. Headless
 * (`exec`) sessions and sub-agents take only machine-written prompts, and T3 Code's are read from its state.
 */
export function readCodexMessages(path: string, since: number, repository: (dir: string) => string): Message[] {
	const messages: Message[] = [];
	let session: string | undefined;
	let where = "";
	eachLine(path, (line, complete) => {
		if (session === undefined) {
			const meta = parseLine(path, line, complete);
			const payload = meta?.payload as Record<string, unknown> | undefined;
			if (meta?.type !== "session_meta" || typeof payload?.id !== "string")
				throw new Error(`${path} does not start with a Codex session_meta record`);
			const interactive =
				typeof payload.source === "string" && payload.source !== "exec" && payload.originator !== T3_CODEX;
			if (!interactive) return false;
			session = payload.id;
			const url = (payload.git as Record<string, unknown> | undefined)?.repository_url;
			const repo = typeof url === "string" ? githubRepository(url) : null;
			if (repo) where = `${repo.owner}/${repo.repo}`;
			else if (typeof payload.cwd === "string") where = repository(payload.cwd);
			else throw new Error(`${path} names no directory`);
			return true;
		}
		if (!line.includes('"role":"user"')) return;
		const record = parseLine(path, line, complete);
		const item = record?.payload as Record<string, unknown> | undefined;
		if (record?.type !== "response_item" || item?.role !== "user") return;
		const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
		if (Number.isNaN(at)) throw new Error(`${path} has a user turn without a timestamp`);
		if (at < since) return;
		const meta = item.internal_chat_message_metadata_passthrough as Record<string, unknown> | undefined;
		if (meta === undefined)
			throw new Error(
				`${path} has a user turn without Codex's provenance metadata, so typed text cannot be told apart`,
			);
		const provenance = Array.isArray(meta.content_item_metadata) ? meta.content_item_metadata : [];
		const content = Array.isArray(item.content) ? item.content : [];
		const text = content
			.filter(
				(part, i) =>
					(provenance[i] as { provenance?: { type?: unknown } } | undefined)?.provenance?.type === "user" &&
					typeof part?.text === "string",
			)
			.map((part) => part.text as string)
			.join("\n")
			.trim();
		if (text !== "")
			messages.push({
				time: new Date(at).toISOString(),
				harness: "codex",
				repository: where,
				session: session!,
				text,
			});
	});
	return messages;
}

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

/** Every message a person typed to an agent on this host since `since`, a `YYYY-MM-DD` local date, oldest first. */
export function messages(since: string, deps: MessagesDependencies): Message[] {
	const from = new Date(`${since}T00:00:00`).getTime();
	const repository = repositories();
	const found: Message[] = [];
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

/** The messages as plain lines: a header per message, then its text indented. */
export function messageLines(found: Message[]): string[] {
	return found.flatMap((m) => [
		`${m.time} ${m.harness ?? "-"} ${m.repository} ${m.session ?? "-"}`,
		...m.text.split("\n").map((line) => `  ${line}`.trimEnd()),
	]);
}
