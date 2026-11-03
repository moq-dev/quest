// `quest resolve`: the merge driver for quest files. Git merges by line, then
// the core resolves the conflicts that only edit a link list.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import { LABELS, chunks, render, resolveLists } from "../core";

/** Git's default conflict marker length. */
const MARKER_SIZE = 7;

/**
 * The command `merge.quest.driver` runs. Git substitutes its temporary file
 * names for `%A`, `%O`, and `%B` and runs it with a shell. A `quest` missing
 * from the merge's PATH, or one without `resolve`, falls back to git's own
 * merge with conflict markers: `quest help <unknown>` exits non-zero, while
 * `quest <unknown> --help` prints the top-level help and exits zero. A
 * fallback that leaves conflicts says why on stderr, naming the file (`%P`),
 * since those markers may be link-list edits `quest resolve` would have
 * merged. Git keeps a placeholder it does not know, such as printf's `%s`.
 */
export const DRIVER =
	"if quest help resolve >/dev/null 2>&1; " +
	"then quest resolve %A %O %B --marker-size=%L --ours-label=%X --base-label=%S --theirs-label=%Y; " +
	'quest_merge_status=$?; if [ "$quest_merge_status" -le 1 ]; then exit "$quest_merge_status"; fi; ' +
	"quest_merge_reason='quest resolve failed'; else quest_merge_reason='no quest resolve on PATH'; fi; " +
	"git merge-file --marker-size=%L -L %X -L %S -L %Y %A %O %B && exit 0; quest_merge_status=$?; " +
	"printf 'quest: %s, so link lists in %s were not auto-resolved\\n' \"$quest_merge_reason\" %P >&2; " +
	'exit "$quest_merge_status"';

export interface ResolveOptions {
	markerSize?: number;
	oursLabel?: string;
	baseLabel?: string;
	theirsLabel?: string;
}

/**
 * Merge `theirs` into `ours` from their common `base`, as `git merge-file`
 * does, writing the result to `ours`. Returns how many conflicts remain.
 */
export function resolveFile(ours: string, base: string, theirs: string, options: ResolveOptions = {}): number {
	const markerSize = options.markerSize ?? MARKER_SIZE;
	if (!Number.isSafeInteger(markerSize) || markerSize <= 0)
		throw new Error("marker size must be a positive safe integer");
	const labels = {
		ours: options.oursLabel ?? LABELS.ours,
		base: options.baseLabel ?? LABELS.base,
		theirs: options.theirsLabel ?? LABELS.theirs,
	};
	if (Object.values(labels).some((label) => /[\r\n]/.test(label)))
		throw new Error("conflict labels must be single lines");
	// Markers longer than any run of marker characters in the inputs cannot be mistaken for content.
	const texts = [ours, base, theirs].map((file) => readFileSync(file, "utf8"));
	const longest = Math.max(
		...texts.flatMap((text) => text.split("\n").map((line) => /^([<|=>])\1*/.exec(line)?.[0].length ?? 0)),
	);
	const size = Math.max(markerSize, longest + 1);

	const merged = spawnSync(
		"git",
		[
			"merge-file",
			"-p",
			"--diff3",
			`--marker-size=${size}`,
			"-L",
			labels.ours,
			"-L",
			labels.base,
			"-L",
			labels.theirs,
			ours,
			base,
			theirs,
		],
		{ encoding: "utf8", maxBuffer: 1 << 30 },
	);
	if (merged.error) throw merged.error;
	// git merge-file exits with the number of conflicts, capped at 127, or above that on failure.
	if (merged.status === null || merged.status > 127) {
		throw new Error(`git merge-file failed: ${merged.stderr.trim()}`);
	}

	const resolved = resolveLists(ours, chunks(merged.stdout, size, labels));
	writeFileSync(ours, render(resolved, markerSize, diff3(), labels));
	return resolved.filter((chunk) => !Array.isArray(chunk)).length;
}

/** Whether unresolved conflicts show the base too, as `merge.conflictStyle` says. */
function diff3(): boolean {
	const style = spawnSync("git", ["config", "--get", "merge.conflictStyle"], { encoding: "utf8" });
	return ["diff3", "zdiff3"].includes(style.stdout?.trim() ?? "");
}
