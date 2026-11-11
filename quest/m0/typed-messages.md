# [M] quest prints the maintainer's typed messages

## Goal

One `quest` command prints the messages a person typed to their agents on
this host since a date, across Claude Code and Codex sessions, each with
its time, harness, repository, and session. It prints nothing else: no
agent reply, tool call, tool output, or machine-written prompt. The
[mistake audit](/quest/m0/mistake-audit.md) reads its output instead of
rebuilding the extraction every run.

## Plan

Decided 2026-11-09 (user, /quest-plan):

- May quest read prompts?
  - ✅ The user's typed messages only, through a quest command
  - Rejected: forge records only, which miss what the user corrects in chat
  - Rejected: a script the audit's agent writes each run, which rebuilds
    the extraction and its noise filters every time
- Which milestone? ✅ m0 (rejected: m1)

Why: the 2026-11-09 scan was the third hand-run transcript audit in six
days, after the [token waste](/quest/m0/token-waste/README.md) audit and
the workflow audit of
[moq-dev/quest#594](https://github.com/moq-dev/quest/pull/594). It cost a
throwaway script and three sub-agents, about 220k tokens.

Agent's recommendations, for the implementer to revisit:

- `quest usage` promises to read "never a prompt or reply" (README, "Audit
  cost and accuracy"). Keep that true of its report: this is its own
  command or flag, documented with exactly what it reads and prints.
  Output goes to stdout only; nothing is posted or stored.
- Find sessions the way `quest usage` does, and print a session once when
  it is logged under two directories.
- What the hand scan learned about the logs. Claude Code: a `user` line
  that is not meta, not a sidechain, and holds no tool result, minus what
  the harness injects (command wrappers, task notifications, reminders,
  skill bodies, compaction summaries). Codex: a `response_item` message
  with role `user`, minus injected instruction blocks; its `event_msg`
  stream held no user text.
- Telling typed from machine-written is the command's main job. Of the 579
  mid-session messages that passed those filters, sub-agents judged about
  227 machine-written: coordinator relays, PR watch updates, delegated
  briefs, and away-mode relays, all in sessions driven through T3 Code. A
  headless session's first message is its brief, not typed. Look for a
  field that marks the sender, such as in T3 Code's own state, before
  matching on wording.
- Test with synthetic transcripts; never commit a real one.

## Related

- [Mistake audit](/quest/m0/mistake-audit.md) - the command's consumer
- [Cut agent token waste](/quest/m0/token-waste/README.md) - its audit read
  the same transcripts for cost
