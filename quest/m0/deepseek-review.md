# [M] A second local review by DeepSeek on every PR

## Goal

Every PR `/quest-review` marks ready has had two local reviews of the
same head: the size list's reviewer, as today (Sol, or Opus when Sol
changed it last), and DeepSeek V4.1 Flash through opencode
(`opencode-go/deepseek-v4.1-flash`). The PR counts as reviewed, for
`quest status`, `/quest-merge`, and `/quest-run`, only when neither leaves
an unrefuted finding on that head, and its `## Review` record shows both.

## Plan

Decided 2026-11-10 (user): Pullfrog now reviews only moq-dev/moq, where
Pullfrog for OSS pays for its model. On the other repositories it spent
the maintainer's OpenCode Go plan on GLM-5.3 until the weekly limit ran
out, so its GitHub App lost access to them and their workflows went. A
second local review by DeepSeek takes its place.

- How DeepSeek reviews:
  - ✅ A second pass after the size list's reviewer, on every PR
  - DeepSeek in place of Opus as the single fallback reviewer: most PRs,
    written by Opus, would still get Sol alone
  - The blind council (`quest/m2/council.md`): deleted with this plan as
    too large for the gain
- Model: ✅ DeepSeek V4.1 Flash (agent's choice). Pullfrog measured
  $0.04-0.07 per review with it, and OpenCode Go charges it against a
  $100 monthly tier, against $15 for DeepSeek V4 Pro and GLM-5.3. Its
  effort is the implementer's call; `high` is what `quest review` already
  passes it in the live tests.

Agent's choices, for the implementer to revisit:

- One `quest review` round runs both reviewers on the head and writes one
  `## Review` record with each reviewer's score and findings, so a head is
  either reviewed or not; each reviewer keeps its own session per branch.
- The DeepSeek reviewer sits beside `REVIEWERS` in `src/cli/models.ts`,
  for every size.
- An opencode outage, such as the Go plan's usage limit, is an outage like
  any reviewer's: the PR stays a draft with a `Waiting` item naming the
  reset, as `/quest-review` describes.
- A later round resumes only the reviewers with a finding to settle.
- `quest usage` counts both reviewers' sessions and scores.
