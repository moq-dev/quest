# [S] The histogram merge property test fits its CPU budget under load

## Goal

The `test/merge.test.ts` property test "merges as git's histogram merge does
on random edits, and differs from merge-file where git does" spends a small,
deterministic amount of CPU, well inside `test/budget.ts`'s 10 s per-test
budget however loaded the host is. It keeps its 1,500 seeds and still checks
the core's merge against real git.

## Plan

Found 2026-11-28 while fixing the base-merge property test's CPU in
[kixel-ai/quest#982](https://github.com/kixel-ai/quest/pull/982): once that
test fell to about 1.1 s, this one became the suite's heaviest, at 3.6 s of
CPU at load ~30 (32 cores, Vitest 5.1, git 2.56). That leaves under 3x of the
5x headroom the budget assumes, so it is the next test to fail the merge
queue under load.

Its cost is `histogram()`: three temp files and one `git merge-file` spawn
per seed, 1,500 spawns.

Recommended: merge every seed at once. Write each seed's base, ours, and
theirs texts as a file `seed-N` in three trees with one `git fast-import`,
run one `git merge-tree --write-tree -X no-renames --merge-base=<base> <ours>
<theirs>`, and read each path's merged blob and whether it conflicted from
its output, with one `git cat-file --batch` for the blobs. That is three
spawns instead of 1,500, and it runs merge-ort itself, which the test's
`histogram()` only approximates with merge-file. The diff property test next
to it (400 `git diff` spawns via `gitHistogram`) may take the same treatment
if it measures heavy.

Measure as kixel-ai/quest#982 did: per-test CPU from `spent()` in
`test/budget.ts`, and `git` spawns counted by a wrapper on `PATH`; record both
before and after. Update the heaviest-test figure in `test/budget.ts`.

## Hosts

- linux - only Linux exposes children's CPU, so the budget applies only there
