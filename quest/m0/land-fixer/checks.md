# [S] The land fixer runs the repository's own checks

## Goal

Before the land fixer reports `fixed` or `requeue`, it runs the checks the
repository's own instructions name for the languages its PR and its fix
touch: lint, format, and type checks as well as build and test. On
moq-dev/moq that is `just check` and `just test`, so the JavaScript type
check runs beside the Rust build. A head the fixer re-enqueues therefore
passes what the merge queue's build will run, or goes back as a handback
quoting the failing command.

## Plan

Decided 2026-11-03 (maintainer, /quest-complete on moq-dev/moq, planned
through moq-dev/moq's coordinator): plan this follow-up. Milestone: m0,
under the land fixer epic. moq-dev/moq lands through this fixer every day,
and m0's Plan ranks the land work first.

What happened: on
[moq-dev/moq#6949](https://github.com/moq-dev/moq/pull/6949), the fixer
requeued the PR without running moq's JavaScript check, and the next build
failed on it. `assets/land-fix.md` tells the fixer to "build and test the
packages the PR and your fix touch", which it read as building and testing
only, and it skipped the check that failed.

Implementation guidance:

- Rewrite that rule in `assets/land-fix.md`: find the repository's check and
  test commands in its root instructions, `CONTRIBUTING.md`, or task runner,
  such as `just check` and `just test`; run them over the PR's and the fix's
  changes; and name each command run in the reason. When the repository
  names no check command, run each touched language's own type check and
  linter beside its build and test.
- A `requeue` of an unchanged head runs the same checks, since the base may
  have moved under it.
- Keep the existing rule: a check the fixer cannot run, or cannot get
  passing mechanically, goes back as a handback quoting the command and its
  output.
