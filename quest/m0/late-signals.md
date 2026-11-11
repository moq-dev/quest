# [M] A finding or decision posted on a head holds its landing

## Goal

A PR does not land past a review finding, or a recorded decision, posted
on its head after the review its pick relied on, including one posted
while it waits in a merge queue. `quest merge` refuses such a head, naming
the finding or comment, and a queued PR that draws one leaves the queue
until it is fixed or refuted.

Non-goal: failed checks on the head, which `quest merge` already refuses
([moq-dev/quest#601](https://github.com/moq-dev/quest/pull/601)), and a
failed run on an earlier head, below.

## Plan

The 2026-11-11 [mistake audit](/quest/m0/mistake-audit.md) found 3 of the
week's 7 escapes landed past a signal already on the PR. The cases this
must refuse:

- [moq-dev/moq#8375](https://github.com/moq-dev/moq/pull/8375): an online
  review posted 65 seconds after enqueue described the bug
  [moq-dev/moq#8504](https://github.com/moq-dev/moq/pull/8504) later
  fixed, and the PR merged 15 minutes after it.
- [moq-dev/moq#8431](https://github.com/moq-dev/moq/pull/8431): a comment
  recording the maintainer's decision said the head lacked a timeout, and
  the same head was enqueued 10 minutes later, fixed by
  [moq-dev/moq#8466](https://github.com/moq-dev/moq/pull/8466).

Agent's choices, for the implementer to revisit:

- `quest merge` reads the reviews posted after the head's commit, and
  the comments the decision under `## Waiting` picks, and refuses while
  one holds a finding or decision the head has not answered.
  `quest status` prints them, so `/quest-merge` sees them before it
  picks.
- The land watcher re-reads queued PRs and dequeues one that draws a
  finding, so CONTRIBUTING's "online findings already posted are addressed
  at merge, never waited for" still holds: nothing waits for a reviewer,
  but a finding that arrives before the merge takes the PR out of the
  queue until it is fixed or refuted.
- [moq-dev/moq#8372](https://github.com/moq-dev/moq/pull/8372) merged with
  a red `platform.yml` dispatch run on an earlier head, which no check on
  its final head showed. Leave it to moq-dev/moq, since one case is not a
  class.

## Waiting

- Maintainer: which comments hold a head? Options: (a) any comment by a
  write-access account after the head's commit, until a push or a reply
  answers it; (b) only comments that open with a fixed marker, such as
  "Maintainer decision", which the skills that record a decision on a PR
  start writing; (c) only review findings, leaving decision comments to
  `/quest-merge`'s prose. Recommend (b): it would have caught
  moq-dev/moq#8431, whose comment opened that way, without holding every
  chat comment, and a check cannot tell a decision from discussion
  otherwise. Check the answer in this Plan.

## Related

- [Mistake audit](/quest/m0/mistake-audit.md) - counts heads that landed
  past a signal
