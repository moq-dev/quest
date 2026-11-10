# [L] A quest's PR targets its epic's branch

## Goal

`quest start` on a quest inside an epic opens its draft PR against the
epic's branch, creating that branch from `main` and the epic's own draft PR
into `main` when they are missing. A quest directly under a milestone still
targets `main`. Claims, `quest unblocked`, `quest status`, `quest wait`,
`quest review` and `quest check --base` read the right base for each, and
the skills and guide name the base instead of assuming `main`.

## Plan

The decisions are in [the epic](/quest/m0/epic-branches/README.md); its
recommendations on the branch's name, partly landed epics, blockers in
other epics, and planning PRs are this quest's to settle or follow.

- [moq-dev/quest#44](https://github.com/moq-dev/quest/pull/44) removed the
  earlier machinery (`quest branch`, `src/branch.rs`, reading a questline
  from its branch on `origin`); read it for what existed, not to restore
  it. With one level there is no chain of bases to print.
- A quest finished on its epic's branch is deleted there and still present
  on `main`. `quest unblocked` in a checkout of `main` must not offer it
  again, nor report its siblings blocked on it: decide from the epic's
  branch on the remote.
- `quest/<epic>/README` already names the epic's claim branch, and
  [moq-dev/quest#214](https://github.com/moq-dev/quest/pull/214) keeps a
  branch named after an epic from blocking its quests' claims.
- A draft PR needs a commit ahead of its base; `quest start` already pushes
  an empty claim commit, which serves for the epic's PR too.

## Related

- [No nested epics](/quest/m0/epic-branches/no-nesting.md) - makes a quest's base its parent directory's branch or `main`, never deeper
