# [S] Live-check Claude's other worktree routes

## Goal

Every way Claude Code creates a worktree works with `quest worktree
hook`, or the README's "Claude Code checkouts" section says what doesn't:
`--worktree '#123'` and PR URLs, background sessions in agent view,
`claude remote-control` worktree mode, and workflow agents. Each route's
checkout is created, released when its agent stops, and removed.

## Plan

Decided 2026-11-01 (user, /quest-plan of the follow-ups from the
2026-11-01 `/quest-complete` sessions): ✅ plan it, [S], m0, from
[moq-dev/quest#350](https://github.com/moq-dev/quest/pull/350)'s suggested
follow-ups.

- #350 verified subagents, `EnterWorktree`/`ExitWorktree`, a suspended
  decision, a restored session, and a crash with Claude Code 2.1.316.
- PR routes: does Claude still fetch the PR's head when a hook creates the
  worktree, since `WorktreeCreate` starts from `origin/HEAD`?
- Workflow agents: `SubagentStop` releases only a checkout named
  `agent-<agent_id>`. If a workflow agent's worktree is named otherwise, it
  is never released.
- Run from a session that is not itself worktree-isolated, in a scratch
  repository with `QUEST_WORKTREE_HOME` isolated, as #350 did. Fix what
  fails, or plan a quest for it.
