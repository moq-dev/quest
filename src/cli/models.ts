// The harnesses, models, and efforts `quest` runs for each size, the same for
// every repository; a repository's AGENTS.md may override them in prose, which
// the session following it passes as flags. The model check
// (quest/m1/model-check.md) audits these lists each milestone.
import { type Doc, SIZES, type Size, onMaintainer, size, waits } from "../core";
import type { HarnessName } from "./agent";
import type { Reviewing } from "./review";

/** One harness running one model at one effort. */
export interface Model {
	harness: HarnessName;
	model: string;
	effort: string;
}

/** The size of a PR with neither a quest nor `--size`. */
export const DEFAULT_SIZE: Size = "M";

const sol = (effort: string): Model => ({ harness: "codex", model: "gpt-6.1-sol", effort });
const opus = (effort: string): Model => ({ harness: "claude", model: "claude-opus-5-5", effort });
const haiku = (effort: string): Model => ({ harness: "claude", model: "claude-haiku-5-5", effort });

/**
 * Each size's writers, ranked: a spawn starts the quest on the first that can
 * run, falling through only while nothing is written, since the model that
 * writes a PR runs all its iterates. XS runs Haiku at xhigh, which scores about
 * as Opus low does for a third of its subscription cost per task.
 */
export const WRITERS: Record<Size, readonly Model[]> = {
	XS: [haiku("xhigh"), sol("low")],
	S: [opus("low"), sol("medium")],
	M: [opus("medium"), sol("high")],
	L: [opus("high"), sol("xhigh")],
	XL: [opus("xhigh")],
};

/**
 * Each PR size's reviewers, ranked: the first whose model is not the latest
 * writer's reviews it, so Claude reviews what Sol changed last, while
 * `SECOND_REVIEWER` reviews the same head beside it.
 */
export const REVIEWERS: Record<Size, readonly Model[]> = {
	XS: [sol("low"), opus("low")],
	S: [sol("medium"), opus("low")],
	M: [sol("medium"), opus("medium")],
	L: [sol("high"), opus("high")],
	XL: [sol("xhigh"), opus("xhigh")],
};

/**
 * The second reviewer of every PR, beside its size's: DeepSeek through opencode, a model family no writer
 * runs, for every size, since a review costs it about $0.05.
 */
export const SECOND_REVIEWER: Reviewing = {
	harness: "opencode",
	model: "opencode-go/deepseek-v4.1-flash",
	effort: "high",
};

/**
 * The writers that start quest `doc`: its size's list, or the next size's
 * while a `Maintainer:` wait leaves it a decision to settle.
 */
export function questWriters(doc: Doc): readonly Model[] {
	const sized = size(doc);
	// `quest check` requires a size of every quest that is not an epic, and only those can be ready.
	if (sized === null) throw new Error(`${doc.path} has no size`);
	const bump = waits(doc).some(onMaintainer) ? 1 : 0;
	return WRITERS[SIZES[Math.min(SIZES.indexOf(sized) + bump, SIZES.length - 1)]];
}

/**
 * The entry that runs `model` on work of `size`: its own in that size's list,
 * else its entry at the nearest size that lists it, the larger on a tie, or
 * null when no list names it.
 */
export function writerAt(size: Size, model: string): Model | null {
	const at = SIZES.indexOf(size);
	const listed = SIZES.flatMap((each, index) => {
		const entry = WRITERS[each].find((e) => e.model === model);
		return entry ? [{ entry, distance: Math.abs(index - at), index }] : [];
	});
	listed.sort((a, b) => a.distance - b.distance || b.index - a.index);
	return listed[0]?.entry ?? null;
}
