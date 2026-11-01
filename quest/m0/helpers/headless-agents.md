# [S] Headless agents for billed spawns

## Goal

`/quest-spawn api` starts, resumes, and stops each billed agent through
`quest agent`, and Claude Code's auto mode allows those commands on the user's
invocation alone, with no per-user settings.

## Plan

`quest agent start|resume|stop` replaces the launcher each session wrote: it
resolves `QUEST_API_KEYS` once into a spawn-scoped store, strips the
harness's variables, passes one key, reports the session, cost, outcome, and
reply, and exits 3 for an exhausted key. What remains is proving the classifier
allows it.

Found on 2026-10-20 running `/quest-spawn api` in moq-dev/moq (16 quests,
three keys): the auto-mode classifier blocked 5 commands, including 3 of about
25 launches and resumes that matched ones it allowed, under "Create Unsafe
Agents", "Unauthorized Persistence", and "Credential Materialization". The
classifier reads user messages, CLAUDE.md, and tool calls, not tool results
([docs](https://code.claude.com/docs/en/permission-modes)), so it saw only an
opaque `run.sh` next to variable stripping and key handling. Decided (user,
2026-10-20): no settings fix; a prose `autoMode.allow` entry would work, but
every user would have to add it.

- Validate with a multi-agent `api` spawn in a repository with no `autoMode`
  settings: no classifier blocks on `start`, `resume`, or stopping a live
  agent, and exhausted keys hand off without the coordinator writing a script.
- Only if blocks remain: each dispatching skill's stub body states what
  invoking it authorizes (starting, resuming, and stopping background agents in
  isolated worktrees, and with `api`, billing them to the user's keys), since
  stub text is part of the user turn the classifier reads. That changes the
  stub contract ("the stub never changes between versions") once: `init` and
  `uninstall` accept only a stub that exactly matches the current text, so they
  must also recognize the known older stub text.
- Support native Windows, which `quest agent` refuses for now: resolve the
  agent CLI to an absolute path from `PATH` with `PATHEXT`, never from the
  worktree (Windows searches the current directory first, so a worktree could
  supply its own `claude.exe` and receive the key), and launch npm `.cmd` shims,
  which `spawn` cannot run without a shell. Then run the fake-CLI tests on the
  native Windows jobs.
- The command does no load or CPU admission, and the skill no longer caps
  agents: the guide routes their expensive commands through `quest gate`.
