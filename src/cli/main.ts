// The `quest` command line: argument parsing and output around the core.

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";

import { Argument, Command, CommanderError, InvalidArgumentError, Option } from "commander";

import { description } from "../../package.json";
import {
	type Doc,
	type RankedQuest,
	blockers,
	check,
	formatFinding,
	hosts,
	label,
	lookup,
	questBranch,
	renderBlocker,
	SIZES,
	type Size,
	unblocked,
	onMaintainer,
	waiting,
} from "../core";
import {
	AgentInputError,
	HARNESSES,
	type HarnessName,
	type Launch,
	admitAgent,
	processDependencies,
	runAgent,
	stopAgent,
	stopAll,
} from "./agent";
import { held, openDrafts, reach, target, upstream, upstreamRefs } from "./claims";
import { PENDING_MS } from "./admission";
import { gate, QUICK_MS } from "./gate";
import { gitHubDependencies, GitHubInputError, pullRequest, readRemote, remoteRepository } from "./github";
import { mergedHolds } from "../github/client";
import { type Hold, finish, land, release, take } from "./hold";
import { LAND_CHECK } from "../github/land";
import { apply, pushCommand } from "./land-apply";
import { EFFORT_VARIABLE, EFFORTS, fix, FixerAgentError } from "./land-fix";
import { watch, type WatchOptions } from "./land-watch";
import { landed, landingCheck } from "./landed";
import { type Report, fixHeadings, fixLinks, moveQuest, removeQuest } from "./move";
import { type ResolveOptions, resolveFile } from "./resolve";
import { DEFAULT_SIZE, REVIEWERS, WRITERS, questWriters, writerAt } from "./models";
import {
	ReviewInputError,
	ReviewLimitError,
	processDependencies as reviewDependencies,
	review,
	nextStep,
	roundLines,
} from "./review";
import { type Recorded, pullModels, recordRounds } from "./review-record";
import {
	BASH_MAX_TIMEOUT_MS,
	CLAUDE_HOOKS,
	CODEX_HOOKS,
	type HookEntry,
	WORKTREE_HOOKS,
	hook,
	setup,
	targets,
} from "./hooks";
import { CHECKED_CONTEXT, USER_ASKED, questRoot } from "./rules";
import { messageLines, messages } from "./messages";
import { heal, init, stubFindings, uninstall } from "./setup";
import { Refusal, describe, notUpstream, releaseQuest, startQuest } from "./start";
import { CONTEXT, GUIDE, GUIDE_SECTIONS, SKILLS, guideSections, sectionHeading, skill } from "./skills";
import { type Terminal, Theme } from "./theme";
import { type Snapshot, checkout, collect, load, snapshot, under } from "./tree";
import { statusLines } from "./status";
import { pullRequestStatus } from "../github/status";
import { TOKEN_MAX_MISSING, daysBefore, usage, usageDependencies, usageLines } from "./usage";
import { waitForActivity, WaitTimeout } from "./wait";
import { version } from "./version";
import { Worktrees } from "./worktree";
import { HOOK_EVENTS, claudeHook } from "./worktree-hook";

/** Where the command writes; the process streams, or a buffer under test. */
export interface Output {
	stdout(text: string): void;
	stderr(text: string): void;
	/** Set when stdout is a terminal, which gets themed output. Piped output is plain. */
	terminal?: Terminal;
}

/** A failure the user caused rather than the command, reported as a usage error. */
class UsageError extends Error {}

/** Run the CLI with `argv` (arguments only, no executable). Returns the exit code. */
export function main(argv: string[], out: Output): number | Promise<number> {
	let pending: Promise<number> | undefined;
	let code = 0;
	// Block bodies: process.stdout.write returns a boolean, which settle would take for the exit code.
	const print = (line: string): void => {
		out.stdout(`${line}\n`);
	};
	const warn = (line: string): void => {
		out.stderr(`quest: ${line}\n`);
	};
	const theme = out.terminal ? new Theme(out.terminal) : null;

	const program = new Command("quest")
		.description(description)
		.version(`quest ${version}`, "-V, --version", "Print version")
		.helpOption("-h, --help", "Print help")
		.helpCommand("help [command]", "Print this message or the help of the given subcommand")
		.addOption(
			new Option("--root <root>", "Repository root holding the quest/ directory")
				.default(".")
				.argParser(nonEmpty),
		)
		.configureOutput({ writeOut: out.stdout, writeErr: out.stderr })
		.configureHelp({ showGlobalOptions: true })
		.addHelpText(
			"after",
			"\nOn a terminal, output is themed as a quest log; set NO_COLOR to drop the colours.\n" +
				"Piped output is plain text for scripts and agents.",
		)
		.exitOverride();
	const root = () => program.opts<{ root: string }>().root;

	program
		.command("gate")
		.summary("Run an expensive command once the host has room for it")
		.description(
			"Wait while the 1-minute load average exceeds the host's CPU count or available memory is below " +
				"min(4 GiB, RAM/4). Each admission in the last minute counts as one more unit of load and one " +
				"budget less memory: commands start at once while those still fit, and 5 seconds apart while " +
				"only the raw measures do. The load limit applies only while a gated command still runs. Where a " +
				"systemd scope owns each running command, the load counts as at least the sum of their peak CPU " +
				"use in the last minute, and nothing starts while those fill every CPU, so a lull between a " +
				"command's phases does not free its CPUs. Leave model calls, such as quest review, and long-running " +
				"servers out of the gate. Nested gate " +
				"calls run immediately. Limits come from the host; there is " +
				"no configuration.\n\n" +
				`--quick waits at most ${QUICK_MS / 1000} seconds, then starts the command anyway; pass it only for ` +
				"cheap commands such as formatters. With QUEST_GATE_PRIORITY=1 in the environment, as a check " +
				"that lands PRs should set, the command waits for memory but never for load, and gets " +
				"MBX_SCHEDULER_PRIORITY=normal unless it sets its own.\n\n" +
				"Once the command exits, or is cancelled and exits, its remaining descendants are killed; a second " +
				"signal kills them all at once. Linux with a systemd 254+ user manager owns every descendant through " +
				"a systemd user scope, inside a Quest scope one bound to it. macOS, and Linux " +
				"without one, own the command's process group in a new session without a controlling terminal, so a " +
				"descendant that leaves the group or session escapes. Windows owns every descendant through a " +
				"kill-on-close Job Object. Exits with the command's status, or 128 plus the signal's number once " +
				"cancelled.\n\n" +
				"With QUEST_GATE_RECORD naming an absolute path, an outermost gate on Linux or macOS appends one JSON " +
				"line per run to that file, however the run ends: its command, directory, when it started and was " +
				"admitted, its systemd scope, whose journal holds its CPU time and peak memory, and its exit status. " +
				"A file it cannot write fails the gate.",
		)
		.option("--quick", `Start a cheap command after at most ${QUICK_MS / 1000} seconds of waiting`)
		.argument("<command>", "Executable to run")
		.argument("[args...]", "Arguments forwarded verbatim")
		.action((command: string, args: string[], options: { quick?: boolean }) => {
			pending = gate([command, ...args], options).catch((error: unknown) => {
				warn(error instanceof Error ? error.message : String(error));
				return 1;
			});
		});

	program
		.command("check")
		.summary("Report every structural mistake in the tree; exit non-zero if any")
		.description(
			"Report every structural mistake in the tree; exit non-zero if any.\n\n" +
				"A link into a submodule that is not checked out resolves at the commit its gitlink pins, read from " +
				"a local git directory that holds it, such as the main worktree's; with none, its links are skipped " +
				"with a note.\n\n" +
				"With --base, also check that a PR from a quest's branch leaves that quest accurate. When the branch " +
				"is a quest's path without .md (an epic's is quest/<path>/README) and that quest exists at the merge " +
				"base with <ref>, the working tree must delete or edit it; a PR that finishes the quest deletes it, and " +
				"one that leaves work rewrites it to what remains. Any other branch adds no finding. Fetch <ref> " +
				"first: a stale base can predate the quest and skip it.\n\n" +
				"A repository's own check also compares its skill stubs with the skills this binary carries, and " +
				"reports a missing, outdated, or retired one. --no-stubs skips that, for a binary built from a base " +
				"that checks a PR whose stubs follow the PR's own skills.\n\n" +
				"With --fix, first drop every Required, Related, or Closes entry that links to a quest deleted in " +
				"the history of HEAD, and of MERGE_HEAD during a merge, that the working tree lacks, as quest rm " +
				"does, such as the quests a merged base finished, and every epic's Required entry naming a quest in " +
				"its own directory, which the epic already waits for, with any heading left empty. It then promotes a " +
				"section heading written below ## to ## where nothing but its own content follows it before the next " +
				"## heading, and no ## section of that name exists. It prints M for each edited document and leaves " +
				"the edits unstaged. A quest moved rather than deleted, a link that never " +
				"named a quest, and a link in prose stay for the check to report. Refuses outside a git work tree " +
				"and while a quest file has unresolved conflicts.",
		)
		.option("--base <ref>", "Also check the quest branch's diff from its merge base with this ref")
		.option("--branch <name>", "The PR's head branch, when it differs from the current branch (needs --base)")
		.option("--no-stubs", "Skip the comparison of the repository's skill stubs with this binary's skills")
		.option(
			"--fix",
			"First drop list links to quests the history deleted and epics' links to their own quests, and promote misleveled section headings",
		)
		.action((options: { base?: string; branch?: string; fix?: boolean; stubs: boolean }) => {
			if (options.branch !== undefined && options.base === undefined) {
				throw new UsageError("--branch requires --base");
			}
			if (options.fix) {
				// fixLinks checks the repair preconditions before anything is written; it runs again
				// after promotion, since a promoted `Required` can hold links it then drops.
				const edited = new Set([...fixLinks(root()), ...fixHeadings(root()), ...fixLinks(root())]);
				for (const line of [...edited].sort()) print(line);
			}
			const tree = checkout(root(), warn);
			const findings = check(tree.docs, tree.exists);
			if (options.base !== undefined) findings.push(...landed(root(), options.base, { branch: options.branch }));
			// A tree nested in another checkout, such as an example, has no stubs of its own.
			const stubs = options.stubs && questRoot(resolve(root())) === resolve(root()) ? stubFindings(root()) : [];
			if (findings.length === 0 && stubs.length === 0) {
				const count = collect(root()).length;
				print(theme ? theme.checked(count) : `quest: ${count} documents ok`);
				return;
			}
			for (const finding of findings) warn(formatFinding(finding));
			for (const stub of stubs) warn(stub);
			code = 1;
		});

	/** The local calendar date as `## Scheduled` writes it, `YYYY-MM-DD`. */
	const today = () => {
		const now = new Date();
		const pad = (n: number) => String(n).padStart(2, "0");
		return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	};

	/** The quest document `path` names, as the tree writes it, as the shell completes it, or as a filesystem path. */
	const locate = (docs: Doc[], path: string): Doc | null => {
		const inside = withinRoot(root(), path);
		return lookup(docs, path) ?? (inside === null ? null : lookup(docs, inside));
	};

	/** Like `locate`, failing when `path` names no quest. */
	const find = (docs: Doc[], path: string): Doc => {
		const doc = locate(docs, path);
		if (doc === null) throw new Error(`${path} is not a quest document under ${under(root(), "quest")}`);
		return doc;
	};

	/** Whether the tree passes `quest check`; otherwise report its findings and fail. */
	const valid = ({ docs, exists }: Snapshot): boolean => {
		const findings = check(docs, exists);
		for (const finding of findings) warn(formatFinding(finding));
		if (findings.length > 0) code = 1;
		return findings.length === 0;
	};

	/** Print what blocks `doc`: the themed log on a terminal, else the blocker list with advice on stderr. */
	const explain = (docs: Doc[], doc: Doc, path: string) => {
		const found = blockers(docs, doc, today());
		if (theme) {
			// The themed log already names every blocker; stderr keeps only the advice.
			for (const line of theme.blockers(new Map(docs.map((d) => [d.path, d])), doc, found)) print(line);
		} else {
			for (const blocker of found) {
				for (const line of renderBlocker(blocker)) print(line);
				warn(`blocked by ${label(blocker)}`);
			}
		}
		if (found.length > 0) {
			// Blocked is not a verdict on the whole plan: the piece of it that
			// does not need the blocker is split into its own quest.
			warn(
				`${path} is blocked; split any independently landable piece into its own quest (\`quest guide\`, Creation) rather than starting this one as it stands`,
			);
		}
	};

	/** A claim command's outcome: 0 when done, 3 when refused, and 1 for any other failure. */
	const settle = <T>(work: Promise<T>, done: (result: T) => number | void) => {
		pending = work.then(
			(result) => done(result) ?? 0,
			(error: unknown) => {
				warn(error instanceof Error ? error.message : String(error));
				return error instanceof FixerAgentError ? error.exitCode : error instanceof Refusal ? 3 : 1;
			},
		);
	};

	program
		.command("unblocked")
		.summary("Rank ready quests, or print what blocks one quest")
		.description(
			"Rank ready quests by milestone priority, distinct transitive dependents, then path order. " +
				"Given a path, print what blocks that quest instead.\n\n" +
				"A quest is ready only when neither it nor any epic above it, milestones included, has a ## Required " +
				"section or a ## Scheduled date after today's local date. Counts exclude structural epic membership " +
				"but include the quests an epic's ## Required holds back. Other prerequisites may remain for dependents. " +
				"Invalid trees fail before printing a ranking. Prints a count and path per line; --json prints an " +
				"ordered array of {path, dependents, hosts, models} objects, where hosts lists the operating systems " +
				"(linux, macos, windows) under the quest's ## Hosts, empty when it runs anywhere, and models ranks the {harness, model, effort} " +
				"entries that write the quest: its size's list, or the next size's while a Maintainer: item under its " +
				"## Waiting leaves a decision open (quest models lists them).\n\n" +
				"--unclaimed ranks the fetched upstream default branch's tree instead of the checkout, then drops " +
				"quests someone holds: a quest branch upstream, or an open PR from that branch in any repository. A " +
				"branch whose tip is a merged PR's head holds nothing; a closed, unmerged PR's branch still does. A " +
				"GitHub remote's upstream is its repository, or the furthest parent up its fork chain reached " +
				"through parents whose default branch has quest/README.md, so a fork with its own quests is its own " +
				"upstream. The branches and PRs of the fork the remote pushes to count too. Each skipped quest is listed on stderr with its PR and how long ago that PR was last " +
				"active, so a stale claim can be offered for takeover. Off GitHub, only branches are checked. " +
				"Outside conditions are never checked.\n\n" +
				"Given a path, piped output lists its blockers, one per line with nesting indented, with an " +
				"explanation on stderr; no output means it is ready. On a terminal it prints a quest log instead: a " +
				"yellow ! for a ready quest, a grey ! for a blocked one, and each size label in its colour. Set " +
				"NO_COLOR to drop the colours. Exits 0 whether or not the quest is blocked; non-zero means the " +
				"command failed.",
		)
		.argument("[path]", "Quest to explain instead of ranking every ready quest")
		.option("--json", "Print a deterministic JSON array")
		.option("--limit <count>", "Maximum number of ready quests to print", positiveInteger("limit"))
		.option("--unclaimed", "Skip quests with a claim branch or open PR, listing them on stderr")
		.option("--remote <name>", "Remote whose upstream holds the claims", "origin")
		.action(
			(
				path: string | undefined,
				options: { json?: boolean; limit?: number; unclaimed?: boolean; remote: string },
			) => {
				if (path !== undefined) {
					if (options.json || options.limit !== undefined || options.unclaimed) {
						throw new UsageError("--json, --limit, and --unclaimed apply to the ranking; omit the path");
					}
					const docs = load(root());
					explain(docs, find(docs, path), path);
					return;
				}
				const show = (quests: RankedQuest[], docs: Doc[]) => {
					const shown = quests.slice(0, options.limit);
					if (options.json) {
						const byPath = new Map(docs.map((doc) => [doc.path, doc]));
						print(
							JSON.stringify(
								shown.map((quest) => {
									const doc = byPath.get(quest.path)!;
									return { ...quest, hosts: hosts(doc), models: questWriters(doc) };
								}),
							),
						);
						return;
					}
					if (theme)
						print("Ready quests by milestone and downstream impact (other prerequisites may remain):");
					for (const quest of shown) print(`${quest.dependents}\t${quest.path}`);
				};
				if (!options.unclaimed) {
					const tree = checkout(root(), warn);
					if (valid(tree)) show(unblocked(tree.docs, today()), tree.docs);
					return;
				}
				// Readiness comes from the upstream default branch, so a stale checkout cannot offer
				// a deleted quest or one whose prerequisite has since finished.
				const deps = { github: () => gitHubDependencies(warn), warn };
				settle(
					(async () => {
						const up = await reach(root(), options.remote, deps);
						const refs = up === null ? null : upstreamRefs(root(), up.git);
						const tree = refs === null ? checkout(root(), warn) : snapshot(root(), refs.base, warn);
						if (!valid(tree)) return null;
						const ranked = unblocked(tree.docs, today());
						const branches = ranked.map((quest) => questBranch(quest.path));
						const holdings = up === null ? [] : (await held(root(), up, branches, refs?.branches)).claims;
						return { ranked, holdings, docs: tree.docs };
					})(),
					(result) => {
						if (result === null) return 1;
						const byBranch = new Map(result.holdings.map((claim) => [claim.branch, claim]));
						const now = Date.now();
						for (const quest of result.ranked) {
							const claim = byBranch.get(questBranch(quest.path));
							if (claim)
								warn(`skipped ${quest.path}: held by ${describe(claim.branch, claim.pull, now)}`);
						}
						show(
							result.ranked.filter((quest) => !byBranch.has(questBranch(quest.path))),
							result.docs,
						);
					},
				);
			},
		);

	program
		.command("waiting")
		.summary("List quests and draft PRs waiting on the maintainer or an outside party")
		.description(
			"List every quest with a ## Waiting section and every open draft PR handed back with one: those " +
				"waiting on the maintainer first, then milestone priority, distinct " +
				"transitive dependents as quest unblocked counts them, ready before blocked, then path order, with " +
				"drafts after quests by PR number. A draft ranks as the quest its branch carries, or last when it " +
				"carries none. Each item opens with who acts, Maintainer: or an outside party such as moq-dev/moq:, " +
				"followed by the condition and how to check or advance it. A draft's item without a party is the " +
				"maintainer's; a draft's section without items is one maintainer item " +
				"holding its prose.\n\n" +
				"Prints one line per item: dependents, ready or blocked (whether Required entries or a future " +
				"Scheduled date remain), the quest's path or the draft's URL, and the item. --json prints an ordered array of {path, pr, dependents, " +
				"ready, waits: [{line, party, text}]} objects, where pr is the draft's URL or null and path is the " +
				"quest, the quest a draft carries, or null. --maintainer keeps only the items the maintainer settles. " +
				"Invalid trees fail before printing. Outside conditions are never checked, nor whether another " +
				"session holds a draft.\n\n" +
				"Drafts are read from the open PRs of the remote's upstream, found as for quest unblocked " +
				"--unclaimed, using GH_TOKEN, GITHUB_TOKEN, or gh auth token. Without the remote, off GitHub, or " +
				"when GitHub cannot be read, it lists the quest tree's items alone and warns that drafts were skipped.",
		)
		.option("--json", "Print a deterministic JSON array")
		.option("--maintainer", "Only items waiting on the maintainer")
		.option("--limit <count>", "Maximum number of entries to print", positiveInteger("limit"))
		.option("--remote <name>", "Remote whose upstream holds the draft PRs", "origin")
		.action((options: { json?: boolean; maintainer?: boolean; limit?: number; remote: string }) => {
			const tree = checkout(root(), warn);
			if (!valid(tree)) return;
			settle(openDrafts(root(), options.remote, { github: () => gitHubDependencies(warn), warn }), (drafts) => {
				const found = waiting(tree.docs, today(), drafts)
					.map((quest) =>
						options.maintainer ? { ...quest, waits: quest.waits.filter(onMaintainer) } : quest,
					)
					.filter((quest) => quest.waits.length > 0)
					.slice(0, options.limit);
				if (options.json) {
					print(JSON.stringify(found));
					return;
				}
				if (theme)
					print("Quests and drafts waiting, the maintainer's first, by milestone and downstream impact:");
				for (const quest of found) {
					for (const wait of quest.waits) {
						print(
							`${quest.dependents}\t${quest.ready ? "ready" : "blocked"}\t${quest.pr ?? quest.path}\t${wait.party}: ${wait.text}`,
						);
					}
				}
			});
		});

	program
		.command("start")
		.summary("Claim a ready quest with a draft PR, or release that claim")
		.description(
			"Claim a ready quest: push an empty claim commit, built on the upstream default branch, to the quest's " +
				"branch (its path without .md), then open a draft PR from it right away. Switches the " +
				"checkout to the claim on a new local branch, or fast-forwards that branch when it is checked out, " +
				"and prints the PR URL, or the branch off GitHub. A local branch left from an earlier attempt is not " +
				"moved: the claim still succeeds, with a warning to switch to it and merge the claim commit.\n\n" +
				"Readiness comes from the fetched upstream default branch's tree, not the checkout. Fails on a tree " +
				"quest check rejects, which can hide a blocker. Refuses a blocked quest, one missing from the " +
				"upstream default branch, and one already held: a branch upstream or an open PR from that branch in " +
				"any repository. A branch whose tip is a merged PR's head holds nothing, and the claim replaces it " +
				"with a lease on that tip. A rejected push means someone else pushed the branch first. A branch named after the claim " +
				"branch's directory, or inside it, refuses the claim too, since git cannot hold both; the refusal names it " +
				"and whether it is a merged PR's head, and leaves it in place. When two PRs " +
				"race, as from forks, the earliest open PR keeps the claim; a later one is closed and its branch " +
				"deleted.\n\n" +
				"The remote's upstream holds claims: on GitHub, the furthest parent up its fork chain reached through " +
				"parents whose default branch has quest/README.md, or the remote's repository when its parent has " +
				"none, so a fork with its own quests claims on itself. A fork of that upstream pushes the branch to " +
				"itself and opens the PR on the upstream, and so does a remote that fetches from upstream but pushes " +
				"to a fork. A failed lookup of a parent's README is an error. Off GitHub, only the branch is pushed, " +
				"with a warning.\n\n" +
				"--release deletes the quest's branch on the remote, with a lease on its tip, and closes its PR, only " +
				"while that tip is still an empty commit.\n\n" +
				"Uses GH_TOKEN, GITHUB_TOKEN, or gh auth token on GitHub. Exits 0 when done, 3 when refused " +
				"(blocked, held, a branch in the way, or work on the branch), 2 for invalid arguments, and 1 for other " +
				"failures.",
		)
		.argument("<quest>", "Quest to claim, as /quest/..., quest/..., or a filesystem path")
		.option("--release", "Release the claim instead: delete the empty claim branch and close its PR")
		.option("--remote <name>", "Remote to push the claim to", "origin")
		.action((path: string, options: { release?: boolean; remote: string }) => {
			const deps = { github: () => gitHubDependencies(warn), warn };
			if (options.release) {
				settle(releaseQuest(root(), find(load(root()), path).path, options.remote, deps), (released) => {
					print(`deleted ${released.branch}`);
					for (const url of released.closed) print(`closed ${url}`);
				});
				return;
			}
			settle(
				(async () => {
					// Readiness comes from the upstream default branch the claim builds on, not the checkout.
					const at = await target(root(), options.remote, deps);
					const doc = locate(at.tree.docs, path);
					if (doc === null) throw notUpstream(find(load(root()), path).path);
					// A malformed tree can hide a blocker, as a misspelled `## Required` does.
					if (!valid(at.tree)) return 1;
					if (blockers(at.tree.docs, doc, today()).length > 0) {
						explain(at.tree.docs, doc, path);
						return 3;
					}
					return startQuest(root(), at, doc.path, doc.title?.text ?? doc.path, deps);
				})(),
				(started) => {
					if (typeof started === "number") return started;
					print(started.url ?? started.branch);
				},
			);
		});

	program
		.command("wait")
		.summary("Wait for pull request activity on GitHub")
		.description(
			"Wait for a review, comment or comment edit, review-thread reply, reaction to the PR or a review, push, merge, close, " +
				"merge-queue removal, disabled auto-merge or auto-merge left on a moved head, label change, or CI result. Polls every 5 minutes, and once more 30 seconds before the timeout; rate limits and longer GitHub poll intervals delay requests. No timeout by default.\n\n" +
				"Prints one plain line per event: timestamp (or commit SHA), type, actor, URL; the last line adds a resume cursor. " +
				"Reactions print as reacted:<content>, such as reacted:thumbs_up, and label changes as labeled:<name> or unlabeled:<name>. " +
				"The head's first failing required check prints as checks:failed, and every required check passing as checks:passed, " +
				"each once per head, with the required check's name as the actor and its details URL. " +
				"Results count as quest status counts them, so neutral and skipped results pass. " +
				"checks:passed waits until no check is pending, no finished job's GitHub Actions run is still going, no run read to replace a cancelled check is unfinished, and every check and workflow the base branch names is present, then names the last required check that passed. " +
				"Optional failures print separately as check:failed; a base branch requiring no checks requires them all. " +
				"When auto-merge stays enabled on a head other than the current one, which GitHub allows across a writer's push, " +
				"auto-merge:moved prints once per head, with the account that enabled it as the actor and a URL naming the head it " +
				"was enabled on, which it reads as quest status does. " +
				"Pass the final field of the last line to --since to resume without replaying events. " +
				"On timeout, the only line is a resume point for --since (a cursor, or the given --since or head SHA if setup did not finish), so a retry with it still reports activity from the first wait.\n\n" +
				"Uses GH_TOKEN, GITHUB_TOKEN, or gh auth token. Label changes, replies, and reactions by that account are ignored. " +
				"Exits 0 for activity, 3 on timeout, 2 for invalid arguments, and 1 for other failures. " +
				"Issue-comment edits print as edited, including updates to older bot status comments. The account's own edits are ignored.",
		)
		.argument("<pr>", "GitHub PR URL, or a PR number in origin")
		.option("--since <point>", "ISO timestamp, branch-tip SHA, or resume cursor (default: current head push time)")
		.option("--timeout <seconds>", "Maximum wait in seconds", positiveSeconds)
		.action((value: string, options: { since?: string; timeout?: number }) => {
			const pr = pullRequest(value, root());
			pending = waitForActivity(pr, options, gitHubDependencies(warn)).then(
				(lines) => {
					for (const line of lines) print(line);
					return 0;
				},
				(error: unknown) => {
					if (error instanceof WaitTimeout && error.cursor) print(error.cursor);
					warn(error instanceof Error ? error.message : String(error));
					return error instanceof WaitTimeout ? 3 : error instanceof GitHubInputError ? 2 : 1;
				},
			);
		});

	program
		.command("status")
		.summary("Print a pull request's current state on GitHub")
		.description(
			"Print a pull request's head, checks, merge state, reviews, reactions, and unresolved review threads " +
				"in one call. It reports facts; it does not decide whether the PR is ready or whose review counts.\n\n" +
				"Plain output prints one record per line, its type first and any free text (a check name or path) last: " +
				"url, state, draft, head, mergeable, merge-state, review-decision, review-record, auto-merge, merge-queue, " +
				"landing-stopped, and checks, whose state and counts follow the checks that count, pending while an open PR's base requires a check or workflow nothing reports; review-record gives whether the PR body's ## Review record " +
				"covers the head, as current, diff-identical (git diff <base>...<head> prints the same as for the head it names), " +
				"stale, or unknown when GitHub cannot compare them, then the head it names last; auto-merge gives its method, who enabled it and when, and the head it was " +
				"enabled on, which differs from head once a push follows, as GitHub keeps auto-merge across a writer's " +
				"push (- when it cannot be told: a quest land pin names it, and otherwise the head branch's push " +
				"activity, which GitHub lists up to minutes late); landing-stopped is the latest exit from the merge queue, auto-merge, or " +
				"quest land's queue, with the reason (such as merge_conflict, failed_checks, manual, or manually_disabled), " +
				"actor, and time, until the PR enters the merge queue or auto-merge again. Then " +
				"a check line per failing or pending check, marked required or optional, counting only each check's latest run (by name, app, and workflow file) " +
				"and dropping a cancelled check once a newer GitHub Actions run of its workflow exists on the head (reading the head's " +
				"workflow runs, which needs Actions read access); a required check or workflow nothing reports prints as pending required " +
				"expected, with its name, followed by (from app <id>) when the requirement names an app, or the workflow's repository and path, as owner/name:path; a review line per " +
				"reviewer's latest review, marked current or stale against the head; a checkpoint line per bot " +
				"reviewer that approves or requests changes, its round, and its review, when that review is of the " +
				"head, while its latest verdict on the head is neither an approval nor a dismissal, and ends its third, sixth, ... round (one commit it reviewed), as " +
				"/quest-review's design checkpoint; a reacted:<content> line per " +
				"reaction on the PR or a review; a thread line per unresolved review thread, led by its node ID; and a " +
				"signal line per finding or decision that holds the head from landing (see the README). " +
				"A missing value prints as -. --json prints the same facts as one deterministic object.\n\n" +
				"Uses GH_TOKEN, GITHUB_TOKEN, or gh auth token. Exits 0 for any PR state, 2 for invalid arguments, " +
				"and 1 for other failures.",
		)
		.argument("<pr>", "GitHub PR URL, or a PR number in origin")
		.option("--json", "Print a deterministic JSON object")
		.action((value: string, options: { json?: boolean }) => {
			const pr = pullRequest(value, root());
			pending = pullRequestStatus(pr, gitHubDependencies(warn)).then(
				(status) => {
					if (options.json) print(JSON.stringify(status));
					else for (const line of statusLines(status)) print(line);
					return 0;
				},
				(error: unknown) => {
					warn(error instanceof Error ? error.message : String(error));
					return 1;
				},
			);
		});

	const OWNERSHIP =
		"Before a session pushes to an existing PR, it takes the PR with iterate, and hands it back with " +
		"release. A taken PR carries the quest:active label; iterate prints a hold token, the ID of the timeline " +
		"event that added it, since sessions often share an account. A command refuses while a quest:active " +
		"label it holds no token for is on the PR, and while the PR is merged, closed, or a draft its starter still " +
		"holds (one whose body has no Waiting heading). A refusal names the holder's label and age, never its " +
		"token; status shows the token, and releasing a stale hold with it is the user's choice. Given a token, a command refuses " +
		"unless the token is still the latest add of its label. When two sessions add the label at once, the " +
		"first added keeps the PR; GitHub records no event when a label already on the PR is added again, so two " +
		"takes within the same moment are not told apart.\n\n" +
		"Uses GH_TOKEN, GITHUB_TOKEN, or gh auth token. Exits 0 when done, 3 when refused, 2 for invalid " +
		"arguments, and 1 for other failures.";
	const printToken = (work: Promise<Hold>) => settle(work, (hold) => print(hold.token));

	program
		.command("iterate")
		.summary("Take a PR to work on it, such as to settle its decisions, fix CI and review findings, and push")
		.description(
			"Take a PR to work on it, such as to settle its decisions, fix CI and review findings, and push. " +
				`Given the token of a hold this session already has, it keeps that hold.\n\n${OWNERSHIP}`,
		)
		.argument("<pr>", "GitHub PR URL, or a PR number in origin")
		.argument("[token]", "Hold token this session already has")
		.action((value: string, token: string | undefined) => {
			printToken(take(pullRequest(value, root()), token, gitHubDependencies(warn)));
		});

	program
		.command("ready")
		.summary("Hand a PR this session holds to reviewers")
		.description(
			"Hand a PR this session holds to reviewers: remove the body's Waiting section and mark a " +
				`draft ready for review. The hold stays; it prints the token again.\n\n${OWNERSHIP}`,
		)
		.argument("<pr>", "GitHub PR URL, or a PR number in origin")
		.argument("<token>", "Hold token printed by iterate")
		.action((value: string, token: string) => {
			printToken(finish(pullRequest(value, root()), token, gitHubDependencies(warn)));
		});

	program
		.command("merge")
		.summary("Land a PR's reviewed head")
		.description(
			"Land a PR's reviewed head: enable auto-merge bound to the full head SHA --land names, or merge at " +
				"once when nothing is left to wait for. It takes no label: the auto-merge or merge-queue entry it " +
				"creates is the queue signal. It refuses while a session holds the PR, so release your own hold " +
				"first, once the head has moved, and while the latest run of any check on the head failed, required " +
				"or not, naming each; a pending or absent check does not block. While the base requires an approval the PR " +
				"lacks (GitHub's review decision is review_required or changes_requested), it only arms auto-merge, which waits " +
				"for it, and refuses where nothing would wait, since an admin's token merges or enqueues past the requirement. It refuses a head on which quest check " +
				"--no-stubs --base <base> --branch <head branch> finds anything, read from git objects fetched from the base repository, " +
				"so nothing from the head runs, except findings the base already has; a base without quests skips it. It also refuses while an online reviewer's " +
				"unanswered finding on the head, or a newer comment opening with 'Maintainer decision', holds it. It uses the method --squash or --rebase names, refusing one " +
				"the repository disallows; otherwise the only method the repository allows, or else a merge commit. " +
				"On a base with GitHub's merge queue, which applies its own method, it enqueues that head, or arms " +
				"auto-merge bound to it while required checks may be pending; a head behind the base is enqueued as " +
				"is, and a head GitHub refuses to enqueue fails, to be fixed and landed again. On a base " +
				`that requires the \`${LAND_CHECK}\` check, it queues the PR for \`quest land\` instead: auto-merge ` +
				"whose commit body pins the head, with the method named, else squash, else any method the " +
				"repository and the base's rulesets allow, as only a queue signal, since quest land applies its own " +
				"method. On an ungated base with auto-merge disabled, it refuses " +
				"unless --direct is passed, which merges at once without waiting for pending checks. Follow the repository landing instructions in CONTRIBUTING.md or " +
				"AGENTS.md; never retry with --direct unless the user asks. GitHub keeps auto-merge across a " +
				"writer's push, so disable it before pushing to the PR; quest status and quest wait report a head " +
				"that moved since auto-merge was enabled.\n\n" +
				OWNERSHIP,
		)
		.argument("<pr>", "GitHub PR URL, or a PR number in origin")
		.requiredOption("--land <sha>", "Land this full 40-character head SHA")
		.addOption(new Option("--squash", "Squash and merge").conflicts("rebase"))
		.option("--rebase", "Rebase and merge")
		.option("--direct", "Merge at once when repository auto-merge is disabled; wait for checks to pass first")
		.action((value: string, options: { land: string; squash?: boolean; rebase?: boolean; direct?: boolean }) => {
			const pr = pullRequest(value, root());
			if (!/^[\da-f]{40}$/i.test(options.land)) throw new UsageError("--land needs a full 40-character SHA");
			const method = options.squash ? "squash" : options.rebase ? "rebase" : undefined;
			settle(
				land(
					pr,
					{ sha: options.land, method, direct: options.direct, check: landingCheck(root()) },
					gitHubDependencies(warn),
				),
				() => undefined,
			);
		});

	const landCommand = program.command("land").summary("Land queued PRs through a host daemon");
	landCommand
		.command("fix")
		.description(
			"Run a mechanical agent fix inside the credential-free fixer container; write quest-land-result.json, whose optional comments the daemon posts. Model endpoint and client key: OPENAI_BASE_URL and OPENAI_API_KEY.",
		)
		.argument("<log>", "Full failure log exposed by the wrapper")
		.argument("<prs...>", "PR numbers with pr-<n> branches")
		.option("--agent <executable>", "Agent executable", "codex")
		.option("--model <id>", "Agent model recorded in the result (passed to default Codex)")
		.option(
			"--agent-arg <argument>",
			"Replace default codex exec arguments (repeatable)",
			(value: string, previous: string[]) => [...previous, value],
			[] as string[],
		)
		.addOption(
			new Option(
				"--effort <level>",
				`Default Codex's model_reasoning_effort (default: $${EFFORT_VARIABLE}, or medium)`,
			).choices(EFFORTS),
		)
		.action(
			(
				log: string,
				prs: string[],
				options: { agent: string; agentArg: string[]; model?: string; effort?: string },
			) => {
				settle(
					fix(
						root(),
						log,
						prs.map(Number),
						options.agent,
						options.agentArg.length ? options.agentArg : undefined,
						options.model,
						options.effort ?? (process.env[EFFORT_VARIABLE] || "medium"),
					),
					() => print("fixer result written"),
				);
			},
		);
	landCommand
		.command("apply")
		.description(
			"Rebuild the commit a quest land fixer handed back unpushed: GitHub refused its push, such as a merge of a " +
				"base that changed .github/workflows, which the App lacks the permission to push, or it edits protected " +
				"paths, which only a maintainer's push lands. Reads the latest " +
				"resolution an App posted on the PR and refuses (exit 3) when the PR's head is no longer the one it " +
				"resolved. Fetches that head and base, recomputes the merge's conflicted result as the daemon did, " +
				"applies the fixer's patch, and checks the resolved tree before committing with your identity. Prints the commit and the push command; " +
				"nothing is pushed and the working tree is untouched.",
		)
		.argument("<pr>", "GitHub PR URL, or a PR number in origin")
		.action((value: string) => {
			settle(apply(root(), pullRequest(value, root()), gitHubDependencies(warn)), (applied) => {
				print(applied.commit);
				print(`review it, then push: ${pushCommand(applied)}`);
			});
		});
	landCommand
		.command("watch")
		.description(
			"Watch the base's queue as a daemon, one per base branch of a repository, resolved once at startup from --base or the default branch: GitHub's merge queue where the base's rules have a merge_queue rule, otherwise the watcher's own serial queue, decided again each pass from GET /rules/branches/<base>, so enabling GitHub's queue switches the watcher with no host change; a pass that cannot read the rules does nothing. On GitHub's queue, once a minute, read the base's open PRs and the merge queue's removals since the last pass, and comment once on each PR the queue dropped unmerged, naming GitHub's reason and, for a failed `merge_group` build, the failing jobs and their logs' tails. A failed build or a conflict is recorded for the land fixer; a push since the removal, a person's removal, or an unknown reason ends the pick. A PR whose auto-merge was armed, by a writer or by the watcher, that is ready (its required checks passed and it does not conflict) but that GitHub never added to the queue is enqueued at the head auto-merge was armed on, never at a head pushed since. A pick is the latest enqueue by anyone, the App included (as for Dependabot's PRs), except the App's enqueues of heads the watcher itself put back in the queue for the pick. A queued or armed PR whose head draws a signal, an online reviewer's unanswered finding or a newer maintainer decision, is taken out of the queue and its auto-merge disarmed, with a comment; the own queue ejects it, and the fixer hands it back rather than re-enqueue it, counting those on the head its fix replaced. " +
				`The own queue, for a base that requires the unreported \`${LAND_CHECK}\` check so GitHub never merges a pick itself, reads its picks from GitHub: PRs whose auto-merge \`quest merge --land\` armed pinned to their head, in arming order, ejecting with a comment each one that cannot land, such as a moved head, requested changes, or unresolved conversations. It tests one at a time: it merges the base into the pick with the quest merge driver, pushes that to quest-queue/<base>/<number>, which the repository's queue workflow builds on push, and waits for the base's required checks other than \`${LAND_CHECK}\` on it, at most --timeout minutes. A pass lands a passing pick with --method, only while the base is still the one it tested; a moved base rebuilds it. It lease-pushes the tested merge to the PR's head and lands it with GitHub's merge API pinned to that head, verifying the landed tree is the tested one, or, when the PR's branch refuses the push, fast-forwards the base to the tested commit and closes the PR with a comment linking it. A failed or timed-out build, or a conflict, disarms the PR's auto-merge and comments with the failing jobs, as GitHub's queue removes a PR, and is recorded for the land fixer; a re-enqueue arms auto-merge again, at the back. A writer's push, a person disarming auto-merge, or a hold ends the build. Each pick carries an informational \`quest queue\` check run with its position, the build in progress and its run, and the outcome. Queue branches go once their pick lands or leaves, and those an earlier process left are pruned on its first pass. ` +
				"With --fixer, a conflict is first merged with the base by the quest merge driver; otherwise the fixer runs in the background on the failure, at most --fixer-jobs at once, oldest removal first. A fixed or merged head is lease-pushed and recorded in Review, and each fixed, merged, or flaky head is re-enqueued at the back of the queue (or armed with auto-merge while its checks run). The pick keeps going while each round makes progress: a round with no new commit for a failure that isn't flaky, the failure a fix addressed recurring right after it, or three flaky rounds in a row hand it back, as does the fixer, with a comment. State keeps each removal handled, so a restart neither misses nor repeats one, each removal's full log, the fixer's jobs, each pick's rounds, and the own queue's build. It holds a lock on its checkout's repository and base and one on its state directory, so two watchers never run beside each other on one base, while daemons on different bases run side by side, each with its own clone. On GitHub's queue the App needs `actions: read` for the logs, `merge_queues: write` to enqueue, and with a fixer `contents: write` to arm auto-merge and push, and `workflows: write` to push fixes that touch workflows. The own queue's App needs `contents: write`, `pull_requests: write`, `actions: write` to read logs and cancel builds, `checks: write`, `administration: read`, `workflows: write` for heads that touch workflows, and a bypass of the base's ruleset.",
		)
		.option("--base <branch>", "Base branch (default: repository default)")
		.addOption(
			new Option("--method <method>", "On the own queue, land each PR as a squash commit or a merge commit")
				.choices(["squash", "merge"])
				.default("squash"),
		)
		.option(
			"--timeout <minutes>",
			"On the own queue, drop a build still running after this long",
			positiveInteger("timeout"),
			60,
		)
		.option(
			"--state <path>",
			"Private daemon state directory (default: <owner>-<repo>@<base> under $STATE_DIRECTORY or the XDG state home)",
		)
		.requiredOption("--app-id <id>", "GitHub App id")
		.option(
			"--fixer <command>",
			"Credential-free fixer wrapper executable, called with the failure log and the PR number (60 minutes from its admission line, 120 in total)",
		)
		.option("--fixer-jobs <count>", "Most fixer jobs to run at once", positiveInteger("fixer-jobs"), 2)
		.addOption(
			new Option(
				"--fixer-effort <level>",
				`The fixer's model_reasoning_effort, passed to the wrapper in $${EFFORT_VARIABLE}`,
			)
				.choices(EFFORTS)
				.default("medium"),
		)
		.option(
			"--fixer-tag <pattern>",
			"Fetch the tags matching this pattern (repeatable), such as `deploy-*`, from GitHub into each fixer checkout, so checks that read them, such as which commit is deployed, run there as in the queue's build",
			refPattern("tag", "deploy-*", 1),
			[] as string[],
		)
		.option(
			"--fixer-branch <pattern>",
			"Fetch the branches matching this pattern (repeatable), such as `release`, from GitHub into each fixer checkout as `origin/<branch>`, so checks that diff against them run there as in the queue's build; the base is always there as `origin/<base>`",
			refPattern("branch", "release"),
			[] as string[],
		)
		.option(
			"--refuse-forks",
			"On the own queue, eject each pick whose head is in a fork, or in a deleted repository, before pushing its build, so a fork's code never reaches a private queue runner",
		)
		.option(
			"--bump",
			"Keep this repository's flake input, in every other repository the App is installed on whose flake.lock locks this repository through exactly one root input, at this repository's base: each pass opens or updates that repository's quest-bump PR as the App and lands it",
		)
		.action((options: WatchOptions) => {
			const origin = readRemote(root(), "origin");
			const repository = origin && remoteRepository(origin).repository;
			if (!repository) throw new Error("origin must name a github.com repository");
			pending = watch(root(), repository, options, warn).then(
				() => 0,
				(error: unknown) => {
					warn(error instanceof Error ? error.message : String(error));
					return 1;
				},
			);
		});

	program
		.command("release")
		.summary("Hand back a PR by removing the label a hold token holds")
		.description(
			"Hand back a PR by removing the quest:* label a hold token holds. Refuses when the token is not the " +
				"latest add of that label, since another session holds it now. A label already off the PR counts as " +
				"released, with a warning. Unlike the other PR state commands, it works on a merged or closed PR.\n\n" +
				OWNERSHIP,
		)
		.argument("<pr>", "GitHub PR URL, or a PR number in origin")
		.argument("<token>", "Hold token printed when the label was taken")
		.action((value: string, token: string) => {
			settle(release(pullRequest(value, root()), token, gitHubDependencies(warn)), (label) =>
				print(`released ${label}`),
			);
		});

	const worktree = program
		.command("worktree")
		.description(
			"Reserve disk for Git checkouts, release it by pruning their scratch in place, and remove finished ones",
		);
	const state = () => new Worktrees();
	const record = (value: unknown) => print(JSON.stringify(value));
	const settled = (result: Promise<unknown>) => {
		pending = result.then(
			(value) => {
				record(value);
				return 0;
			},
			(error: unknown) => {
				warn(error instanceof Error ? error.message : String(error));
				return 1;
			},
		);
	};
	worktree
		.command("capacity <bytes>")
		.description("Set this user's shared disk budget in bytes; until set, only free disk space limits checkouts")
		.action((bytes: string) => {
			state().configure(positiveInteger("bytes")(bytes));
		});
	worktree
		.command("status")
		.description("Print the capacity, allocated bytes, and checkouts as JSON")
		.action(() => record(state().status()));
	worktree
		.command("create <name>")
		.description("Create an exclusively owned detached Git worktree under .worktrees/")
		.requiredOption("--reserve <bytes>", "Checkout and expected build growth in bytes", positiveInteger("bytes"))
		.option("--ref <ref>", "Initial Git revision", "HEAD")
		.option(
			"--scratch <path...>",
			"Ignored paths release deletes, such as dependencies and build output; they must hold no tracked files",
			[],
		)
		.action((name: string, options: { reserve: number; ref: string; scratch: string[] }) =>
			settled(state().create(root(), name, options.reserve, options.ref, options.scratch)),
		);
	worktree
		.command("run")
		.summary("Run a command in a checkout, then release it once every process stops")
		.description(
			"Run a command in the checkout, restoring it first when released, without the repository-location " +
				"variables, such as GIT_DIR, that a Git hook exports. The command and its descendants " +
				"run in a new systemd user scope; once the command exits, descendants still in the scope " +
				"are killed. A `quest gate` inside it runs its command in a scope of its own, bound to this one. " +
				"When no other supervised run remains, the scratch declared at creation is pruned. Put the whole job, " +
				"such as an agent session or a script that installs, builds, and tests, in one run.\n\n" +
				"A supervisor that crashes leaves its run recorded; the next worktree command drops it once its scope " +
				"is empty, and releases the checkout; `quest worktree stop` ends what it left. Needs Linux 5.14+ with a systemd 254+ user manager and unified cgroup " +
				"v2, and fails on other hosts. Exits with the command's status; a release that fails is reported, leaves " +
				"the checkout reserved, and turns success into exit 1.",
		)
		.argument("<id>", "Checkout ID or name")
		.argument("<command>", "Executable to run; put -- before it when any argument starts with -")
		.argument("[args...]", "Arguments forwarded verbatim")
		.action((id: string, command: string, args: string[]) => {
			pending = state()
				.run(id, [command, ...args])
				.then(
					({ code, failure }) => {
						if (!failure) return code;
						warn(failure);
						return code || 1;
					},
					(error: unknown) => {
						warn(error instanceof Error ? error.message : String(error));
						return 1;
					},
				);
		});
	worktree
		.command("release <id>")
		.description(
			"Delete the scratch declared at creation and keep the checkout; refuses while supervised runs are live, " +
				"and drops the record of a removed checkout",
		)
		.action((id: string) => record(state().release(id)));

	// Only a commit no local ref reaches asks the forge, so other removals need no token.
	const merged = async (repository: string, commit: string) => {
		const origin = readRemote(repository, "origin");
		if (origin === null) return false; // No forge to ask.
		const up = await upstream(repository, origin, { github: () => gitHubDependencies(warn), warn });
		return up.github !== null && mergedHolds(up.github.client, up.github.repository, commit);
	};
	worktree
		.command("remove <id>")
		.description(
			"Delete a finished checkout and drop its record after recursive safety checks. Refuses while supervised runs are live, " +
				"and refuses modified or untracked files, an ignored path holding a nested repository or worktree, and commits no branch " +
				"or remote-tracking ref reaches, unless the GitHub upstream that holds origin's claims merged a PR whose head is " +
				"that commit or descends from it. Every other ignored path, declared as scratch or not, is deleted with the checkout. Submodules must have no changed files and no commits their remote refs do not reach, including in deinitialized module stores, and module stores must have no linked worktrees of their own.",
		)
		.action((id: string) => settled(state().remove(id, merged)));
	worktree
		.command("stop <id>")
		.description(
			"Kill the processes crashed supervisors left in the checkout's scopes and wait until they are gone, then " +
				"release the checkout once no run remains. Runs whose supervisor is alive are left to it and reported " +
				"as a failure.",
		)
		.action((id: string) => settled(state().stop(id)));
	worktree
		.command("restore <id>")
		.description("Reserve a released checkout's disk again before rebuilding its scratch")
		.action((id: string) => record(state().restore(id)));
	worktree
		.command("hook")
		.summary("Handle a Claude Code worktree, subagent, or session hook event read on stdin")
		.description(
			"Handle the Claude Code hook event whose JSON input arrives on stdin, for " +
				HOOK_EVENTS.join(", ") +
				". `quest setup --worktrees` installs it for those events.\n\n" +
				"WorktreeCreate checks out the remote's default branch as last fetched (origin/HEAD), as Claude does by " +
				"default, or the session's commit without one, as a quest worktree under the main checkout's .worktrees/, " +
				"initializes its submodules recursively, and prints its path. A name pr-<number>, which Claude gives the worktree for --worktree '#<number>' or a " +
				"pull request's URL, checks out that request's head from origin instead, when origin has one. Its scratch is the main checkout's top-level ignored entries, except " +
				".worktrees/, .claude/, and entries holding a nested repository; its reserve is the main checkout's disk " +
				"usage without .git and those checkouts, plus its submodule stores. An existing checkout of that name in the repository is " +
				"restored instead. WorktreeRemove removes the checkout as `remove` does, so Claude keeps one holding " +
				"unpreserved work. SubagentStop releases the subagent's own checkout, named agent-<agent_id> by Claude, " +
				"or a workflow agent's, named for its run and bound to the first subagent that starts in it, " +
				"when it finishes or stops to wait, keeping its .tmp/ workspace for the parent to read until removal, and SubagentStart restores it. " +
				"Every other checkout WorktreeCreate makes is a session's: SessionEnd releases it the same way once no session that " +
				"created it or started in it is left, except when /clear starts another in its place, and SessionStart restores it. " +
				"Other checkouts are left alone. " +
				"Exits 1 on failure, never 2, which would keep a subagent running.",
		)
		.action(() => {
			pending = (async () =>
				claudeHook(
					JSON.parse(readFileSync(0, "utf8")),
					state(),
					merged,
					program.getOptionValueSource("root") === "cli" ? root() : process.env.CLAUDE_PROJECT_DIR,
				))().then(
				(output) => {
					if (output) out.stdout(output);
					return 0;
				},
				(error: unknown) => {
					warn(error instanceof Error ? error.message : String(error));
					return 1;
				},
			);
		});

	const agent = program
		.command("agent")
		// Options come before <worktree>, so a prompt or answer starting with "-" is never read as one.
		.enablePositionalOptions()
		.summary("Start, resume, and stop headless agents on the logged-in account")
		.description(
			"Run one headless agent turn per call in the foreground, on the agent CLI's own login, so a spawn " +
				"starts any harness's agent with one legible command.\n\n" +
				"Codex requires a registered Quest checkout and Linux worktree supervision; these are checked before any agent state is written. " +
				"It uses the quest worktree run lifecycle: restore before each turn and release declared scratch after exit. Claude runs directly in the given checkout.\n\n" +
				"The agent CLI runs from its absolute path on PATH, never from the worktree; on native Windows " +
				"a batch shim such as npm's claude.cmd runs through System32's cmd.exe, and stop ends the agent's process tree at once.\n\n" +
				"The agent runs in <worktree> with the user's environment minus every CLAUDE* (except CLAUDE_CONFIG_DIR), " +
				"ANTHROPIC*, CODEX_* (except CODEX_HOME), OP_*, OPENAI_API_KEY, QUEST_GATE_ADMITTED, QUEST_GATE_PRIORITY, " +
				"and MBX_SCHEDULER_PRIORITY when QUEST_GATE_PRIORITY=1, so it uses the CLI's stored login rather than the coordinating session's.\n\n" +
				"Start and resume first wait until the host can carry the agent, as agent admit describes, " +
				"before claiming the worktree.\n\n" +
				"Prints `session <id>` as soon as the id is known, then `outcome finished|failed|limited|logged-out|stopped`, " +
				"a blank line, and the agent's final reply. Exits 0 when the agent finished, 3 when its account hit a " +
				"usage limit or ran out of credit, 4 when the CLI is logged out (after printing its login command), 2 for " +
				"invalid arguments, 128 plus the signal number when interrupted, and 1 otherwise.",
		);
	const launchOptions = (command: Command) =>
		command
			.addOption(new Option("--harness <name>", "Agent CLI to run").choices(HARNESSES).makeOptionMandatory())
			.requiredOption("--model <model>", "Model the agent runs")
			.requiredOption("--effort <level>", "Reasoning effort the agent runs at, never max", effortLevel)
			.requiredOption(
				"--permission-mode <mode>",
				"Claude Code's --permission-mode, or Codex's sandbox mode; the agent cannot prompt",
			);
	type LaunchOptions = Omit<Launch, "worktree">;
	const launch = (worktree: string, prompt: string, session: string | undefined, options: LaunchOptions) => {
		pending = runAgent({ ...options, worktree }, prompt, session, agentDependencies()).catch(agentFailure);
	};
	const agentDependencies = () => processDependencies({ stdout: out.stdout, stderr: out.stderr });
	const agentFailure = (error: unknown) => {
		if (error instanceof AgentInputError) {
			out.stderr(`error: ${error.message}\n`);
			return 2;
		}
		warn(error instanceof Error ? error.message : String(error));
		return 1;
	};
	launchOptions(
		agent
			.command("start")
			.description("Start a new agent session in a worktree with a prompt")
			.argument("<worktree>", "Checkout the agent works in")
			.argument("<prompt>", "The agent's instructions")
			.passThroughOptions(),
	).action((worktree: string, prompt: string, options: LaunchOptions) =>
		launch(worktree, prompt, undefined, options),
	);
	launchOptions(
		agent
			.command("resume")
			.description("Resume an agent's session in its worktree with a message")
			.argument("<worktree>", "Checkout the session ran in")
			.argument("<session>", "Session id printed by start")
			.argument("<message>", "The next message, such as an answer to its decisions")
			.passThroughOptions(),
	).action((worktree: string, session: string, message: string, options: LaunchOptions) =>
		launch(worktree, message, session, options),
	);
	agent
		.command("admit")
		.summary("Wait until the host can carry one more agent")
		.description(
			"Wait until this host can carry one more agent, for a coordinator to run before it starts or resumes " +
				"an agent of its own, such as a sub-agent; start and resume do the same themselves. The host has room " +
				"while quest gate would admit a command at once, counting every queued command and, as one recent " +
				`admission each, every agent admitted in the last ${PENDING_MS / 60_000} minutes, since an agent adds ` +
				"no gated load until its first build; an agent start or resume runs counts only until it exits. Agents " +
				"already running are never paused.\n\n" +
				"Exits 0 once admitted, 128 plus the signal number when interrupted, and 1 otherwise.",
		)
		.action(() => {
			pending = admitAgent(agentDependencies()).then((status) => status ?? 0, agentFailure);
		});
	agent
		.command("stop")
		.summary("Stop the agent in a worktree, or end the spawn with --all")
		.description(
			"Stop the agent running in a worktree and wait until its start or resume has reported. With --all, " +
				"end the spawn: stop every agent in this repository's worktrees and delete their records.",
		)
		.argument("[worktree]", "Checkout whose agent to stop")
		.option("--all", "Stop every agent in this repository's worktrees")
		.action((worktree: string | undefined, options: { all?: boolean }) => {
			if ((worktree === undefined) === !options.all) throw new UsageError("give a worktree or --all");
			const deps = agentDependencies();
			pending = (worktree === undefined ? stopAll(root(), deps) : stopAgent(worktree, deps)).then(
				() => 0,
				agentFailure,
			);
		});

	program
		.command("models")
		.summary("Print the harnesses, models, and efforts that write work of a size, ranked")
		.description(
			"Print the ranked entries that write work of a size, the same for every repository unless its AGENTS.md " +
				"names others: " +
				SIZES.map(
					(size) =>
						`${size} ${WRITERS[size].map((e) => `${e.harness} ${e.model} ${e.effort}`).join(", then ")}`,
				).join("; ") +
				". A spawn starts a quest on the first entry that can run, as quest unblocked --json lists them. " +
				"--writer prints the one entry that runs that model on the work instead, for an iterate, which stays " +
				"on its PR's writer: the size's own entry for the model, else its entry at the nearest size that " +
				"lists it, the larger on a tie, so an XS iterate on an Opus PR runs Opus at S's effort. A model no " +
				"list names is an error. Prints harness, model, and effort per line, tab-separated; --json prints an " +
				"array of {harness, model, effort} objects.",
		)
		.addArgument(new Argument("<size>", "The work's size").choices(SIZES))
		.option("--writer <model>", "Print only the entry that runs this model, the PR's first Implementer")
		.option("--json", "Print a JSON array")
		.action((size: Size, options: { writer?: string; json?: boolean }) => {
			let entries = WRITERS[size];
			if (options.writer !== undefined) {
				const entry = writerAt(size, options.writer);
				if (entry === null) throw new UsageError(`no write list names ${options.writer}`);
				entries = [entry];
			}
			if (options.json) print(JSON.stringify(entries));
			else for (const e of entries) print(`${e.harness}\t${e.model}\t${e.effort}`);
		});

	program
		.command("usage")
		.summary("Report which models worked on each PR, at what token cost, and how its reviews went")
		.description(
			"Report origin's PRs updated since --since and the agent sessions active since then on this host and each " +
				"--ssh host, as token-max sessions exports and prices them, the cost an estimate at each model's API list " +
				"price; its sub-agents are sessions of their own. Each Claude Code or Codex session belongs to the PR whose " +
				"head branch it last names, when a repository token-max resolved for it on its own host, or for another " +
				"session in the same directory there, is this one; no prompt or reply is read out. Its role is " +
				"reviewing when the PR's ## Review record names it or Codex marks it a review, implementing when its first " +
				"request since --since came before the PR opened, and iterating otherwise. A session found on several hosts counts once, at its " +
				"costliest copy, and the report says how many copies it folded from which hosts; a session with a request " +
				"token-max could not price or a line it could not read is listed, its cost a lower bound. A host that fails fails the report. " +
				"Each PR also shows its ## Models size and implementers, and as unread each Implementer line it cannot read, " +
				"each reviewer the ## Review record names, with its latest round and score and its tally of findings across every round, marked when it is the shadow, " +
				"where a merged PR whose last round left only low findings open counts them settled, since the author fixes or refutes those before merge, " +
				"the later merged PRs whose ## Caused by bullets open with its link, and each online reviewer's record from GitHub: whether it " +
				"reviewed the last head, and its findings accepted, declined, unclassified, or unanswered. An online reviewer " +
				"is a bot whose review has a body or opens a thread, or a review whose body opens with Automated review by <name>; a finding is a " +
				"review thread it opens or a [P<n>] line in its review body, and its first answer's first word takes or " +
				"declines it. Rollups follow: spend by size, role, harness, model, and " +
				"effort, accuracy by size and implementer, summing each branch's tallies but the shadow's once, where an Implementer line's own size, as (iterate, XS), wins " +
				"over the PR's, and each online reviewer's coverage and findings over the merged PRs. Without token-max on PATH, it says how to install it and reports the PRs' records alone. " +
				"--json prints the same report as one object.\n\n" +
				"Uses GH_TOKEN, GITHUB_TOKEN, or gh auth token. Exits 0 when done, 2 for invalid arguments, and 1 for " +
				"other failures.",
		)
		.option("--since <date>", "First local date to report, as YYYY-MM-DD (default: 7 days ago)", date)
		.option("--quest <path>", "Report only the PRs of this quest's branch")
		.option("--pr <number>", "Report only this PR", positiveInteger("--pr"))
		.option(
			"--ssh <host>",
			"Also attribute this SSH destination's sessions, read by the token-max installed there (repeatable)",
			(host: string, hosts: string[] = []) => [...hosts, host],
		)
		.option("--json", "Print one JSON object")
		.action((options: { since?: string; quest?: string; pr?: number; ssh?: string[]; json?: boolean }) => {
			const github = { github: () => gitHubDependencies(warn), warn };
			const since = options.since ?? daysBefore(new Date(), 7);
			settle(
				usage(
					root(),
					{ since, quest: options.quest, pr: options.pr, ssh: options.ssh },
					usageDependencies(github),
				),
				(report) => {
					if (!report.priced) warn(TOKEN_MAX_MISSING);
					if (options.json) print(JSON.stringify(report));
					else for (const line of usageLines(report)) print(line);
				},
			);
		});

	program
		.command("messages")
		.summary("Print the messages a person typed to agents on this host, and their answers to agents' questions")
		.description(
			"Print each message a person typed to a Claude Code or Codex session on this host since --since, oldest " +
				"first, with its time, harness, repository, and session, and no agent reply, tool call or output, " +
				"harness reminder, or prompt an agent or scheduler wrote, except the questions answers reply to. Sessions T3 Code drives are read from " +
				"its state ($T3CODE_HOME, or ~/.t3), which records whether a person or an agent sent each message. " +
				"Other Claude Code sessions, from $CLAUDE_CONFIG_DIR (or ~/.config/claude and ~/.claude), count a turn " +
				"Claude Code marks as a human's; other Codex sessions, from $CODEX_HOME (or ~/.codex), count the " +
				"content Codex marks as the user's, outside headless and sub-agent sessions. The repository is the " +
				"checkout's GitHub origin, else the directory. Output goes to stdout only; nothing is stored or " +
				"posted. Each answer a person gave an agent's blocking question (Claude Code's AskUserQuestion, " +
				"Codex's request_user_input) prints too, from the harness's own log in every session, T3 Code's " +
				"included, with the skill the session last ran, the question, the options the agent marked " +
				"(Recommended), and the ones picked or the words typed instead. --json prints a JSON array of " +
				'{kind: "message", time, harness, repository, session, text} and {kind: "answer", time, harness, ' +
				"repository, session, skill, header, question, options, recommended, picked}.\n\n" +
				"Exits 0 when done, 2 for invalid arguments, and 1 for other failures, such as a log or T3 Code " +
				"record in a shape quest does not know.",
		)
		.option("--since <date>", "First local date to print, as YYYY-MM-DD (default: 7 days ago)", date)
		.option("--json", "Print a JSON array")
		.action((options: { since?: string; json?: boolean }) => {
			const found = messages(options.since ?? daysBefore(new Date(), 7), { env: process.env, home: homedir() });
			if (options.json) print(JSON.stringify(found));
			else for (const line of messageLines(found)) print(line);
		});

	const reviewers = SIZES.map(
		(size) => `${size} ${REVIEWERS[size].map((e) => `${e.harness} ${e.model} ${e.effort}`).join(", then ")}`,
	).join("; ");
	program
		.command("review")
		.summary("Have a model other than the latest writer review the committed branch, read-only")
		.description(
			"Review the checkout's committed branch against its base with a reviewer its size picks, never the " +
				`model that changed it last. Each size ranks its reviewers (harness, model, effort): ${reviewers}. The ` +
				"first whose model is not avoided reviews, and beside it, on the same head in its own session, the shadow: " +
				"the pick's model one effort lower (low, medium, high, xhigh), skipped when the pick runs at low or an " +
				"effort off that ladder, so each effort step can be compared with the one below it. The shadow runs on a " +
				"branch's first run of the pick, then only while it has findings to settle or once the pick changed so it is " +
				"no longer one step below; its findings are numbered and settled like any reviewer's, its session carries " +
				"over to the new shadow, and a pick with no step below it seats a shadow at its own effort while the old " +
				"shadow still has findings. " +
				"--exclude-model names each model to avoid; without it, the " +
				"latest writer is avoided: the model the last Implementer line names in the `## Models` record of the body of the branch's open PR. " +
				"When it names none or an `unknown` model, " +
				"it is any model of the harness running this command, usually the session that just pushed, detected from the " +
				"variables each sets, so Codex reviews from Claude Code and Claude Code from Codex; with --harness it is " +
				"none. " +
				"--harness names the only reviewer instead of the pick and the shadow, at its entry's model and effort, and --model and " +
				"--effort override that reviewer's, or without --harness, the size pick's; a repository whose AGENTS.md names other reviewers " +
				"passes them. A --harness run keeps the other reviewers' sessions for the next run of the pick, and refuses while one has findings to settle, as a run of the pick does while a reviewer only --harness runs has some. When the latest writer changes the size's pick to one with no session on the branch, its first session settles the open findings of the reviewer it replaces. The reviewers run at once, and the first to fail stops the others and fails the " +
				"run, saving no round. The " +
				"size is --size, else the size of the quest a quest/ branch names, read from the base's tip so a " +
				`change cannot lower its own review, else the PR record's Size line, else ${DEFAULT_SIZE}. ` +
				"The reviewer reaches its model as the user's own CLI " +
				"does: Claude Code keeps ANTHROPIC_BASE_URL, ANTHROPIC_CUSTOM_HEADERS, and its cloud providers' " +
				"CLAUDE_CODE_USE_* switches and settings, and Codex keeps CODEX_CA_CERTIFICATE and sends its requests to " +
				"OPENAI_BASE_URL, if set, as its openai_base_url setting. It uses the CLI's own " +
				"stored login; the credential the CLI reads from the environment (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, " +
				"or CLAUDE_CODE_OAUTH_TOKEN for Claude Code, CODEX_API_KEY or CODEX_ACCESS_TOKEN for Codex) passes only " +
				"when the CLI has no stored login or a gateway or provider is set, and a provider's own keys " +
				"(ANTHROPIC_AWS_API_KEY, ANTHROPIC_FOUNDRY_API_KEY, ANTHROPIC_FOUNDRY_AUTH_TOKEN) only while one is set. A logged-out error names the profile it checked, " +
				"CLAUDE_CONFIG_DIR or CODEX_HOME, or the default when unset, and any gateway or provider.\n\n" +
				"Every turn reviews only the branch's own change, from the merge base of HEAD with the base's tip, so " +
				"a branch behind its base draws no findings on the base's newer code. The first round runs the " +
				"reviewer's own review (`codex exec review` with custom instructions, or Claude Code's " +
				"`/code-review <effort> <merge-base>...HEAD` with text after it), given the range, the base's REVIEW.md, if " +
				"any, and any responses up front, then resumes that session for one turn that reports the review in one " +
				"JSON schema without reading anything again. --responses gives the author's fixes and refutations of " +
				"the last round's findings, required while that round reported any; the reply settles each of those " +
				"findings, by its number in the prompt, as fixed, refuted, or still open. Findings are numbered across " +
				"the reviewers in the order the round printed them, and each reviewer settles only its own, given " +
				"--responses only when it has some. A later round resumes the " +
				"session and checks only what changed since the last round's head and those findings when nothing " +
				"but the head changed: the same model, effort, and base, a merge base the last round's covers, as " +
				"when the base moved on, and the same applicable AGENTS.md, CLAUDE.md, and REVIEW.md. Otherwise it " +
				"starts a new session that reviews the whole change and still weighs --responses. A round that would " +
				"resume on the head the last round reviewed, when that round found nothing, runs no reviewer and " +
				"repeats that round, marked unchanged, so on the same head only a reviewer with findings to settle runs. " +
				"--new starts new sessions, continuing each reviewer's tally of its findings on the branch, less those it drops unsettled, unless the saved state is one this quest cannot read. Each reviewer's session is kept per branch in the clone's common Git directory, so any worktree of the clone resumes it. " +
				"A checked-out branch with an upstream other than the base continues its upstream branch's session, so a " +
				"temporary branch tracking the PR's head shares the head's rounds. " +
				"--branch names the branch instead of the checked-out one, as a detached HEAD requires, such as a " +
				"checkout of a branch another worktree holds.\n\n" +
				"The reviewer is read-only: Codex in its read-only sandbox without execpolicy rules, user config, or its " +
				"skills catalog, Claude Code with " +
				"no settings files, only read tools, and the Bash commands it judges read-only. It follows the base's AGENTS.md and CLAUDE.md, from the root and " +
				"each directory holding a changed path, never the checkout's, so a change cannot instruct its own " +
				"reviewer, and is told to disregard other instructions and run no builds, tests, or quest commands. " +
				"The base is fetched first, since the sandbox has no network.\n\n" +
				"Prints the size and where it came from, base, and head, then for each reviewer its harness, model, and " +
				"effort, followed by shadow for the shadow, session, round, an " +
				"unchanged line for a repeated round, a usage line per turn (input tokens, the " +
				"part read from the prompt cache, and output), a score from 0 to 10 for how ready the head is to land with " +
				"its one-sentence rationale, the finding count, each finding by its number, then the last round's findings with " +
				"their numbers and dispositions; then the `record` line below and a last `next` line naming the author's next step: " +
				"`next finish` when every finding is low severity, to fix or refute them without another round, " +
				"`next checkpoint` when a reviewer's every third round reports other findings, to compare the current approach " +
				"with the best long-term approach worked out from first principles before fixing them, `next respond` to fix or refute the findings, or `next done`. A reply without a valid score " +
				"fails as any malformed reply does. --json prints " +
				"one object: `rounds`, one per reviewer, `tallies`, every reviewer's findings across the branch's rounds, `record`, and `next`.\n\n" +
				"After each round, it rewrites the `## Review` section of the branch's open PR into the base, as the " +
				"user the GitHub token names, keeping the rest of the body, and prints `record <url>`: the reviewed " +
				"head, named in full only once no reviewer reports a finding, the base, and each reviewer, its Reviewer line ending in `, shadow` for the shadow, its " +
				"session and round, score, its tally of findings across the branch's rounds, and each finding with its disposition. With no " +
				"such PR, or a remote off GitHub, it prints `record skipped: <why>` and changes nothing.\n\n" +
				"Exits 0 once the round finishes, whatever it found, 2 for invalid arguments " +
				"or a checkout or CLI that cannot be reviewed, including a login the API rejects, 3 when a reviewer's " +
				"account hit its usage limit, and 1 for other failures, including a PR GitHub will not show or a record it " +
				"refuses. A malformed `## Models` field the round reads, such as a Size line naming no size or an " +
				"Implementer line naming no model it can read, is a usage error, unless --size or --exclude-model replaces it. A usage limit prints one line, " +
				"`error: <harness> hit its usage limit; resets <time>`, where <time> is the reset as an ISO 8601 UTC " +
				"timestamp, or `unknown` when the CLI named none.",
		)
		.option("--base <remote/branch>", "Base branch to review against (default: origin's default branch)")
		.addOption(
			new Option(
				"--harness <name>",
				"The only reviewer to run, instead of the size's pick and the shadow",
			).choices(HARNESSES),
		)
		.option("--model <model>", "Model the size's pick, or --harness's reviewer, runs instead")
		.option(
			"--effort <level>",
			"Reasoning effort the size's pick, or --harness's reviewer, runs at instead, never max",
			effortLevel,
		)
		.option(
			"--exclude-model <model>",
			"A model never picked to review it, instead of the PR's latest writer; repeat for each",
			(value: string, previous: string[] = []) => [...previous, value],
		)
		.addOption(
			new Option(
				"--size <size>",
				"The PR's size, instead of its quest's, its PR record's, or the default",
			).choices(SIZES),
		)
		.option("--responses <file>", "The author's responses to the last round's findings; - reads stdin")
		.option("--new", "Start a new review session instead of resuming the branch's")
		.option(
			"--branch <name>",
			"Branch whose review session to continue, instead of the checked-out one or its upstream",
		)
		.option("--json", "Print one JSON object")
		.action(
			(options: {
				base?: string;
				branch?: string;
				harness?: HarnessName;
				model?: string;
				effort?: string;
				excludeModel?: string[];
				size?: Size;
				responses?: string;
				new?: boolean;
				json?: boolean;
			}) => {
				const responses =
					options.responses === undefined
						? undefined
						: readFileSync(options.responses === "-" ? 0 : options.responses, "utf8");
				const github = { github: () => gitHubDependencies(warn), warn };
				const run = review(
					{ ...options, root: root(), exclude: options.excludeModel, responses, fresh: options.new },
					{
						...reviewDependencies(),
						models: (dir, base, branch) => pullModels(dir, base, branch, github),
					},
				);
				pending = run.then(
					async ({ rounds, tallies }) => {
						// The rounds are saved in their sessions either way, so their report prints before a failed record.
						let record: Recorded | undefined;
						let failure: unknown;
						try {
							record = await recordRounds(root(), rounds, tallies, github);
						} catch (error) {
							failure = error;
						}
						if (options.json)
							print(JSON.stringify({ rounds, tallies, record: record ?? null, next: nextStep(rounds) }));
						else {
							for (const line of roundLines(rounds)) print(line);
							if (record !== undefined)
								print("url" in record ? `record ${record.url}` : `record skipped: ${record.skipped}`);
							print(nextStep(rounds));
						}
						if (failure === undefined) return 0;
						warn(
							`the round finished, but recording it in the PR body failed: ${failure instanceof Error ? failure.message : String(failure)}`,
						);
						return 1;
					},
					(error: unknown) => {
						if (error instanceof ReviewInputError) {
							out.stderr(`error: ${error.message}\n`);
							return 2;
						}
						if (error instanceof ReviewLimitError) {
							out.stderr(`error: ${error.message}\n`);
							return 3;
						}
						warn(error instanceof Error ? error.message : String(error));
						return 1;
					},
				);
			},
		);

	/** Changes on stdout; mentions and check findings on stderr, which fail the command. */
	const report = (result: Report): number => {
		for (const line of result.changes) print(line);
		for (const line of result.warnings) warn(line);
		for (const line of result.findings) warn(line);
		return result.findings.length > 0 ? 1 : 0;
	};

	program
		.command("mv")
		.summary("Move a quest or epic and rewrite the links to it")
		.description(
			"Move a quest, or an epic directory and everything under it, with git mv, and rewrite every " +
				"root-absolute link to it under quest/. The change is staged.\n\n" +
				"Refuses the root epic and milestones, which are permanent. Refuses outside a git work tree, when " +
				"the destination exists, and while a moved quest has a claim branch or open PR on origin, or on " +
				"the upstream that holds origin's claims (see quest start), since the old branch would no longer name it. A " +
				"quest belongs to the epic whose directory holds it, so moving it into another directory moves it " +
				"into that epic.\n\n" +
				"Prints R for the move and M for each edited document. Mentions of the old path that are not links, " +
				"or are outside quest/, are reported on stderr and left alone. Runs quest check on the result and " +
				"exits 1 if it fails.",
		)
		.argument("<from>", "Quest file or epic directory, as /quest/..., quest/..., or a filesystem path")
		.argument("<to>", "Its new path, which must not exist")
		.action((from: string, to: string) => {
			pending = moveQuest(root(), from, to, { github: () => gitHubDependencies(warn), warn }).then(
				report,
				(error: unknown) => {
					warn(error instanceof Error ? error.message : String(error));
					return 1;
				},
			);
		});

	program
		.command("rm")
		.summary("Delete a quest or epic and drop the links to it")
		.description(
			"Delete a quest, or an epic and the quests under it, with git rm, and drop every Required, Related, " +
				"or Closes entry that links to it, with any heading left empty. It also drops every Required link to a " +
				"finished milestone, one whose directory holds no other quest and whose README has no Required left, " +
				"and every epic's Required entry naming a quest in its own directory. The change is staged.\n\n" +
				"Refuses outside a git work tree. An epic is its directory or README; removing one that holds other " +
				"quests requires -r. The root epic and milestones are permanent.\n\n" +
				"Prints D for each deleted quest and M for each edited document. Mentions that are not list entries, " +
				"or are outside quest/, are reported on stderr and left alone. Runs quest check on the result and " +
				"exits 1 if it fails.",
		)
		.argument("<path>", "Quest file, or epic directory or README")
		.option("-r, --recursive", "Remove an epic with the quests under it")
		.action((path: string, options: { recursive?: boolean }) => {
			code = report(removeQuest(root(), path, options.recursive ?? false));
		});

	program
		.command("resolve")
		.summary("Merge driver: resolve concurrent edits to a quest's link lists")
		.description(
			"Merge driver: merge <theirs> into <ours> from <base> by lines, as git merge-file does, and write the " +
				"result to <ours>. A conflict that only edits the entries of one Required, Related, or Closes list is " +
				"resolved: entries either side removed stay removed, entries either side added are kept in their " +
				"place, ours before theirs, and an entry only one side changed takes that change. Entries match by " +
				"their opening link. Any other conflict, including prose, a heading, an entry both sides changed, or a " +
				"reordered list, keeps standard conflict markers, showing the base when merge.conflictStyle is diff3 " +
				"or zdiff3. Exits 1 when a conflict remains.\n\n" +
				"quest init registers it for quest/** as the merge.quest driver. Any other command registers the driver " +
				"in the clone's config when .gitattributes names merge=quest and no config sets it, or the one set is a " +
				"driver an older quest registered; a custom driver stays. Without quest on " +
				"the merge's PATH, the driver falls back to git merge-file, and when conflicts remain it prints to stderr " +
				"that the file's link lists were not auto-resolved. GitHub's merges ignore merge drivers.",
		)
		.argument("<ours>", "Our version, overwritten with the result (git's %A)")
		.argument("<base>", "The common ancestor (git's %O)")
		.argument("<theirs>", "Their version (git's %B)")
		.option("--marker-size <size>", "Conflict marker length (git's %L; default: 7)", positiveInteger("marker-size"))
		.option("--ours-label <label>", "Our conflict label (git's %X; default: ours)")
		.option("--base-label <label>", "Ancestor conflict label (git's %S; default: base)")
		.option("--theirs-label <label>", "Their conflict label (git's %Y; default: theirs)")
		.action((ours: string, base: string, theirs: string, options: ResolveOptions) => {
			if (resolveFile(ours, base, theirs, options) > 0) code = 1;
		});

	program
		.command("guide")
		.summary("Print the quest guide: the format, workflow, and rules agents follow")
		.description(
			"Print the quest guide: the format, workflow, and rules agents follow. Each skill already carries the " +
				`sections it needs. Name sections to print only those, in the guide's order: ${GUIDE_SECTIONS.join(", ")}.`,
		)
		.argument("[section...]", "Sections to print, ignoring case")
		.action((sections: string[]) => {
			if (sections.length === 0) return out.stdout(GUIDE);
			for (const section of sections) {
				try {
					sectionHeading(section);
				} catch (error) {
					throw new UsageError(error instanceof Error ? error.message : String(error));
				}
			}
			out.stdout(`${guideSections(sections)}\n`);
		});

	program
		.command("context")
		.summary("Print the engineering rules agents follow in every task, before the repository's own")
		.description(
			"Print the engineering rules agents follow in every task, before the repository's own. The hooks " +
				"`quest setup` installs add them to each Claude Code and Codex session in a repository that uses " +
				"Quest, so its agents need not run this, and check the rules under its last section, Checked, on " +
				"each tool call, so the context they add leaves that section out.",
		)
		.action(() => out.stdout(`${CONTEXT}\n${CHECKED_CONTEXT}`));

	program
		.command("skill")
		.summary("Print a skill's instructions, or list the skills with no name")
		.description(
			"Print a skill's instructions, or list the skills with no name.\n\n" +
				"A repository installs only a stub per skill, so the pinned binary decides what every agent follows. " +
				"Claude Code's stub runs this when the skill is invoked and reads its output in place; the stub other " +
				"agents read asks them to run it. It prints the skill's own instructions, then each skill it builds " +
				"on, then the quest guide's sections any of them use, so one call holds everything the skill needs.",
		)
		.argument("[name]", "Skill to print")
		.action((name: string | undefined) => {
			if (name === undefined) {
				for (const s of SKILLS) print(`${s.name} - ${s.description}`);
				return;
			}
			const found = skill(name);
			if (!found) throw new Error(`no skill named ${name} (have: ${SKILLS.map((s) => s.name).join(", ")})`);
			out.stdout(found.instructions);
		});

	const listed = (hooks: readonly HookEntry[]) =>
		hooks.map((h) => (h.matcher ? `${h.event} (${h.matcher})` : h.event)).join(", ");
	program
		.command("setup")
		.summary("Configure your own Claude Code and Codex settings for quest work")
		.description(
			"Configure your own Claude Code settings for quest work, in $CLAUDE_CONFIG_DIR/settings.json or else " +
				"~/.claude/settings.json, and Codex's in $CODEX_HOME/hooks.json or else ~/.codex/hooks.json when " +
				"that directory exists, keeping every other setting and hook. Touches no repository.\n\n" +
				`Sets Claude Code's env.BASH_MAX_TIMEOUT_MS and env.BASH_DEFAULT_TIMEOUT_MS to ${BASH_MAX_TIMEOUT_MS}, so a ` +
				"foreground command, such as a blocking wait or a long build, runs 55 minutes without the agent passing " +
				"a timeout: just under the 1h prompt-cache TTL. " +
				`Installs Claude Code's ${listed(CLAUDE_HOOKS)} hooks and Codex's ${listed(CODEX_HOOKS)} hooks. ` +
				"The start hooks add `quest context` to each session and Claude Code subagent in a repository that " +
				"uses Quest, and again after compaction, so agents never run it themselves. PreToolUse blocks tool " +
				"calls there that break a rule a program can check: em dashes an agent writes, a push without an " +
				"explicit refspec, a force-push or rebase, a GitHub post without its `(Written by ...)` footer, and " +
				"scratch files in /tmp. Stop and SubagentStop refuse to end an agent's turn while a `quest gate` " +
				"command it started runs in the background. Each runs `quest hook`, so `quest` must be on the PATH the agent starts " +
				"with, and Codex asks to trust its hooks once through /hooks.\n\n" +
				"With --worktrees, also installs Claude Code's " +
				WORKTREE_HOOKS.map((h) => h.event).join(", ") +
				" hooks running `quest worktree hook`, which hand Claude Code's worktrees to `quest worktree`; " +
				"--no-worktrees takes them out, and without either a rerun keeps them as they are. Only one hook " +
				"can manage Claude's worktrees, so remove any other WorktreeCreate or WorktreeRemove hook first.\n\n" +
				"Validates each whole file, then writes it once and prints each change; settings that are not a JSON " +
				"object, or whose env or hooks are malformed, are an error and stay unchanged. Rerun it after " +
				"upgrading Quest; it replaces Quest's earlier hooks and changes nothing when all is set.",
		)
		.option("--worktrees", "Also install the worktree hooks")
		.option("--no-worktrees", "Remove the worktree hooks")
		.option("--remove", "Remove Quest's hooks, and each timeout while it still holds Quest's value")
		.action((options: { remove?: boolean; worktrees?: boolean }) => {
			for (const target of targets()) {
				const changes = setup(target, options);
				for (const line of changes) print(line);
				if (target.name === "Codex" && changes.length > 0 && !options.remove)
					print(`${target.path}: review and trust Quest's hooks with /hooks in Codex`);
			}
		});

	program
		.command("hook")
		.summary("Handle a Claude Code or Codex hook event `quest setup` installed, read on stdin")
		.description(
			"Handle the Claude Code or Codex hook event whose JSON input arrives on stdin, for the entries " +
				"`quest setup` installs, in a repository whose root AGENTS.md or CLAUDE.md, in the checkout holding " +
				"the input's cwd, has a line starting with `Quests: `, as `quest init` writes; elsewhere it prints " +
				"nothing. SessionStart and SubagentStart print `quest context` as the session's or subagent's " +
				"additional context. PreToolUse denies a call that breaks a checked rule, naming the rule: an edit " +
				"or a commit message or new GitHub post that adds an em dash outside a `>` quote line, a `git push` " +
				"whose refspecs lack a `:`, a force-push, a `git rebase` or `git pull --rebase`, a new GitHub post " +
				"whose body lacks a `(Written by ...)` line, or a file written under /tmp. A force-push or rebase the " +
				`user asked for passes with the \`${USER_ASKED}\` prefix. Stop and SubagentStop refuse to end the ` +
				"turn, naming each command, while a `quest gate` command the ending agent started runs in Claude " +
				"Code's background: one whose background ID its transcript holds. Exits 1 on malformed input or an event it " +
				"does not handle.",
		)
		.action(() => {
			out.stdout(hook(JSON.parse(readFileSync(0, "utf8"))));
		});

	program
		.command("init")
		.description("Install skill stubs, a quest root, agent pointers, and the merge driver for this repository")
		.action(() => {
			const changes = init(root());
			for (const line of theme ? theme.init(changes) : changes) print(line);
		});

	program
		.command("uninstall")
		.description("Remove Quest stubs, markers, and the merge driver installed by `quest init`")
		.action(() => {
			const changes = uninstall(root());
			for (const line of theme ? theme.uninstall(changes) : changes) print(line);
		});

	// Fresh clones and worktrees get the merge driver from whichever command runs first.
	program.hook("preAction", (_program, action) => {
		// `setup` and `hook` act on the user's settings, and every session waits on `hook`.
		if (action.parent !== program || !["init", "uninstall", "setup", "hook"].includes(action.name())) heal(root());
	});

	try {
		program.parse(gateBoundary(argv), { from: "user" });
		return pending ?? code;
	} catch (error) {
		if (error instanceof CommanderError) {
			// Help and version exit 0; any other parse failure is a usage error.
			return error.exitCode === 0 ? 0 : 2;
		}
		if (error instanceof UsageError || error instanceof GitHubInputError) {
			out.stderr(`error: ${error.message}\n`);
			return 2;
		}
		warn(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

/**
 * An agent's effort: any level but `max`, which costs as much as a stronger
 * model at a lower effort without matching it.
 */
function effortLevel(value: string): string {
	if (value === "max") throw new InvalidArgumentError("max is never run; use a stronger model instead");
	return nonEmpty(value);
}

/** An empty path names no directory, so it is a usage error rather than `.`. */
function nonEmpty(value: string): string {
	if (value === "") throw new InvalidArgumentError("a value is required");
	return value;
}

/**
 * `path` as a repository-relative path, when it names a file inside `root` by
 * its filesystem path (absolute, or relative to the working directory).
 */
function withinRoot(root: string, path: string): string | null {
	try {
		const rel = relative(realpathSync(root), realpathSync(resolve(path)));
		if (rel === "" || rel.startsWith(`..${sep}`) || rel === "..") return null;
		return rel.split(sep).join("/");
	} catch {
		return null;
	}
}

/** A local calendar date, as YYYY-MM-DD. */
function date(value: string): string {
	const day = new Date(`${value}T00:00:00`);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(day.getTime()) || daysBefore(day, 0) !== value)
		throw new InvalidArgumentError("a date must be YYYY-MM-DD");
	return value;
}

/** A deadline must be finite, positive, and safe for the platform's timer. */
function positiveSeconds(value: string): number {
	const seconds = Number(value);
	if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > 2_147_483_647) {
		throw new InvalidArgumentError("timeout must be positive seconds, at most 2147483.647");
	}
	return seconds;
}

/**
 * Stop option parsing before a gated executable, keeping its own flags intact.
 * Quest's global options still apply on either side of `gate`, and its own `--quick` after it.
 */
export function gateBoundary(argv: string[]): string[] {
	const skip = (index: number, own: string[] = []) => {
		for (;;) {
			if (argv[index] === "--root") index += 2;
			else if (argv[index]?.startsWith("--root=") || own.includes(argv[index])) index += 1;
			else return index;
		}
	};
	const index = skip(0);
	if (argv[index] !== "gate") return argv;
	const command = skip(index + 1, ["--quick"]);
	if (!argv[command] || argv[command].startsWith("-")) return argv;
	return [...argv.slice(0, command), "--", ...argv.slice(command)];
}

/**
 * Collect a repeatable ref name pattern, such as `deploy-*`, refusing one that could read as an option or escape its
 * namespace, or that holds more `*` than `stars`: a pattern that becomes a fetch refspec may hold only one.
 */
function refPattern(kind: string, example: string, stars = Infinity) {
	return (value: string, previous: string[]) => {
		if (
			!/^[\w.*/-]+$/.test(value) ||
			value.startsWith("-") ||
			value.includes("..") ||
			value.split("*").length > stars + 1
		)
			throw new InvalidArgumentError(`expected a ${kind} name pattern, such as ${example}`);
		return [...previous, value];
	};
}

/** Parses a positive, safe integer option named `name`. */
function positiveInteger(name: string): (value: string) => number {
	return (value) => {
		const count = Number(value);
		if (!/^\d+$/.test(value) || !Number.isSafeInteger(count) || count <= 0) {
			throw new InvalidArgumentError(`${name} must be a positive safe integer`);
		}
		return count;
	};
}
