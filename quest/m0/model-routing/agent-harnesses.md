# [M] quest agent starts Grok and opencode

## Goal

`quest agent start|resume|stop` drives the Grok CLI and opencode as well as
Claude Code and Codex, each on the user's logged-in account, so
[routing](/quest/m0/model-routing/models.md) can start a quest on any
entry of its ranked list and fall through on a usage limit.

## Plan

Decided 2026-11-04 (user, /quest-plan): XS quests start on Grok, falling
back to DeepSeek through opencode.

- Both run headless (checked 2026-11-04 on this host): grok 1.0.70 has
  `-p` (single turn), `--resume`, `-m`, `--output-format json`, and
  `--json-schema`; opencode v2.2.5 has `opencode run` with `--model
  provider/model#variant`, `--session`, and `--format json`. Effort maps to
  grok's reasoning effort and opencode's `#variant`; find each CLI's flag.
- Report the session, reply, outcome, and a distinct exit for a logged-out
  CLI and for a usage limit, as `quest agent` does for Claude Code and Codex.
  Reuse `src/runner/opencode.ts`'s handling of opencode's output and limits
  where it fits; it drives opencode for kix jobs.
- Strip the coordinating session's variables, as `STRIPPED` does, and
  keep each CLI's own configuration directory so its login works.
- Extend `quest agent`'s tests with stub CLIs, as for the existing two.

## Required

- [Headless agents](/quest/m0/helpers/headless-agents.md) - `quest agent` first moves to the logged-in account and drops API keys
