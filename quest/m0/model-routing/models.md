# [L] Spawns and iterates route down a ranked list by size

## Goal

The `quest` binary ranks harnesses and models for each size: Opus writes the
code and Sol reviews it. `quest unblocked --json` reports each ready quest's
ranked list, and `/quest-spawn` starts the quest on the first entry that can
run: its CLI installed, logged in, and under its usage limit. A coordinator
that dispatches `/quest-iterate` (`/quest-complete`, `/quest-unblock`,
`/quest-merge`) sizes the work left on the PR, not the quest's original size,
and starts the iterate down that size's list, so a merge-and-record iterate on
an L quest runs at XS. A quest or iterate is skipped only when its whole list
is out. A repository's `AGENTS.md` may override the lists in prose; otherwise
every repository gets the same ones.

## Plan

Decided 2026-11-04 (user, /quest-plan); the evidence is in
[the epic](/quest/m0/model-routing/README.md).

- Where does each quest's model come from?
  - ✅ Lists built into `quest`, the same for every repository; a
    repository's `AGENTS.md` overrides them in prose (user, replacing a
    `MODELS.md` file per repository)
  - A `MODELS.md` in each repository, parsed by `quest`
  - Per quest, in its plan
- One model per size, or a ranked list?
  - ✅ A ranked list, so a usage limit falls through to the next entry
    (user, replacing "skip the quest and report the outage")
- Which models? ✅ Haiku writes XS and Opus writes S and up, with Sol as
  the fallback through L; XL has no fallback and waits for Opus (user,
  2026-11-05, revised below; replacing the 2026-11-04 lists that gave XS to
  Grok).
- Grok? ✅ Removed from routing and from every review (user, 2026-11-05:
  its weekly usage is close to zero and its results were weak), so
  `quest agent` gains no Grok harness; the "quest agent starts Grok" quest is
  deleted.
- A quest with an open decision? ✅ Routes one size up (user). The signal:
  a `Maintainer:` item under its `## Waiting`. An XL stays XL.

The lists, pinned in `src/cli/models.ts` beside the review lists
`quest review` reads (user, 2026-11-05, revised the same evening below):

| Size | Writes (spawn and iterate) | Reviews (`quest review`) |
|---|---|---|
| XS | claude `claude-haiku-5-5` high → codex `gpt-6.1-sol` low | codex `gpt-6.1-sol` low → claude `claude-opus-5-5` low |
| S | claude `claude-opus-5-5` low → codex `gpt-6.1-sol` medium | codex `gpt-6.1-sol` medium → claude `claude-opus-5-5` low |
| M | claude `claude-opus-5-5` medium → codex `gpt-6.1-sol` high | codex `gpt-6.1-sol` medium → claude `claude-opus-5-5` medium |
| L | claude `claude-opus-5-5` high → codex `gpt-6.1-sol` xhigh | codex `gpt-6.1-sol` high → claude `claude-opus-5-5` high |
| XL | claude `claude-opus-5-5` xhigh | codex `gpt-6.1-sol` xhigh → claude `claude-opus-5-5` xhigh |

Opus takes a review only when Sol wrote the code, and never reviews XL in
practice, since Sol writes no XL.

Revised 2026-11-05 evening (user, /quest-plan, while spawning the
[token waste](/quest/m0/token-waste/README.md) quests), replacing writes of
XS Opus low, S Opus medium, M Opus high, L and XL Opus xhigh, and Sol
fallbacks of medium, high, and xhigh for XS to M. Agents already running
keep the efforts they started with. Decision prompts, chosen options
marked ✅:

- Goal: ✅ every size gets a cheaper writer, so xhigh is XL's alone.
- Opus writes: ✅ one rung lower, S low, M medium, L high, XL xhigh (the
  user's proposal).
- XS writer: ✅ Haiku high, then Sol low (rejected: Haiku medium, Opus low,
  Sol medium, DeepSeek through opencode). The user asked whether Haiku high
  beats Opus low. No published benchmark measures Opus 5.5 at low effort.
  [Bito's coding benchmark](https://bito.ai/blog/claude-haiku-5-5-vs-sonnet-5-5-vs-opus-5-5/)
  (October 2026, judged by Opus) scored Haiku 5.5 high 87% on one-shot asks
  and 82% on long builds against Opus 5.5 medium's 90% and 87%, at 1/4 to
  1/23 of the cost; Haiku medium scored 76-79% with about three times the
  variance between sessions. Anthropic warns that low effort on long agent
  prompts skips checks and follow-through. models.dev prices Haiku 5.5 at
  $0.10/$0.50 per million input/output tokens, five times that for a
  request over 100k tokens, against Opus 5.5's $4/$20. DeepSeek would need
  an opencode harness and its sandbox in `quest agent`, which left on
  2026-11-04. The [model check](/quest/m1/model-check.md) moves XS back to
  Opus if Haiku's review scores lag.
- Sol fallbacks: ✅ one rung lower, XS low, S medium, M high, and a new L
  fallback at xhigh; XL keeps none (the user's pick; rejected: unchanged).
- Review efforts: ✅ [Single-pass review](/quest/m0/token-waste/review-single-pass.md)'s
  Sol column (XS low, S medium, M medium, L high, XL xhigh) replaces the
  rule that a review runs at the effort Sol would write at, since that
  decision ([moq-dev/quest#509](https://github.com/moq-dev/quest/pull/509))
  is newer than this quest's
  ([moq-dev/quest#507](https://github.com/moq-dev/quest/pull/507)) and
  carries the cost data. That quest's PR changes `REVIEWERS`; this one adds
  the write lists. Opus's review efforts follow its write efforts
  (rejected: the write list mirrors the reviews).

Agent's choice, for the implementer to revisit: an iterate whose writer is
missing from its size's list runs at that writer's effort for the nearest
size that lists it, so an XS iterate on an Opus PR runs Opus low and an L
iterate on a Haiku PR runs Haiku high.

Iterates, decided 2026-11-05 (user, /quest-plan, after a `/quest-complete`
run in moq-dev/moq sent many merge-and-record iterates):

- Which list does an iterate use? ✅ The same write list, indexed by the
  iterate's size (user). Not chosen: a separate iterate list.
- Who sizes it? ✅ The dispatching coordinator, with the quest rubric (the
  agent's effort to finish, verify, and land what is left, judgment
  included), from the PR's state: conflicts, unanswered findings, decisions
  to apply, rework. It names the size in the brief, and the iterate's
  `Implementer:` line in the PR's `## Models` section carries it, such as
  `Implementer: Claude Code, claude-opus-5-5, low effort (iterate, XS)`, so
  the [model check](/quest/m1/model-check.md) can audit it. Not chosen:
  `quest` estimating it from those signals.
- What if two models have written a PR? ✅ They never do: one writer per
  PR (user, 2026-11-05, from a CodeRabbit finding on
  [moq-dev/quest#507](https://github.com/moq-dev/quest/pull/507)). Each
  review list holds only Sol and Opus, and `quest review` excludes every
  model that wrote the PR, so a PR both wrote would have no reviewer. A PR's
  iterates run on the model that first wrote it, waiting out its usage limit
  rather than falling back; the fallback applies only when spawning a fresh
  quest. Not chosen: a person reviews such a PR; the model that wrote fewer
  lines reviews it.
- Does the iterate's review shrink too? ✅ No: `quest review` reviews the
  whole branch, so it keeps the PR's size (user). A merge-only change is
  already exempt from review.
- Where does it live? ✅ This quest, resized from M to L (user). Not
  chosen: a separate child.

- Each entry names its model, so a review passes it to `quest review
  --exclude-model` and never uses the model that wrote the code.
- `quest unblocked --json` adds the ranked list per quest, after the
  decision bump. An epic whose README carries no size has none; the
  spawner then inherits its own settings.
- `/quest-spawn`: follow the repository's `AGENTS.md` where it names other
  models, and otherwise the list. Start a quest on a harness matching the
  session's as a native sub-agent, and any other through `quest agent` on
  the logged-in account. When `quest agent` cannot start an entry (CLI
  missing, logged out) or the agent exits on a usage limit while its
  checkout still holds nothing beyond the claim commit (no edits, no local
  or pushed commits), move to the next entry, resuming from the claim PR and
  checkout. Once a model has written anything there, the PR has its writer:
  wait for it rather than fall back, as iterates do. With no
  entry left, skip the quest. Report each harness's outage once.
- `/quest-complete`, `/quest-unblock`, and `/quest-merge`: size each
  `/quest-iterate` they dispatch by its remaining work and start it on the
  PR's writer (its first `Implementer:` model) at that size's effort,
  natively or through `quest agent`; at that writer's usage limit, wait for
  it rather than fall back.
- Remove Grok from what ships: its line in `assets/CONTEXT.md`'s model and
  effort lookup, and any Grok harness code or test that exists by then.
- Docs: the README documents the lists, the decision bump, iterate sizing,
  the override, and `quest unblocked --json`'s new field. The
  [model check](/quest/m1/model-check.md) audits the lists each milestone.
