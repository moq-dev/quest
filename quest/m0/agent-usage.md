# [M] Agent admission reads Claude's usage and sizes an agent's share

## Goal

`quest agent admit`, `start`, and `resume` refuse a Claude agent its account's
usage cannot cover, as they already do for Codex, and expect more of the
account from a large quest's agent than from a small one's.

## Plan

Found 2026-11-12 while building agent admission
([moq-dev/quest#692](https://github.com/moq-dev/quest/pull/692)), which
checks the host for every harness and the account for Codex alone:

- Claude Code 2.1.322 gives no command its usage windows. Its docs name them
  only in the JSON a `statusLine` command receives (`rate_limits.five_hour`
  and `rate_limits.seven_day`, each with `used_percentage` and `resets_at`),
  for claude.ai subscribers. A headless `claude -p --output-format
  stream-json --verbose` turn on the CLI's own login printed no
  `rate_limit_event`, which the SDK docs say comes only when a limit's status
  changes, and no transcript or file under `~/.claude` holds the windows. So
  admission says Claude reports no usage and checks the host alone.
- Sessions through a credential-pool gateway (`ANTHROPIC_BASE_URL`) have no
  single account: a pool's windows are its credentials', which only the
  gateway knows, and asking it is a non-goal of admission.
- An agent's expected share is the token-weighted mean share of the host's
  sessions since the window opened, whatever its quest's size. `quest
  usage`'s per-size history, which the plan named, took 21 seconds and a
  listing of the repository's PRs per call on the maintainer's host, and
  attributed 29 of 964 sessions to a PR, with no row for L or XL.

Agent's choices, for the implementer to revisit:

- Read Claude's windows from a status line: `quest setup` installs a
  `statusLine` command that records the `rate_limits` it is given, chaining
  to the one the user already has, and admission reads the newest record.
  It covers only hosts where an interactive session runs on the account.
- For sizes, take `--size` on `admit`, `start`, and `resume`, and scale the
  host's mean share by the size's share of spend where `quest usage` has
  history for it, read from a cache a coordinator refreshes once per run.

## Waiting

- Maintainer: whether an agent's expected share stays the host's mean for every size (recommended: the per-size history is too thin to change a decision, and a wrong size estimate refuses agents the account could carry) or takes the quest's size as above. An agent cannot pick: the plan decided per-size history before the data showed how little of it there is. Check: this item is answered in the Plan.

## Related

- [Cut agent token waste](/quest/m0/token-waste/README.md) - the other half of what an account's usage buys
