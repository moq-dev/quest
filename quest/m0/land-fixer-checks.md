# [S] The land fixer leaves the full gate to the merge queue

## Goal

A land fixer verifies a fix with the checks that cover what it changed and
the check the failure log shows failing, not the repository's whole merge
gate, which the queue runs again on the merge group before anything lands.
The PR reports the fixers' CPU per run before and after, from their
`Consumed` journal lines on a host that runs them.

## Plan

Measured 2026-11-28
([kixel-ai/dotfiles#422](https://github.com/kixel-ai/dotfiles/pull/422)):
on the dotfiles NixOS host, 84% of the land fixers' CPU (193 CPU-hours over
145 runs, 2026-11-21 to 11-27, about 40 CPU-hours a day) went to runs where
the agent reran the repository's whole gate (`just ci base`, the command
moq's and rind's queue jobs run) before reporting `fixed` or `requeue`.
Those runs averaged 100 to 130 CPU-minutes, against 2 to 24 for runs that
stopped at `just check`. One example: a fix for a merge conflict in rind's
generated `BENCHMARKS.md` ran `just check base` for 5 minutes and then
`CHECK_QUEUE=1 just ci base` for 10.

`assets/land-fix.md`'s Repository checks asks for this: it says to run the
repository's checks "as the merge queue will". Since Codex stopped fixing
(#832), Claude reran the gate on 80% of moq's fixer runs, where Codex did on
61%.

- Rewrite Repository checks so the fixer runs the base's quick local check
  on its change (such as `just check base`), plus the failing check from the
  failure log, and leaves the full gate (`just ci`, release-only proofs) to
  the queue. A conflict in a generated file needs only that file's own
  regeneration or check.
- The trade-off: a fix the narrow check misses fails once more in the queue.
  The queue is the gate either way.
- rind's standalone Lean proofs (`admin/prove lean`) were another 20% of its
  fixer CPU. Since kixel-ai/rind#958, they gate releases rather than merges,
  so the queue never repeats them. Say whether the fixer runs a check the
  merge gate does not.
