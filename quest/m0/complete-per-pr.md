# [XS] /quest-complete never offers a grouped pick

## Goal

`/quest-complete` asks one question per PR and offers no option that covers
several PRs at once, such as "merge all 20 landable PRs" or "accept every
recommendation". A blanket answer that the maintainer gives on their own
still counts, as `assets/skills/complete.md` already describes.

## Plan

Decided 2026-11-03 (maintainer, /quest-complete on moq-dev/moq): "Ask per
PR. Update quest to always ask per PR." Milestone: m0, ranked right after the
Kix decision UI. moq-dev/moq runs `/quest-complete` every day, and m0's Plan
ranks the land work, then Kix, before the rest of m0.

The skill already says to ask "with one question per PR, never grouping PRs
into one question". The agent still added a grouped "merge all 20 landable
PRs" option, maybe because the next paragraph describes a blanket answer as
valid.

Implementation guidance:

- In `assets/skills/complete.md`, say that no option may name more than one
  PR, so no grouped or blanket option appears, and that each question's
  options are only that PR's actions.
- Reword the blanket-answer sentence so it applies only to an answer the
  maintainer gives on their own, never to an option the agent offers.
- Check the other skills that ask about several PRs, such as
  `assets/skills/unblock.md` and `assets/skills/afk.md`, and apply the same
  rule where they put PR picks to the user.
