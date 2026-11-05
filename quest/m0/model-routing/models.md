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
- Which models? ✅ Opus writes the code at every size, with Sol as the
  fallback through M; L and XL have no fallback and wait for Opus (user,
  2026-11-05, replacing the 2026-11-04 lists that gave XS to Grok).
- Grok? ✅ Removed from routing and from every review (user, 2026-11-05:
  its weekly usage is close to zero and its results were weak), so
  `quest agent` gains no Grok harness; the "quest agent starts Grok" quest is
  deleted.
- A quest with an open decision? ✅ Routes one size up (user). The signal:
  a `Maintainer:` item under its `## Waiting`. An XL stays XL.

The lists, pinned in `src/cli/models.ts` beside the review lists
`quest review` reads (user, 2026-11-05):

| Size | Writes (spawn and iterate) | Reviews (`quest review`) |
|---|---|---|
| XS | claude `claude-opus-5-5` low → codex `gpt-6.1-sol` medium | codex `gpt-6.1-sol` medium → claude `claude-opus-5-5` low |
| S | claude `claude-opus-5-5` medium → codex `gpt-6.1-sol` high | codex `gpt-6.1-sol` high → claude `claude-opus-5-5` medium |
| M | claude `claude-opus-5-5` high → codex `gpt-6.1-sol` xhigh | codex `gpt-6.1-sol` xhigh → claude `claude-opus-5-5` high |
| L, XL | claude `claude-opus-5-5` xhigh | codex `gpt-6.1-sol` xhigh → claude `claude-opus-5-5` xhigh |

The review list is the write list flipped: Sol reviews at the effort Sol
would write at, and Opus takes the review only when Sol wrote the code. This
raises every Sol review one step from
[moq-dev/quest#493](https://github.com/moq-dev/quest/pull/493)'s (XS low,
S medium, M high).

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
  missing, logged out) or the agent exits on a usage limit, move to the
  next entry, resuming from the claim PR and checkout. With no entry left,
  skip the quest. Report each harness's outage once.
- `/quest-complete`, `/quest-unblock`, and `/quest-merge`: size each
  `/quest-iterate` they dispatch by its remaining work and start it down that
  size's write list the same way, natively or through `quest agent`.
- Remove Grok from what ships: its line in `assets/CONTEXT.md`'s model and
  effort lookup, and any Grok harness code or test that exists by then.
- Docs: the README documents the lists, the decision bump, iterate sizing,
  the override, and `quest unblocked --json`'s new field. The
  [model check](/quest/m1/model-check.md) audits the lists each milestone.
