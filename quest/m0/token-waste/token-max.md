# [XS] Point to token-max

## Goal

Quest's `SETUP.md` recommends [token-max](https://github.com/kixelated/token-max)
for checking agent settings, and this epic's closing re-measure runs it
beside `quest usage`.

## Plan

Decided 2026-11-05 (user, /quest-plan,
[moq-dev/quest#513](https://github.com/moq-dev/quest/pull/513)): the settings
doctor first planned as `quest doctor` is a standalone Rust CLI with no
quest wrapper. Its plan, survey, and checks moved to kixelated/token-max's
own quest tree ([kixelated/token-max#1](https://github.com/kixelated/token-max/pull/1)),
so this quest keeps only quest's side.

## Waiting

- kixelated/token-max: publish 0.1.0 on crates.io; check with `cargo search token-max`
