// The harnesses, models, and efforts `quest` runs for each size, the same for
// every repository; a repository's AGENTS.md may override them in prose, which
// the session following it passes as flags. The model check
// (quest/m1/model-check.md) audits these lists each milestone.
import { createHash } from "node:crypto";
import { type Doc, SIZES, type Size, onMaintainer, size, waits } from "../core";
import type { HarnessName } from "./agent";

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
const sonnet = (effort: string): Model => ({ harness: "claude", model: "claude-sonnet-5-5", effort });
const fable = (effort: string): Model => ({ harness: "claude", model: "claude-fable-5-2", effort });

/**
 * Each size's writers, ranked: a spawn starts the quest on the first that can
 * run, falling through only while nothing is written, since the model that
 * writes a PR runs all its iterates. XS runs Sonnet rather than the cheaper
 * Haiku, whose surcharge past 100k input tokens leads users to cap its
 * compaction window there, barely above an agent's fixed load of prompt,
 * context, and skill. No size runs Opus at low, which misses too much. XL
 * stays on Opus rather than Fable, which a subscription caps at half its
 * weekly limit and which uses that limit faster.
 */
export const WRITERS: Record<Size, readonly Model[]> = {
	XS: [sonnet("high"), sol("low")],
	S: [opus("medium"), sol("medium")],
	M: [opus("medium"), sol("high")],
	L: [opus("high"), sol("xhigh")],
	XL: [opus("xhigh")],
};

/**
 * Each PR size's reviewers, ranked: the first whose model is not the latest
 * writer's reviews it, so Claude reviews what Sol changed last.
 */
export const REVIEWERS: Record<Size, readonly Model[]> = {
	XS: [sol("medium"), opus("low")],
	S: [sol("medium"), opus("low")],
	M: [sol("high"), opus("medium")],
	L: [sol("xhigh"), opus("high")],
	XL: [sol("xhigh"), opus("xhigh")],
};

/** One side of the writer A/B: A runs the size's own first writer, B the alternative. */
export type Arm = "A" | "B";
export const ARM_NAMES: readonly Arm[] = ["A", "B"];

/**
 * The writer A/B: each armed size's quests split between its first writer
 * and an alternative where published results disagree, until the readout in
 * quest/m0/routing-evidence/README.md deletes it. L runs no arm.
 */
export const ARMS: Partial<Record<Size, Record<Arm, Model>>> = {
	XS: { A: sonnet("high"), B: opus("medium") },
	S: { A: opus("medium"), B: sonnet("high") },
	M: { A: opus("medium"), B: opus("high") },
	XL: { A: opus("xhigh"), B: fable("medium") },
};

/** The size quest `doc` is written at: its own, or the next while a `Maintainer:` wait leaves it a decision to settle. */
function writeSize(doc: Doc): Size {
	const sized = size(doc);
	// `quest check` requires a size of every quest that is not an epic, and only those can be ready.
	if (sized === null) throw new Error(`${doc.path} has no size`);
	const bump = waits(doc).some(onMaintainer) ? 1 : 0;
	return SIZES[Math.min(SIZES.indexOf(sized) + bump, SIZES.length - 1)]!;
}

/**
 * The writers that start quest `doc`, ranked, and its arm when its size runs
 * one: the arm's entry, then the size's list without it. The arm hashes the
 * quest's path, so a restart or respawn draws the same one.
 */
export function questWriters(doc: Doc): { arm: Arm | null; models: readonly Model[] } {
	const at = writeSize(doc);
	const arms = ARMS[at];
	if (!arms) return { arm: null, models: WRITERS[at] };
	const arm = ARM_NAMES[createHash("sha256").update(doc.path).digest()[0]! & 1]!;
	const entry = arms[arm];
	const same = (e: Model) => e.model === entry.model && e.effort === entry.effort;
	return { arm, models: [entry, ...WRITERS[at].filter((e) => !same(e))] };
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
