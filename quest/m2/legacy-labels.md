# [XS] Delete the legacy hold labels

## Goal

Condition: quest, moq, moq.pro, rind and rust2 all pin a quest release that
includes [moq-dev/quest#326](https://github.com/moq-dev/quest/pull/326).
Then `LEGACY_IGNORED` in `src/core/hold.ts` and its notes in the README and
`quest iterate --help` are gone, and only `quest:active` and `quest:kix`
count as holds.

## Plan

Decided 2026-10-31 (user, /quest-plan of the follow-ups from moq.pro's and rust2's cutover to the host gate and the fixer repairs [moq-dev/quest#320](https://github.com/moq-dev/quest/pull/320), [#325](https://github.com/moq-dev/quest/pull/325), [#327](https://github.com/moq-dev/quest/pull/327) and [#328](https://github.com/moq-dev/quest/pull/328)).

- Check the condition with each repository's quest pin (`flake.nix` or
  `mise.toml`).
- Decide then whether any other `quest:*` label should still count as a
  hold; recommend only the two.
