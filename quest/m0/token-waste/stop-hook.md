# [M] A turn cannot end on a running gate

## Goal

An agent no longer ends its turn while a `quest gate` command it started is
still running: a `Stop` hook that `quest setup` installs refuses, naming
the command and telling the agent to block on it. `quest setup` also sets
Claude Code's default Bash timeout to its maximum, so a long foreground
command needs no backgrounding. The rule's prose leaves `quest context`
where the hook now enforces it.

## Plan

Decided 2026-11-09 (user, /quest-plan), from a workflow audit: over four
days of coordinators delegating through the T3 Code harness, 64 of 107
follow-up messages (277 delegations) told a child it had ended its turn on
an interim report with a build or check in the background, which kills the
command and leaves the thread idle. `quest context` already forbids this in
prose.

- ✅ A `Stop` hook plus the timeout (rejected: a `PreToolUse` hook that
  denies every `run_in_background`, which also blocks background work a
  foreground coordinator does wait on; the timeout alone).

Guidance:

- The maintainer's settings hold `BASH_MAX_TIMEOUT_MS=3300000` but no
  `BASH_DEFAULT_TIMEOUT_MS`, so a foreground command stops at two minutes
  unless the agent passes a timeout. That is a likely cause, not a proven
  one; measure the follow-ups again after the change.
- The hooks `quest setup` installs are listed in `src/cli/hooks.ts`, and
  [moq-dev/quest#553](https://github.com/moq-dev/quest/pull/553) added the
  first enforcing one. Check what Claude Code's `Stop` and `SubagentStop`
  hooks and Codex's equivalent receive and how each refuses; where a
  harness cannot refuse, the prose stays for it.
- The hook must tell which gates the ending session started. A gate runs in
  its own systemd scope and knows its caller's environment; recording the
  session there is one way.
- A hook that refuses again and again would trap a session whose gate
  hangs. It refuses only while the gate is alive, and `quest gate` already
  stops on cancellation.
- `quest setup` edits the user's own settings, so the hook reaches a host
  only when its user reruns it; the PR says so. As of 2026-11-09 the
  maintainer's desktop holds none of the hooks #553 added.
