Keep the core independent of a particular repository, agent, or issue tracker.
Prefer simple, maintainable changes and ask about consequential product choices.

- Read `CONTRIBUTING.md` before making changes or preparing a PR.
- Read `PROMPTING.md` before changing instructions or skills, or delegating work.
- Keep shared workflow instructions in `assets/AGENTS.md`.
- Keep skills in `assets/skills/` and explain only their particular workflow.

Do not edit `CONTRIBUTING.md`, `PROMPTING.md`, `assets/AGENTS.md`, or
`assets/skills/` unless the user asks for that work.

## Development

- Run `quest guide` and read it completely before starting work.
- Keep README examples consistent with the CLI's actual `--help` output.
  In this checkout, `quest` means `bun run --silent quest`; the dev shell's
  `quest` is a pinned build for the merge driver, not this checkout.
- Use an isolated worktree under `.worktrees/`. Preserve existing changes.
- Use the Nix shell so local tooling matches CI: `nix develop`
- Run `just install` in a fresh checkout to install the locked dependencies.
- Run `just check` and `just test` before handing off changes; `just fix` applies
  formatting. Missing tools are failures, not checks to silently skip.
- Fix root causes. Do not mask fixable failures with retries, sleeps, or timeouts.
- Prefer simplification and refactoring over compatibility layers for unpublished
  interfaces. Keep changes focused on the requested outcome.
- Reproduce bugs and add a regression test when practical. Wire tests into CI.
- Ask about consequential scope or API choices, with options and a recommendation.
- Stop and report when progress stalls. Suggest follow-up work for `/quest-plan`
  rather than creating quests for it directly.
- Starting or spawning quests stops at PR creation. It merges only when the user
  picks /quest-merge, and only after repository checks and reviews pass.
- Pull requests land as squash merges.
- End every GitHub post with `(written by <model>)`, naming the running model.
  Do not comment on repositories outside kixelated/moq-dev without approval.
