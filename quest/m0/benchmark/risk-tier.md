# [L] Give every PR a risk tier from its diff

## Goal

Every PR carries a risk tier, low, medium, or high, with a one-line
reason: what could break, for whom, and how hard it is to undo. `quest`
sets it from the diff when the PR is reviewed and again for each later
head, and the tier never depends on who wrote the change. A file checked
into each repository lists the paths that are always high, such as
billing, deploys, workflow files, and a wire protocol, and may describe
what else is customer-facing there. The tier and reason show in the PR
body beside its size, in `quest status`, and in the PR's records.

Until [tier guardrails](/quest/m0/benchmark/guardrails.md) lands, the tier
changes nothing: it is only recorded, so its accuracy can be read before
anything trusts it.

## Plan

Decided 2026-11-13 (user, /quest-plan): the tier comes from the diff,
because "effort is for writing the code, and risk is for merging it".
Size keeps routing the writer, so a hard problem still starts on the
strongest model by its size. Rejected: a tier set at planning and
re-judged from the diff; separate scores for customer impact,
reversibility, and breadth.

Agent's choices, for the implementer to revisit:

- Classify before the review starts, since the tier picks the review's
  depth: a cheap model call over the diff and the repository's file, with
  a path match that needs no model for the always-high list. The reviewer
  may raise the tier with a reason and never lower it.
- A later head is classified again, and a tier that rises reopens
  whatever the lower tier skipped.
- The repository's file is itself always high, as is any workflow file,
  following the post's rule that "some paths always need a person".
- Read accuracy two ways once [breakage](/quest/m0/benchmark/breakage.md)
  exists: how often a low-tier PR is later a culprit, and how often the
  maintainer overrides a tier. An override is recorded with its reason.
- Fail loud on a repository with no file: every PR there is medium, and
  `quest` says why.

## Waiting

- Maintainer: a week of recorded tiers read against what merged, before
  [tier guardrails](/quest/m0/benchmark/guardrails.md) acts on them; no
  agent can judge whether the tiers match their own sense of risk. Check
  with the tier column in `quest usage`.

## Related

- [Development as a benchmark](/quest/m0/benchmark/README.md) - the
  decisions this builds on
