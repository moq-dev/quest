// The merge queue watcher's record of flaky tests: each flaky verdict the fixer gives, by the test it
// names, and the commit that disables a test seen flaking twice, which the watcher opens as a PR.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { git, tryGit } from "./land";
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
	/** How it ended: queued (`enqueued` or `armed`), or why it could not be. */
	done?: string;
}

/** A test the fixer judged flaky, by the `failure` it named. */
export interface FlakyTest {
	failure: string;
	/** Its follow-up quest, `quest/m0/flaky/<name>.md`, chosen at its first verdict for the skip to name. */
	quest?: string;
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
const EPIC = "quest/m0/flaky/README.md";
/** The longest follow-up quest name, cut at a word. */
const NAME_LIMIT = 60;
const BOT = {
	GIT_AUTHOR_NAME: "moq-bot",
	GIT_AUTHOR_EMAIL: "moq-bot@users.noreply.github.com",
	GIT_COMMITTER_NAME: "moq-bot",
	GIT_COMMITTER_EMAIL: "moq-bot@users.noreply.github.com",
};

/**
 * The follow-up quest's name for `failure`: its last segment after a `:` or `>`, the test itself, in
 * lowercase kebab-case.
 */
export function flakyName(failure: string): string {
	const segment =
		signature(failure)
			.split(/[:>]/)
			.map((part) => part.trim())
			.filter(Boolean)
			.pop() ?? "";
	let name = segment
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (name.length > NAME_LIMIT) {
		name = name.slice(0, NAME_LIMIT + 1);
		const cut = name.lastIndexOf("-");
		name = (cut > 0 ? name.slice(0, cut) : name.slice(0, NAME_LIMIT)).replace(/-+$/, "");
	}
	return name || "test";
}

/** A follow-up quest path for `failure` that neither another test nor the base at `base` holds. */
function questFor(root: string, base: string, tests: FlakyTest[], failure: string): string {
	const taken = new Set(tests.map((test) => test.quest ?? test.disable?.quest));
	const name = flakyName(failure);
	for (let index = 1; ; index++) {
		const path = `quest/m0/flaky/${index === 1 ? name : `${name}-${index}`}.md`;
		if (!taken.has(path) && tryGit(root, ["cat-file", "-e", `${base}:${path}`]).status !== 0) return path;
	}
}

/** GitHub's own job URLs, the only links a quest takes from the fixer's round. */
const GITHUB_URL = /^https:\/\/github\.com\/[^\s()<>[\]]+$/;

/** The follow-up quest a disable adds: a fixed template, sized `[S]` for a coordinator to correct. */
export function flakyQuest(failure: string, jobs: string[]): string {
	const name = failure.replace(/`/g, "").replace(/\s+/g, " ").trim();
	const links = [...new Set(jobs)]
		.filter((url) => GITHUB_URL.test(url))
		.map((url, index) => `- [Job ${index + 1}](${url})`);
	return `# [S] Fix the flaky test ${flakyName(failure)}

## Goal

Fix \`${name}\` so it passes reliably, or delete it, and remove its skip.
quest land watch disabled it after the land fixer judged it flaky in
more than one \`merge_group\` build.${links.length ? `\n\nFailing jobs:\n\n${links.join("\n")}` : ""}
`;
}

/** The flaky epic's README, written when the base keeps none. */
export const FLAKY_EPIC = `# Fix disabled flaky tests

## Goal

Each disabled flaky test is fixed or deleted, with its skip removed when
fixed. Each quest here records the failures that led to its skip.
`;

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
		if (test.quest === undefined) continue;
		const item = {
			failure: test.failure,
			quest: test.quest,
			jobs: test.verdicts.slice(-RECENT).flatMap((verdict) => verdict.jobs),
		};
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
	test.quest ??= questFor(root, round.base.sha, tests, round.failure);
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
				const quest = test.quest;
				const added = disabling(
					root,
					state,
					round,
					head,
					quest,
					flakyQuest(
						test.failure,
						test.verdicts.flatMap((verdict) => verdict.jobs),
					),
				);
				test.disable = { head: added, base: round.base, quest, attribution: round.attribution };
				output.push(`disable ${round.number} ${added}`);
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
 * leaving every protected path and the quest tree as the base has them. Then commit the follow-up
 * `quest` on top, with the flaky epic's README when the base keeps none. Returns that commit.
 */
function disabling(root: string, state: string, round: FlakyRound, head: string, quest: string, body: string): string {
	importFixer(root, state, round.checkout, "disable", head, round.packs);
	validateFix(root, { head: round.base.sha }, head, round.base.sha);
	const quests = git(root, ["diff", "--name-only", "--no-renames", round.base.sha, head, "--", "quest"]);
	if (quests) throw new Error("a disable must leave quest/ as the base has it; quest land watch adds its quest");
	if (tryGit(root, ["cat-file", "-e", `${head}:quest/m0/README.md`]).status !== 0)
		throw new Error("the base keeps no quest/m0/ for the follow-up quest");
	if (tryGit(root, ["cat-file", "-e", `${head}:${quest}`]).status === 0) throw new Error(`${quest} already exists`);
	const index = resolve(root, git(root, ["rev-parse", "--git-path", `quest-land-flaky-${process.pid}.index`]));
	const env = { GIT_INDEX_FILE: index };
	try {
		git(root, ["read-tree", head], { env });
		const add = (path: string, text: string) => {
			const blob = git(root, ["hash-object", "-w", "--stdin"], { input: text });
			git(root, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
		};
		add(quest, body);
		if (tryGit(root, ["cat-file", "-e", `${head}:${EPIC}`]).status !== 0) add(EPIC, FLAKY_EPIC);
		const tree = git(root, ["write-tree"], { env });
		return git(root, ["commit-tree", tree, "-p", head], {
			input: `quest: add ${quest} for the disabled flaky test\n\nquest land watch writes the follow-up quest for the test the land fixer skipped.\n`,
			env: { ...BOT },
		});
	} finally {
		rmSync(index, { force: true });
	}
}

/** The follow-up quest's name, as a disable's branch and title name it. */
export const questName = (quest: string) => QUEST.exec(quest)?.[1] ?? quest;
