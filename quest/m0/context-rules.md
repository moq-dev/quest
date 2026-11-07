# [S] Three generic rules in the shared context

## Goal

`quest context` gives every repository three engineering rules that moq-dev/rust2 used to
carry itself, each said once in the section it belongs to:

- Match the code's existing conventions, patterns, and naming.
- Never pass a flaky test by loosening its assertion; fix the cause.
- Short names under a module namespace, rather than repeating the module in each name.

## Plan

[moq-dev/rust2#553](https://github.com/moq-dev/rust2/pull/553) replaced rust2's own copies
of the shared rules with `quest context`, dropping these because `assets/CONTEXT.md` had
no equivalent. Word each to fit its neighbors, such as "Name by role" under Public API and
the root-cause rule under Required, and follow `quest guide prompting`.
The context is hook context, capped at `CONTEXT_LIMIT` (10,000 characters, `src/cli/hooks.ts`),
and had about 230 to spare when [moq-dev/quest#517](https://github.com/moq-dev/quest/pull/517)
merged, so make room in the same PR where the three rules do not fit.

Decided 2026-11-07 (maintainer, moq-dev/rust2 /quest-complete):

- Which dropped rules join the shared context?
  - ✅ Match existing conventions, patterns, and naming
  - ✅ Never pass a flaky test by loosening its assertion
  - ✅ Short names under a module namespace
  - Rejected: "keep the PR to one problem, no drive-by changes", which clashes with
    fixing bugs in the code a PR touches and outdated docs inline
  - Rejected: "if a skill's usage is unclear, offer to update it"
- Where does this quest go?
  - ✅ m0 (recommended)
  - m1
  - m2
