# Development as a benchmark

## Goal

Software development in moq-dev's and Kixel's repositories is run as a
benchmark with several axes. Every change records its risk tier, what it
cost (tokens, compute, and time split into working and blocked on CI,
GitHub, git, or a person), who wrote and reviewed it, and what it later
broke. The tier, set from the change itself, scales its guardrails: review
depth, CI, human approval, and a stated way to undo it. The maintainer
steers from a report of all of it without reading code, and adds or removes
guardrails from that evidence. Every cost is measured so it can be driven
toward zero.

This epic's own work is the end-to-end check: one real PR, taken from its
first session to a week after its merge, shows on Kixel Code's factory
page with its tier and reason, its cost on every axis, its reviews, and
anything it broke, and the numbers match what `quest usage` prints for it.

Non-goals: storing records in PR bodies or git; a dashboard in `quest`
itself, which Kixel Code owns; deploy safety, which each repository's own
tree owns.

## Plan

Decided 2026-11-13 (user, /quest-plan, from
[How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/)
and the posts it links, a survey of the four quest trees, and the
maintainer's typed messages since 2026-10-01):

- Goal?
  - ✅ Measurement and risk tiers together, measurement covering everything
    including blocked time
  - Rejected: measurement only, with tiers planned from its data later;
    tiers only, on today's `quest usage`
- How do low-risk PRs land, given Kixel Code had settled that every code
  merge is a tap?
  - ✅ Earned from evidence: tiers start by only recording, automatic
    merging starts with what the standing pick covers today, and each
    wider class of change is the maintainer's decision off the report.
    Reverses Kixel Code's rule.
  - Rejected: every low-tier PR merges on its own from day one; every merge
    stays a tap
- Where does the report reach the maintainer, given Kixel Code had settled
  that decisions are pulled, never pushed?
  - ✅ A factory page in Kixel Code plus a pushed digest. Reverses the
    rejected digest.
  - Rejected: the page alone; `quest usage` alone
- Which repositories get quests? ✅ moq-dev/quest, Kixel Code,
  moq-dev/moq, and moq-dev/moq.pro (rejected: the first two, with the
  others as a follow-up; those plus moq-dev/moq.pro).
- Must Quest stay generic? ✅ No (user, unprompted): contributors must be
  able to run the binary, and using it on repositories of their own that
  are not forks is a non-goal. The root Goal and `AGENTS.md` say so since
  this plan (rejected: recording it only in these quests; also auditing
  m1's public-release quests in the same session, left to `/quest-audit`).
- Where do records live? ✅ Kixel Code stores them, and the PR body keeps
  only its short lines (rejected: a data branch in each repository, which
  puts private cost in public repositories; rebuilding from each host's
  transcripts on demand, which is slow and lost when transcripts are
  pruned).
- How is time classified? ✅ Exact where a tool already times the wait, a
  cheap model for the rest of the transcript (rejected: the model alone;
  tool timings alone).
- Who sets the risk tier? ✅ The diff (user: "effort is for writing the
  code, and risk is for merging it"). Size keeps routing the writer.
  Rejected: set at planning and re-judged from the diff; a separate score
  per axis.
- What does the tier scale?
  - ✅ Review, approval, and CI, as
    [tier guardrails](/quest/m0/benchmark/guardrails.md) lists
  - Rejected: review and approval only; approval only
- Who moves a class of change into or out of automatic merging?
  - ✅ The maintainer, both ways: the report flags a class whose breakage
    rose, and it keeps merging until they act
  - Rejected: a breaker that tightens on its own; automatic both ways
- Digest? ✅ Daily, with breakage posted at once (rejected: weekly;
  breakage only).
- Milestone? ✅ m0 here and for Kixel Code's store and page; m1 for Kixel
  Code's digest and for moq-dev/moq's and moq-dev/moq.pro's quests
  (rejected: everything in m0; everything in m1).

What the posts add that these quests take: a tier set from the change and
not its author, paths that always need a person, evidence and a brief
read in place of the diff, a stated way to undo each change, automatic
merging widened one class at a time on breakage data, and past incidents
kept as a reviewer's test set. Already in place: a different model
reviews each PR, every finding is answered before merge, a design
checkpoint after repeated review rounds, a merge queue, and diff-scoped
gates in moq-dev/moq and moq-dev/moq.pro.

No post describes attributing cost, model, and effort to each change, so
that part has no precedent to copy.

## Related

- [Routing evidence](/quest/m0/routing-evidence/README.md) - measures what
  each writer and reviewer effort buys; its tallies become records here
- [Mistake audit](/quest/m0/mistake-audit.md) - groups recurring mistakes
  weekly, and reads the time split and breakage once they exist
- [Token waste](/quest/m0/token-waste/README.md) - cuts token cost, one
  of this benchmark's axes
- [Model check](/quest/m1/model-check.md) - retunes routing each milestone
  from the same records
