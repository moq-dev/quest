# [L] /quest-council reviews with one model per maker, blind

## Goal

`/quest-council <pr>` works like `/quest-review`, but a council reviews
the branch: one reviewer per model maker that can run (Anthropic, OpenAI,
xAI, DeepSeek), leaving out the maker or makers that implemented the PR.
Each reviews independently and blind, never seeing another's findings or
which model wrote the change. The author gets one merged list, each
finding tagged with how many members raised it, plus each member's score
out of 10, and fixes or refutes the findings as in a single review.

## Plan

Decided 2026-11-04 (user, /quest-plan), for multiple opinions on a PR at
a token cost the user chooses per PR:

- How blind?
  - ✅ Independent and anonymous: each member reviews an anonymized copy,
    the branch squashed into one commit with a neutral message and no
    trailers, so no member knows which model wrote it
  - Independent only
- How are findings combined?
  - ✅ Merged, duplicates folded, each tagged with its agreement count
    (user); every review also scores the change out of 10
    ([review score](/quest/m0/model-routing/review-score.md))
  - Merged, then a blind vote that drops findings most members reject
- Who sits on it?
  - ✅ One reviewer per maker, at that maker's entry in the PR size's review
    list ([Review by size](/quest/m0/model-routing/review-effort.md)),
    minus the implementers' makers
  - One per maker, the implementer's included
  - Every ranked model
- Which milestone? ✅ m2 (rejected: m0 after routing, m1)

Agent's choices, for the implementer to revisit:

- `quest review --council` runs the members concurrently, each in its own
  session kept per branch and member, and prints the merged findings and
  each member's score. `/quest-council` is `/quest-review` with that flag,
  so taking the PR, the checks, fixing, refuting, recording, and marking
  ready stay one flow.
- Anonymize in a detached checkout in the clone's scratch: one commit of
  the branch's tree on the merge base, so the diff matches, with a neutral
  message, and no PR body. Each member still reads the base's `AGENTS.md`
  and `REVIEW.md`.
- Later rounds resume only the members with an unrefuted finding, on the
  new head's anonymized copy, with the author's responses to their own
  findings; members that found nothing are done.
- A member at its usage limit falls through to the next model of the same
  maker in the list, or the council runs without that maker and says so.
- `/quest-council` is invoked by the user only; nothing runs it
  automatically.
- The `## Review` record lists each member (harness, model, effort), its
  score, and each finding's agreement count and disposition.
- Online reviewers such as Pullfrog and CodeRabbit stay outside the
  council: they see the PR, so they are not blind. Their findings are
  answered as usual.

## Required

- [Grok and opencode reviewers](/quest/m0/model-routing/review-harnesses.md) - the council's xAI and DeepSeek members
- [Review by size](/quest/m0/model-routing/review-effort.md) - the ranked review lists the council picks its members from
- [Review score](/quest/m0/model-routing/review-score.md) - the score each member reports

## Related

- [Donated reviews](/quest/m2/automation/review.md) - independent agent reviews donated to other projects
