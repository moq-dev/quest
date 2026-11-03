# [XS] Turn off Codex cloud reviews

## Goal

Codex cloud stops reviewing PRs automatically in every repository that uses
quest, once none still relies on it. Then the maintainer turns off automatic
reviews in Codex's settings, and this quest is deleted.

## Plan

Local review (`quest review` and `/quest-review`) has landed. As of
2026-11-02, moq, rind and rust2's `CONTRIBUTING.md` no longer name Codex's
cloud review; moq.pro's still does.

## Waiting

- moq.pro: its review policy stops naming Codex's cloud review, as moq's,
  rind's and rust2's did. Check its `CONTRIBUTING.md` for
  `chatgpt-codex-connector`.
- moq, moq.pro, rind, rust2, quest: no open PR was opened before its
  repository adopted local review without having merged main since. To
  check, list each repository's open PRs and compare them with the adoption
  merge. To advance it, update the stragglers to main.
