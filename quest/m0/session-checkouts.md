# [M] A Claude session's checkout is released when the session ends

## Goal

A checkout `quest worktree hook` made for a Claude Code session itself (not
a subagent), through `--worktree`, `--bg`, or agent view, is released when
the session ends and claimed again when it resumes, so session checkouts no
longer pile up the way Claude Code's own do.

## Plan

Decided 2026-11-02 (coordinator, /quest-spawn follow-ups, after the user
asked the coordinator to decide follow-ups from evidence): plan it, [M], m0.

Evidence, gathered 2026-11-02:

- [moq-dev/quest#425](https://github.com/moq-dev/quest/pull/425)'s live
  probes found session checkouts never released by any route.
- Claude Code's own session worktrees (not `agent-*`) already accumulate:
  32 registered in moq.pro, 21 in moq, and 3 in quest (2026-10-14 to
  10-27), beside 449, 124, and 26 `agent-*` worktrees. Once the hooks own
  these checkouts the same backlog would build in the registry.

Work:

- Install `SessionEnd` and `SessionStart` hook entries through
  `quest init`, recognised by `init` and `uninstall` like the others.
- `SessionEnd` releases (never removes) the session's checkout;
  `SessionStart` claims it again on resume. `/clear` also fires
  `SessionEnd`, so release is idempotent and the next `SessionStart`
  reclaims it. An idle background session never ends; leave it held.
- Verify each route live as #425 did, from a session that is not itself
  worktree-isolated.
