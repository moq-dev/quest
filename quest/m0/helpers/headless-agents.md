# [S] Auto mode allows headless agent launches

## Goal

Claude Code's auto mode allows `quest agent start`, `resume`, and `stop` on
the user's invocation of a dispatching skill alone, with no per-user
settings, so a `/quest-spawn` can start the other vendor's agents without
classifier blocks.

## Plan

`quest agent` now runs agents on each CLI's logged-in account, and
`/quest-spawn api` and `QUEST_API_KEYS` are gone
([moq-dev/quest#492](https://github.com/moq-dev/quest/pull/492)). That
removed the credential steps the classifier flagged.

- Found on 2026-10-20 running `/quest-spawn api` in moq-dev/moq (16 quests,
  three keys): the auto-mode classifier blocked 5 commands, including 3 of
  about 25 launches and resumes that matched ones it allowed, under "Create
  Unsafe Agents", "Unauthorized Persistence", and "Credential
  Materialization". The classifier reads user messages, CLAUDE.md, and tool
  calls, not tool results
  ([docs](https://code.claude.com/docs/en/permission-modes)). Decided (user,
  2026-10-20): no settings fix; a prose `autoMode.allow` entry would work,
  but every user would have to add it.
- Only if blocks remain: each dispatching skill's stub body states what
  invoking it authorizes (starting, resuming, and stopping background agents
  in isolated worktrees), since stub text is part of the user turn the
  classifier reads. That changes the stub body once: `init` and `uninstall`
  recognize a stub of any version by its body (`STUB` in
  `src/core/init.ts`), so it must accept both the old and the new body.
- The command does no load or CPU admission: the guide routes the agents'
  expensive commands through `quest gate`.

## Waiting

- Maintainer: in Claude Code's auto mode, in a repository with no
  `autoMode` settings, run a `/quest-spawn` that starts Codex agents through
  `quest agent` (ask for them on Codex), then answer one so it resumes, and
  stop one while it runs. An agent cannot: the classifier judges only an
  interactive auto-mode session's own user turns, and background agents run
  with permissions bypassed. Done when no `start`, `resume`, or `stop` was
  blocked; delete this quest then, or take the stub change above if one was.
