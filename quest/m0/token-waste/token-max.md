# [L] token-max recommends agent settings

## Goal

[kixelated/token-max](https://github.com/kixelated/token-max), a Rust CLI
published on crates.io, replays this host's Claude Code and Codex
transcripts against public API prices and reports which agent settings
should change. For each setting it prints the current value, the
recommended one, the file or tool that owns it, the evidence, and what the
change would have saved over the window and per month. It exits nonzero
when anything should change and never edits settings. Quest's `SETUP.md`
points to it, and this epic's closing re-measure runs it.

## Plan

Decided 2026-11-05 (user, /quest-plan, the
[token waste](/quest/m0/token-waste/README.md) epic). The maintainer asked
for a command that "reads transcripts and determines if settings need to be
changed", such as whether sub-agents should use a 5m or 1h cache based on
public API pricing. It was first planned as `quest doctor`
([moq-dev/quest#512](https://github.com/moq-dev/quest/pull/512)); the same
day the maintainer asked whether a tool separate from quest could "win some
ez internet points", and it became this standalone tool.

Survey, 2026-11-05: no tool recommends settings from transcripts for both
harnesses, and none covers the compaction window or the Bash cap.

- [ccusage](https://github.com/ccusage/ccusage) (19.3k stars) reports usage
  and cost for about 18 harnesses but recommends nothing. It is now Rust,
  but its crates are not on crates.io, and its JSON is per day and per
  session, without per-request times, context sizes, or the 5m/1h write
  split a replay needs.
- [cebert/cache-ttl-analyzer](https://github.com/cebert/cache-ttl-analyzer)
  replays one Claude session at 5m and 1h, main conversation only.
  [Jerry0022/dotclaude#613](https://github.com/Jerry0022/dotclaude/pull/613)
  is the same check as a prompt (5m cost them 24-38% more).
- [jdx/jouet](https://github.com/jdx/jouet) audits tokens and drafts agent
  rules, not settings. Claude-Code-Usage-Monitor and claude-cost-optimizer
  are a live monitor and cost guides.

Decision prompts, chosen options marked ✅:

- Checks in the first version: ✅ cache TTL, ✅ compaction window, ✅ Bash
  and wait caps (rejected: review efforts, which the
  [model check](/quest/m0/model-check.md) owns).
  - Cache TTL: 5m or 1h, separately for main sessions and sub-agents
    (Claude Code's `promptCacheTtl` and `subagentPromptCacheTtl`), by
    replaying each session's request gaps: under 5m, a gap of 5 to 60
    minutes rewrites the cached prefix at the 5m write price instead of
    reading it; under 1h, every write costs the 1h price.
  - Compaction window: Claude Code's `autoCompactWindow` and Codex's
    `model_auto_compact_token_limit`, from the spend on requests above each
    candidate context size, net of the compaction requests a lower window
    would add.
  - Bash and wait caps: `BASH_MAX_TIMEOUT_MS` against the cache TTL (a cap
    at or above the TTL lets a wait outlive the cache), and Bash calls that
    hit the cap or poll in loops.
- Applying: ✅ recommend only (rejected: `--fix`). The maintainer's dotfiles
  rewrite the agent settings every hour, so a direct edit would be
  overwritten; the output names the owner instead.
- Milestone: ✅ m0, in this epic (rejected: m1). Usage measures and
  token-max tunes, which closes the epic's measurement loop.
- Where it lives: ✅ a standalone tool (rejected: `quest doctor`; a
  `doctor` command proposed to ccusage, which would reach its users at once
  but waits on its maintainer).
- Data: ✅ its own per-request transcript parser and
  [models.dev](https://models.dev) prices, the catalog ccusage also uses
  (rejected: ccusage's output, which lacks the per-request detail).
- Language: ✅ Rust. Repository: ✅ kixelated. Name: ✅ token-max, the
  maintainer's pick (free on crates.io and under kixelated; 191 GitHub
  repositories share the name, and
  [Kalmantic/jusTokenMax](https://github.com/Kalmantic/jusTokenMax), a
  token-reduction toolkit, is close in name and topic).
- Quest wrapper: ✅ none (rejected: `quest doctor` calling token-max).
  [quest usage](/quest/m0/token-waste/usage.md) reuses ccusage instead, so
  the two share no code.

The 2026-11-05 audit did the cache replay by hand over 10-30 to 11-05 at
Opus 5.5's models.dev prices ($5 per million for a 5m write, $8 assumed for
a 1h write, $0.20 for a read). 1h cost $5,494 for main sessions and $1,906
for sub-agents; 5m would have cost $8,869 and $2,382, so the 1h TTL saves
about $17k a month at API prices (38% and 20%). The scripts are not kept, so
this quest rebuilds the method and should reproduce those figures.

Agent's choices, for the implementer to revisit:

- A fourth check, Codex's skills catalog: entries listed more than once, or
  a catalog over `skills.max_context_tokens`. The audit found 182 entries,
  104 of them copies of claude.ai's synced skills, fixed in
  [kixelated/dotfiles#47](https://github.com/kixelated/dotfiles/pull/47).
- Fetch prices from models.dev's `api.json` with a cached copy, and say
  which price an estimate assumed when the catalog lacks one (such as the
  1h write).

Recommendations for the implementer:

- A replay assumes sessions would behave the same under the other setting.
  Say so in the output, and recommend a change only when the saving clears
  that uncertainty.
- Default to a window since the setting last changed, read from the
  transcripts (each request records its cache TTL), so old behavior does not
  argue against a setting already in place.
- Codex exposes no cache TTL, so the cache check covers Claude Code only.
- Read sessions where each CLI keeps them, honoring `CLAUDE_CONFIG_DIR` and
  `CODEX_HOME`, and never print prompt or reply text.
