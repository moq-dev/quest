# [S] Runner reviews never block the runner, and Codex is pinned

## Goal

A runner's review of a published head never blocks the runner process.
Its `git fetch` and `ls-remote` run asynchronously, under the workspace lock
that guards the shared clone. The runner package pins a Codex CLI, so any
runner user with a Codex login can review a Claude Code job.

## Plan

Decided 2026-11-03 (coordinator, /quest-complete follow-ups, under the
user's 2026-11-02 instruction to decide follow-ups from evidence): plan it,
[S], in the kix epic. Both items come from
[moq-dev/quest#417](https://github.com/moq-dev/quest/pull/417)'s
follow-ups. The 2026-11-02 follow-up review sent them to that PR as
[a comment](https://github.com/moq-dev/quest/pull/417#issuecomment-6596307686),
and #417 merged without them. Its third follow-up, cancelling a running
review with its job, was fixed in #417's own first review round: the
attempt's abort signal kills the reviewer CLI (`src/runner/review.ts`).

Evidence, gathered 2026-11-03 on `main`:

- `reviewHead` (`src/runner/review.ts:68`) runs `quest review`'s `review()`
  in the runner process. `review()` runs `git ls-remote --symref`
  (`src/cli/review.ts:807`) and `git fetch` (`:888`) through `gitOutput`
  (`src/cli/claims.ts`), which is `execFileSync`. The review checkout's
  `origin` is the GitHub URL (`src/runner/workspace.ts:102`), so each
  network call stalls the runner's WebSocket and its other jobs. It also
  fetches into the shared clone outside `locked()` (`workspace.ts:414`),
  which every other fetch there holds.
- `flake.nix` pins `QUEST_RUNNER_CLAUDE`, `QUEST_RUNNER_OPENCODE` and
  `QUEST_RUNNER_SRT`, but no Codex. `reviewerFor` reviews a Claude Code job
  with whatever `codex` is on the runner user's `PATH`. Without one, the
  review fails and the head falls back to waiting on a person's approval.
  nixpkgs' codex 0.164.0 accepted every flag `quest review` passes, checked
  2026-11-02.

Work:

- Make the review's git calls async (`review()` already is), or prefetch the
  base in `reviewCheckout` under the lock and pass `--base` so `review()`
  needs no network. Prefer the prefetch, which keeps `quest review` itself
  unchanged. Test that a slow fetch doesn't block a concurrent runner
  message.
- Add `--set-default QUEST_RUNNER_CODEX ${getExe pkgs.codex}` to the runner
  wrapper. In `reviewerFor`, put that binary's directory first on `PATH`, as
  for Claude Code. The user still brings their own Codex login.
- Note the pin in the runner docs, beside the Claude Code and opencode pins.
