# [L] Rules load once

## Goal

A quest skill's first turn already holds its body and the rules it needs,
and both survive compaction. A Claude Code skill invocation runs no
bootstrap commands, and a Codex one runs a single `quest skill <name>`.
Implementers no longer load rules only reviewers or prompt authors need.

## Plan

Decided 2026-11-05 (user, /quest-plan, the
[token waste](/quest/m0/token-waste/README.md) audit).

Measured, Claude Code 2026-10-28 to 11-05:

- Each skill run takes 3-4 turns before real work: the installed stub
  (`Skill.stub` in `src/cli/skills.ts`) says to run `quest skill <name>`,
  whose output says to run `quest guide` and `quest skill grill`, and the
  guide says to run `quest context`. That is about 27KB (context 17KB, guide
  10KB), roughly 260 instruction sentences, against the 150-200 published
  guidance says models follow reliably.
- `quest guide` ran 2,283 times, `quest skill` 3,057 times (695 sessions ran
  it twice or more), and `quest context` 373 times: about 198M weighted
  tokens.
- These arrive as Bash output, which compaction summarizes away. Claude Code
  re-injects invoked skill bodies (up to 5k tokens each) and the output of
  `SessionStart` hooks matching `compact`.
- `Reviews` is 36% of `assets/CONTEXT.md`, and every implementer loads it.

Decision prompts, chosen options marked ✅:

- Delivery: ✅ injection plus a user hook. Claude stubs inline
  `` !`quest skill <name>` ``, which prints the skill with the guide and
  context sections it needs. A user-level `SessionStart` hook (startup,
  resume, and compact) that `quest setup` installs prints the always-on
  rules, since repositories write no hooks
  ([Agents get the dev shell from user settings](/quest/m0/user-dev-shell/README.md)).
  Codex keeps a single `quest skill <name>` call. Rejected: install full
  skill bodies (each repository's copy drifts from the CLI); one command
  only (rules still vanish on compaction).
- Split `assets/CONTEXT.md` by role: the review procedure moves to
  `/quest-review` and `quest review`'s own output, Prompting stays with the
  path-scoped rule, and question mechanics go to the skills that ask. Say
  each rule once, as Prompting requires.

Recommendations: keep the important lines near the top of each skill, since
re-injection keeps the start of a skill past 5k tokens. A failing `!`
command aborts the skill, so `quest skill` must print the setup pointer
itself when it cannot run.
