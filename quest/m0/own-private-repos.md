# [S] The maintainer's own private repositories may be named

## Goal

Quest's rules let a public repository name and link its owner's own private
repositories, such as moq-dev/moq.pro from moq-dev/quest, while customers,
partners, and prospects stay unmentioned. Reviewers stop flagging those
mentions as violations.

## Plan

Decided 2026-11-12 (user, /quest-plan): moq.pro is fine to mention in
moq-dev's public repositories.

- Should the rule change, given reviewers flag the moq.pro mentions?
  - ✅ Narrow `assets/CONTEXT.md`'s rule to allow the owner's own private
    repositories (rejected: keep the rule and accept the flags).
- Rejected: rewording moq.pro mentions out of this repository's code, tests,
  and quests.

Recommended wording for the rule in `assets/CONTEXT.md`: "In a public
repository, never mention customers, partners, or prospects, or link to
another owner's private repository." Follow the guide's Prompting section,
and keep `assets/CONTEXT.md` under the 10,000 characters a hook's context
shows.
