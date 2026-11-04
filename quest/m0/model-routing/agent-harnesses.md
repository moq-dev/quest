# [S] quest agent starts Grok

## Goal

`quest agent start|resume|stop` drives the Grok CLI as well as Claude Code
and Codex, on the user's logged-in account, so
[routing](/quest/m0/model-routing/models.md) can start XS quests on Grok
and fall through to Sol on a usage limit.

## Plan

Decided 2026-11-04 (user, /quest-plan): XS quests start on Grok high.
opencode left the lists (user), so `quest agent` does not drive it.

- Grok runs headless (checked 2026-11-04 on this host, grok 1.0.70): `-p`
  (single turn), `--resume`, `-m`, `--output-format json`, and
  `--json-schema`. Find its effort flag.
- Report the session, reply, outcome, and a distinct exit for a logged-out
  CLI and for a usage limit, as `quest agent` does for Claude Code and Codex.
- Strip the coordinating session's variables, as `STRIPPED` does, and keep
  Grok's own configuration directory so its login works.
- Extend `quest agent`'s tests with a stub Grok CLI, as for the existing two.

