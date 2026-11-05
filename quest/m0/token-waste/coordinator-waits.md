# [M] Coordinators and waits

## Goal

Long coordinators (`/quest-complete`, `/quest-spawn`, `/quest-afk`) keep
their state in GitHub and the quest tree and rely on compaction instead of
growing without bound. Sub-agent reports stay short. Every wait blocks on a
terminal state in one call instead of polling, and agents batch independent
reads and searches into one turn.

## Plan

Decided 2026-11-05 (user, /quest-plan, the
[token waste](/quest/m0/token-waste/README.md) audit).

Measured, Claude Code 2026-10-28 to 11-05:

- The most expensive session was a `/quest-complete` coordinator: 1,895
  turns at a mean context of 444k, peaking at 966k, with 374 delegated-task
  reports of up to 37k characters each. `/quest-complete` and
  `/quest-spawn` are 32% of all cost.
- Polling cost 264M (6.8%): 1,165 `until grep -q "^EXIT=" ...; do sleep`
  loops, 2,701 sleep calls, 850 background waits that returned nothing, and
  1,204 `quest wait` calls. In Codex interactive sessions, polling requests
  were 19.6% of input.
- Serial exploration: search and read calls trigger 35% of turn cost, at
  1.11 tool calls per request, so each read re-sends the whole context.
- T3 Code sessions never saw the dotfiles' `BASH_MAX_TIMEOUT_MS`, so
  foreground waits hit the 10-minute cap. The maintainer's user settings now
  set it to 3300000, just under the 1h cache TTL.

Decision prompts, chosen options marked ✅:

- Coordinator context: ✅ rely on compaction (rejected: a handoff and
  restart after N picks). Claude Code reminds the session which background
  agents still run after compacting, so finished children shrink to the
  summary without a status file. Automatic compaction cannot be steered, so
  state that must persist belongs in GitHub and the quest tree.

Recommendations for the implementer:

- Cap a child's report at the PR, its state, and the decisions it needs,
  with details in the PR body.
- `quest setup` sets the Bash timeout cap for Claude Code under the cache
  TTL, so no session depends on a shell profile.
- Name the banned shapes (sleep or `until` loops, short-timeout waits) once,
  where waits are described.
