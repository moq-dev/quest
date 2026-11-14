# [M] Split each session's time into categories with a cheap model

## Goal

Each session's record says where its time and tokens went beyond the
waits tools already time: a cheap model reads the finished transcript and
sorts the rest into a fixed list of categories, such as understanding the
task, writing, testing, fighting git, working around the forge, redoing
work after a review, and going in circles, and names in a line what went
wrong when something did. The split is sent with the session's record, so
the report can rank where the factory loses time and whether a fix moved
it.

A stronger model re-classifies a sample, and the disagreement rate is
reported beside the split, so the classifier has a known error.

Non-goal: a programmatic log of every command, which the maintainer ruled
out ("maybe Haiku could scan a transcript to classify time spent into
categories rather than listing every single command run").

## Plan

Decided 2026-11-13 (user, /quest-plan): exact timings where a tool has
them, a cheap model for the rest (rejected: the model alone; tool timings
alone).

Agent's choices, for the implementer to revisit:

- The maintainer named "Haiku/Jev" for the classifier. No model called Jev
  is known to the planner; use Haiku unless the maintainer names another,
  and add the role to `src/cli/models.ts` so the model check retunes it.
- Fix the category list in code, with one catch-all, so splits compare
  across weeks. Settle the list from a sample of real transcripts before
  writing the prompt, and change it only with a note of the date, since a
  change breaks the trend.
- Give the model the transcript's tool calls with their timestamps and
  results trimmed, not full file contents, and have it return time and
  tokens per category that sum to the session's totals after the exact
  waits are taken out.
- Its own cost is a record too, so the report shows what measuring costs.
- This reads transcript text, which the records otherwise never do. Only
  the categories and the one-line note leave the host; a note names no
  customer and quotes no message.

## Related

- [Mistake audit](/quest/m0/mistake-audit.md) - groups what went wrong
  into classes weekly, and can read these notes instead of inferring them
