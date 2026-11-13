# [M] Merge everything outside a protected list on a standing pick

## Goal

A coordinator that would recommend `/quest-merge` for a PR runs it without
asking, unless the PR is on the protected list:

- a public API or wire change, or a breaking (`!`) title
- a release, deploy, or backport, or anything that ships one
- a new dependency
- shipped agent rules or skills, such as Quest's own `assets/`
- an author without write access
- open decisions: a `## Waiting` section, or a plan PR holding decisions
  the maintainer did not make in its interview

A plan PR that records only the maintainer's own interview answers
qualifies, so adding or expanding quests no longer needs a pick by itself.
A repository's `CONTRIBUTING.md` can opt out, as today, or add protected
paths, such as deploy or billing configuration. The summary names each
PR merged this way, with the class it qualified under.

## Plan

Decided 2026-11-12 (maintainer, /quest-plan,
[the epic](/quest/m0/ask-less/README.md)): ✅ protected list (rejected:
plan PRs and bug fixes only; plan PRs only), in every repository with
`CONTRIBUTING.md` opt-out as today (rejected: opt in per repository; all
but production services).

The standing pick of `assets/skills/run.md` (landed in
[moq-dev/quest#534](https://github.com/moq-dev/quest/pull/534)) covers only
PRs with no user-facing behavior change that add no quests. This
replaces that rule there, in `assets/skills/afk.md` and `merge.md` where
they restate it, and in this repository's `AGENTS.md`, whose merge line
quotes the old rule.

Agent's choices, for the implementer to revisit:

- Judge the diff, not the title, as today, and ask when unsure. A pick
  stays standing only while each new head still qualifies.
- Record the class each merge qualified under, through
  [recorded picks](/quest/m0/ask-less/recorded-picks.md) once it lands,
  so the [landed list](/quest/m0/ask-less/landed-list.md) and the
  [mistake audit](/quest/m0/mistake-audit.md) can tell standing picks from
  the maintainer's.
- Before review, replay the rule over a sample of last week's merge-pick
  questions and report how many it would have taken and how many of those
  the maintainer overrode, from `quest messages --json`.

## Related

- [Mistake audit](/quest/m0/mistake-audit.md) - proposes narrowing a class
  whose escapes rise
