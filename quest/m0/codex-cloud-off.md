# [S] Turn off Codex cloud reviews

## Goal

Codex cloud stops reviewing PRs automatically in every repository that uses
quest, once none still relies on it. Then the maintainer turns off automatic
reviews in Codex's settings, and this quest is deleted.

## Plan

Local review (`quest review` and `/quest-review`) has landed. As of
2026-11-02, moq, rind and rust2's `CONTRIBUTING.md` no longer name Codex's
cloud review; moq.pro's still does.

Decided 2026-11-08 (maintainer, /quest-unblock): ✅ an agent moves moq.pro to
local review and updates its stragglers (rejected: keep Codex cloud review
for moq.pro and delete this quest; leave it waiting).

- The moq.pro PR, 3725, rewrites its `CONTRIBUTING.md` review policy to
  local review, as moq's did, dropping the `chatgpt-codex-connector[bot]`
  findings rule.
- Once it lands, merge main into every open moq.pro PR opened before it
  (on 2026-11-08: 3215, 3211, 3209 and 3091, all the maintainer's drafts).
  moq, rind, rust2 and quest had no such stragglers that day.
- Then the maintainer turns off automatic reviews in Codex's settings, and
  this quest is deleted.

## Waiting

- moq.pro: the review-policy PR (3725) lands, then merge main into 3215,
  3211, 3209 and 3091; check that each shows the new policy.
- Maintainer: turn off automatic reviews in Codex's settings once those
  merges are in; no agent can reach the Codex settings page.
