# [XS] Turn Spotlight off in this repository's macOS CI jobs

## Goal

Every macOS job in this repository's workflows runs `sudo mdutil -a -i off`
as its first step, so Spotlight's first full index of the fresh VM no
longer competes with the job.

## Plan

Decided 2026-11-01 (user, /quest-plan of the follow-ups from the
2026-11-01 `/quest-complete` sessions): ✅ plan it, [XS], m0, from
[moq-dev/quest#342](https://github.com/moq-dev/quest/pull/342)'s suggested
follow-ups.

- #342's diagnostic run held `macos-14`'s load at about 4× its 3 CPUs for
  the whole sample while Spotlight indexed, dropping below 1 within minutes
  once it was off. The gate already admits a lone command on such a host,
  so this is about job time, not admission.
- The jobs: Check's `lifecycle` on `macos-14`
  (`.github/workflows/check.yml`), Release's `macos` jobs
  (`release.yml`), and Install check's macOS jobs (`install-check.yml`).
  Compare a job's time before and after.
