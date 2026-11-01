# [S] quest land reports queue conflicts again when the queue changes

## Goal

A queued PR's conflict report stays current: when a PR ahead of it lands,
is requeued, or changes head, `quest land` checks it against the queue again
and updates its single report, saying when a conflict has cleared.

## Plan

Decided 2026-10-31 (user, /quest-plan of the follow-ups from moq.pro's and rust2's cutover to the host gate and the fixer repairs [moq-dev/quest#320](https://github.com/moq-dev/quest/pull/320), [#325](https://github.com/moq-dev/quest/pull/325), [#327](https://github.com/moq-dev/quest/pull/327) and [#328](https://github.com/moq-dev/quest/pull/328)).

- Starts once [moq-dev/quest#322](https://github.com/moq-dev/quest/pull/322)
  lands. It reports a newly queued PR's conflicts with the PRs ahead of it,
  once per queueing, so a PR behind a requeued or changed one is never
  checked again.
- Edit the earlier report rather than adding comments, so a busy queue does
  not flood a PR.
