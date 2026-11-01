# [S] quest init removes stale skill stubs

## Goal

`quest init` and `quest uninstall` remove Quest skill stubs whose skill
no longer exists, such as `quest-ready`, from `.claude/skills` and
`.agents/skills`. They recognize a stub by its Quest-written content, so a
user's own skill with a `quest-` name is never touched.

## Plan

Decided 2026-10-28 (user, /quest-plan of the follow-ups from [moq-dev/quest#271](https://github.com/moq-dev/quest/pull/271)).

- #271 removed `/quest-ready`, but repositories that ran `quest init`
  earlier still list it, and agents invoke it.
- `src/cli/setup.ts` recognizes a stub only by exact match with a current
  skill's stub. Recognize a retired one by the stub's shape (frontmatter, then
  the ``Run `quest skill <name>` and follow its output.`` body; the
  description varies) for a name `quest skill` no longer has, rather than a
  list of retired names.
- Re-running `quest init` after upgrading the pin is how a repository picks
  this up; no new check command.
