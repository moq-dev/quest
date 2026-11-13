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
own quest tree ([kixelated/token-max#1](https://github.com/kixelated/token-max/pull/1)),
so this quest keeps only quest's side.

Amended 2026-11-06 (maintainer, /quest-plan in token-max): first use should
be one command. The maintainer delegated packaging and allowed TypeScript;
token-max now plans Node-compatible TypeScript and npm distribution
([kixelated/token-max#2](https://github.com/kixelated/token-max/pull/2)).
Use `npx --yes @kixelated/token-max@latest`, or `bunx --bun @kixelated/token-max@latest` for
Bun-only execution. This supersedes the crates.io release dependency; it
does not require a quest wrapper or Rust toolchain. The scoped package
keeps the `token-max` command while avoiding reliance on the unverified
unscoped npm name.

Amended 2026-11-12 (maintainer, in token-max's own plan): token-max moved
to the kixel-ai organization
([kixel-ai/token-max#83](https://github.com/kixel-ai/token-max/pull/83))
and was rewritten in Rust, superseding the 2026-11-06 npm plan and its
`npx` and `bunx` commands. Its 0.1.0 is to ship on crates.io, with prebuilt
binaries on its GitHub Release, and
`curl -LsSf https://max.kixel.ai/run.sh | sh` downloads one and runs
`token-max doctor` once, with no Rust toolchain; point `SETUP.md` at that
line.

## Waiting

- kixel-ai/token-max: publish 0.1.0 and serve `run.sh`; check `curl -fsS -A quest https://crates.io/api/v1/crates/token-max/0.1.0 | jq .version.repository` prints `"https://github.com/kixel-ai/token-max"`, and `curl -fsSI https://max.kixel.ai/run.sh` succeeds
