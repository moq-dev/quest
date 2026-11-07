# [S] Epics list no children

## Goal

This repository's epic and milestone READMEs no longer list their children,
and `quest check` rejects a README `Required` entry naming a quest in its own
directory. Finishing a quest then deletes its file and edits no README, so
PRs that finish sibling quests stop conflicting there.

## Plan

Decided 2026-11-05 (user, /quest-plan, the
[token waste](/quest/m0/token-waste/README.md) audit): an epic's children are
the quests in its directory, its `Required` lists only what blocks it, and
path order replaces list order.

Measured, moq-dev PRs created 2026-10-06 to 11-05:

- `quest/m1/README.md` was touched by 33% of merged moq-dev/moq PRs, and
  milestone READMEs as a group by 45%; in moq-dev/rust2, `quest/m3/README.md`
  by 290 of 585.
- GitHub's merge queue cannot run quest's merge driver and ejected 723 PRs
  for conflicts.

Decided 2026-11-07 (user): ✅ stage it in two PRs (rejected: admin-bypass
merge once; skip; delete). The merge queue checks a PR with the CLI built
from its base, which rejected the migrated tree.
[moq-dev/quest#518](https://github.com/moq-dev/quest/pull/518) shipped
directory membership with a validator that accepts both formats: an epic's
`Required` link to a quest it holds is allowed and counts once, as a child.
This quest is the second PR:

- Make `remove()` (`src/core/edit.ts`) drop every epic's `Required` link to a
  quest it holds, so `quest check --fix`, `quest rm`, and the land daemon's
  base-merge prune strip old child lists, and let `quest check --fix` run with
  no history to read. #518's commit caa32fc3 has both, with tests.
- Run `quest check --fix` on this tree and on prose that describes the lists.
- Turn `requires X, which this epic holds` into a `quest check` error.
- The PR is breaking: other repositories migrate with `quest check --fix` on
  their pin bump past it, as
  the moq-dev pin bumps did.
