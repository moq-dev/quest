# [S] The inbox flags a missing review before the merge click

## Goal

kix's inbox shows, on each PR item, when no review counts on its head yet,
with the reason the land gate would give. A maintainer sees it before
picking merge, instead of having the click refused.

## Plan

Decided 2026-11-01 (user, /quest-plan of the follow-ups from the
2026-11-01 `/quest-complete` sessions): ✅ plan it, [S], m1, from
[moq-dev/quest#351](https://github.com/moq-dev/quest/pull/351)'s suggested
follow-ups.

- #351 refuses the inbox's **Merge this PR** with the gate's reason only
  after the click. Flag it up front from what the inbox already observes,
  such as the PR's `latestReviews` and the App's `quest review` check, and
  keep the click's live check as the authority.
- Keep the extra GitHub reads within the Worker's subrequest budget.
