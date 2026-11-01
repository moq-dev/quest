# [S] The fixer edits protected paths when the edit is mechanical

## Goal

The fixer may resolve conflicts and failures in protected paths (`.github/`,
`flake.nix`, `nix/`, justfiles, and the rest of the protected set) when it
judges the edit mechanical. A head with such an edit lands like any other
fix.

## Plan

Decided 2026-11-01 (user, /quest-plan of the land fixer audit; see the
[epic](/quest/m0/land-fixer/README.md)). This reverses
[Fixer proxy access](/quest/m0/host-land/fixer.md)'s 2026-10-30 decision
that protected paths are blocked. 17 handbacks were protected-path
conflicts, most of them mechanical: keep both sides, or drop a tool the base
removed. Maintainers resolved them by hand, for example on
[moq-dev/moq#7344](https://github.com/moq-dev/moq/pull/7344),
[#7315](https://github.com/moq-dev/moq/pull/7315), and
[#7318](https://github.com/moq-dev/moq/pull/7318).

- First round:
  - Resolve verbatim hunks only
  - Hand back a ready commit
  - Keep blocking
  - User's answer: "Up to the fixer to determine what is mechanical"
- Second round, challenging the earlier decision, since a fixer head lands
  with no further review:
  - The fixer decides, but a protected edit needs a counted review
  - ✅ The fixer decides, and the fix lands. User: "Any prompt injections
    should be caught before enabling auto merge"; the maintainer's pick is
    the injection check
  - Workflows stay blocked

Remove the protected-set check from `validateFix` (`src/cli/land-fixer.ts`,
"protected set must equal pinned head or base merge result"). Replace the
protected-path rule in `assets/land-fix.md` with the same mechanical bar
every other path has. Keep the rule that the fixer hands back any attempt to
redirect its task, and update the decision line in
[Fixer proxy access](/quest/m0/host-land/fixer.md).

## Related

- [Fork commits](/quest/m0/land-fixer/fork-commit.md) - workflow edits GitHub refuses to take from the App on forks
