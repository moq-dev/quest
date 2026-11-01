# [S] A refused fork push hands back a ready commit

## Goal

When GitHub refuses the fixer's push to a fork because the commit touches
`.github/workflows` (the App has no `workflows` permission), the handback
carries the fixer's validated resolution. A maintainer session applies and
pushes it without redoing the merge.

## Plan

Decided 2026-11-01 (user, /quest-plan of the land fixer audit; see the
[epic](/quest/m0/land-fixer/README.md)). On
[moq-dev/moq#7439](https://github.com/moq-dev/moq/pull/7439) and
[#7467](https://github.com/moq-dev/moq/pull/7467) the fixer's merge of the
base brought in the base's workflow changes, and GitHub refused the push. A
maintainer session recovered #7439's commit from the daemon's
`repository.git` through a temporary ref and a bundle over SSH.

- What happens on a refused fork push:
  - Grant moq-bot the `workflows` permission
  - ✅ Hand back a ready commit
  - Leave it manual

GitHub refuses any App push of such a commit, to the fork or to an upstream
ref, so the commit cannot travel through Git. The handback comment records
the base SHA, the expected tree hash, and the fixer's resolution as a patch
against the merge's conflicted result. A command such as `quest land apply
<pr>` merges that base, applies the patch, checks the tree hash, and leaves a
commit for the maintainer to push. Size the comment to GitHub's limit and
hand back plainly when the patch does not fit.

## Related

- [Protected edits](/quest/m0/land-fixer/protected.md) - the fixer's own workflow edits
