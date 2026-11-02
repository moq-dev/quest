# [M] Close quest merge --land's gaps

## Goal

`quest merge --land` lands a PR without per-repository workarounds, and
auto-merge never merges a head nobody landed. On a repository that allows only
squash it squashes without `--squash`. It works from outside a checkout when
given a PR URL. With auto-merge disabled, it refuses unless the user explicitly
requests `--direct`, preserving the repository’s own landing queue. A direct merge releases its `quest:merge` label. When
auto-merge is left on for a head other than the one landed, `quest status`
and `quest wait` say so.

## Plan

Implemented: the 2026-10-28 decision to refuse an ungated landing when repository
auto-merge is disabled, unless `--direct` was explicitly requested. Follow the
repository’s own landing instructions on refusal. The remaining gaps follow.

Decided 2026-10-28 (user, /quest-plan of the follow-ups from a 25-PR /quest-complete run). Merge agents hit each of these repeatedly:

- **Merge method.** With merge commits disabled, a bare `--land` tried a merge
  commit and failed. Read the repository's allowed methods. Use the only one
  allowed, or the one the flag names, and refuse a named method the repository
  disallows.
- **Outside a checkout.** `quest merge 237` run from `/tmp` failed on
  `git -C . remote get-url origin`, while the merge skill says to run a
  `quest` the PR can't modify from outside the head checkout. Resolve the
  repository from a full PR URL. A bare number keeps needing a checkout or
  `--root`, and its error says so.
- **Direct merges keep their label.** The label is supposed to stay only while
  the PR is queued or auto-merging, but it stayed after direct merges on
  #253, #254, #257 and #259. Release it once the merge is confirmed.
- **Auto-merge carry-over.** #256's agent enabled squash auto-merge on a
  reviewed head, then pushed a base merge, and GitHub merged the new head
  before it was reviewed or landed. GitHub keeps auto-merge across pushes by
  writers.
  - The merge skill says to disable auto-merge before any push to a PR that
    has it.
  - `quest status` reports the head auto-merge was enabled on next to the
    current one. `quest wait` prints an event when they differ.
  - Rejected: `quest` disabling auto-merge itself, since it doesn't see the
    push.
