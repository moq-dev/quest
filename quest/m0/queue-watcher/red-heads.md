# [S] quest merge refuses a head whose checks failed

## Goal

`quest merge <pr> --land <sha>` refuses a head on which any check's latest
run failed, required or not, and names the failing check. A pending or
absent check does not block. The agent fixes or reruns the check, then
lands. `/quest-merge` describes the refusal.

## Plan

Decided 2026-11-09 (user, /quest-plan), from a workflow audit of
moq-dev/moq's queue, 2026-11-03 to 11-10: in 20 of 82 failed `merge_group`
builds, the PR's own hosted `Check` had already failed at the head that was
queued, and each spent a queue build and a fixer run.

- ✅ Refuse failed heads (rejected: also wait for pending checks, which
  adds the hosted runners' latency to every landing; leave `Check`
  advisory).

This keeps the epic's "no pre-checks" decision: it runs nothing and reads
only the results already on the head. Today `quest merge` refuses only a
failing required check, and `Queue`, the one required check, skips on pull
requests, so nothing a PR's own CI reports can stop a landing.

A check that fails for a reason outside the PR, such as a flaky test, is
rerun like any other; add no flag to land past it.
