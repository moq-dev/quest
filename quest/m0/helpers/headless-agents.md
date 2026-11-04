# [M] Headless agents on the logged-in account

## Goal

`quest agent start|resume|stop` runs Claude Code and Codex agents on the
user's logged-in account, with no API keys, so a coordinating session can
start the other vendor's agents, and Claude Code's auto mode allows those
commands on the user's invocation alone, with no per-user settings.
`/quest-spawn api` and `QUEST_API_KEYS` are removed.

## Plan

Decided 2026-11-04 (user, /quest-plan of
[model routing](/quest/m0/model-routing/README.md)): billed spawns are
removed, since the user no longer runs `/quest-spawn api`. This replaces
the 2026-10-20 goal, a billed launcher for `api` spawns. Claude Code's
`Agent` starts only Claude models and Codex only its own, so `quest agent`
stays as the way to start the other vendor.

- Remove from `src/cli/agent.ts` and `quest agent`: `--key`, `QUEST_API_KEYS`
  and its key store, `op inject` resolution, the per-key redaction, and
  exit 3 for an exhausted key. Keep stripping the coordinating session's
  harness variables and credentials (`STRIPPED`), so the agent runs on the
  CLI's own login rather than as the session's sub-session. Report a CLI
  that is logged out or at its usage limit distinctly, reusing the matcher
  [Reviewer usage limits](/quest/m0/review-quota.md) shares, so
  `/quest-spawn` can skip that harness's quests.
- Remove the `## API keys` section and the `api` resume path from
  `assets/skills/spawn.md`, and the billed-spawn text from the README,
  `quest agent --help`, and `docs/windows.md`, with their tests.
- Found on 2026-10-20 running `/quest-spawn api` in moq-dev/moq (16 quests,
  three keys): the auto-mode classifier blocked 5 commands, including 3 of
  about 25 launches and resumes that matched ones it allowed, under "Create
  Unsafe Agents", "Unauthorized Persistence", and "Credential
  Materialization". The classifier reads user messages, CLAUDE.md, and tool
  calls, not tool results
  ([docs](https://code.claude.com/docs/en/permission-modes)). Decided (user,
  2026-10-20): no settings fix; a prose `autoMode.allow` entry would work,
  but every user would have to add it. Dropping the key handling removes
  the credential steps it flagged.
- Validate with a `/quest-spawn` that starts Codex agents through `quest
  agent` in a repository with no `autoMode` settings: no classifier blocks
  on `start`, `resume`, or stopping a live agent.
- Only if blocks remain: each dispatching skill's stub body states what
  invoking it authorizes (starting, resuming, and stopping background agents
  in isolated worktrees), since stub text is part of the user turn the
  classifier reads. That changes the stub body once: `init` and `uninstall`
  recognize a stub of any version by its body (`STUB` in
  `src/cli/setup.ts`), so it must accept both the old and the new body.
- The command does no load or CPU admission: the guide routes the agents'
  expensive commands through `quest gate`.

## Related

- [Reviewer usage limits](/quest/m0/review-quota.md) - [moq-dev/quest#471](https://github.com/moq-dev/quest/pull/471) also edits `src/cli/agent.ts`'s usage-limit matcher
