# [S] Context before every decision prompt, and automation before maintainer steps

## Goal

Every decision prompt first gives the maintainer the context to answer it
without opening the quest or PR: what the work is, the problem it hit, and
what each option would change. A `Maintainer:` waiting item says why an agent
cannot take the step itself, and agents automate a step rather than leave it
to a person whenever they can.

## Plan

Decided 2026-11-02 (maintainer, /quest-plan of the follow-ups from a scan of
the maintainer's Claude Code and Codex transcripts since 2026-10-12):

- Is that the goal? The proposal was plain words and defined jargon; the
  maintainer answered "I mostly just lack context, so include context
  before quest-decide or whatever", so the quest is context first.
- Also require a `Maintainer:` item to say why an agent can't do it? Context
  only; ✅ context and automation, in Quest's shared guide.
- Which milestone? ✅ m0, after the land work and before Kix; m0 last; m1.

Evidence from the scan:

- 26 confused answers in 14 sessions ("I lack context, what are the
  device-grant slots...?", "sorry what? can you explain?", "I have no idea
  what you're talking about with the moq smoke token"). The confusing
  questions were longer, not shorter (median 403 characters against 294), so
  the fix is context, not length.
- About 35 moq.pro drafts existed only to hold steps for a person ("retain …
  proof", "record … blockers"), and the maintainer asked twice to "automate
  everything, avoiding a human in the loop unless it's not possible"
  (2026-10-30, 2026-11-02).

Files: the guide's Questions and Creation sections in `assets/AGENTS.md`,
and `assets/skills/grill.md`.

- Questions: open each prompt with the context it needs; name and explain
  anything the agent or its PR introduced.
- Creation: a `Maintainer:` item states why an agent cannot do it and what
  automation was considered; a quest that only waits on someone else carries
  `## Waiting` instead of an evidence-only draft PR.
