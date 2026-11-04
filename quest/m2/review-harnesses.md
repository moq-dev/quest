# [L] quest review runs Grok and opencode reviewers

## Goal

`quest review --harness grok` and `--harness opencode` review a branch as
the Claude Code and Codex reviewers do: read-only, running nothing from the
reviewed head, following the base's `AGENTS.md` and `REVIEW.md`, resuming
one session per branch across rounds, and returning findings in the same
schema. `just review-sandbox`'s planted hostile repository proves both.

## Plan

Decided 2026-11-04 (user, /quest-plan): `/quest-council` needs a reviewer
per maker. Planned in m0 for ranked single reviews, it moved to m2 with
the council once single reviews became Sol only (user, the same day).

- Sandboxing is the work. The reviewer must not run code from the head or
  write anywhere. opencode already runs kix jobs inside srt
  (`src/runner/opencode.ts`, `src/runner/cli.ts`); reuse that boundary.
  For Grok, find what its permission rules (`--deny`, `--allow`,
  `--disallowed-tools`) and config can lock down, and wrap it in srt if
  they are not enough.
- Each CLI's own review mode where it has one, as Codex's `exec review`
  and Claude Code's `/code-review`; otherwise one turn with the review
  prompt, then the schema turn.
- Report a logged-out CLI and a usage limit distinctly, as
  [Reviewer usage limits](/quest/m0/review-quota.md) does for the others,
  so the council can run without that maker.
- The [model check](/quest/m1/model-check.md)'s sandbox test covers all
  four reviewers from then on; the PR adds them to its Plan.

## Related

- [Reviewer usage limits](/quest/m0/review-quota.md) - the distinct usage-limit exit each reviewer reports
