# [S] A failed fixer still hands back the gate's failure

## Goal

When the land fixer fails for its own reasons (a crash, a refused launch, a
timeout, an invalid result), its handback still quotes the gate's own failure:
the check output that dropped the PR. The PR's author sees the real cause
without reading the host's logs. A test fails a fixer run on purpose and finds
the gate's failing output in the handback's comment.

## Plan

Planned 2026-11-10 (maintainer, /quest-plan in moq-dev/moq.pro): ✅ m0, in this
epic (rejected: m1). Every hidden failure costs a person a round trip.

Found on moq-dev/moq.pro on 2026-11-10. From 00:33Z to 22:43Z the host's fixer
launcher refused every run (kixelated/nixos, fixed by its #46), and each
handback quoted only `quest land check: [Errno 32] Broken pipe`. The gate's own
logs held the real causes, all fixable without a person: a type error from a
base merge, a migration check that needs a remote, and a batchmate's oversized
skill file. Requeueing by hand then dropped the same innocent PRs again.

`land-fixer.ts` already keeps "the failure log the fixer read, which a
handback's comment quotes", but on these runs the quoted log was the wrapper's
41-byte error. Find where that log is chosen on each failure path in `settle`,
and quote the check's failing output there. Name the fixer's own error
separately, as the comment's reason.

## Related

- [Land through a serial merge queue with an async fixer](/quest/m0/queue-watcher/README.md) -
  the fixer this hands back from
