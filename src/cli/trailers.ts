// The trailers that name the harness, model, and effort behind a commit, so audits can tell which of
// them made it. Agents add their own as `quest context` says; code that commits for an agent adds them here.
import { spawnSync } from "node:child_process";

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
	const paragraphs = message
		.replace(/\r\n/g, "\n")
		.trimEnd()
		.split(/\n[ \t]*\n/);
	// Git replaces only the last of a key's repeats, so drop them all first, but only from the block Git
	// reads as trailers: the last paragraph that is not all comments, when Git finds trailers there.
	let block = paragraphs.length - 1;
	while (block > 0 && paragraphs[block]!.split("\n").every((line) => line.startsWith("#"))) block--;
	const found = interpret(["--only-trailers", "--only-input", "--no-divider"], `${paragraphs.join("\n\n")}\n`);
	if (block > 0 && found.split("\n").some((line) => OWN.test(line))) {
		const kept = paragraphs[block]!.split("\n").filter((line) => !OWN.test(line));
		if (kept.length) paragraphs[block] = kept.join("\n");
		else paragraphs.splice(block, 1);
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
		`${paragraphs.join("\n\n")}\n`,
	);
}
