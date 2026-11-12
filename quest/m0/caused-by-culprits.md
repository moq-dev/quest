# [S] Caused by names only the PR that shipped the defect

## Goal

A fix's `## Caused by` names the PR whose diff introduced the defect, not
one that only touched the same lines, deferred the work to a planned
follow-up, or kept behavior older than it, so the escapes `quest usage`
counts are defects.

## Plan

The 2026-11-11 [mistake audit](/quest/m0/mistake-audit.md) found 4 of 14
moq-dev/moq culprit links named a PR that shipped no defect:
[moq-dev/moq#8294](https://github.com/moq-dev/moq/pull/8294) and
[moq-dev/moq#8440](https://github.com/moq-dev/moq/pull/8440) left the work
to a planned follow-up,
[moq-dev/moq#8362](https://github.com/moq-dev/moq/pull/8362) deferred it on
the maintainer's decision, and
[moq-dev/moq#8402](https://github.com/moq-dev/moq/pull/8402) kept an older
order. `quest context` says to find the culprit "by `git blame` on the
lines the fix changes", which finds the last PR to touch them.

Agent's choices, for the implementer to revisit:

- Reword that rule in `assets/CONTEXT.md` to confirm in the blamed PR's
  diff that it introduced the defect, else follow blame further back or
  say no single PR caused it. This is a prose rule because only judgment
  can tell a defect from a deferral. `assets/CONTEXT.md` is at 9,933 of
  its 10,000 characters, so the rewording must not grow it.
- Follow `quest guide prompting`.
