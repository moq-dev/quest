# [L] Scale review, CI, and approval to a PR's risk tier

## Goal

A PR's guardrails follow its risk tier:

| Tier | Review | CI | Lands on |
|---|---|---|---|
| Low | The online reviewer only | The checks its diff reaches | Its own, once its class of change is on the repository's list; else the maintainer's pick |
| Medium | A local review by a model other than its writer | The checks its diff reaches | The maintainer's pick |
| High | Two independent local reviews, on the strongest reviewers | The repository's full suite | The maintainer's pick, with the full brief |

A medium or high PR states how to undo it in its body, and `quest merge`
refuses one that does not. The tier replaces `/quest-run`'s standing pick:
the classes that merge on their own are a list in the repository's risk
file, starting with what the standing pick covers today, and only a PR the
maintainer picks changes that list. Automatic merging stays limited to
authors with write access.

Each guardrail's cost and catches reach the PR's records: what each review
found, what the full suite failed that the scoped checks passed, and how
long the PR waited on a person. The report can then show a guardrail that
catches nothing, so the maintainer can remove it.

## Plan

Decided 2026-11-13 (user, /quest-plan):

- What does the tier scale? ✅ Review, approval, and CI (rejected: review
  and approval only, keeping CI scoped at every tier; approval only).
- How do low-risk PRs land? ✅ Earned from evidence, starting with the
  standing pick's classes (rejected: every low PR from day one; every
  merge a tap).
- Who moves a class? ✅ The maintainer, both ways. The report flags a class
  whose breakage rose and it keeps merging until they act. Rejected: a
  breaker that tightens on its own; automatic both ways.
- Customer-facing changes get "rollbacks and higher quality" (user): the
  high tier's stated undo and second review.

This quest edits the shipped skills and rules, which the maintainer asked
for by planning it.

Agent's choices, for the implementer to revisit:

- `quest` cannot run a repository's CI. Expose the tier to the gate, and
  let the risk file name the full-suite command, so moq-dev/moq's
  `just gate` and moq-dev/moq.pro's nightly tier run for a high PR and the
  scoped checks for the rest.
- Size keeps picking the review effort within a tier. High adds a second
  reviewer on a different model from the first; the routing table gains
  that column.
- A class is a named rule over the diff in the risk file, such as "only
  test files". A PR lands on its own only when it is low and every changed
  file falls in a listed class.
- The undo line says which of revert, flag, or redeploy applies and what
  it leaves behind, such as a migration. Low PRs are undone by a revert
  and need no line.
- A widening is proposed with its class's numbers: PRs merged, culprits
  among them, and what a tap cost in waiting time.
- Tell the maintainer when a tier rises on a later head of a PR they
  already picked; the pick ends there, as the standing pick's does. A
  tier that rises reopens whatever the lower tier skipped.
- The maintainer can override a tier, recorded with its reason, and the
  report counts how often they do as a reading of the tier's accuracy.
  [#716](https://github.com/moq-dev/quest/pull/716), which set the tier,
  left this here, since nothing reads an override until the tier gates
  something.

Open question for the maintainer, asked before the list is written: the
standing pick covers CI changes today, but the post requires a person for
"any CI workflow file", and `quest review` holds workflow files always
high. Recommended: keep them high, which takes CI changes out of
automatic merging.

## Required

- [Read a week of risk tiers before guardrails act on them](/quest/m0/benchmark/risk-tier.md) -
  the maintainer's verdict that the recorded tiers can be trusted

## Related

- [Breakage](/quest/m0/benchmark/breakage.md) - the culprit counts each
  class is judged on
- [Routing evidence](/quest/m0/routing-evidence/README.md) - its shadow
  reviewer measures what a deeper review buys
