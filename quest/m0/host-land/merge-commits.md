# [M] quest land queues and lands merge commits

## Goal

A `quest land serve` instance can be configured to land with merge commits
instead of squash commits, and squash stays the default. In merge-commit mode,
each landed PR is a merge commit whose first parent is the base it was tested
on and whose second parent is the queued head, so the base keeps the PR
branch's ancestry, and its tree is exactly the tree the gate checked.
`quest merge <pr> --land <sha>` queues a PR on such a base. Squash instances
behave as they do today.

## Plan

Decided 2026-11-04 (maintainer, /quest-plan), under the exception to the
host-gate freeze recorded in the [epic](/quest/m0/host-land/README.md): a
long-lived branch such as a release branch must keep the ancestry of what
merges into it, so a squash loses it.

- Today the gate squashes everywhere: `enqueue` in `src/cli/land.ts` arms
  auto-merge with `mergeMethod: SQUASH`, the chain is built with
  `git merge --squash`, and `mergePinned` in `src/cli/land-serve.ts` calls
  GitHub with `merge_method: "squash"`.
- The method is the instance's setup, such as a `quest land serve` option
  defaulting to squash, decided once at startup. It applies everywhere the
  gate builds or lands a commit: the screening and batch chain (a
  `git merge --no-ff` with the quest merge driver), the fixer's starting
  commit, and GitHub's merge call. `quest land watch` is out of scope: GitHub's
  merge queue applies its own method.
- Verification after each GitHub merge already compares the first parent to
  the expected base and the tree to the tested link. In merge-commit mode, also
  require the second parent to be the pinned head, or the gate's own base
  merge pushed on top of it, and treat a mismatch like a tree mismatch.
- The auto-merge request is only the queue signal, so its method never decides
  how the gate lands. `quest merge --land` arms it with a method the base
  allows, reusing `quest merge`'s existing method choice, so a base that
  allows only merge commits can still be queued.
- The startup protection checks follow the configured method, for rulesets
  (`UPHELD` and `unheld` in `src/cli/land.ts`) and classic branch protection
  (`UPHELD_CLASSIC` and `unheldClassic`) alike: refuse merge-commit mode on a
  base that requires linear history (the ruleset rule or classic
  `required_linear_history`), and require `allowed_merge_methods` to include
  the configured method rather than always squash. Update the rules' reasons,
  which now say the gate lands squash commits. Test the refusal on both paths.
- Tests cover a merge-commit batch end to end against the mocked GitHub (chain
  shape, the API's `merge_method`, both parents, and the tree), a wrong second
  parent, and the ruleset refusals. Document the option in the README's
  `quest land` section and in `--help`.
