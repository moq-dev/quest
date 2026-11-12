# [XS] Point to token-max

## Goal

Quest's `SETUP.md` recommends [token-max](https://github.com/kixel-ai/token-max)
for checking agent settings, and this epic's closing re-measure runs it
beside `quest usage`.

## Plan

Decided 2026-11-05 (user, /quest-plan,
[moq-dev/quest#513](https://github.com/moq-dev/quest/pull/513)): the settings
doctor first planned as `quest doctor` is a standalone CLI with no
quest wrapper. Its plan, survey, and checks moved to kixel-ai/token-max's
own quest tree ([kixel-ai/token-max#1](https://github.com/kixel-ai/token-max/pull/1)),
so this quest keeps only quest's side.

Amended 2026-11-06 (maintainer, /quest-plan in token-max): first use should
be one command. The maintainer delegated packaging and allowed TypeScript;
token-max now plans Node-compatible TypeScript and npm distribution
([kixel-ai/token-max#2](https://github.com/kixel-ai/token-max/pull/2)).
Use `npx --yes @kixelated/token-max@latest`, or `bunx --bun @kixelated/token-max@latest` for
Bun-only execution. This supersedes the crates.io release dependency; it
does not require a quest wrapper or Rust toolchain. The scoped package
keeps the `token-max` command while avoiding reliance on the unverified
unscoped npm name.

## Waiting

- kixel-ai/token-max: publish 0.1.0 on npm; check `npm view @kixelated/token-max@0.1.0 version repository.url` for that version and the kixel-ai/token-max repository
