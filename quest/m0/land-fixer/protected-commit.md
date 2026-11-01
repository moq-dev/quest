# [S] A protected edit the fixer writes comes back as a ready commit

## Goal

When `validateFix` rejects a fixer result because it edits a protected path
(`.github/`, `flake.nix`, `nix/`, justfiles, gitlinks) beyond what the base
merge carries, the handback carries that result as a ready commit, the same
form as a fork push GitHub refuses
([moq-dev/quest#358](https://github.com/moq-dev/quest/pull/358)).
The maintainer reviews it and applies it with `quest land apply <pr>`, then
pushes and re-picks. Protected edits never land automatically.

## Plan

Decided 2026-11-01 (maintainer, from the audit of the merge-queue plan; see
the [epic](/quest/m0/land-fixer/README.md)). The maintainer kept
`validateFix`'s protected-path block and closed
[moq-dev/quest#357](https://github.com/moq-dev/quest/pull/357), which would
have let these edits land unreviewed. moq-dev/moq has about 25 release
workflows with publishing secrets, and a merge pick covers the PR's diff,
not the fixer's later resolution. About 17 such handbacks happened in 3 days,
most of them mechanical, so a one-command ready commit keeps the human review
cheap.

Reuse [moq-dev/quest#358](https://github.com/moq-dev/quest/pull/358)'s
handback format and `quest land apply`. Record the PR head, base, expected
tree hash, and the patch against the merge's conflicted result. Size it to
GitHub's comment limit, and hand back plainly when it does not fit.
