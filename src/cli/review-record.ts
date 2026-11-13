// `quest review` rewrites the `## Review` section of its branch's open PR after each round, so the head
// it reviewed counts without an agent copying the round into the body by hand.
import { reviewSection } from "../core";
import { recorded } from "../github/models";
import { type ClaimDependencies, repositoryPath, upstream } from "./claims";
import { git } from "./git";
import { requireRemote, string } from "./github";
import { type PullModels, type Round, SEVERITIES, type Tally, located, parseBase, sameSeat } from "./review";

const HARNESSES: Record<Round["reviewer"], string> = { claude: "Claude Code", codex: "Codex", opencode: "opencode" };

/**
 * Model text as one inline code span, so a mention, issue reference, or Markdown in it renders as text.
 * `quest status` takes the last full SHA the section names as its reviewed head, so no full SHA appears in it.
 */
function code(text: string): string {
	const flat = text
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\b[0-9a-f]{40}\b/g, (sha) => sha.slice(0, 12));
	const fence = "`".repeat(Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length)) + 1);
	const pad = /^`|`$/.test(flat) ? " " : "";
	return `${fence}${pad}${flat}${pad}${fence}`;
}

const capitalized = (word: string) => word[0]!.toUpperCase() + word.slice(1);

/** A block's Reviewer line, ending in `, shadow` for the shadow, the size's pick one effort lower. */
const reviewerLine = (seat: Pick<Tally, "reviewer" | "model" | "effort" | "shadow">) =>
	`- Reviewer: ${HARNESSES[seat.reviewer]}, ${seat.model}, ${seat.effort} effort${seat.shadow ? ", shadow" : ""}`;

/** A tally's counts, as the record's `Rounds:` line and `quest usage` write them. */
export interface Counts {
	rounds: number;
	findings: Tally["findings"];
	fixed: number;
	refuted: number;
	/** Open findings of a merged PR's last all-low round, which the review rule fixes or refutes before merge. */
	settled: number;
	open: number;
}

/** The counts as the record's `Rounds:` line ends, after the rounds, naming only the severities found. */
export function findingsText(counts: Omit<Counts, "rounds">): string {
	const total = SEVERITIES.reduce((sum, severity) => sum + counts.findings[severity], 0);
	const severities = SEVERITIES.filter((severity) => counts.findings[severity] > 0)
		.map((severity) => `${severity} ${counts.findings[severity]}`)
		.join(", ");
	return `findings ${total}${severities && ` (${severities})`}: fixed ${counts.fixed}, refuted ${counts.refuted}${counts.settled > 0 ? `, settled ${counts.settled}` : ""}, open ${counts.open}`;
}

/** A tally's counts, where a finding neither fixed nor refuted is open. */
const counted = (tally: Tally): Counts => ({
	...tally,
	settled: 0,
	open: SEVERITIES.reduce((sum, severity) => sum + tally.findings[severity], 0) - tally.fixed - tally.refuted,
});

/**
 * The `## Review` section's text for a run's `rounds` of the same head, without its heading, with every tally
 * on the branch: each round's reviewer's beside its round, and a reviewer the run left out on its own.
 */
export function reviewRecord(rounds: Round[], tallies: Tally[]): string {
	const [shared] = rounds;
	// A reviewer the run left out may still hold open findings, which keep the head from passing too.
	const clean =
		rounds.every((round) => round.findings.length === 0) && tallies.every((tally) => counted(tally).open === 0);
	const lines = [
		MARK,
		"",
		// `quest status` counts a full SHA here as a review of that head, which an open finding has not passed.
		`- Head: ${clean ? shared!.head : `${shared!.head.slice(0, 12)}, named in full once no reviewer reports a finding`}`,
		`- Base: ${shared!.base.ref} at ${shared!.base.sha.slice(0, 12)}`,
	];
	for (const round of rounds) {
		lines.push(
			"",
			reviewerLine(round),
			`- Session: ${code(round.session)}, round ${round.round}`,
			`- Score: ${round.score}/10, ${code(round.rationale)}`,
		);
		const tally = tallies.find((each) => sameSeat(each, round));
		if (tally === undefined) throw new Error(`no tally for ${round.reviewer}'s round`);
		lines.push(`- Rounds: ${tally.rounds}; ${findingsText(counted(tally))}`);
		if (round.findings.length === 0) lines.push("- Findings: none");
		else lines.push("- Findings, open until the next round settles them:");
		for (const finding of round.findings)
			lines.push(`  - ${capitalized(finding.severity)}, ${code(located(finding))}: ${code(finding.title)}`);
		const settled = round.earlier?.findings ?? [];
		if (settled.length > 0) lines.push(`- The last round's findings, at ${round.earlier!.head.slice(0, 12)}:`);
		for (const finding of settled)
			lines.push(
				`  - ${capitalized(finding.disposition)}: ${finding.severity}, ${code(located(finding))}: ${code(finding.title)}; ${code(finding.reason)}`,
			);
	}
	for (const tally of tallies.filter((each) => !rounds.some((round) => sameSeat(round, each))))
		lines.push("", reviewerLine(tally), `- Rounds: ${tally.rounds}; ${findingsText(counted(tally))}`);
	return lines.join("\n");
}

/** What a PR body's `## Review` record says of one reviewer, as `reviewRecord` writes it. */
export interface ReviewSummary {
	/** The reviewer's harness as the record names it, such as `Codex`. */
	harness: string;
	model: string;
	effort: string;
	/** Whether it is the shadow: the size's pick one effort lower, beside it on the same heads. */
	shadow: boolean;
	/** Its latest session and round, null when the latest run left it out. */
	session: string | null;
	round: number | null;
	/** Null when the latest run left it out, or on a record written before rounds were scored. */
	score: number | null;
	/** Its findings across every round on the branch, null on a record written before tallies. */
	tally: Counts | null;
	/** The severity of each finding its latest round left open. */
	open: Tally["findings"];
}

const MARK = "Rewritten by `quest review` after each round.";

/**
 * Each reviewer's latest round `body`'s `## Review` section records, or none when `quest review` wrote none
 * there, as when the section records a skipped review or only the land fixer's fixes.
 */
export function parseReview(body: string): ReviewSummary[] {
	const section = reviewSection(body);
	if (!section) return [];
	const all = body.slice(section.start, section.end);
	const at = all.indexOf(MARK);
	if (at < 0) return [];
	// Each reviewer's block starts at its Reviewer line.
	const blocks = all
		.slice(at)
		.split(/^(?=- Reviewer: )/m)
		.slice(1);
	if (blocks.length === 0) throw new Error("the ## Review record names no reviewer");
	return blocks.map((text) => {
		const match = (pattern: RegExp) => {
			const found = pattern.exec(text);
			if (!found) throw new Error(`the ## Review record has no line matching ${pattern.source}`);
			return found;
		};
		const reviewer = match(/^- Reviewer: (.+?), (\S+), (\S+) effort(, shadow)?\r?$/m);
		const tally = parseCounts(text);
		// A reviewer the latest run left out has only its tally.
		const session =
			tally !== null && !/^- Session: /m.test(text)
				? null
				: match(/^- Session: (`+) ?(.*?) ?\1, round (\d+)\r?$/m);
		const score = /^- Score: (\d+)\/10,/m.exec(text);
		const open = { high: 0, medium: 0, low: 0 };
		for (const [, severity] of text.matchAll(/^  - (High|Medium|Low), /gm))
			open[severity!.toLowerCase() as keyof typeof open]++;
		return {
			harness: reviewer[1]!,
			model: reviewer[2]!,
			effort: reviewer[3]!,
			shadow: reviewer[4] !== undefined,
			session: session && session[2]!,
			round: session && Number(session[3]),
			score: score ? Number(score[1]) : null,
			tally,
			open,
		};
	});
}

/** A block's `Rounds:` line, or null without one; malformed or inconsistent counts fail. */
function parseCounts(text: string): Counts | null {
	const line = /^- Rounds: (.*?)\r?$/m.exec(text);
	if (!line) return null;
	const found =
		/^(\d+); findings (\d+)(?: \(([^)]*)\))?: fixed (\d+), refuted (\d+)(?:, settled (\d+))?, open (\d+)$/.exec(
			line[1]!,
		);
	if (!found) throw new Error(`the ## Review record's Rounds line is malformed: ${line[1]}`);
	const findings = { high: 0, medium: 0, low: 0 };
	for (const part of found[3]?.split(", ") ?? []) {
		const [severity, count] = part.split(" ");
		if (!SEVERITIES.includes(severity as keyof typeof findings) || !/^\d+$/.test(count ?? ""))
			throw new Error(`the ## Review record's Rounds line is malformed: ${line[1]}`);
		findings[severity as keyof typeof findings] = Number(count);
	}
	const counts = {
		rounds: Number(found[1]),
		findings,
		fixed: Number(found[4]),
		refuted: Number(found[5]),
		settled: Number(found[6] ?? 0),
		open: Number(found[7]),
	};
	const total = SEVERITIES.reduce((sum, severity) => sum + findings[severity], 0);
	if (total !== Number(found[2]) || counts.fixed + counts.refuted + counts.settled + counts.open !== total)
		throw new Error(`the ## Review record's Rounds line does not add up: ${line[1]}`);
	return counts;
}

/** `body` with `record` as its `## Review` section, which it gains when it has none; the rest stays as written. */
export function withReview(body: string, record: string): string {
	const section = reviewSection(body);
	if (!section) {
		const appended = `${body.trimEnd()}${body.trim() ? "\n\n" : ""}## Review\n\n${record}\n`;
		// A body that ends inside an unclosed code fence or HTML comment would swallow the heading.
		if (reviewSection(appended) === null)
			throw new Error(
				"the PR body ends inside an unclosed code fence or HTML comment; close it so the record can follow",
			);
		return appended;
	}
	const { start, end } = section;
	return `${body.slice(0, start)}\n\n${record}\n${end < body.length ? "\n" : ""}${body.slice(end)}`;
}

/** Where a round's record went: the PR whose body holds it, or why no body changed. */
export type Recorded = { url: string } | { skipped: string };

/**
 * The open PR from `branch` into the base `<remote>/<branch>` names, found among the upstream's PRs from the
 * repository the base's remote pushes to, as claims find a branch's PR; or why there is none.
 */
async function openPull(root: string, baseRef: string, branch: string, deps: ClaimDependencies) {
	// The checkout's top level: a subdirectory would look for the quest tree below it.
	const top = git(root, ["rev-parse", "--show-toplevel"]);
	const { remote, branch: base } = parseBase(top, baseRef);
	const up = await upstream(top, requireRemote(top, remote), deps);
	if (up.github === null) return { skipped: `${remote} is not on GitHub` };
	const { client, repository, head } = up.github;
	const from = `${head.owner}:${branch}`;
	const query = `state=open&head=${encodeURIComponent(from)}&base=${encodeURIComponent(base)}&per_page=100`;
	const [pull] = await client.all(`${repositoryPath(repository)}/pulls?${query}`);
	if (pull === undefined) return { skipped: `no open PR from ${from} into ${base}` };
	const path = `${repositoryPath(repository)}/pulls/${Number(pull.number)}`;
	return {
		client,
		path,
		number: Number(pull.number),
		repository,
		url: string(pull.html_url),
		body: typeof pull.body === "string" ? pull.body : "",
	};
}

/** The `## Models` record of `branch`'s open PR into `baseRef`, or null when it has no PR. */
export async function pullModels(
	root: string,
	baseRef: string,
	branch: string,
	deps: ClaimDependencies,
): Promise<PullModels | null> {
	const pull = await openPull(root, baseRef, branch, deps);
	if ("skipped" in pull) return null;
	return recorded(pull.body);
}

/** Record a run's `rounds` in the `## Review` section of their branch's open PR. The edit is the token's user's, which `/quest-merge` counts only when that user wrote the PR. */
export async function recordRounds(
	root: string,
	rounds: Round[],
	tallies: Tally[],
	deps: ClaimDependencies,
): Promise<Recorded> {
	const [shared] = rounds;
	const pull = await openPull(root, shared!.base.ref, shared!.branch, deps);
	if ("skipped" in pull) return pull;
	const next = withReview(pull.body, reviewRecord(rounds, tallies));
	if (next !== pull.body) await pull.client.request(pull.path, { method: "PATCH", body: { body: next } });
	return { url: pull.url };
}
