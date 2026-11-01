# Agent workflow helpers

## Goal

Agents stop hand-writing `gh`, `jq`, and `sed` loops for routine quest
workflow steps, because `quest` commands cover them and the skills point at
those commands: CI results while waiting, a one-shot PR status, claiming
quests and PRs, moving and deleting quests, and unattended work. Skill
rules that remove the maintainer's repeated steering belong here too.

Only generic helpers belong here. Non-goals: the kix.quest UI, a daemon, and
deciding whose review or which result counts; the agent still decides.

## Plan

Decided 2026-10-19 from an audit of Claude Code transcripts in moq-dev/moq and
moq-dev/moq.pro: 396 sessions from Oct 17-19, 2026, plus about 339k Bash
commands from Sep-Oct. Session counts in each child come from that window.

- Decided (user): plan only the really generic helpers. Replying to and
  resolving review threads (103 and 68 sessions) is dropped: its attribution
  footer and wording are user and repository policy, and `gh api` already
  does the call. Parsing open decisions from a PR body is dropped from
  `quest status`, since that body format is a skill convention.
- GitHub calls live in `src/cli/` beside `quest wait`, outside the
  forge-agnostic core. Pure tree edits, such as link rewriting, go in the
  core. GitHub commands share the client in `src/cli/github.ts` (auth,
  rate-limit retry, same-origin pagination, GraphQL) instead of copying it.
- Decided (user): no separate documentation page. Each child updates
  `--help`, README examples, and the skill prose it replaces; the user asked
  for those skill edits through this plan.
- Decided 2026-10-20 (user), from a wider audit of Claude Code and Codex
  sessions: claims and PR ownership live on GitHub as a draft PR per claimed
  quest and one `quest:*` state label per owned PR, replacing the planned
  `quest claim`. The named gate lock is dropped: it replaced moq.pro's mkdir
  merge mutex, which
  [moq-dev/moq.pro#2510](https://github.com/moq-dev/moq.pro/pull/2510)
  replaced with a label queue, and PR ownership covers the remaining
  collisions.
- Decided 2026-10-21 (user): no `quest:start` label; a draft belongs to its
  starter until its body has a `## Decisions needed` section, which the guide
  defines as the hand-back marker. Commands read only whether it is present.
  This narrows the 2026-10-19 decision above: `quest status` still does not
  parse the decisions listed in a PR body. It also amends the 2026-10-20
  decision: a PR is owned while it carries a `quest:*` label or is a draft
  without that section.
- Decided (user): this epic ranks after the worktree and gate quests and
  before the Kix decision UI. Children rank by sessions affected.
- Decided 2026-10-21 (user), from a month of moq maintainer transcripts:
  quests that remove the maintainer's repeated steering join this epic.
  `/quest-afk` and the guide rules rank first, since they save the most
  maintainer time and change only prose. The complete loop ranks right after
  the PR state commands, which also rewrite `complete`. Findings that fit an
  existing child went into it: the merge method and the merged-PR refusal
  into the PR state commands, which landed in
  [moq-dev/quest#185](https://github.com/moq-dev/quest/pull/185).

- Decided 2026-10-26 (user), from moq-dev/moq's serial merge queue: a batched
  merge gate, `quest land`, joins this epic. It ranks after the existing
  children, and moq-dev/quest adopts it first. moq-dev/moq, moq-dev/moq.pro,
  and moq-dev/rust2 plan their own adoption.
- Decided 2026-10-27 (user), from the follow-ups of
  [moq-dev/quest#229](https://github.com/moq-dev/quest/pull/229): the
  gate's rule and setup fixes rank after its adoption, which verifies forks
  live.
- Decided 2026-10-28 (user), from the follow-ups of
  [moq-dev/quest#271](https://github.com/moq-dev/quest/pull/271): the
  delegated follow-up rule ranks right after the review rules, as a prose
  rule, and dropping `review-rounds` follows it.

## Required

- [quest merge --land gaps](/quest/m0/helpers/merge-land.md) - squash on squash-only repositories, PR URLs outside a checkout, labels released after direct merges, and a warning when auto-merge outlives its head
- [Headless agents](/quest/m0/helpers/headless-agents.md) - `/quest-spawn api` launches, resumes, and stops billed agents through one command auto mode allows
- [Sibling PRs through a server-side merge](/quest/m0/helpers/queue-siblings.md) - children of one epic land back to back through a merge queue without conflicting on its link list
- [moq-dev/quest lands through quest land](/quest/m0/helpers/land-adopt.md) - this repository's `main` changes only through its own gate
