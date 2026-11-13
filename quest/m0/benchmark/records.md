# [L] Send each session's record to Kixel Code

## Goal

When an agent session on a quest or PR ends, `quest` sends one record of
it to Kixel Code: the repository, PR, and quest; its role (planning,
implementing, iterating, reviewing, merging); harness, model, and effort;
tokens and their price; wall time; and each wait a tool already times
exactly, by kind: queued in `quest gate`, running a gated command, waiting
on CI or a reviewer in `quest wait`, waiting in the merge queue, and
waiting on a person's answer. A PR's records add up to its whole cost,
including sub-agent and coordinator sessions that `quest usage` could not
trace to a PR on 2026-11-11, when it traced 28% of host spend.

The record is a type `quest` exports, so Kixel Code, which uses `quest` as
a library, stores exactly what is sent. `quest usage` prints the same
records for a contributor's own sessions. A contributor whose checkout
names no Kixel Code endpoint, or who has no access to it, sends nothing,
and `quest` says so once.

Non-goals: logging every command; sending prompts, replies, or any
transcript text; CI runner compute, which the forge reports and Kixel Code
reads itself.

## Plan

Decided 2026-11-13 (user, /quest-plan): Kixel Code stores the records, as
[the epic](/quest/m0/benchmark/README.md) records, and measuring covers
"the time spent blocked on GitHub or CI or git or a human".

Agent's choices, for the implementer to revisit:

- Build the record from what `quest usage` already reads per session, so
  one code path prices a session for both. Its attribution through
  token-max is
  [moq-dev/quest#704](https://github.com/moq-dev/quest/pull/704).
- Send from the hook that already runs when a session stops, and resend
  what failed on the next run, so a host that is offline loses nothing. A
  record carries the session's id, so a resend replaces and never doubles.
- A wait on a person is the time between an agent's question and the
  typed answer, both timestamped in the transcript; `quest messages`
  already pairs them.
- Sessions with no PR yet, such as planning, are sent against their branch
  and joined to the PR once it opens.
- Leave time no tool times, such as fighting git or redoing work, to
  [the time split](/quest/m0/benchmark/time-split.md).

## Related

- [Development as a benchmark](/quest/m0/benchmark/README.md) - the
  decisions this builds on
- [Price sessions through token-max](/quest/m0/routing-evidence/usage-token-max.md) -
  the per-session pricing these records reuse
