# [M] Single-pass review

## Goal

A `quest review` round explores the change once. The reviewer starts with
the diff, the base's `REVIEW.md`, and the responses to earlier findings, and
never reloads `quest guide`, `quest context`, or the repository's
instruction files, or runs builds and tests. `quest review` with no flags
reads the size and implementing models from the PR body's `## Models`
record. Review efforts follow the new table below, and low-severity
findings end the loop once handled.

## Plan

Decided 2026-11-05 (user, /quest-plan, the
[token waste](/quest/m0/token-waste/README.md) audit).

Measured, Codex reviews over 30 days:

- Round 1 is two full reviews. `src/cli/review.ts` runs the harness's
  built-in review (`codex exec review`, or Claude's `/code-review`), then
  resumes it with `firstPrompt`'s "Report your review as JSON", and that turn
  re-explores from scratch: 608M input (121M uncached) against the first
  pass's 706M. The two passes agree on whether there are findings in 96.5% of
  reviews; the second added findings 41 times (2.5%). Later rounds resume
  cheaply (404M input, 28M uncached over 934 rounds).
- The reviewer ran `quest guide` 2,125 times and `quest context` 598 times,
  plus about 7.8k `git show` reads of instruction files it already had: about
  163M tokens carried.
- Each review request carries a ~10k-token skills catalog (92 entries, many
  repeated 4×), about 270M over 26,765 requests (estimate), and the
  maintainer's global `AGENTS.md` leaks in despite `--ignore-user-config`.
- 26% of tool outputs hit the ~40k-character cap and get re-read in slices.
- Tests ran in 483 of 4,219 review turns and builds in 71. Few tokens, but
  `quest gate` stalls in the read-only sandbox and the reviewer polls it.
- Claude sessions ran `quest review --help` 1,130 times, mostly to find
  `--exclude-model` and `--size`.

Decision prompts, chosen options marked ✅:

- Review efforts: ✅ revisit in this quest (rejected: record the cost data
  in the model check; leave the table). The Sol column becomes XS low,
  S medium, M medium, L high, XL xhigh, replacing M high and L xhigh from
  [moq-dev/quest#493](https://github.com/moq-dev/quest/pull/493). xhigh cost
  2-6× more per review, and only 4 large xhigh reviews exist, so nothing yet
  shows it finds more. The Opus column is unchanged. This PR updates
  [Model check](/quest/m0/model-check.md)'s Plan with the change, so its
  audit compares findings by effort once reviews are single-pass.
- Round budget: ✅ adopted 2026-11-05 (user), after Theo's
  [`sol-loop`](https://github.com/t3dotgg/tstack). A round whose findings
  are all low severity needs no further round once they are fixed or
  refuted, and a later round checks only the changes since the reviewed head
  and the open findings. `quest context`'s Reviews section and
  `/quest-review` change with it; the round-3 design checkpoint stays.
- Where the size and implementing models come from: ✅ read the PR body's
  `## Models` record when no flag is given; flags still override (rejected:
  keep the flags only). The implementing agent writes that record and passes
  the flags today, so trust is unchanged. #493's rule stands: the size never
  comes from the head's files.

Recommendations for the implementer:

- `codex exec review` takes custom instructions as its prompt argument, and
  Claude's `/code-review` accepts text after its target. Put the scope,
  `REVIEW.md`, the responses, and the report shape into round 1 itself, so
  the follow-up turn only shapes the answer. Prefer one turn when the harness
  can return the schema directly.
- The prompt says that the repository's instruction files and `REVIEW.md`
  are already given, and forbids builds, tests, and `quest` commands.
- Drop the skills catalog with Codex's `-c skills.include_instructions=false`
  (Codex config reference, checked 2026-11-05), and find a supported way to
  drop the user's global `AGENTS.md`; verify both in the transcript, not by
  assumption.
- Skip a round when the head has not changed since the last review.

## Related

- [Review sessions keyed by upstream branch](/quest/m0/review-session-key.md) - the detached-HEAD failures
- [Route quests to models by size](/quest/m0/model-routing/README.md) - shares the size tables
