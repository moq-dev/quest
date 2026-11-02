// The `quest` command line: argument parsing and output around the core.

import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import { Argument, Command, CommanderError, InvalidArgumentError, Option } from "commander";

import { description, version } from "../../package.json";
import {
	type Doc,
	type RankedQuest,
	blockers,
	check,
	formatFinding,
	label,
	lookup,
	questBranch,
	renderBlocker,
	unblocked,
} from "../core";
import {
	AgentInputError,
	HARNESSES,
	type HarnessName,
	type Launch,
	processDependencies,
	runAgent,
	stopAgent,
	stopAll,
} from "./agent";
import {
	DEFAULT_URL,
	RunnerInputError,
	addAccount,
	listAccounts,
	login,
	removeAccount,
	runRunner,
} from "../runner/cli";
import type { AdapterName } from "../runner/adapter";
import { held, reach, target, upstream, upstreamRefs } from "./claims";
import { gate } from "./gate";
import { gitHubDependencies, GitHubInputError, mergedHead, pullRequest, readRemote, remoteRepository } from "./github";
import { type Hold, finish, land, release, take } from "./hold";
import { LAND_CHECK } from "./land";
import { apply, pushCommand } from "./land-apply";
import { fix, FixerAgentError } from "./land-fix";
import { serve, type ServeOptions } from "./land-serve";
import { landed } from "./landed";
import { type Report, moveQuest, removeQuest } from "./move";
import { type ResolveOptions, resolveFile } from "./resolve";
import { MODELS, ReviewInputError, processDependencies as reviewDependencies, review, roundLines } from "./review";
import { heal, init, uninstall } from "./setup";
import { Refusal, describe, notUpstream, releaseQuest, startQuest } from "./start";
import { GUIDE, SKILLS, skill } from "./skills";
import { type Terminal, Theme } from "./theme";
import { type Snapshot, checkout, collect, exists, load, snapshot, under } from "./tree";
import { pullRequestStatus, statusLines } from "./status";
import { waitForActivity, WaitTimeout } from "./wait";
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
				"only the raw measures do. Nested calls run immediately. Limits come from the host; there is " +
				"no configuration.\n\n" +
				"Once the command exits, or is cancelled and exits, its remaining descendants are killed; a second " +
				"signal kills them all at once. Linux with a systemd 254+ user manager owns every descendant through " +
				"a systemd user scope. macOS, and Linux without one, own the command's process group in a new session " +
				"without a controlling terminal, so a descendant that leaves the group or session escapes. Windows " +
				"owns only the command. Exits with the command's status, or 128 plus the signal's number once cancelled.",
		)
		.argument("<command>", "Executable to run")
		.argument("[args...]", "Arguments forwarded verbatim")
		.action((command: string, args: string[]) => {
			pending = gate([command, ...args]).catch((error: unknown) => {
				warn(error instanceof Error ? error.message : String(error));
				return 1;
			});
		});

	program
		.command("check")
		.summary("Report every structural mistake in the tree; exit non-zero if any")
		.description(
			"Report every structural mistake in the tree; exit non-zero if any.\n\n" +
				"With --base, also check that a PR from a quest's branch leaves that quest accurate. When the branch " +
				"is a quest's path without .md (an epic's is quest/<path>/README) and that quest exists at the merge " +
				"base with <ref>, the working tree must delete or edit it; a PR that finishes the quest deletes it, and " +
				"one that leaves work rewrites it to what remains. Any other branch adds no finding. Fetch <ref> " +
				"first: a stale base can predate the quest and skip it.",
		)
		.option("--base <ref>", "Also check the quest branch's diff from its merge base with this ref")
		.option("--branch <name>", "The PR's head branch, when it differs from the current branch (needs --base)")
		.action((options: { base?: string; branch?: string }) => {
			if (options.branch !== undefined && options.base === undefined) {
				throw new UsageError("--branch requires --base");
			}
			const findings = check(load(root()), (path) => exists(root(), path));
			if (options.base !== undefined) findings.push(...landed(root(), options.base, options.branch));
			if (findings.length === 0) {
				const count = collect(root()).length;
				print(theme ? theme.checked(count) : `quest: ${count} documents ok`);
				return;
			}
			for (const finding of findings) warn(formatFinding(finding));
			code = 1;
		});

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
		const found = blockers(docs, doc);
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
			"Rank ready quests by milestone priority, distinct transitive dependents, then tree order. " +
				"Given a path, print what blocks that quest instead.\n\n" +
				"Counts exclude structural epic membership. Other prerequisites may remain for dependents. " +
				"Invalid trees fail before printing a ranking. Prints a count and path per line; --json prints an " +
				"ordered array of {path, dependents} objects.\n\n" +
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
				const show = (quests: RankedQuest[]) => {
					const shown = quests.slice(0, options.limit);
					if (options.json) {
						print(JSON.stringify(shown));
						return;
					}
					if (theme)
						print("Ready quests by milestone and downstream impact (other prerequisites may remain):");
					for (const quest of shown) print(`${quest.dependents}\t${quest.path}`);
				};
				if (!options.unclaimed) {
					const tree = checkout(root());
					if (valid(tree)) show(unblocked(tree.docs));
					return;
				}
				// Readiness comes from the upstream default branch, so a stale checkout cannot offer
				// a deleted quest or one whose prerequisite has since finished.
				const deps = { github: () => gitHubDependencies(warn), warn };
				settle(
					(async () => {
						const up = await reach(root(), options.remote, deps);
						const refs = up === null ? null : upstreamRefs(root(), up.git);
						const tree = refs === null ? checkout(root()) : snapshot(root(), refs.base);
						if (!valid(tree)) return null;
						const ranked = unblocked(tree.docs);
						const branches = ranked.map((quest) => questBranch(quest.path));
						const holdings = up === null ? [] : (await held(root(), up, branches, refs?.branches)).claims;
						return { ranked, holdings };
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
						show(result.ranked.filter((quest) => !byBranch.has(questBranch(quest.path))));
					},
				);
			},
		);

	program
		.command("start")
		.summary("Claim a ready quest with a draft PR, or release that claim")
		.description(
			"Claim a ready quest: push an empty claim commit, built on the upstream default branch, to the quest's " +
				"branch (its path without .md), then open a draft PR from it right away. Switches the " +
				"checkout to the claim on a new local branch, or fast-forwards that branch when it is checked out, " +
				"and prints the PR URL, or the branch off GitHub.\n\n" +
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
					if (blockers(at.tree.docs, doc).length > 0) {
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
				"checks:passed waits until no check is pending, no GitHub Actions run is unfinished, and every check and workflow the base branch names is present, then names the last required check that passed. " +
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
		.option("--since <point>", "ISO timestamp, pushed-tip SHA, or resume cursor (default: current head push time)")
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
				"url, state, draft, head, mergeable, merge-state, review-decision, auto-merge, merge-queue, " +
				"landing-stopped, and checks; auto-merge gives its method, who enabled it and when, and the head it was " +
				"enabled on, which differs from head once a push follows, as GitHub keeps auto-merge across a writer's " +
				"push (- when it cannot be told: a quest land pin names it, and otherwise the head branch's push " +
				"activity, which GitHub lists up to minutes late); landing-stopped is the latest exit from the merge queue, auto-merge, or " +
				"quest land's queue, with the reason (such as merge_conflict, failed_checks, manual, or manually_disabled), " +
				"actor, and time. Then " +
				"a check line per failing or pending check, marked required or optional; a review line per " +
				"reviewer's latest review, marked current or stale against the head; a reacted:<content> line per " +
				"reaction on the PR or a review; and a thread line per unresolved review thread, led by its node ID. " +
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
		"event that added it, since sessions often share an account. A command refuses while a quest:* label " +
		"it holds no token for is on the PR, and while the PR is merged, closed, or a draft its starter still " +
		"holds (one whose body has no Decisions needed heading). A refusal names the holder's label, age, and " +
		"token; releasing a stale hold with that token is the user's choice. Given a token, a command refuses " +
		"unless the token is still the latest add of its label. When two sessions add the label at once, the " +
		"first added keeps the PR; GitHub records no event when a label already on the PR is added again, so two " +
		"takes within the same moment are not told apart. Older quest versions' quest:iterate and quest:ready " +
		"labels hold a PR like any quest:* label, and taking it with their token swaps them for quest:active; " +
		"their quest:merge label holds nothing.\n\n" +
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
			"Hand a PR this session holds to reviewers: remove the body's Decisions needed section and mark a " +
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
			"Land a PR's reviewed head: enable auto-merge bound to the full head SHA --land names, which enters the " +
				"base's merge queue when it has one, or merge at once when nothing is left to wait for. It takes no " +
				"label: the auto-merge it enables is the queue signal. It refuses while a session holds the PR, so " +
				"release your own hold first, and once the head has moved. It uses the method --squash or " +
				"--rebase names, refusing one the repository disallows; otherwise the only method the repository " +
				"allows, or else a merge commit. A merge queue applies its own. On a base " +
				`that requires the \`${LAND_CHECK}\` check, it queues the PR for \`quest land\` instead: squash ` +
				"auto-merge whose commit body pins the head. On an ungated base with auto-merge disabled, it refuses " +
				"unless --direct is passed. Follow the repository landing instructions in CONTRIBUTING.md or " +
				"AGENTS.md; never retry with --direct unless the user asks. GitHub keeps auto-merge across a " +
				"writer's push, so disable it before pushing to the PR; quest status and quest wait report a head " +
				"that moved since auto-merge was enabled.\n\n" +
				OWNERSHIP,
		)
		.argument("<pr>", "GitHub PR URL, or a PR number in origin")
		.requiredOption("--land <sha>", "Land this full 40-character head SHA")
		.addOption(new Option("--squash", "Squash and merge").conflicts("rebase"))
		.option("--rebase", "Rebase and merge")
		.option("--direct", "Allow landing when repository auto-merge is disabled")
		.action((value: string, options: { land: string; squash?: boolean; rebase?: boolean; direct?: boolean }) => {
			const pr = pullRequest(value, root());
			if (!/^[\da-f]{40}$/i.test(options.land)) throw new UsageError("--land needs a full 40-character SHA");
			const method = options.squash ? "squash" : options.rebase ? "rebase" : undefined;
			settle(land(pr, options.land, method, gitHubDependencies(warn), options.direct), () => undefined);
		});

	const landCommand = program.command("land").summary("Land queued PRs through a host daemon");
	landCommand
		.command("fix")
		.description(
			"Run a mechanical agent fix inside the credential-free fixer container; write quest-land-result.json, whose optional comments the daemon posts. Model endpoint and client key: OPENAI_BASE_URL and OPENAI_API_KEY.",
		)
		.argument("<log>", "Full failure log exposed by the wrapper")
		.argument("[prs...]", "PR numbers with pr-<n> branches; none to fix the base alone, on its base branch")
		.option("--agent <executable>", "Agent executable", "codex")
		.option("--model <id>", "Agent model recorded in the result (passed to default Codex)")
		.option(
			"--agent-arg <argument>",
			"Replace default codex exec arguments (repeatable)",
			(value: string, previous: string[]) => [...previous, value],
			[] as string[],
		)
		.action((log: string, prs: string[], options: { agent: string; agentArg: string[]; model?: string }) => {
			settle(
				fix(
					root(),
					log,
					prs.map(Number),
					options.agent,
					options.agentArg.length ? options.agentArg : undefined,
					options.model,
				),
				() => print("fixer result written"),
			);
		});
	landCommand
		.command("apply")
		.description(
			"Rebuild the commit a quest land fixer handed back because GitHub refused its push, such as a merge of a " +
				"base that changed .github/workflows, which the App lacks the permission to push. Reads the latest " +
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
		.command("serve")
		.description(
			"Run one daemon per repository. Every squash, and every base merged into a PR head, drops each list entry linking to a quest the base deleted since the PR branched, as quest rm would. As a batch is filled, park alone for the fixer (eject alone, without one) each PR it reaches whose squash onto the base fails quest check with findings the base lacks, and comment once on each newly queued PR that conflicts with the four PRs landing soonest ahead of it. Check a base PR plus up to floor(log2 n) cleanly merging PRs once through the sandbox, alternating the oldest and the newest queued PR as the base. A failed batch is never bisected: its PRs are parked for the fixer, which blames the ones at fault, or ejected together without a fixer. It halves the next batch's size down to one PR; each landed batch grows it back by one. When the fixer blames none and the base fails its check alone, the queue halts until a moved base passes, and the fixer proposes a fix of the base as a PR. Requires quest on PATH and flock. Sandbox and fixer wrappers MUST run code as a different user from the App key owner (for example in nspawn containers); environment filtering alone cannot isolate /proc or host files. The sandbox receives <checkout> <base-sha>, with the base also in QUEST_LAND_BASE and present in the standalone shallow clone; the optional tracked background fixer receives the log path followed by PR numbers, or none for a base that fails alone. Neither receives credentials. State retains logs, fixer jobs, and one mechanical attempt per maintainer pick across restarts. Fixer results are validated, lease-pushed, recorded in Review, and pinned for requeue, and the comment a result carries for its PR is posted there; invalid results, crashes, and timeouts are handed back. A validated fix whose push GitHub refuses is handed back with its resolution for `quest land apply`. After revalidating the queue, merge the base into each behind-base PR head with quest resolve, verify the tested tree, and lease-push that head before the pinned GitHub squash API merge. A permissions-refused branch push falls back to a leased fast-forward of the tested squash to the base, closing the PR with a linked-commit comment. A recorded daemon merge atop the original pin is recognized after restart; other moved heads require maintainer requeueing. Pending mergeability, and GitHub still showing the pin after the daemon's own push, are retried briefly; a confirmed conflict parks only that PR for the fixer and a moved head ejects only that PR, and the rest of the batch stays queued. A refusal that would repeat, such as squash being disabled, ejects as merge_refused without the fixer. An unexpected squash parent rebuilds the queue without ejecting; a tree mismatch logs CRITICAL, ejects only a PR whose prepared tree differs as tree_mismatch (an already squashed PR stays merged), and leaves the rest of the batch queued to be rebuilt on the new base. Merged PRs drop out of the queue after restart.",
		)
		.option("--base <branch>", "Base branch (default: repository default)")
		.option("--state <path>", "Private daemon state directory (default: $STATE_DIRECTORY or the XDG state home)")
		.requiredOption(
			"--sandbox <command>",
			"Sandbox executable called with <checkout> <base-sha> and QUEST_LAND_BASE",
		)
		.option(
			"--fixer <command>",
			"Credential-free fixer wrapper executable (60 minutes from its admission line, 120 in total)",
		)
		.requiredOption("--app-id <id>", "GitHub App id")
		.option("--timeout <minutes>", "Fail a check that runs longer than this", positiveInteger("timeout"), 60)
		.action((options: ServeOptions) => {
			const origin = readRemote(root(), "origin");
			const repository = origin && remoteRepository(origin).repository;
			if (!repository) throw new Error("origin must name a github.com repository");
			pending = serve(root(), repository, options, warn).then(
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
			record(state().create(root(), name, options.reserve, options.ref, options.scratch)),
		);
	worktree
		.command("run")
		.summary("Run a command in a checkout, then release it once every process stops")
		.description(
			"Run a command in the checkout, restoring it first when released. The command and its descendants " +
				"run in a new systemd user scope; once the command exits, descendants still in the scope are killed. " +
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
	// Only a commit no local ref reaches asks the forge, so other removals need no token.
	const merged = async (repository: string, commit: string) => {
		const origin = readRemote(repository, "origin");
		if (origin === null) return false; // No forge to ask.
		const up = await upstream(repository, origin, { github: () => gitHubDependencies(warn), warn });
		return up.github !== null && mergedHead(up.github.client, up.github.repository, commit);
	};
	worktree
		.command("remove <id>")
		.description(
			"Delete a finished checkout and drop its record, never forcing. Refuses while supervised runs are live, " +
				"and refuses modified, untracked, or ignored files beyond the declared scratch, and commits no branch " +
				"or remote-tracking ref reaches, unless the GitHub upstream that holds origin's claims merged a PR whose head is exactly " +
				"that commit. Prunes the scratch first, so a refusal over ignored files leaves the checkout released.",
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
		.summary("Handle a Claude Code worktree or subagent hook event read on stdin")
		.description(
			"Handle the Claude Code hook event whose JSON input arrives on stdin; `quest init` installs it in " +
				".claude/settings.json for " +
				HOOK_EVENTS.join(", ") +
				".\n\n" +
				"WorktreeCreate checks out the remote's default branch as last fetched (origin/HEAD), as Claude does by " +
				"default, or the session's commit without one, as a quest worktree under the main checkout's .worktrees/, " +
				"and prints its path. Its scratch is the main checkout's top-level ignored entries, except " +
				".worktrees/, .claude/, and entries holding a nested repository; its reserve is the main checkout's disk " +
				"usage without .git and those checkouts. An existing checkout of that name in the repository is " +
				"restored instead. WorktreeRemove removes the checkout as `remove` does, so Claude keeps one holding " +
				"unpreserved work. SubagentStop releases the subagent's own checkout, named agent-<agent_id> by Claude, " +
				"when it finishes or stops to wait, and SubagentStart restores it. Other checkouts are left alone. " +
				"Exits 1 on failure, never 2, which would keep a subagent running.",
		)
		.action(() => {
			pending = (async () => claudeHook(JSON.parse(readFileSync(0, "utf8")), state(), merged))().then(
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
		.summary("Start, resume, and stop headless agents billed to API keys")
		.description(
			"Run one headless agent turn per call in the foreground, billed to one of the keys in QUEST_API_KEYS, " +
				"so a spawn launches every agent with one legible command.\n\n" +
				"Codex requires a registered Quest checkout and Linux worktree supervision; these are checked before resolving keys. " +
				"It uses the quest worktree run lifecycle: restore before each turn and release declared scratch after exit. Claude runs directly in the given checkout.\n\n" +
				"QUEST_API_KEYS lists keys separated by whitespace; --key names one by its 1-based position. An " +
				"entry may be a 1Password op:// reference: the first launch resolves every reference in one " +
				"`op inject` and keeps the keys in a user-only store under $XDG_RUNTIME_DIR (or the temporary " +
				"directory) shared by the repository's worktrees, until `quest agent stop --all`.\n\n" +
				"The agent CLI and op run from their absolute paths on PATH, never from the worktree; on native Windows " +
				"a batch shim such as npm's claude.cmd runs through System32's cmd.exe, and stop ends the agent's process tree at once.\n\n" +
				"The agent runs in <worktree> with the user's environment minus every CLAUDE* (except CLAUDE_CONFIG_DIR), " +
				"ANTHROPIC*, CODEX_* (except CODEX_HOME), OP_*, OPENAI_API_KEY, QUEST_API_KEYS, and QUEST_GATE_ADMITTED variable, plus " +
				"its one key as " +
				"ANTHROPIC_API_KEY (claude -p) or CODEX_API_KEY (codex exec). It never prints a key; any the agent " +
				"repeats is shown as <key N>.\n\n" +
				"Prints `session <id>` as soon as the id is known, then `cost <dollars>` when the agent reports it, " +
				"`outcome finished|failed|exhausted|stopped`, a blank line, and the agent's final reply. Exits 0 " +
				"when the agent finished, 3 when the provider refused the key for lack of credit, 2 for invalid " +
				"arguments, 128 plus the signal number when interrupted, and 1 otherwise.",
		);
	const launchOptions = (command: Command) =>
		command
			.addOption(new Option("--harness <name>", "Agent CLI to run").choices(HARNESSES).makeOptionMandatory())
			.requiredOption("--key <position>", "1-based position of the key in QUEST_API_KEYS", positiveInteger("key"))
			.requiredOption("--model <model>", "Model the agent runs")
			.requiredOption("--effort <level>", "Reasoning effort the agent runs at")
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
		.command("stop")
		.summary("Stop the agent in a worktree, or end the spawn with --all")
		.description(
			"Stop the agent running in a worktree and wait until its start or resume has reported. With --all, " +
				"end the spawn: stop every agent in this repository's worktrees and delete the resolved keys.",
		)
		.argument("[worktree]", "Checkout whose agent to stop")
		.option("--all", "Stop every agent and delete the resolved keys")
		.action((worktree: string | undefined, options: { all?: boolean }) => {
			if ((worktree === undefined) === !options.all) throw new UsageError("give a worktree or --all");
			const deps = agentDependencies();
			pending = (worktree === undefined ? stopAll(root(), deps) : stopAgent(worktree, deps)).then(
				() => 0,
				agentFailure,
			);
		});

	const models = HARNESSES.map((h) => `${MODELS[h].model} at ${MODELS[h].effort} effort for ${h}`).join(" and ");
	program
		.command("review")
		.summary("Have the other vendor's model review the committed branch, read-only")
		.description(
			"Review the checkout's committed branch against its base with the other harness: Codex when run from " +
				"Claude Code, Claude Code when run from Codex, detected from the variables each sets. --harness names " +
				"the reviewer instead; there is no other fallback. The reviewer uses its CLI's own stored login or, " +
				"without one, the credential it reads from the environment (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or " +
				"CLAUDE_CODE_OAUTH_TOKEN for Claude Code, CODEX_API_KEY for Codex) unless a stripped ANTHROPIC_BASE_URL or " +
				"CLAUDE_CODE_USE_BEDROCK, _VERTEX, or _FOUNDRY would send it elsewhere. A logged-out error names the " +
				"profile it checked, CLAUDE_CONFIG_DIR or CODEX_HOME, or the default when unset. It runs " +
				`with ${models}. --model and --effort override them.\n\n` +
				"The first round runs the reviewer's own review (`codex exec review --base`, or Claude Code's " +
				"`/code-review <effort> <base>...HEAD`), then resumes that session for one turn that applies the base's " +
				"REVIEW.md, if any, and reports the findings in one JSON schema. Later rounds on the branch resume the " +
				"same session with the new head and --responses, the author's fixes and refutations of the last " +
				"round's findings, required while that round reported any. A resumed session keeps the instructions it " +
				"started with, so when the applicable AGENTS.md or CLAUDE.md files change, the round starts a new " +
				"session that still weighs --responses. --new starts a new session. The session is kept per branch in the clone's common Git directory, so any worktree of the clone resumes it.\n\n" +
				"The reviewer is read-only: Codex in its read-only sandbox without execpolicy rules or user config, Claude Code with " +
				"no settings files, only read tools, and the Bash commands it judges read-only. It follows the base's AGENTS.md and CLAUDE.md, from the root and " +
				"each directory holding a changed path, never the checkout's, so a change cannot instruct its own " +
				"reviewer. The base is fetched first, since the sandbox has no network.\n\n" +
				"Prints the reviewer, model, and effort, session, round, base, head, a usage line per turn (input tokens, the " +
				"part read from the prompt cache, and output), the finding count, then each finding. --json prints " +
				"the same as one object. Exits 0 once the round finishes, whatever it found, 2 for invalid arguments " +
				"or a checkout or CLI that cannot be reviewed, including a login the API rejects, and 1 for other failures.",
		)
		.option("--base <remote/branch>", "Base branch to review against (default: origin's default branch)")
		.addOption(new Option("--harness <name>", "Reviewer to run instead of the other harness").choices(HARNESSES))
		.option("--model <model>", "Model the reviewer runs instead")
		.option("--effort <level>", "Reasoning effort the reviewer runs at instead")
		.option("--responses <file>", "The author's responses to the last round's findings; - reads stdin")
		.option("--new", "Start a new review session instead of resuming the branch's")
		.option("--json", "Print one JSON object")
		.action(
			(options: {
				base?: string;
				harness?: HarnessName;
				model?: string;
				effort?: string;
				responses?: string;
				new?: boolean;
				json?: boolean;
			}) => {
				const responses =
					options.responses === undefined
						? undefined
						: readFileSync(options.responses === "-" ? 0 : options.responses, "utf8");
				const run = review({ ...options, root: root(), responses, fresh: options.new }, reviewDependencies());
				pending = run.then(
					(round) => {
						if (options.json) print(JSON.stringify(round));
						else for (const line of roundLines(round)) print(line);
						return 0;
					},
					(error: unknown) => {
						if (error instanceof ReviewInputError) {
							out.stderr(`error: ${error.message}\n`);
							return 2;
						}
						warn(error instanceof Error ? error.message : String(error));
						return 1;
					},
				);
			},
		);

	const runnerIO = () => ({ stdout: out.stdout, stderr: out.stderr, env: process.env });
	const runnerFailure = (error: unknown) => {
		if (error instanceof RunnerInputError) {
			out.stderr(`error: ${error.message}\n`);
			return 2;
		}
		warn(error instanceof Error ? error.message : String(error));
		return 1;
	};
	const runnerAction = (task: () => number | Promise<number>) => {
		try {
			pending = Promise.resolve(task()).catch(runnerFailure);
		} catch (error) {
			pending = Promise.resolve(runnerFailure(error));
		}
	};
	const runner = program
		.command("runner")
		.summary("Run kix jobs on this machine with its own agent accounts")
		.description(
			"Turn this Linux or macOS machine into a kix runner. `quest runner login` connects it to your kix " +
				"account, `quest runner account add` signs agent accounts in with their own CLIs, and `quest runner` " +
				"runs routed jobs in the foreground until interrupted.\n\n" +
				"Each account signs in through its CLI's own flow, Claude Code or opencode, in an isolated home; kix " +
				"stores only an opaque account id, its kind, and its label, and never sees its tokens. Every job runs " +
				"inside its project's `nix develop` shell. State lives in $QUEST_RUNNER_HOME, by default " +
				"$XDG_DATA_HOME/quest/runner.",
		);
	runner
		.command("run", { isDefault: true })
		.description(
			"Connect to kix and run assigned jobs until interrupted. On SIGINT or SIGTERM, running agents stop, " +
				"their work is published to their job branches, and their jobs move to another runner.",
		)
		.option("--slots <count>", "Jobs to run at once", positiveInteger("slots"), 1)
		.action((options: { slots: number }) => runnerAction(() => runRunner(runnerIO(), options)));
	runner
		.command("login")
		.description(
			"Connect this machine to your kix account: print a link to approve it while signed in, then wait. " +
				"The machine keeps its token; the link carries only its hash.",
		)
		.option("--url <origin>", "The kix origin", DEFAULT_URL)
		.option("--name <name>", "The name kix shows for this machine (default: its hostname)")
		.action((options: { url: string; name?: string }) => runnerAction(() => login(runnerIO(), options)));
	const account = runner.command("account").description("Add, list, and remove this runner's agent accounts");
	account
		.command("add")
		.description(
			"Sign an account in with its CLI's own flow in a new isolated home: `claude auth login` for Claude " +
				"Code, or `opencode auth login` for an OpenCode Go plan, a ChatGPT plan, or any provider's API key",
		)
		.addArgument(new Argument("[cli]", "The agent CLI").choices(["claude", "opencode"]).default("claude"))
		.option("--console", "Claude Code: sign in with an Anthropic Console account (API billing)")
		.option("--model <provider/model>", "opencode: the model this account's jobs use (default: opencode's)")
		.option("--label <label>", "The name kix shows for the account (default: its email or providers)")
		.action((cli: AdapterName, options: { console?: boolean; model?: string; label?: string }) =>
			runnerAction(() =>
				addAccount(runnerIO(), { cli, console: !!options.console, model: options.model, label: options.label }),
			),
		);
	account
		.command("list")
		.description("Print each account's id, kind, and label")
		.action(() => runnerAction(() => listAccounts(runnerIO())));
	account
		.command("remove <id>")
		.description("Remove an account and delete its home, signing it out of this machine")
		.action((id: string) => runnerAction(() => removeAccount(runnerIO(), id)));

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
				"the upstream that holds origin's claims (see quest start), since the old branch would no longer name it. Moving a " +
				"quest into or out of an epic changes which epic lists it; the check afterwards reports what to fix.\n\n" +
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
				"finished milestone, one whose README has no Required left, except the root's own listing. The change " +
				"is staged.\n\n" +
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
				"in the clone's config when .gitattributes names merge=quest and no config sets it. Without quest on " +
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
		.description("Print the quest guide: the format, workflow, and rules agents follow")
		.action(() => out.stdout(GUIDE));

	program
		.command("skill")
		.summary("Print a skill's instructions, or list the skills with no name")
		.description(
			"Print a skill's instructions, or list the skills with no name.\n\n" +
				"A repository installs only a stub per skill, which runs this, so the pinned binary decides what " +
				"every agent follows.",
		)
		.argument("[name]", "Skill to print")
		.option("--stub", "Print the stub SKILL.md a repository installs instead")
		.action((name: string | undefined, options: { stub?: boolean }) => {
			if (name === undefined) {
				if (options.stub) throw new UsageError("--stub requires a skill name");
				for (const s of SKILLS) print(`${s.name} - ${s.description}`);
				return;
			}
			const found = skill(name);
			if (!found) throw new Error(`no skill named ${name} (have: ${SKILLS.map((s) => s.name).join(", ")})`);
			out.stdout(options.stub ? found.stub : found.body);
		});

	program
		.command("init")
		.description(
			"Install skill stubs, a quest root, agent pointers, Claude Code worktree hooks, and the merge driver for this repository",
		)
		.action(() => {
			const changes = init(root());
			for (const line of theme ? theme.init(changes) : changes) print(line);
		});

	program
		.command("uninstall")
		.description("Remove Quest stubs, markers, hooks, and the merge driver installed by `quest init`")
		.action(() => {
			const changes = uninstall(root());
			for (const line of theme ? theme.uninstall(changes) : changes) print(line);
		});

	// Fresh clones and worktrees get the merge driver from whichever command runs first.
	program.hook("preAction", (_program, action) => {
		if (!["init", "uninstall"].includes(action.name())) heal(root());
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
 * Quest's global options still apply on either side of `gate`.
 */
export function gateBoundary(argv: string[]): string[] {
	const skipRoot = (index: number) => {
		while (argv[index] === "--root" || argv[index]?.startsWith("--root=")) {
			index += argv[index] === "--root" ? 2 : 1;
		}
		return index;
	};
	const index = skipRoot(0);
	if (argv[index] !== "gate") return argv;
	const command = skipRoot(index + 1);
	if (!argv[command] || ["--", "-h", "--help", "-V", "--version"].includes(argv[command])) return argv;
	return [...argv.slice(0, command), "--", ...argv.slice(command)];
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
