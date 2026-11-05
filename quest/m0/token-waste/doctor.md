# [M] quest doctor

## Goal

`quest doctor` replays this host's agent transcripts against public API
pricing and reports which agent settings should change. For each setting it
prints the current value, the recommended one, the file or tool that owns
it, the evidence, and the cost the change would have saved over the window,
and it exits nonzero when anything should change. It recommends only; it
never edits settings.

## Plan

Decided 2026-11-05 (user, /quest-plan, the
[token waste](/quest/m0/token-waste/README.md) epic). The maintainer asked
for a command that "reads transcripts and determines if settings need to be
changed", such as whether sub-agents should use a 5m or 1h cache based on
public API pricing.

Decision prompts, chosen options marked ✅:

- Checks in the first version: ✅ cache TTL, ✅ compaction window, ✅ Bash
  and wait caps (rejected: review efforts, which the
  [model check](/quest/m1/model-check.md) owns).
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
- Relation to [quest usage](/quest/m0/token-waste/usage.md): ✅ a separate
  command and quest that reuses its transcript reader and pinned price table
  (rejected: a `quest usage --doctor` mode). Usage reports what happened;
  doctor recommends what to change.
- Applying: ✅ recommend only (rejected: `--fix`). The maintainer's dotfiles
  rewrite the agent settings every hour, so a direct edit would be
  overwritten; the output names the owner instead.
- Milestone: ✅ m0, in this epic (rejected: m1). Usage measures and doctor
  tunes, which closes the epic's measurement loop.

The 2026-11-05 audit did this replay by hand. Since 10-30, 3.4% of main
session requests and 1.6% of sub-agent requests followed a 5-60 minute gap,
so a 5m TTL would have cost 35% and 14% more cache spend than 1h. Before
then the default 5m TTL caused 194M weighted tokens (5%) of cache misses.
The scripts are not kept, so this quest rebuilds the method.

Recommendations for the implementer:

- A replay assumes sessions would behave the same under the other setting.
  Say so in the output, and recommend a change only when the saving clears
  that uncertainty.
- Default to a window since the setting last changed, read from the
  transcripts (each request records its cache TTL), so old behavior does not
  argue against a setting already in place.
- Codex exposes no cache TTL, so the cache check covers Claude Code only.

## Required

- [quest usage](/quest/m0/token-waste/usage.md) - the transcript reader and price table it reuses
