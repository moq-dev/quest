# [XS] Waiting quests use the ## Waiting section

## Goal

Every quest in this repository that waits on something outside the tree
lists it in a `## Waiting` section, one item per condition, so
`quest waiting` and `/quest-unblock` find it. That covers bun-efault,
codex-project-config, land-fixer/workflows-permission, queue-watcher/follow,
queue-watcher/retire, m2/chatgpt-waitlist and m2/legacy-labels, plus any
quest that gains a prose wait before this lands.

## Plan

Decided 2026-11-02 (maintainer, /quest-plan of the follow-ups from the
2026-11-02 `/quest-complete` session, raised by
[moq-dev/quest#390](https://github.com/moq-dev/quest/pull/390)): ✅ plan it,
m0.

- Start only once #390 has landed: CI checks a PR's quests with main's
  `quest`, which rejects `## Waiting` until then. That is why #390 left the
  migrations out.
- #390's original commit `4e6fd679` holds the edits for the seven quests;
  reapply them, then search the tree for other prose waits ("Waiting on",
  "Waits on", "Condition:").
