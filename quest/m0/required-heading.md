# [XS] The merge driver drops a Required heading it empties

## Goal

After a merge where the `quest resolve` driver removes the last entry from
an epic's `Required` list, the `## Required` heading is gone too, and
`quest check` passes on the merged tree.

## Plan

Decided 2026-10-31 (user, /quest-plan of the follow-ups from a moq-dev/moq
`/quest-complete` run). [moq-dev/moq#7251](https://github.com/moq-dev/moq/pull/7251)
merged cleanly, then failed `quest check`. The driver had emptied a
`Required` list and left its heading, but the guide says an empty `Required`
section is deleted.

`resolveLists` (`src/core/merge.ts`) merges only the conflicting entries,
so it never sees the heading. After resolving, drop a `Required` heading
whose section is now empty. Leave other empty sections to `quest check`, which
should report them. Test it with both sides each removing one of the last two
entries.

## Related

- [Visible merge-driver fallback](/quest/m0/helpers/merge-driver.md) - the driver's other gap
