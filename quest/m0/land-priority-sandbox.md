# [XS] Land checks run at gate priority

## Goal

`quest land serve` runs each batch check with `QUEST_GATE_PRIORITY=1`, so a
repository's nested `quest gate` calls admit the land check ahead of agent
load.

## Plan

Decided 2026-10-31 (user, /quest-plan of the follow-ups from moq.pro's and rust2's cutover to the host gate and the fixer repairs [moq-dev/quest#320](https://github.com/moq-dev/quest/pull/320), [#325](https://github.com/moq-dev/quest/pull/325), [#327](https://github.com/moq-dev/quest/pull/327) and [#328](https://github.com/moq-dev/quest/pull/328)).

- Starts once [moq-dev/quest#324](https://github.com/moq-dev/quest/pull/324)
  lands; it adds the variable. Pass it to the `--sandbox` command from
  `src/cli/land-serve.ts`. The host also exports it in its check command,
  which the [gate host](/quest/m0/host-land/host.md) owns.
