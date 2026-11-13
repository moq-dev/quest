# [L] Score reviewers against the PRs that broke something

## Goal

The culprit PRs on record, each with the defect's file and line taken from
its fix, form a test set, beside a set of PRs known to be clean. A command
runs a reviewer over both and reports how many defects it found and how
many findings on the clean set would have led to a harmful change. A
change to a reviewer's prompt, model, effort, or the repository's
`REVIEW.md` is scored on the set before it lands, and the score, with its
cost, is in that change's PR.

## Plan

From the post: "Incidents become an eval. Past incident-causing PRs, with
their fix-forwards and reverts, were collected," and a change to the
reviewer "is kept only if the score goes up". The same post measures noise
by running the reviewer on known-clean PRs.

Review scores here are saturated, with about 90% of PRs scoring 9 or 10
([routing evidence](/quest/m0/routing-evidence/README.md)), and live
shadow reviews need weeks of PRs per comparison. A fixed set answers the
same question in one run.

Agent's choices, for the implementer to revisit:

- Start from the escapes the mistake audit judged catchable from the diff;
  a runtime escape no reviewer could see only adds noise to the score.
- Confirm each defect's location by a stronger model reading the culprit
  and its fix, and by hand for a sample, before trusting the set.
- Keep the set outside this public repository where its PRs are private.
- Run on demand and before a reviewer change, not on a schedule: a full
  run costs tokens, and the score moves only when the reviewer does.
- Report recall by tier and size, so a reviewer effort can be cut where it
  finds nothing more.

## Required

- [Record what each merged PR broke](/quest/m0/benchmark/breakage.md) - the
  culprits with their cause and how they were found

## Related

- [Model check](/quest/m1/model-check.md) - retunes the reviewer table
  each milestone, and can score candidates on this set
