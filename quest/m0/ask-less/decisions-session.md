# [L] Settle every repository's decisions in one session

## Goal

One `/quest-complete` session covers every repository the user works in:
it first says how many decisions wait, and where, then shows the
[landed list](/quest/m0/ask-less/landed-list.md), then asks the decisions
in its usual rounds, ranked across repositories by what each unblocks. It
edits each repository's quests in a checkout of that repository, one PR per
repository, as it does for one today.

## Plan

Decided 2026-11-12 (maintainer, /quest-plan,
[the epic](/quest/m0/ask-less/README.md)), with the
[headless loop](/quest/m0/ask-less/headless-loop.md): one session asks the
decisions every loop deferred.

Agent's choices, for the implementer to revisit:

- The repositories come from one list in the user's own Quest settings,
  which the headless loop's host service reads too, rather than a scan of
  checkouts.
- Reuse `quest waiting --json` per repository and merge the rankings,
  rather than a cross-repository command, unless the merge needs one.

## Related

- [Recorded picks](/quest/m0/ask-less/recorded-picks.md) - keeps it from
  asking what an earlier session settled
