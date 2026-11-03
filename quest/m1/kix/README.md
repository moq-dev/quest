# Kix for any repository

## Goal

A maintainer outside moq-dev enrolls their repository on kix.quest without
help from the operator, learns the trust rules their repository must meet,
and accepts contributors' PRs without running contributor-controlled code
unconfined on their own machines.

## Plan

Moved from m0 on 2026-10-30 (user, /quest-plan): moq-dev's own repositories
already carry Quest, are enrolled by the operator, and are worked on by their
maintainers, so they need none of this first.

## Required

- [Setup PR](/quest/m1/kix/setup-pr.md) - enrolling a repository without Quest makes the App open its `quest init` pull request
- [Read-only CI](/quest/m1/kix/ci-read-only.md) - enrolled repositories keep pull-request CI read-only, checked at enrollment, with every trust boundary written down
- [Contributor sandboxing](/quest/m1/kix/sandbox/README.md) - contributors' PR heads build in a VM, on stock Ubuntu and verified on macOS
- [Onboarding guide](/quest/m1/kix/guide.md) - a complete maintainer path, from runner setup through a reviewed PR
- [Missing review flag](/quest/m1/kix/review-flag.md) - the inbox shows a PR's missing review before the merge click
