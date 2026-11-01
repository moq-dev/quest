# [S] Sibling quest PRs land through a server-side merge

## Goal

Several PRs that each finish a child of the same epic land back to back
through a server-side merge, such as a GitHub merge queue, without each
landing knocking the next one out on a conflict in the epic's link list, or
on a `quest check` failure over a quest the base just finished.

## Plan

Decided 2026-10-25 (user), from a moq-dev/moq merge wave. Nine
test-flake PRs each deleted their own line from one epic README's
`Required` list. The local `quest` merge driver resolves those edits, but
GitHub's merge queue builds its merge commit without it. Each landing
conflicted with the next queued sibling, which cost four extra
drop, merge, and re-land cycles in one batch.

A second symptom: a quest-only PR waiting in the queue fails `quest check`
once main finishes a quest it links. moq-dev/moq#6707 was dropped 3 times
and moq-dev/moq#6790 4 times. Options: run `quest check` against current
main before queueing, or have the check treat a link to a deleted quest as
resolvable. A pre-queue check alone misses a base that moves after queueing,
and a tolerant check must tell a finished quest from a mistyped link.

The fix belongs in quest, not in each repository's process. Rejected:
landing one sibling at a time, which serializes batches.

Narrowed 2026-10-26 (user): `quest land` runs
the merge driver while it builds its chain, so a repository on that gate no
longer hits the link-list conflict. This quest keeps the dead-link
`quest check` failure on every gate, which caused 6 of moq's queue failures
from 2026-10-23 to 10-26, and the link-list conflict for repositories that
still merge through GitHub's merge queue. Its third option below is what
`quest land` does.

Narrowed 2026-10-31: before batching, `quest land` runs `quest check` on
each queued PR squashed alone onto the current base, and ejects a PR whose
new findings, such as a link to a quest the base finished, fail it, with that
output. It no longer fails a whole batch. That is the pre-queue check above,
run against every base the PR waits on. The PR is still ejected and needs a
fix, so this quest keeps the tolerant check or another way to spare it, on
every gate.

Open (this quest decides, with a recommendation to the user):

- Change the link-list format so deleting one entry never touches its
  neighbors' lines in a 3-way merge.
- Or keep the finishing PR's diff off the shared parent list. Example: drop
  the link in a later pass, or have `quest check` treat a link to a deleted
  child as done rather than broken.
- Or have `quest merge --land` merge the base locally with the driver and
  re-land when the queue drops a PR only for a link-list conflict.

Whatever it picks must keep `quest check`'s rule that a finished quest leaves
no dangling reference once all siblings land. Test it with two sibling PRs
landing through a merge that does not run the driver.
