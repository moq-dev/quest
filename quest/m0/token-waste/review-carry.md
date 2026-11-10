# [S] A review record carries across a diff-identical head

## Goal

`quest merge <pr> --land <sha>` counts a `## Review` record that names an
earlier head when the branch's own diff is unchanged since it:
`git diff <remote>/<base>...<head>` prints the same as for the reviewed
head. A conflict-free merge of the base then lands without an agent
rewriting the record.

## Plan

Found 2026-11-09 by a workflow audit: over four days, 10 of 107 coordinator
follow-ups sent an agent back to a PR only because "the `## Review` record
still names" the head before a base merge, "so the new head can't be
queued". `/quest-merge` already exempts changes that leave the head's diff
identical (`assets/skills/merge.md`), but the command counts a record only
for the exact SHA it names, so the exemption costs a session each time.

- Carry only this exemption, which a program can decide. The others, such
  as a reviewer's suggested patch applied unchanged, stay the skill's
  judgment.
- `/quest-merge` and `/quest-review` drop the steps that re-record a review
  for such a head.
