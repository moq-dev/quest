# [S] Fewer git processes on Windows

## Goal

The CLI and its tests spawn far fewer git processes, so Windows runs, where
each process start is slow, finish faster. Repeated lookups in one command
are batched. Tests reuse copied fixture repositories with
`maintenance.auto=false` instead of creating each one from scratch.

## Plan

Decided 2026-10-28 (user, /quest-plan of the follow-ups from a 25-PR
/quest-complete run), from
[moq-dev/quest#233](https://github.com/moq-dev/quest/pull/233). `quest mv`
runs `git remote get-url origin` twice plus `git config --get
remote.origin.url`, and `quest start` runs similar sets. Native Windows tests
needed a file-level time limit in #233. Measure process counts and Windows
test time before and after.
