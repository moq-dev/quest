// Untrusted agent side. The host wrapper supplies only a model endpoint and its client key; the agent holds no
// GitHub credential, and the daemon posts the comments it writes into its result.
import { spawn, spawnSync } from "node:child_process";
import { constants, closeSync, existsSync, fstatSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import prompt from "../../assets/land-fix.md";
import { discoveryEnv } from "./git";
import { programEnvironment, requireProgram } from "./program";

export class FixerAgentError extends Error {
	constructor(readonly exitCode: number) {
		super(`fixer agent exited ${exitCode}`);
	}
}

export const FIX_RESULT = "quest-land-result.json";
/**
 * The repository's known flaky tests, which a daemon may write in the checkout's `.git` before a round,
 * where no commit can carry it: a JSON array of `KnownFlaky`.
 */
export const FLAKY_INPUT = "quest-land-flaky.json";

/** A test the fixer judged flaky before, by the `failure` it named, with the `merge_group` jobs that showed it. */
export interface KnownFlaky {
	failure: string;
	/** The follow-up quest quest land watch adds when it is disabled, for the skip's reason to name. */
	quest: string;
	jobs: string[];
}

/** A regular file of at most 100 KB, never through a link. */
function readBounded(path: string, what: string): string {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > 100_000) throw new Error(`${what} must be a regular file under 100 KB`);
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}

export function readFixResult(root: string): string {
	return readBounded(join(root, FIX_RESULT), "fixer result");
}

/** The known flaky tests the daemon left in `root`'s `.git`, if any, as the agent's input lists them. */
export function knownFlaky(root: string): KnownFlaky[] {
	const path = join(root, ".git", FLAKY_INPUT);
	if (!existsSync(path)) return [];
	const value = json(readBounded(path, "known flaky tests"));
	if (
		!Array.isArray(value) ||
		!value.every(
			(item) =>
				item &&
				typeof item.failure === "string" &&
				typeof item.quest === "string" &&
				Array.isArray(item.jobs) &&
				item.jobs.every((job: unknown) => typeof job === "string"),
		)
	)
		throw new Error("invalid known flaky tests");
	return value as KnownFlaky[];
}
/** The longest Markdown comment a result may ask the daemon to post on its PR. */
export const COMMENT_LIMIT = 4000;
/** The longest failure signature a result may name, short enough to quote in a handback. */
const FAILURE_LIMIT = 200;

/**
 * Why a PR requeued unchanged failed with no fault of its own: a test that comes and goes (`flaky`), a
 * failure the base shows alone (`base`), or the runner's environment, such as a missing tool or a full disk.
 */
export const CAUSES = ["flaky", "base", "environment"] as const;
export type Cause = (typeof CAUSES)[number];

/**
 * `failure` as signatures are compared: without backticks or quotes, with whitespace collapsed, so one
 * test named with and without quoting is still one test.
 */
export const signature = (failure: string) => failure.replace(/[`'"]/g, "").replace(/\s+/g, " ").trim();

/**
 * The fixer's verdict on one PR. `blame` names a PR whose own change caused the failure; a blamed PR
 * is fixed or handed back, never requeued. A handback's `log` cites the failure log's lines, first
 * to last, that show the failure, which its comment quotes. `failure` names the failing test or step,
 * the signature the stop rules compare across a pick's rounds. A requeue of the PR's own failure names
 * its `cause`. A flaky one names its test by `failure`, or, for a known flaky test, by that entry's
 * `quest`, so a reworded name never splits one test's record. Only a known one may carry `disable`:
 * the tip of the fixer's `disable` branch, a commit on the base that skips the test and adds its
 * follow-up quest, which the daemon opens as a PR of its own.
 */
export type FixResult = {
	agent?: string;
	model?: string;
	effort?: string;
	blame?: boolean;
	comment?: string;
	failure?: string;
} & (
	| { number: number; action: "requeue"; reason: string; cause?: Cause; quest?: string; disable?: string }
	| { number: number; action: "fixed"; head: string; reason: string }
	| { number: number; action: "handback"; diagnosis: string; recommendation: string; log?: [number, number] }
);

/**
 * The fixer's verdict on the base alone, when no PR is supplied: a mechanical fix committed on its
 * `base` branch, which the daemon opens as a PR, or a handback, which halts the queue with an issue.
 */
export type BaseFix = { agent?: string; model?: string; effort?: string } & (
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
function validate(item: any, pr: boolean, known: KnownFlaky[] = []): void {
	const named = pr ? ["number"] : [];
	const fields =
		item.action === "fixed"
			? [...named, "action", "head", "reason"]
			: item.action === "requeue" && pr
				? [...named, "action", "reason"]
				: item.action === "handback"
					? [...named, "action", "diagnosis", "recommendation"]
					: [];
	const metadata = ["agent", "model", "effort"].filter((key) => key in item);
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
	if (pr && "failure" in item) {
		if (
			typeof item.failure !== "string" ||
			!signature(item.failure) ||
			item.failure.length > FAILURE_LIMIT ||
			/[\u0000-\u001f\u007f]/.test(item.failure)
		)
			throw new Error("invalid fixer failure");
		metadata.push("failure");
	}
	if (pr && "cause" in item) {
		if (item.action !== "requeue" || !CAUSES.includes(item.cause)) throw new Error("invalid fixer cause");
		metadata.push("cause");
	}
	if (pr && "quest" in item) {
		if (item.cause !== "flaky" || !known.some((test) => test.quest === item.quest))
			throw new Error("invalid fixer quest: not a known flaky test's");
		metadata.push("quest");
	}
	if (pr && item.cause === "flaky" && !("quest" in item) && !("failure" in item))
		throw new Error("a flaky requeue must name its test");
	if (pr && "disable" in item) {
		if (!("quest" in item) || typeof item.disable !== "string" || !/^[a-f0-9]{40}$/.test(item.disable))
			throw new Error("invalid fixer disable");
		metadata.push("disable");
	}
	// One optional Markdown comment per PR: multiline, but no other control characters.
	if (pr && "comment" in item) {
		if (
			typeof item.comment !== "string" ||
			!item.comment.trim() ||
			item.comment.length > COMMENT_LIMIT ||
			/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item.comment)
		)
			throw new Error("invalid fixer comment");
		metadata.push("comment");
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

/** Reject extra fields, duplicate/missing PRs, multiline reasons, oversized comments, and oversized output. */
export function parseFixResult(text: string, numbers: number[], known: KnownFlaky[]): FixResult[] {
	const value = json(text);
	if (!Array.isArray(value) || value.length !== numbers.length)
		throw new Error("fixer must return every PR exactly once");
	const seen = new Set<number>();
	for (const item of value) {
		if (!item || typeof item !== "object" || !numbers.includes(item.number) || seen.has(item.number))
			throw new Error("invalid or duplicate fixer PR");
		seen.add(item.number);
		validate(item, true, known);
		if ("failure" in item) item.failure = signature(item.failure);
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

/** Codex's reasoning efforts, for `model_reasoning_effort`. */
export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
/**
 * The variable a daemon sets for its fixer wrapper to pass on as `quest land fix --effort`, since the
 * wrapper's arguments are only the failure log and the PR numbers.
 */
export const EFFORT_VARIABLE = "QUEST_LAND_FIXER_EFFORT";

export async function fix(
	root: string,
	log: string,
	numbers: number[],
	agent = "codex",
	args?: string[],
	model?: string,
	effort = "medium",
): Promise<void> {
	if (!EFFORTS.includes(effort)) throw new Error(`fix effort must be one of ${EFFORTS.join(", ")}`);
	// No PR numbers fixes the base alone, which fails its check without any PR.
	if (
		numbers.some((number) => !Number.isSafeInteger(number) || number <= 0) ||
		new Set(numbers).size !== numbers.length
	)
		throw new Error("fix needs distinct positive PR numbers");
	if (!args && (!process.env.OPENAI_BASE_URL || !process.env.OPENAI_API_KEY))
		throw new Error("fix needs OPENAI_BASE_URL and OPENAI_API_KEY from the container wrapper");
	readFileSync(log); // Fail before starting an agent when the wrapper did not expose the log.
	const flaky = numbers.length ? knownFlaky(root) : [];
	// The daemon pinned each PR's head on its pr-<n> branch; name it so the agent need not look it up.
	const prs = numbers.map((number) => {
		const ref = `pr-${number}`;
		const head = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${ref}^{commit}`], {
			cwd: root,
			encoding: "utf8",
			env: discoveryEnv(),
		}).stdout.trim();
		if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error(`fix needs a ${ref} branch`);
		return `- #${number}: branch ${ref} at ${head}`;
	});
	// The agent runs in the PRs' checkout, so neither it nor its commands are found there: a name is
	// looked up in PATH's absolute directories, and a path is resolved here rather than in the checkout.
	const program = agent.includes("/") ? resolve(agent) : requireProgram(agent, process.env);
	rmSync(join(root, FIX_RESULT), { force: true });
	const env: NodeJS.ProcessEnv = {
		...programEnvironment({ PATH: process.env.PATH }),
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
		`model_reasoning_effort=${JSON.stringify(effort)}`,
		...(model ? ["--model", model] : []),
		"-",
	];
	// Codex names its model in the header it prints first, whether or not the command line does.
	let header = "";
	await new Promise<void>((done, reject) => {
		// Relay the agent's output through pipes of its own rather than letting it inherit ours. Once Bun writes
		// to a pipe it marks that pipe non-blocking, and an inheriting child shares the flag: Codex then panicked
		// (exit 101) with EAGAIN as soon as one command's output outran the host's reader.
		const child = spawn(program, argv, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
		child.stdout.pipe(process.stdout, { end: false });
		child.stderr.pipe(process.stderr, { end: false });
		child.stderr.on("data", (chunk: Buffer) => {
			if (header.length < 4096) header += chunk.toString("utf8");
		});
		child.once("error", reject);
		child.stdin.on("error", () => {});
		child.stdin.end(
			`${prompt}\n\nFailure log: ${JSON.stringify(log)}\nPRs:${prs.length ? `\n${prs.join("\n")}` : " none; the base fails alone"}\n${flaky.length ? `Known flaky tests: ${JSON.stringify(flaky)}\n` : ""}`,
		);
		child.once("close", (code) => (code === 0 ? done() : reject(new FixerAgentError(code ?? 1))));
	});
	const parse = (text: string) => (numbers.length ? parseFixResult(text, numbers, flaky) : parseBaseFix(text));
	const results = parse(readFixResult(root));
	const index = argv.findIndex((arg) => arg === "-m" || arg === "--model");
	const ranModel =
		(index >= 0 ? argv[index + 1] : argv.find((arg) => arg.startsWith("--model="))?.slice(8)) ??
		/^model: ([a-zA-Z0-9._/-]{1,100})$/m.exec(header)?.[1];
	const identity = {
		agent: basename(agent),
		model: ranModel ?? "unknown",
		// Replaced arguments may run the agent at any effort.
		effort: args ? "unknown" : effort,
	};
	const result = JSON.stringify(
		Array.isArray(results) ? results.map((item) => ({ ...item, ...identity })) : { ...results, ...identity },
	);
	parse(result);
	writeFileSync(join(root, FIX_RESULT), result);
}
