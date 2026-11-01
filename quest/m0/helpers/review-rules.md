# [XS] Keep a review across an identical diff

## Goal

Merge agents stop waiting for a new review when a head's diff against the new
base equals the reviewed diff. That head keeps the review, even after a
hand-resolved merge.

## Plan

Decided 2026-10-28 (user, /quest-plan of the follow-ups from a 25-PR /quest-complete run).

- The rule goes in the guide's Reviews section, beside the existing
  exemptions (a conflict-free base merge, an unchanged reviewer patch). #233's
  hand-resolved merge left its diff byte-identical to the reviewed head, yet it
  still waited 45 minutes for a review. Name a check agents can run, such as
  comparing `git diff <base>...<head>` before and after the merge.
- It applies to whichever review the policy counts, including the
  `## Review` record that `/quest-review` writes.

Decided 2026-10-28 (user, /quest-merge of #267): the declined-finding and
stalled-review rules for Codex cloud were dropped, since local review replaces
Codex as the required reviewer and never waits for online reviewers.
