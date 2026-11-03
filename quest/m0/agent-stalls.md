# [M] Long waits, known failures, and reviewer outages don't stall agents

## Goal

An agent blocks on a long build or `quest gate` run in the same turn instead
of ending its turn with it in the background, and re-runs a timed-out gate
wait instead of cancelling it. A failure that reproduces unchanged on the
base is recorded as pre-existing and the PR still goes through review and
readiness, without bypassing the repository's harness. A reviewer that is
out of quota or logged out becomes a `## Waiting` item naming when it resets,
so the PR resurfaces instead of stalling silently.

## Plan

Decided 2026-11-02 (maintainer, /quest-plan of the follow-ups from a scan of
the maintainer's Claude Code and Codex transcripts since 2026-10-12):

- Is that the goal? Two quests (waits; failures and outages); ✅ one combined
  quest; only the waits.
- Which milestone? ✅ m0, after the land work and before Kix; m0 last; m1.

Evidence from the scan:

- Waits: 417 of 1,108 sub-agent completion messages were interim status
  ("Waiting on `just fix`…", "`just ci` is rerunning") across 13 coordinator
  sessions, and parents had to correct 14 sub-agents ("Your turn keeps ending
  while `just ci` runs in the background", 2026-10-30). Six reports gave up on
  `quest gate` admission ("Full CI never gained host admission", 2026-10-31).
  Inferred cause: `just ci` runs past the guide's "bound each wait under an
  hour", so agents background it and stop.
- Known failures: a toolchain failure broke moq's full local gate for 32
  sub-agents (2026-10-29 to 11-02). 14 bypassed it (unsetting `BASH_ENV`,
  disabling the tool) and marked the PR ready, 3 refused to run `quest
  review` citing "Commit and pass the repository's checks first", and the
  rest stayed drafts; parents sent corrections such as "do not disable mbx …
  or claim an overridden diagnostic is the unmodified gate".
- Reviewer outages: about 29 sessions (2026-10-30 to 11-01) ended "Required
  Claude review hit its weekly quota, so the PR remains draft", while spawn
  kept starting agents.

Files: the guide's Workspace and Reviews sections in `assets/AGENTS.md`,
`assets/skills/review.md`, `assets/skills/spawn.md`, `assets/skills/afk.md`.

- Workspace: spell out the blocking recipe: run the gated command in the
  foreground with its exit code read directly; when it may outlast the tool's
  limit, start it in the background and block on it in the same turn with
  the harness's wait, re-running the wait on timeout. A coordinator stays
  silent on interim reports.
- Reviews: a failure that reproduces unchanged on the base is pre-existing:
  record the reproduction in the PR's validation and go on; never alter the
  harness to get a pass. Spawn passes a blocker two agents report into later
  briefs.
- Reviews: the reviewer's quota or login failure is an outside party's
  `## Waiting` item with its reset time and the check (`quest review` runs),
  so `quest waiting` and `/quest-unblock` list it and `/quest-afk`
  re-dispatches `/quest-review` after the reset. Spawn reports the outage
  once, not per agent.
