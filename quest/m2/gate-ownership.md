# [M] Own gated descendants everywhere

## Goal

A gate inside a `quest worktree run` scope owns its own subtree, and on
Windows a gate owns its command's descendants, not just the command.

## Plan

Decided 2026-10-28 (user, /quest-plan of the follow-ups from a 25-PR /quest-complete run), from [moq-dev/quest#261](https://github.com/moq-dev/quest/pull/261),
which made the gate own descendants through systemd scopes on Linux and a
process group on macOS.

- **Delegated sub-cgroups.** Set `Delegate=yes` on `quest worktree run`
  scopes, so a nested gate can create a child cgroup instead of deferring to
  the enclosing scope. Today it defers, because a new scope would let
  `cgroup.kill` on the outer scope leave the gated command running.
- **Windows Job Objects.** Assign the command to a Job Object with
  kill-on-close, so stopping the gate stops every descendant.
