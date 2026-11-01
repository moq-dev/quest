// Untrusted agent side. The host wrapper supplies only a model endpoint and its client key.
import { spawn } from "node:child_process";
import { constants, closeSync, fstatSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import prompt from "../../assets/land-fix.md";

export class FixerAgentError extends Error {
	constructor(readonly exitCode: number) {
		super(`fixer agent exited ${exitCode}`);
	}
}

export const FIX_RESULT = "quest-land-result.json";
export function readFixResult(root: string): string {
	const fd = openSync(join(root, FIX_RESULT), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > 100_000) throw new Error("fixer result must be a regular file under 100 KB");
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}
/**
 * The fixer's verdict on one PR. `blame` names a PR whose own change caused the failure; a blamed PR
 * is fixed or handed back, never requeued. A handback's `log` cites the failure log's lines, first
 * to last, that show the failure, which its comment quotes.
 */
export type FixResult = { agent?: string; model?: string; blame?: boolean } & (
	| { number: number; action: "requeue"; reason: string }
	| { number: number; action: "fixed"; head: string; reason: string }
	| { number: number; action: "handback"; diagnosis: string; recommendation: string; log?: [number, number] }
);

/**
 * The fixer's verdict on the base alone, when no PR is supplied: a mechanical fix committed on its
 * `base` branch, which the daemon opens as a PR, or a handback, which halts the queue with an issue.
 */
export type BaseFix = { agent?: string; model?: string } & (
	| { action: "fixed"; head: string; reason: string }
	| { action: "handback"; diagnosis: string; recommendation: string }
);

function json(text: string): unknown {
	if (text.length > 100_000) throw new Error("fixer result exceeds 100 KB");
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("fixer result is not valid JSON");
	}
}

/** Reject extra fields, multiline reasons, and oversized values in one result entry; `pr` allows a PR's own fields. */
function validate(item: any, pr: boolean): void {
	const named = pr ? ["number"] : [];
	const fields =
		item.action === "fixed"
			? [...named, "action", "head", "reason"]
			: item.action === "requeue" && pr
				? [...named, "action", "reason"]
				: item.action === "handback"
					? [...named, "action", "diagnosis", "recommendation"]
					: [];
	const metadata = ["agent", "model"].filter((key) => key in item);
	if (metadata.some((key) => typeof item[key] !== "string" || !/^[a-zA-Z0-9 ._/-]{1,100}$/.test(item[key])))
		throw new Error("invalid fixer identity");
	if (pr && "blame" in item) {
		if (typeof item.blame !== "boolean") throw new Error("invalid fixer blame");
		if (item.blame && item.action === "requeue") throw new Error("a blamed PR must be fixed or handed back");
		metadata.push("blame");
	}
	if (pr && "log" in item) {
		const log = item.log;
		if (
			item.action !== "handback" ||
			!Array.isArray(log) ||
			log.length !== 2 ||
			!log.every((line) => Number.isSafeInteger(line) && line >= 1) ||
			log[0] > log[1]
		)
			throw new Error("invalid fixer log lines");
		metadata.push("log");
	}
	if (
		fields.length === 0 ||
		Object.keys(item).length !== fields.length + metadata.length ||
		fields.some((key) => !(key in item))
	)
		throw new Error("invalid fixer action or fields");
	for (const key of fields.filter((key) => key !== "number")) {
		if (
			typeof item[key] !== "string" ||
			!item[key].trim() ||
			item[key].length > 4000 ||
			/[\u0000-\u001f\u007f]/.test(item[key])
		)
			throw new Error(`invalid fixer ${key}`);
	}
	if (item.action === "fixed" && !/^[a-f0-9]{40}$/.test(item.head)) throw new Error("invalid fixer head");
}

/** Reject extra fields, duplicate/missing PRs, multiline reasons, and oversized output. */
export function parseFixResult(text: string, numbers: number[]): FixResult[] {
	const value = json(text);
	if (!Array.isArray(value) || value.length !== numbers.length)
		throw new Error("fixer must return every PR exactly once");
	const seen = new Set<number>();
	for (const item of value) {
		if (!item || typeof item !== "object" || !numbers.includes(item.number) || seen.has(item.number))
			throw new Error("invalid or duplicate fixer PR");
		seen.add(item.number);
		validate(item, true);
	}
	return value as FixResult[];
}

/** The base fixer's one result object, as strictly as a PR's. */
export function parseBaseFix(text: string): BaseFix {
	const value = json(text);
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("a base fix result must be one JSON object");
	validate(value, false);
	return value as BaseFix;
}

export async function fix(
	root: string,
	log: string,
	numbers: number[],
	agent = "codex",
	args?: string[],
	model?: string,
): Promise<void> {
	// No PR numbers fixes the base alone, which fails its check without any PR.
	if (
		numbers.some((number) => !Number.isSafeInteger(number) || number <= 0) ||
		new Set(numbers).size !== numbers.length
	)
		throw new Error("fix needs distinct positive PR numbers");
	if (!args && (!process.env.OPENAI_BASE_URL || !process.env.OPENAI_API_KEY))
		throw new Error("fix needs OPENAI_BASE_URL and OPENAI_API_KEY from the container wrapper");
	readFileSync(log); // Fail before starting an agent when the wrapper did not expose the log.
	rmSync(join(root, FIX_RESULT), { force: true });
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		LANG: "C.UTF-8",
		OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
		OPENAI_API_KEY: process.env.OPENAI_API_KEY,
		CODEX_API_KEY: process.env.OPENAI_API_KEY,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
	};
	const argv = args ?? [
		"exec",
		"--ephemeral",
		"--ignore-user-config",
		"--ignore-rules",
		"--dangerously-bypass-approvals-and-sandbox",
		"-c",
		"project_doc_max_bytes=0",
		"-c",
		`developer_instructions=${JSON.stringify(prompt)}`,
		"-c",
		'model_provider="quest-fixer"',
		"-c",
		'model_providers.quest-fixer.name="Host model proxy"',
		"-c",
		`model_providers.quest-fixer.base_url=${JSON.stringify(process.env.OPENAI_BASE_URL)}`,
		"-c",
		'model_providers.quest-fixer.env_key="OPENAI_API_KEY"',
		"-c",
		'model_providers.quest-fixer.wire_api="responses"',
		...(model ? ["--model", model] : []),
		"-",
	];
	await new Promise<void>((done, reject) => {
		// Relay the agent's output through pipes of its own rather than letting it inherit ours. Once Bun writes
		// to a pipe it marks that pipe non-blocking, and an inheriting child shares the flag: Codex then panicked
		// (exit 101) with EAGAIN as soon as one command's output outran the host's reader.
		const child = spawn(agent, argv, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
		child.stdout.pipe(process.stdout, { end: false });
		child.stderr.pipe(process.stderr, { end: false });
		child.once("error", reject);
		child.stdin.on("error", () => {});
		child.stdin.end(
			`${prompt}\n\nFailure log: ${JSON.stringify(log)}\nPRs: ${numbers.length ? numbers.join(", ") : "none; the base fails alone"}\n`,
		);
		child.once("close", (code) => (code === 0 ? done() : reject(new FixerAgentError(code ?? 1))));
	});
	const parse = (text: string) => (numbers.length ? parseFixResult(text, numbers) : parseBaseFix(text));
	const results = parse(readFixResult(root));
	const index = argv.findIndex((arg) => arg === "-m" || arg === "--model");
	const ranModel = index >= 0 ? argv[index + 1] : argv.find((arg) => arg.startsWith("--model="))?.slice(8);
	const identity = { agent: basename(agent), model: ranModel ?? "Codex" };
	const result = JSON.stringify(
		Array.isArray(results) ? results.map((item) => ({ ...item, ...identity })) : { ...results, ...identity },
	);
	parse(result);
	writeFileSync(join(root, FIX_RESULT), result);
}
