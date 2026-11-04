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

/**
 * `message` ending with `by`'s trailers, replacing any it already gives, by Git's own trailer rules so
 * they join an existing block such as `Co-Authored-By`.
 */
export function withTrailers(message: string, by: Implementer): string {
	const result = spawnSync(
		"git",
		[
			"interpret-trailers",
			// A `---` line in the message is prose, not the start of a patch.
			"--no-divider",
			"--if-exists",
			"replace",
			"--trailer",
			`Agent-Harness: ${field(by.harness)}`,
			"--trailer",
			`Agent-Model: ${field(by.model)}`,
			"--trailer",
			`Agent-Effort: ${field(by.effort)}`,
		],
		{
			// Outside any repository, with no user or system config, so no `trailer.*` setting reshapes them.
			cwd: "/",
			encoding: "utf8",
			env: { ...discoveryEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
			input: message,
		},
	);
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`git interpret-trailers failed: ${result.stderr.trim()}`);
	return result.stdout;
}
