# [S] The opencode sandbox's boundary test runs in CI

## Goal

The opencode sandbox's hostile-repository boundary test is checked in as
`test/live/runner-sandbox.test.ts`, drives opencode and srt with a scripted
model, and runs on Linux in this repository's checks, on `main` and in the
merge group. An srt or opencode bump that weakens the boundary fails CI
before it lands.

## Plan

Decided 2026-11-02 (user, /quest-plan of
[moq-dev/quest#338](https://github.com/moq-dev/quest/pull/338)'s suggested
follow-ups):

- How it runs:
  - ✅ CI on Linux: a scripted model needs no login and spends no usage
  - A manual recipe, like `just review-sandbox`
- Milestone: ✅ m0 · m1

#338 ran the test by hand against srt 0.0.79. Merging main moved srt to
0.0.81, which the maintainer accepted from the release notes and a direct
srt run, without rerunning the full test. The checked-in test covers what
that run did: a checkout that tries to read a denied file, write outside the
checkout and attempt directory, create `.opencode/plugin`, `opencode.json` or
`opencode.jsonc`, and reach the network. Each attempt is refused, and nothing
is left behind in the checkout. Follow `test/live/review-sandbox.test.ts`
for the layout. Since this test needs no login, it runs without
`QUEST_LIVE`, skipping only where srt can't run (macOS and Windows).

[opencode 2.x](/quest/m0/opencode-sdk.md) reruns the boundary test on 2.x;
with this quest done, that rerun is this test.
