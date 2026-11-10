# [S] The land fixer survives a closed pipe

## Goal

A fixer run on a dropped PR finishes with a fix, a flaky verdict, or a
handback that names a decision, never a crash from a closed pipe. A test
closes the reader of the step that crashed and finds the run still reports.

## Plan

Planned 2026-11-10 (maintainer, /quest-complete in moq-dev/moq). Milestone:
✅ m0, in this epic (rejected: m0 standalone, m1).

On moq-dev/moq the fixer handed back two ordinary drops with
`fixer crashed (exit 1); run /quest-iterate` and the output
`quest land check: [Errno 32] Broken pipe`:
[moq-dev/moq#8406](https://github.com/moq-dev/moq/pull/8406) (a failed
`merge_group` build, caused by a dead quest link) and
[moq-dev/moq#8429](https://github.com/moq-dev/moq/pull/8429) (a merge
conflict). Each then needed a person. `[Errno 32]` is Python's wording, so
the crash may be in a script the fixer runs rather than in Quest's
TypeScript; find which process prints it from the host's fixer logs first.
If it is moq-dev/moq's own check script, fix it there instead (its
`sh/migrate.sh` had the same `grep -q` under `pipefail` bug, fixed in
[moq-dev/moq#8424](https://github.com/moq-dev/moq/pull/8424)) and delete
this quest.

Seen again 2026-11-10 on moq-dev/moq.pro, where it dropped about a dozen PRs
in a day. There the batch check logs under the land state directory never
contain the Broken-pipe line: they end with the real failure (a test, a
typecheck, a merge conflict, or a timeout with exit 124), and the line shows
up only in the fixer's handback. So the crash is in the fixer's own run, not
in the repository's check, and the handback hides that real failure. A fixed
fixer should still name it.

Public API: none. Wire: none.
