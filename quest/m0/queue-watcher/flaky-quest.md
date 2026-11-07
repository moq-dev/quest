# [S] The watcher writes flaky quests

## Goal

When the queue watcher disables a test seen flaking twice, the follow-up
quest (`quest/m0/flaky/<name>.md`, with its epic created when missing)
comes from a fixed template in `quest land watch`, not from the land fixer.
The fixer's `disable` commit holds only the skip, whose reason names the
quest path the watcher chose. No headless agent writes quest prose.

## Plan

Decided 2026-11-05 (user, /quest-plan). The user's rule: quests are written
only by a coordinator (`/quest-complete`, `/quest-spawn`) on Opus, never by a
sub-agent. The skills already follow it: only `/quest-merge` and
`/quest-complete` plan follow-ups, and `/quest-plan` refuses to run in an
agent that cannot prompt. The land fixer, a headless Codex agent, is the one
exception: `assets/land-fix.md` has it write the flaky quest, and the
`quest/m0/flaky/README.md` epic when missing, in the disable commit, and
`src/cli/land-watch-flaky.ts` requires exactly one added quest file.

Decision prompts, chosen options marked ✅:

- Who writes it: ✅ the watcher, from a template (rejected: the fixer
  reports the test and a coordinator runs `/quest-plan` on it later, which
  leaves the skipped test untracked until then; keep the exception).
- Milestone: ✅ m0, in the queue watcher epic, whose end-to-end run
  disables a flaky test (rejected: m1).

Recommendations for the implementer:

- The watcher already knows the test (the `failure` the fixer names, from
  its known-flaky input) and the `merge_group` jobs that showed it, so it
  picks `<name>` and passes the quest path in the fixer's input for the skip
  reason, then adds the quest file to the disable commit itself, or as a
  second commit on the disable branch.
- The template's Goal says to fix the test or delete it and links each job.
  Its size is a fixed guess, such as `[S]`, for the next coordinator to
  correct.
- Epic READMEs list no children, so the quest file is the only tree edit
  besides creating the epic's README when missing.
- `validateFix` then rejects a disable commit that touches `quest/` at all.
