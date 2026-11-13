# Ask the maintainer only what their answer changes

## Goal

Agents ask the maintainer only the decisions their answer is likely to
change. Everything else proceeds on a standing rule the maintainer set and
recorded, and stays reviewable after the fact. Each repository's work loop
runs without being launched by hand, and the maintainer opens one session
when they choose, or when a push says decisions wait.

This epic's own work is its closing re-measure: rerun the baseline below
over a week of sessions on every host, and record the comparison in its
closing PR.

Non-goals: releases and deploys, which keep their own approvals; the
online reviewers; changing what reviews a PR before it is ready.

## Plan

Decided 2026-11-12 (maintainer, /quest-plan), from the transcripts on the
maintainer's three Linux hosts and the forge records of moq-dev/moq,
moq-dev/moq.pro, moq-dev/quest, kixel-ai/rust2 and kixel-ai/rind:

- Goal? ✅ As above (rejected: keep every merge pick and stop only
  repeated and rubber-stamped questions; agents merge whatever they
  recommend and the maintainer only sets direction).
- Scope? ✅ All four: merge picks by change class, never asking twice,
  the loop running without the maintainer, and the machine-side blockers
  (rejected: none dropped).
- Which merges land on a standing pick? ✅ Every PR the coordinator would
  merge, except a protected list
  ([standing picks](/quest/m0/ask-less/standing-picks.md)) (rejected:
  plan PRs and bug fixes only; plan PRs only). The maintainer's override
  rate barely varies by kind of change, and the pick does not catch
  escapes: nearly every later culprit had been picked.
- Review after the fact? ✅ A list of what landed on a standing pick,
  acted on by naming one ([landed list](/quest/m0/ask-less/landed-list.md))
  (rejected: session summaries only; the list plus a weekly second-model
  audit). Either way the [mistake audit](/quest/m0/mistake-audit.md)
  counts escapes by standing and maintainer pick, and proposes narrowing a
  class whose escapes rise.
- Which planning questions stop? ✅ Milestone placement only
  ([milestone by rule](/quest/m0/ask-less/milestone-by-rule.md)); which
  follow-ups to plan is still asked (rejected: both; neither).
- The loop? ✅ Each repository's `/quest-run` runs headless on a schedule
  and never asks, a push goes out when only decisions remain, and one
  session asks them across every repository
  ([headless loop](/quest/m0/ask-less/headless-loop.md),
  [decisions session](/quest/m0/ask-less/decisions-session.md))
  (rejected: the same without a push; keep launching by hand, with one
  cross-repository `/quest-complete`).
- Push channel? ✅ The Discord webhook kixel-ai/dotfiles' storage-alert
  quest adds, so there is one place to look (rejected: a separate Discord
  channel; ntfy; decide later). Quest runs a configured command; the
  host owns the channel.
- How long does a recorded skip hold? ✅ Until the PR's head changes or the
  maintainer lifts it
  ([recorded picks](/quest/m0/ask-less/recorded-picks.md)) (rejected:
  until lifted; until the next day).
- Which repositories? ✅ Every repository, opting out or adding protected
  paths in its `CONTRIBUTING.md` as today (rejected: opt in per
  repository; all but those running production services).
- Milestone? ✅ m0 (rejected: m1; fixes in m0 and the loop in m1).

Host work, decided the same day, goes to kixel-ai/dotfiles' m0, since its
consolidate-hosts quest makes it the one repository for the maintainer's
hosts and archives kixel-ai/nixos:

- The service running each loop and posting to Discord.
- The dev-shell guard, which refused 601 agent session starts since 11-03.
  ✅ Keep its HEAD-on-origin check and accept the flake files at any version
  merged on the default branch, not only its tip. First picked without the
  HEAD check, then reversed once it turned out to reopen the fork-PR hole
  kixel-ai/dotfiles@7202fdf closed (rejected: drop the HEAD check too; also
  accept the agent's own flake changes; keep the guard as is).

Baseline. Typed messages and answers come from `quest messages --json` run
on each host, 2026-10-20 to 11-13; sessions whose Codex TUI turns it
rejects were skipped ([messages fix](/quest/m0/ask-less/messages-codex-tui.md)).
Blocking time comes from the session logs since 11-03; PR stages from the
forge timelines of PRs created and merged 11-03 to 11-13.

- 12,900 answers to agents' blocking questions, about 500 a day, with the
  maintainer active 7 to 12 hours every day. 74% took the recommendation
  unchanged, 8% picked another listed option, 12% typed something else
  (9% in the first week, 15% in the last), and 5% had no recommendation.
- 2,752 answers where the agent recommended merging, 5.1% overridden; 4.2%
  where the question named no API, breaking, decision, outside-author, or
  release signal. Since the narrow standing pick landed on 11-07, about
  127 such answers a day.
- 345 merge-pick answers and 80 skips repeated an answer already given for
  the same PR; 325 PRs were asked about three or more times.
- Milestone placement was asked 902 times (85% accepted), and which
  follow-ups to plan 602 times (86%).
- Typed overrides that were not just the recommendation retyped: 13% asked
  what something is or why, 12% cut scope or deleted, and 8% were about API
  shape or naming. Those, goal and scope, and product knowledge are where
  the maintainer's answer changed outcomes.
- Typed messages: 192 hand-run `/quest-complete`, 112 `/afk`, and status
  nudges such as "any new prs?", "finish up", and "continue" among the
  commonest short messages.
- 2,954 blocking questions since 11-03 kept their agents waiting 389 hours
  in total: median 2.4 minutes, p90 16 minutes, 8 over six hours.
- 2,354 merged PRs: median lead time 5.8 hours, p90 25.6. Of the summed
  lead time, implementation and local review took 38%, waiting from ready
  to the first pick 40% (median 1.0 hour, p90 12.2), and the queue 21%.
  A PR readied between 23:00 and 04:00 Pacific waited a median 5 to 9
  hours for its pick. 96% were first picked from the maintainer's account.
- 213 merged PRs (9%) are linked under a later PR's `## Caused by`, an
  upper bound, since the mistake audit found most such links are not real
  escapes.

## Related

- [Mistake audit](/quest/m0/mistake-audit.md) - tallies escapes by pick and
  the answers taken as recommended each week
- [Late signals](/quest/m0/late-signals.md) - holds a head on a marked
  decision comment, which recorded picks can share
- [Queue watcher](/quest/m0/queue-watcher/README.md) - re-enqueues the
  merge queue's drops, 21% of merged PRs' lead time
