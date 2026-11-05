// `quest review` rewrites the `## Review` section of its branch's open PR after each round, so the head
// it reviewed counts without an agent copying the round into the body by hand.
import { reviewSection } from "../core";
import { type ClaimDependencies, repositoryPath, upstream } from "./claims";
import { git } from "./git";
import { requireRemote, string } from "./github";
import { type Round, located, parseBase } from "./review";

const HARNESSES: Record<Round["reviewer"], string> = { claude: "Claude Code", codex: "Codex" };

/**
 * Model text as one inline code span, so a mention, issue reference, or Markdown in it renders as text.
 * The land gate counts every full SHA the section names, so no full SHA appears in it.
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
		"Rewritten by `quest review` after each round.",
		"",
		`- Reviewer: ${HARNESSES[round.reviewer]}, ${round.model}, ${round.effort} effort`,
		`- Session: ${code(round.session)}, round ${round.round}`,
		// The land gate counts a full SHA here as a review of that head, which an open finding has not passed.
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

/** `body` with `record` as its `## Review` section, which it gains when it has none; the rest stays as written. */
export function withReview(body: string, record: string): string {
	const section = reviewSection(body);
	if (!section) return `${body.trimEnd()}${body.trim() ? "\n\n" : ""}## Review\n\n${record}\n`;
	const { start, end } = section;
	return `${body.slice(0, start)}\n\n${record}\n${end < body.length ? "\n" : ""}${body.slice(end)}`;
}

/** Where a round's record went: the PR whose body holds it, or why no body changed. */
export type Recorded = { url: string } | { skipped: string };

/**
 * Record `round` in the `## Review` section of the open PR from its branch into its base, found among the
 * upstream's PRs from the repository the base's remote pushes to, as claims find a branch's PR. The edit
 * is the token's user's, which the land gate counts only when that user wrote the PR.
 */
export async function recordRound(root: string, round: Round, deps: ClaimDependencies): Promise<Recorded> {
	// The checkout's top level, as the round reviewed it: a subdirectory would look for the quest tree below it.
	const top = git(root, ["rev-parse", "--show-toplevel"]);
	const { remote, branch: base } = parseBase(top, round.base.ref);
	const up = await upstream(top, requireRemote(top, remote), deps);
	if (up.github === null) return { skipped: `${remote} is not on GitHub` };
	const { client, repository, head } = up.github;
	const from = `${head.owner}:${round.branch}`;
	const query = `state=open&head=${encodeURIComponent(from)}&base=${encodeURIComponent(base)}&per_page=100`;
	const [pull] = await client.all(`${repositoryPath(repository)}/pulls?${query}`);
	if (pull === undefined) return { skipped: `no open PR from ${from} into ${base}` };
	const body = typeof pull.body === "string" ? pull.body : "";
	const next = withReview(body, reviewRecord(round));
	if (next !== body)
		await client.request(`${repositoryPath(repository)}/pulls/${Number(pull.number)}`, {
			method: "PATCH",
			body: { body: next },
		});
	return { url: string(pull.html_url) };
}
