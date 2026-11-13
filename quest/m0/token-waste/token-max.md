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

Amended 2026-11-12 (maintainer, /quest-plan,
[moq-dev/quest#669](https://github.com/moq-dev/quest/pull/669)): token-max
was rewritten in Rust on 2026-11-08 and ships on crates.io with prebuilt
binaries, rejecting npm, which supersedes the 2026-11-06 npm plan. Point to
the run-once lines its install site serves:
`curl -LsSf https://max.kixel.ai/run.sh | sh`, and on Windows
`irm https://max.kixel.ai/run.ps1 | iex`. Neither needs a Rust toolchain or
a quest wrapper. Still ✅ no npm package now that the `@kixel` npm scope
exists (rejected: cargo-dist's npm installer for `npx @kixel/token-max`,
which adds a release channel and a GitHub-hosted publish job that `run.ps1`
makes unnecessary).

## Waiting

- kixel-ai/token-max: publish 0.1.0 and serve both run-once lines; check
  `gh release view -R kixel-ai/token-max` for 0.1.0 or later and that
  `curl -fsSI` succeeds for both `https://max.kixel.ai/run.sh` and
  `https://max.kixel.ai/run.ps1`
