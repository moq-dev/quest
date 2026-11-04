// The harnesses, models, and efforts `quest` runs for each size, the same for
// every repository; a repository's AGENTS.md may override them in prose, which
// the session following it passes as flags. The model check
// (quest/m1/model-check.md) audits these lists each milestone.
import type { Size } from "../core";
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

/**
 * Each PR size's reviewers, ranked: the first whose model wrote none of the
 * code reviews it, so Opus reviews what Sol wrote. Sol's efforts are the
 * user's; Opus's are its review efforts from before the lists were ranked.
 */
export const REVIEWERS: Record<Size, readonly Model[]> = {
	XS: [sol("low"), opus("low")],
	S: [sol("medium"), opus("low")],
	M: [sol("high"), opus("medium")],
	L: [sol("xhigh"), opus("high")],
	XL: [sol("xhigh"), opus("high")],
};
