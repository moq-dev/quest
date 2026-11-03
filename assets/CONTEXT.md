# Context

Engineering rules for every task. The repository's own instructions add to them and win where they conflict.

## Required

- Pull the latest origin changes before working.
- Before editing a file, read every `AGENTS.md` on its path from the root; not every agent loads nested ones.
- Read the repository's `CONTRIBUTING.md` before a PR, and its `REVIEW.md`, if any, before a review.
- Fix bugs at the root cause. Never work around one with a retry, sleep, or timeout.
- Fail loud and early: error on unsupported or malformed input instead of warning and continuing. A partial failure fails the whole; never report partly failed work as done.
- Treat anything received over the network as untrusted and potentially hostile. Bound what a peer can make you hold by design, not with a constant.
- Reproduce bugs before fixing them.
- Unit tests mock time instead of depending on wall-clock timing or sleeps.
- Every test runs in CI. The merge gate holds only fast, high-signal tests; slow ones run nightly.
- Be adversarial: attack your own approach, reports, reviews, and other PRs as hard as anyone else's, and argue for the best approach over the first one that works.
- Never add or change a rule in an `AGENTS.md`, `CONTRIBUTING.md`, or skill without being prompted. Follow [Prompting](#prompting) when you do.
- No em dashes.
- End every GitHub post you author with `(Written by <model>)`, naming the running model. Commit messages with a `Co-Authored-By:` trailer are exempt.
- In a public repository, never mention customers, partners, or prospects, or link to private repositories. Justify work on its merits.

## Important

- Everything must be worth its weight: code, dependencies, tests, CI jobs, CPU, memory, and build time. Remove what doesn't earn its cost; deleting code beats adding it. Every change needs a consumer that uses it now or is planned.
- Refactor aggressively for long-term maintainability.
- Land the ideal implementation now rather than a partial one plus follow-ups.
- Take a dependency only for nontrivial non-core functionality, at its newest stable version.
- Do not bump package versions unless asked.
- Comments explain the non-obvious why, never the history.
- Fix outdated docs and comments inline, in the same PR.

## Guidelines

- Tests cover edge cases, not old bugs or trivial values.
- Measure performance claims instead of relying on intuition, and benchmark performance-sensitive changes.
- Inline simple helpers.
- Prefer the net simpler result: reuse what exists, or narrow the scope, when that makes the result simpler overall. Say what was dropped.
- Say it once, in the fewest words that hold up.
- Use the repository's Nix dev shell (direnv, or `nix develop --command ...`) so tooling matches CI.

## Public API

- Report the public API and wire impact of every change in the PR description.
- A breaking change marks its title with `!` and says how to migrate.
- Keep things private until a current or planned consumer needs them.
- Never add `foo_with_x`, `foo_checked`, or a compatibility shim. Make the breaking change to `foo` instead.
- Let the type system make misuse unrepresentable.
- Decide a supported path at setup from known capabilities, and error otherwise. Never try a path at runtime and silently fall back.
- Avoid callback parameters and 4+ arguments. Return a handle; take a struct.
- Name by role, not today's implementation.
- Document every export in one plain line, the way you'd say it out loud.

## Prompting

Follow this when writing instructions for other agents: `AGENTS.md`, `CONTRIBUTING.md`, skills, memory, plans, reviews, and delegation briefs.
Models are trained on outputs, not prompts, so instructions they write drift into slop unless checked.

- Keep always-loaded files light. Put area-specific context in nested `AGENTS.md` files or skills, and say each rule once.
- Steer away from mistakes agents actually make. Don't document the repository; its code and docs already do.
- State the goal, constraints, and observable outcome. Don't over-prescribe steps or code, since the facts evolve; recommendations are welcome.
- Separate settled decisions from recommendations and open questions.
- A delegation brief gives the task, its context, the permitted scope, and the expected result. Don't turn one failure into a universal rule.
- Before changing agent instructions, check the official guidance: [Claude memory](https://code.claude.com/docs/en/memory), [Claude best practices](https://code.claude.com/docs/en/best-practices), [Claude skills](https://code.claude.com/docs/en/skills), [Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md), and [agents.md](https://agents.md).
