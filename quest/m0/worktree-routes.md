# [XS] Live-check remote control's worktrees

## Goal

`claude remote-control --spawn worktree` works with `quest worktree hook`, or
the README's "Claude Code checkouts" section says what doesn't: a session
spawned from claude.ai or the Claude app gets a hook-created checkout, and
ending the session removes it when it has no changes and keeps it otherwise.

## Plan

[moq-dev/quest#425](https://github.com/moq-dev/quest/pull/425) live-checked
the other routes with Claude Code 2.1.316 and documented them. Remote control
needs a session spawned from claude.ai or the Claude app, which a headless
agent can't do, so its README description comes from Claude Code's own code:

- The bridge creates a spawned session's worktree through `WorktreeCreate`,
  named `bridge-<session ID>`, and no `SubagentStart` or `SubagentStop` fires
  for it, so it is never released.
- When the session ends, or `claude remote-control` shuts down, it compares
  the checkout with the commit it started at. A checkout without changes is
  removed through `WorktreeRemove`, and one with changes is kept.
- The bridge never runs `git worktree unlock` on a hook-created checkout,
  since it records no Git root for one, so quest's lock stays in place.

Check it from a scratch repository with the worktree hooks configured (the
opt-in user-level setup the README's "Claude Code checkouts" section
describes), with
`QUEST_WORKTREE_HOME` isolated: start `claude remote-control --spawn worktree`,
spawn a session from claude.ai, end it once without changes and once with an
untracked file, and watch `quest worktree status`. Fix the README if it
differs.

## Waiting

- Maintainer: spawn a remote-control session from claude.ai or the Claude app against a scratch repository, as the Plan says; done once the README matches what happened.
