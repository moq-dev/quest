# [S] The gate gets a check on heads it pushes

## Goal

When the host gate (`quest land serve`) or its fixer pushes a new head to a
queued PR's branch, the base's required checks run on that head, and a head
whose required check never starts is reported instead of held silently.

## Plan

Decided 2026-11-02 (maintainer, /quest-plan of the follow-ups from the
2026-11-02 `/quest-complete` session): ✅ plan it, m0.

Seen 2026-11-02 on moq-dev/quest:
[#342](https://github.com/moq-dev/quest/pull/342)'s head `aa87d974`
("quest land: merge tested base", pushed by moq-bot) and
[#338](https://github.com/moq-dev/quest/pull/338)'s `2f7aa77f` (a land fixer
merge) got no workflow run at all, so the required `check` never reported
and the gate held both for 13 hours with a "required check is still pending"
comment. Dispatching `check.yml` on their branches fixed it.

- First find why those pushes started no `pull_request` run. An App
  installation token's push normally triggers workflows, so check how the gate
  and the fixer push (credential, remote, `--no-verify`-like options) and
  whether GitHub recorded a skipped or approval-required run.
- Then make the gate get a check on any head it pushed: dispatch the base's
  required workflows that support `workflow_dispatch` on the head branch after
  the push, or, where none can be dispatched, report the stall once with what
  to run, rather than waiting forever.
- This is a fix the gate needs while moq-dev/quest, moq.pro, rust2 and rind
  still land through it, within the [queue watcher](/quest/m0/queue-watcher/README.md)
  epic's freeze on gate improvements.
