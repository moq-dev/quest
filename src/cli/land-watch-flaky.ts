// The merge queue watcher's record of flaky tests: each flaky verdict the fixer gives, by the test it
// names, and the commit that disables a test seen flaking twice, which the watcher opens as a PR.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./land";
import { FLAKY_INPUT, type FixResult, type KnownFlaky, signature } from "./land-fix";
import { validateFix } from "./land-fixer";
import { importFixer } from "./land-fixer-repository";
import { save } from "./land-serve";

/** One round's flaky verdict on a test. */
export interface FlakyVerdict {
	/** The fixer job that gave it: collecting the same job again replaces its verdict rather than adding one. */
	job: string;
	number: number;
	/** When the queue dropped the PR. */
	at: string;
	/** The failing `merge_group` jobs, by URL. */
	jobs: string[];
}

/** The commit that disables a test, validated, and how far its PR has come. */
export interface Disable {
	head: string;
	/** The base the fixer committed it on. */
	base: { ref: string; sha: string };
	/** The follow-up quest it adds, `quest/m0/flaky/<name>.md`. */
	quest: string;
	/** Who wrote it, for the PR's attribution and its Review record. */
	attribution: string;
	/** Its PR, once opened. */
	number?: number;
	id?: string;
	/** Why it could not be queued, such as a hold, recorded before its comment, so a retry only comments. */
	refused?: string;
	/** How it ended: queued (`enqueued` or `armed`), or why it could not be. */
	done?: string;
}

/** A test the fixer judged flaky, by the `failure` it named. */
export interface FlakyTest {
	failure: string;
	verdicts: FlakyVerdict[];
	disable?: Disable;
}

/** The flaky verdicts that disable a test: one alone only re-enqueues, since it might hide a real bug. */
export const FLAKY_VERDICTS = 2;
/** The most recent verdicts of a test that a round's input or a disable's PR lists. */
export const RECENT = 10;
/**
 * The bytes of known flaky tests a round is told about, most recently seen first, well within the
 * 100 KB `quest land fix` reads.
 */
const KNOWN_BYTES = 50_000;
/** The follow-up quest a disable adds, one per test, in the repository's m0 `flaky` epic. */
const QUEST = /^quest\/m0\/flaky\/([a-z0-9][a-z0-9._-]*)\.md$/;

const flakyPath = (state: string) => join(state, "flaky.json");

/** The repository's flaky tests, in the order first seen. */
export function readFlaky(state: string): FlakyTest[] {
	const path = flakyPath(state);
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as FlakyTest[]) : [];
}

export function saveFlaky(state: string, tests: FlakyTest[]): void {
	save(flakyPath(state), tests);
}

/**
 * Tell a round's fixer, in its `checkout`'s `.git`, which tests flaked before and are not yet disabled,
 * by the signature it should reuse, so a second flake of one is recognized and disabled.
 */
export function writeKnownFlaky(state: string, checkout: string): void {
	const latest = (test: FlakyTest) => test.verdicts.reduce((at, verdict) => (verdict.at > at ? verdict.at : at), "");
	const known: KnownFlaky[] = [];
	let bytes = 2;
	for (const test of readFlaky(state)
		.filter((test) => test.disable === undefined && test.verdicts.length > 0)
		.sort((a, b) => latest(b).localeCompare(latest(a)))) {
		const item = { failure: test.failure, jobs: test.verdicts.slice(-RECENT).flatMap((verdict) => verdict.jobs) };
		bytes += Buffer.byteLength(JSON.stringify(item)) + 1;
		if (bytes > KNOWN_BYTES) break;
		known.push(item);
	}
	if (known.length) writeFileSync(join(checkout, ".git", FLAKY_INPUT), JSON.stringify(known), { mode: 0o600 });
}

/** A collected round that requeued a failed build unchanged, judging it flaky (`cause` is `flaky`). */
export interface FlakyRound {
	/** The fixer job's file name. */
	job: string;
	number: number;
	dropped: string;
	jobs: string[];
	base: { ref: string; sha: string };
	checkout: string;
	packs?: string[];
	failure: string;
	result: Extract<FixResult, { action: "requeue" }>;
	attribution: string;
}

/**
 * Record a flaky verdict on `round.failure`, and, once the test has `FLAKY_VERDICTS` of them, take the
 * round's disabling commit for its own PR: imported into the daemon's `root` and validated as a fix of
 * the base is, adding one follow-up quest. Returns what it did, if anything worth saying.
 */
export function recordFlaky(root: string, state: string, round: FlakyRound): string[] {
	const tests = readFlaky(state);
	let test = tests.find((item) => signature(item.failure) === signature(round.failure));
	if (!test) {
		test = { failure: round.failure, verdicts: [] };
		tests.push(test);
	}
	test.verdicts = [
		...test.verdicts.filter((verdict) => verdict.job !== round.job),
		{ job: round.job, number: round.number, at: round.dropped, jobs: round.jobs },
	];
	const output: string[] = [];
	const head = round.result.disable;
	if (head !== undefined && test.disable === undefined) {
		if (test.verdicts.length < FLAKY_VERDICTS) output.push(`disable ignored ${round.number}: first flaky verdict`);
		else
			try {
				const quest = disabling(root, state, round, head);
				test.disable = { head, base: round.base, quest, attribution: round.attribution };
				output.push(`disable ${round.number} ${head}`);
			} catch (error) {
				// A later flake of the same test tries again.
				output.push(`disable refused ${round.number}: ${String(error)}`);
			}
	}
	saveFlaky(state, tests);
	return output;
}

/**
 * Import the fixer's `disable` branch at `head` and check it: new commits on the base it was given,
 * leaving every protected path as the base has it, that add exactly one follow-up quest. Returns its path.
 */
function disabling(root: string, state: string, round: FlakyRound, head: string): string {
	importFixer(root, state, round.checkout, "disable", head, round.packs);
	validateFix(root, { head: round.base.sha }, head, round.base.sha);
	const added = git(root, ["diff", "--name-only", "--no-renames", "--diff-filter=A", round.base.sha, head, "--"])
		.split("\n")
		.filter((path) => QUEST.test(path) && path !== "quest/m0/flaky/README.md");
	if (added.length !== 1) throw new Error("a disable must add exactly one follow-up quest in quest/m0/flaky/");
	return added[0];
}

/** The follow-up quest's name, as a disable's branch and title name it. */
export const questName = (quest: string) => QUEST.exec(quest)?.[1] ?? quest;
