// `quest review` rewrites the `## Review` section of its branch's open PR after each round, so the head
// it reviewed counts without an agent copying the round into the body by hand.
import { reviewSection } from "../core";
import { recorded } from "../github/models";
import { type ClaimDependencies, repositoryPath, upstream } from "./claims";
import { git } from "./git";
import { requireRemote, string } from "./github";
import { type PullModels, type Round, located, parseBase } from "./review";

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

/** The `## Review` section's text for `round`, without its heading. */
export function reviewRecord(round: Round): string {
	const lines = [
		MARK,
		"",
		`- Reviewer: ${HARNESSES[round.reviewer]}, ${round.model}, ${round.effort} effort`,
		`- Session: ${code(round.session)}, round ${round.round}`,
		// `quest status` counts a full SHA here as a review of that head, which an open finding has not passed.
		`- Head: ${round.findings.length === 0 ? round.head : `${round.head.slice(0, 12)}, named in full once a round reports no findings`}`,
		`- Base: ${round.base.ref} at ${round.base.sha.slice(0, 12)}`,
		`- Score: ${round.score}/10, ${code(round.rationale)}`,
	];
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
	return lines.join("\n");
}

/** What a PR body's `## Review` record says of its latest round, as `reviewRecord` writes it. */
export interface ReviewSummary {
	/** The reviewer's harness as the record names it, such as `Codex`. */
	harness: string;
	model: string;
	effort: string;
	session: string;
	round: number;
	/** Null on a record written before rounds were scored. */
	score: number | null;
	/** The latest round's findings, open until the next round settles them. */
	findings: number;
	/** The round before's findings this round found fixed, and those whose refutation held. */
	fixed: number;
	refuted: number;
}

const MARK = "Rewritten by `quest review` after each round.";

/**
 * The latest round `body`'s `## Review` section records, or null when `quest review` wrote none there, as when the
 * section records a skipped review or only the land fixer's fixes.
 */
export function parseReview(body: string): ReviewSummary | null {
	const section = reviewSection(body);
	if (!section) return null;
	const all = body.slice(section.start, section.end);
	const at = all.indexOf(MARK);
	if (at < 0) return null;
	const text = all.slice(at);
	const match = (pattern: RegExp) => {
		const found = pattern.exec(text);
		if (!found) throw new Error(`the ## Review record has no line matching ${pattern.source}`);
		return found;
	};
	const reviewer = match(/^- Reviewer: (.+?), (\S+), (\S+) effort\r?$/m);
	const session = match(/^- Session: (`+) ?(.*?) ?\1, round (\d+)\r?$/m);
	const score = /^- Score: (\d+)\/10,/m.exec(text);
	const items = (prefix: RegExp) => text.split(/\r?\n/).filter((line) => prefix.test(line)).length;
	return {
		harness: reviewer[1]!,
		model: reviewer[2]!,
		effort: reviewer[3]!,
		session: session[2]!,
		round: Number(session[3]),
		score: score ? Number(score[1]) : null,
		findings: items(/^ {2}- (High|Medium|Low), /),
		fixed: items(/^ {2}- Fixed: /),
		refuted: items(/^ {2}- Refuted: /),
	};
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

/** Record `round` in the `## Review` section of its branch's open PR. The edit is the token's user's, which `/quest-merge` counts only when that user wrote the PR. */
export async function recordRound(root: string, round: Round, deps: ClaimDependencies): Promise<Recorded> {
	const pull = await openPull(root, round.base.ref, round.branch, deps);
	if ("skipped" in pull) return pull;
	const next = withReview(pull.body, reviewRecord(round));
	if (next !== pull.body) await pull.client.request(pull.path, { method: "PATCH", body: { body: next } });
	return { url: pull.url };
}
