# [S] Agents stop spinning a core while they wait

## Goal

Agents no longer wait with loops that spin a CPU, such as
`read -t 1 < /dev/zero`, which they reach for because the rules forbid
`sleep`. They block on the harness's own wait, `quest wait`, or the
command itself, as `assets/CONTEXT.md` intends.

## Plan

Found 2026-11-12 in read-only host audits: reading `/dev/zero` never
blocks, so `read -t N < /dev/zero` busy-loops for its whole timeout. The
pattern appears 254 times in one host's transcripts since 11-08, and one
session spent 0.39 CPU-hours in it during a 4.8-hour sample. The Workspace
rule says never to poll background work with `sleep` or status checks,
and agents read that as a ban on the `sleep` command rather than on
polling.

Decided 2026-11-12 (maintainer, /quest-plan): ✅ plan it in m0
(rejected: m1; dropping it).

Agent's choices, for the implementer to revisit:

- Prefer a check over prose, per [token-waste](/quest/m0/token-waste/README.md)'s
  decision that mechanical rules become hooks or lint: a rule in `quest
  hook`'s `PreToolUse` handler, which both Claude Code and Codex already
  run on shell commands (`src/cli/hooks.ts`), that refuses a command
  reading `/dev/zero` with `read -t` or in a loop, and names the wait to
  use instead.
- If prose is still needed, make the existing rule say polling in any
  form, not only `sleep`, rather than adding a new rule, since
  `assets/CONTEXT.md` must stay under 10,000 characters.
