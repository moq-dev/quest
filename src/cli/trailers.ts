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
	// Git appends a marker trailer to the block it reads as trailers, or starts one. Old agent trailers
	// leave that block, folded lines included, since Git would replace only one of a key's repeats, and the
	// current ones take the marker's place, so no paragraph the block hid is ever read as trailers.
	const marker = `Quest-Block-${randomUUID()}: end`;
	const lines = interpret(
		// A `---` line in the message is prose, not the start of a patch.
		["--no-divider", "--trailer", marker],
		`${message.replace(/\r\n/g, "\n").trimEnd()}\n`,
	).split("\n");
	const end = lines.indexOf(marker);
	if (end < 0) throw new Error("git interpret-trailers did not place the trailer block's marker");
	let begin = end;
	while (begin > 0 && lines[begin - 1]!.trim()) begin--;
	const block: string[] = [];
	let dropping = false;
	for (const line of lines.slice(begin, end)) {
		dropping = OWN.test(line) || (dropping && /^[ \t]/.test(line));
		if (!dropping) block.push(line);
	}
	const own = [
		`Agent-Harness: ${field(by.harness)}`,
		`Agent-Model: ${field(by.model)}`,
		`Agent-Effort: ${field(by.effort)}`,
	];
	return [...lines.slice(0, begin), ...block, ...own, ...lines.slice(end + 1)].join("\n");
}
