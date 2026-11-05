# [XS] Report claude rm's unlock advice upstream

## Goal

anthropics/claude-code has an issue asking `claude rm` to dispatch the
`WorktreeRemove` hook for a checkout a `WorktreeCreate` hook made, as remote
control already does, instead of telling the user to run
`git worktree unlock`, which breaks the hook's lock. Delete this quest once
the issue is filed, or abandon it if the maintainer declines.

## Plan

Decided 2026-11-02 (coordinator, /quest-spawn follow-ups, after the user
asked the coordinator to decide follow-ups from evidence): plan it, [XS],
m0, waiting on the maintainer's approval to post.

Decided 2026-11-04 (maintainer, /quest-unblock): posting on
anthropics/claude-code is approved.

- Can I file the issue on anthropics/claude-code?
  - ✅ Approve posting
  - Decline
  - Skip for now

- [moq-dev/quest#425](https://github.com/moq-dev/quest/pull/425)'s probe
  with Claude Code 2.1.316: `claude rm` on an agent-view session's
  hook-made checkout reports it "locked … by something other than Claude
  Code" and suggests `git worktree unlock`. The README now tells users to
  run `quest worktree remove` first.
- No upstream issue covers it (searched 2026-11-02). Related but different:
  [anthropics/claude-code#79872](https://github.com/anthropics/claude-code/issues/79872)
  (`claude agents` delete skips plugin `WorktreeRemove` hooks),
  [#93676](https://github.com/anthropics/claude-code/issues/93676),
  [#101283](https://github.com/anthropics/claude-code/issues/101283), and
  [#99270](https://github.com/anthropics/claude-code/issues/99270). Link
  them in the report.
- Include the Claude Code version, the minimal reproduction from #425's
  scratch repository, and the expected behaviour.
