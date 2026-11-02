# [M] Runners publish the App's quest review check

## Goal

After a runner publishes a head, it runs `quest review` on that head with
the other vendor's account, outside the agent's sandbox, and kix writes the
result as the App's `quest review` check run on that commit. A head a
runner pushed then lands through kix's land gate without a human approval,
once that check passes.

## Plan

Decided 2026-11-01 (user, /quest-plan of the follow-ups from the
2026-11-01 `/quest-complete` sessions): ✅ plan it, [M], m0, from
[moq-dev/quest#351](https://github.com/moq-dev/quest/pull/351)'s suggested
follow-ups.

- #351's gate (`cloudflare/src/github/review.ts`) already counts a
  completed, successful `quest review` check run by this App on the exact
  head. Nothing writes one yet, and the author's `## Review` record never
  counts on a commit an App committed, so every runner head needs a person's
  approval today.
- The runner process, not the agent, runs the review, so the agent cannot
  fake it. It sends the result to kix over a new runner protocol message.
- The App needs `checks: write`, which existing installations must accept;
  add the operator step to `cloudflare/GITHUB.md`.
- Choose which jobs run it, such as iterate and merge jobs after they
  publish.
