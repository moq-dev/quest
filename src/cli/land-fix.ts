// Untrusted agent side. The host wrapper supplies only a model endpoint and its client key; the agent holds no
// GitHub credential, and the daemon posts the comments it writes into its result.
import { spawn, spawnSync } from "node:child_process";
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
/** The longest Markdown comment a result may ask the daemon to post on its PR. */
export const COMMENT_LIMIT = 4000;
export type FixResult = { agent?: string; model?: string; comment?: string } & (
	| { number: number; action: "requeue"; reason: string }
	| { number: number; action: "fixed"; head: string; reason: string }
	| { number: number; action: "handback"; diagnosis: string; recommendation: string }
);

/** Reject extra fields, duplicate/missing PRs, multiline reasons, oversized comments, and oversized output. */
export function parseFixResult(text: string, numbers: number[]): FixResult[] {
	if (text.length > 100_000) throw new Error("fixer result exceeds 100 KB");
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("fixer result is not valid JSON");
	}
	if (!Array.isArray(value) || value.length !== numbers.length)
		throw new Error("fixer must return every PR exactly once");
	const seen = new Set<number>();
	for (const item of value) {
		if (!item || typeof item !== "object" || !numbers.includes(item.number) || seen.has(item.number))
			throw new Error("invalid or duplicate fixer PR");
		seen.add(item.number);
		const fields =
			item.action === "fixed"
				? ["number", "action", "head", "reason"]
				: item.action === "requeue"
					? ["number", "action", "reason"]
					: item.action === "handback"
						? ["number", "action", "diagnosis", "recommendation"]
						: [];
		const metadata = ["agent", "model"].filter((key) => key in item);
		if (metadata.some((key) => typeof item[key] !== "string" || !/^[a-zA-Z0-9 ._/-]{1,100}$/.test(item[key])))
			throw new Error("invalid fixer identity");
		// One optional Markdown comment per PR: multiline, but no other control characters.
		if (
			"comment" in item &&
			(typeof item.comment !== "string" ||
				!item.comment.trim() ||
				item.comment.length > COMMENT_LIMIT ||
				/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item.comment))
		)
			throw new Error("invalid fixer comment");
		const optional = metadata.length + ("comment" in item ? 1 : 0);
		if (
			fields.length === 0 ||
			Object.keys(item).length !== fields.length + optional ||
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
	return value as FixResult[];
}

export async function fix(
	root: string,
	log: string,
	numbers: number[],
	agent = "codex",
	args?: string[],
	model?: string,
): Promise<void> {
	if (
		!numbers.length ||
		numbers.some((number) => !Number.isSafeInteger(number) || number <= 0) ||
		new Set(numbers).size !== numbers.length
	)
		throw new Error("fix needs distinct positive PR numbers");
	if (!args && (!process.env.OPENAI_BASE_URL || !process.env.OPENAI_API_KEY))
		throw new Error("fix needs OPENAI_BASE_URL and OPENAI_API_KEY from the container wrapper");
	readFileSync(log); // Fail before starting an agent when the wrapper did not expose the log.
	// The daemon pinned each PR's head on its pr-<n> branch; name it so the agent need not look it up.
	const prs = numbers.map((number) => {
		const ref = `pr-${number}`;
		const head = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${ref}^{commit}`], {
			cwd: root,
			encoding: "utf8",
		}).stdout.trim();
		if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error(`fix needs a ${ref} branch`);
		return `- #${number}: branch ${ref} at ${head}`;
	});
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
		// Without this, Codex runs the proxy's model with no reasoning at all ("reasoning effort: none").
		"-c",
		'model_reasoning_effort="medium"',
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
		child.stdin.end(`${prompt}\n\nFailure log: ${JSON.stringify(log)}\nPRs:\n${prs.join("\n")}\n`);
		child.once("close", (code) => (code === 0 ? done() : reject(new FixerAgentError(code ?? 1))));
	});
	const results = parseFixResult(readFixResult(root), numbers);
	const index = argv.findIndex((arg) => arg === "-m" || arg === "--model");
	const ranModel = index >= 0 ? argv[index + 1] : argv.find((arg) => arg.startsWith("--model="))?.slice(8);
	const identity = { agent: basename(agent), model: ranModel ?? "Codex" };
	const result = JSON.stringify(results.map((item) => ({ ...item, ...identity })));
	parseFixResult(result, numbers);
	writeFileSync(join(root, FIX_RESULT), result);
}
