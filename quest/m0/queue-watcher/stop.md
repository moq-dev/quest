# [S] The fixer keeps going while it makes progress

## Goal

The watcher keeps fixing and re-enqueuing a dropped PR, with no attempt
limit, for as long as each round changes something. It hands the PR back to
a person when:

- a fix attempt produces no new commit and the failure isn't flaky;
- the same failure (the same failing test or step) recurs right after a fix;
- or the PR has been re-enqueued unchanged as flaky 3 times in a row.

The fixer handing back on its own (a design decision, a protected edit) still
hands back at once. A handback comment names the rule that fired.

## Plan

Decided 2026-11-01 (maintainer, /quest-plan; see the
[epic](/quest/m0/queue-watcher/README.md)):

- How attempts count:
  - ✅ Unlimited while progressing, with the three stop rules above. This
    replaces batch triage's ([moq-dev/quest#355](https://github.com/moq-dev/quest/pull/355))
    one attempt per pick, and the earlier plan to spend that attempt only on
    a failed fix (2026-11-01, from the audit of 98 "already used its
    mechanical fix attempt" handbacks), which this quest held before the
    switch.

Extend the attempt record `fix-attempt-<n>.json` (`src/cli/land-fixer.ts`,
read by `spent` and `handbackRepeated`) into a per-pick history: each round's
outcome (`fixed`, `merged`, `unchanged`, `flaky`, or a handback), the head
before and after, and the failure's signature. The signature is the failing
test or step the fixer names, falling back to the failing job and step from
the `merge_group` run. A record written by the host gate, without these
fields, starts a fresh history.

A conflict after the base moved is a new failure, not a repeat, so a PR that
keeps conflicting with a busy base keeps being fixed while each fix lands a
new merge. A flaky round resets neither of the other rules' state; three
flaky rounds in a row hand back so a real nondeterministic bug in the PR
reaches a person.
