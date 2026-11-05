# [M] quest review runs opencode reviewers

## Goal

`quest review --harness opencode` reviews a branch as
the Claude Code and Codex reviewers do: read-only, running nothing from the
reviewed head, following the base's `AGENTS.md` and `REVIEW.md`, resuming
one session per branch across rounds, and returning findings in the same
schema. `just review-sandbox`'s planted hostile repository proves it.

## Plan

Decided 2026-11-04 (user, /quest-plan): `/quest-council` needs a reviewer
per maker. Planned in m0 for ranked single reviews, it moved to m2 with
the council once single reviews became Sol only (user, the same day).

- Sandboxing is the work. The reviewer must not run code from the head or
  write anywhere. opencode already runs kix jobs inside srt
  (`src/runner/opencode.ts`, `src/runner/cli.ts`); reuse that boundary.
- Grok was dropped from this quest on 2026-11-05 (user, /quest-plan): its
  weekly usage is close to zero and its results were weak, so the council
  has no xAI member.
- opencode's own review mode if it has one, as Codex's `exec review` and
  Claude Code's `/code-review`; otherwise one turn with the review prompt,
  then the schema turn.
- Report a logged-out CLI and a usage limit distinctly, as `quest review`
  does for Claude Code and Codex (exit 3 with the reset, through
  `ReviewLimitError` and `src/cli/limit.ts`), so the council can run
  without that maker.
- The [model check](/quest/m1/model-check.md)'s sandbox test covers all
  three reviewers from then on; the PR adds opencode to its Plan.
