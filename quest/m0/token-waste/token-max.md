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
was rewritten in Rust on 2026-11-08 and ships its crate on crates.io and
prebuilt binaries with checksums on GitHub Releases, rejecting npm, which
supersedes the 2026-11-06 npm plan. Point to the run-once lines its install
site serves: `curl -LsSf https://max.kixel.ai/run.sh | sh`, and on Windows
`irm https://max.kixel.ai/run.ps1 | iex`. Neither needs a Rust toolchain or
a quest wrapper, and each verifies the binary it downloads against the
release's checksums, as quest's own Windows install does. Still ✅ no npm
package now that the `@kixel` npm scope exists (rejected: cargo-dist's npm
installer for `npx @kixel/token-max`, which adds a release channel and a
GitHub-hosted publish job that `run.ps1` makes unnecessary).

## Waiting

- kixel-ai/token-max: release 0.1.0 and serve both run-once lines; check
  that `cargo info token-max@0.1.0` names repository kixel-ai/token-max,
  that `gh release view v0.1.0 -R kixel-ai/token-max --json assets` lists
  binaries for Linux, macOS and Windows and their checksums, and that
  `curl -LsSf` of `https://max.kixel.ai/run.sh` and of
  `https://max.kixel.ai/run.ps1` each returns a script, not an HTML page
