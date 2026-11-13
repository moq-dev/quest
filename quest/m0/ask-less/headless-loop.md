# [L] Run a repository's quest loop headless and push when decisions wait

## Goal

One command runs a repository's `/quest-run` as a headless agent that never
asks: it takes the standing picks, starts ready quests, iterates and
merges, and defers every decision the maintainer owns, as `/quest-afk`
does. When it goes idle with nothing left but the maintainer's decisions,
it runs a command the user configured once, with how many decisions wait
in which repositories. A host service runs it on a schedule, and the
maintainer answers in the
[decisions session](/quest/m0/ask-less/decisions-session.md).

Non-goal: the service and the channel, which the host owns: the
maintainer's are a kixel-ai/dotfiles quest posting to Discord.

## Plan

Decided 2026-11-12 (maintainer, /quest-plan,
[the epic](/quest/m0/ask-less/README.md)): ✅ headless loops with a push
when decisions wait (rejected: the same without a push; keep launching by
hand). The core runs a configured command, so it names no service.

From 2026-10-20 to 11-13 the maintainer hand-ran `/quest-complete` 192
times and `/afk` 112 times, each in one repository, and PRs readied
between 23:00 and 04:00 Pacific waited a median 5 to 9 hours for a pick.

Agent's choices, for the implementer to revisit:

- Build on `quest agent start`, which already runs a headless turn on the
  CLI's own login and reports `limited` on a usage limit, rather than a
  second runner. A limit ends the run cleanly; the next scheduled run
  resumes it.
- Push once per transition to "only decisions wait", never per run, so a
  schedule that finds nothing new says nothing.
- Keep the configured command in the user's own Quest settings, where
  `quest setup` writes, never in a repository.

## Related

- [Agent admission](/quest/m0/agent-admission.md) - what an unattended
  loop may start
- [Standing picks](/quest/m0/ask-less/standing-picks.md) - what it may
  merge without the maintainer
