# [S] Keep local merges and the merge driver current

## Goal

A local merge of the base into a quest branch needs no hand edits for
links to quests the base finished: a command, such as `quest check --fix`,
drops those list links as `quest land` does. Clones whose
`merge.quest.driver` an older quest version registered get the current
driver, while a custom driver stays untouched. The dev shell's
`quest-pinned` flake input stays current, so its merge driver has the
latest fixes.

## Plan

Decided 2026-11-01 (user, /quest-plan of the follow-ups from the
2026-11-01 `/quest-complete` sessions): ✅ plan it, [S], m0.

- Finished links:
  [moq-dev/quest#353](https://github.com/moq-dev/quest/pull/353) makes
  `quest land` drop `Required`, `Related`, and `Closes` links to quests
  the base deleted since the PR's merge base, using core `remove()`. Apply
  the same edit in a checkout after merging the base, for example with
  `quest check --fix` or `quest resolve --finish <merge-head>`, and point
  the guide's merge line at it. Links in prose stay for a person to fix.
- Driver upgrades: `heal` in `src/cli/setup.ts` sets
  `merge.quest.driver` only when none is configured, so clones keep the
  driver an older quest wrote and miss
  [moq-dev/quest#344](https://github.com/moq-dev/quest/pull/344)'s fallback
  warning. Recognize earlier quest-generated driver strings and replace them
  with the current `DRIVER`.
- The pin: [moq-dev/quest#344](https://github.com/moq-dev/quest/pull/344)
  added the `quest-pinned` input, which only a manual `nix flake update
  quest-pinned` bumps. Pick how it stays current, such as Dependabot's nix
  updates, a step in the release checklist, or a recurring quest, and do it.

## Related

- [Merge queue siblings](/quest/m0/helpers/queue-siblings.md) - the landing-time drop this quest brings to local merges
