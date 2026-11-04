// The trailers that name the harness, model, and effort behind a commit, so audits can tell which of
// them made it. Agents add their own as `quest context` says; code that commits for an agent adds them here.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { discoveryEnv } from "./git";

/** The agent session that wrote a commit. */
export interface Implementer {
	harness: string;
	model: string;
	effort: string;
}

/** `value` when it fits on one trailer line, otherwise `unknown`. */
const field = (value: string) => (/^[\w.:/@+-]{1,100}$/.test(value) ? value : "unknown");

/** `git interpret-trailers` on `input`, outside any repository and with no user or system config, so no `trailer.*` setting reshapes it. */
function interpret(args: string[], input: string): string {
	const result = spawnSync("git", ["interpret-trailers", ...args], {
		cwd: "/",
		encoding: "utf8",
		env: { ...discoveryEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
		input,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`git interpret-trailers failed: ${result.stderr.trim()}`);
	return result.stdout;
}

const OWN = /^Agent-(?:Harness|Model|Effort)\s*:/i;

/**
 * `message` ending with `by`'s trailers, which replace every one its trailer block already gives, by Git's
 * own trailer rules so they join an existing block such as `Co-Authored-By`.
 */
export function withTrailers(message: string, by: Implementer): string {
	let text = `${message.replace(/\r\n/g, "\n").trimEnd()}\n`;
	// Git replaces only one of a key's repeats, so drop them all first, folded lines included, from the
	// block Git reads as trailers: a marker trailer Git appends to that block shows where it ends.
	const found = interpret(["--only-trailers", "--only-input", "--no-divider"], text);
	if (found.split("\n").some((line) => OWN.test(line))) {
		const marker = `Quest-Block-${randomUUID()}: end`;
		const lines = interpret(["--no-divider", "--trailer", marker], text).split("\n");
		const end = lines.indexOf(marker);
		let begin = end;
		while (begin > 0 && lines[begin - 1]!.trim()) begin--;
		const block: string[] = [];
		let dropping = false;
		for (const line of lines.slice(begin, end)) {
			dropping = OWN.test(line) || (dropping && /^[ \t]/.test(line));
			if (!dropping) block.push(line);
		}
		// An emptied block takes its separating blank line with it.
		const before = block.length ? lines.slice(0, begin) : lines.slice(0, Math.max(begin - 1, 0));
		text = [...before, ...block, ...lines.slice(end + 1)].join("\n");
	}
	return interpret(
		[
			// A `---` line in the message is prose, not the start of a patch.
			"--no-divider",
			"--trailer",
			`Agent-Harness: ${field(by.harness)}`,
			"--trailer",
			`Agent-Model: ${field(by.model)}`,
			"--trailer",
			`Agent-Effort: ${field(by.effort)}`,
		],
		text,
	);
}
