Keep the core independent of a particular repository, agent, or issue tracker.

- Read `CONTRIBUTING.md` before making changes or preparing a PR.
- Keep shared engineering rules in `assets/CONTEXT.md`, shared workflow instructions in `assets/AGENTS.md`, and skills in `assets/skills/`, each explaining only its own workflow.
- Installing or running a skill never authorizes remote writes or merges beyond the user's request.

Do not edit `CONTRIBUTING.md`, `assets/CONTEXT.md`, `assets/AGENTS.md`, or
`assets/skills/` unless the user asks for that work.

## Development

- Run `quest context` and `quest guide` and read them completely before starting work.
- Keep README examples consistent with the CLI's actual `--help` output.
  In this checkout, `quest` means `bun run --silent quest`; the dev shell's
  `quest` is a pinned build for the merge driver, not this checkout.
- Use an isolated worktree under `.worktrees/`. Preserve existing changes.
- Run `just install` in a fresh checkout to install the locked dependencies.
- Run `just check` and `just test` before handing off changes; `just fix` applies
  formatting. Missing tools are failures, not checks to silently skip.
- Nothing is in production yet, so skip backwards compatibility: change
  formats, schemas, flags, and on-disk state directly, with no migrations,
  shims, or cleanup of what earlier versions wrote.
- Starting or spawning quests stops at PR creation. It merges only on a
  /quest-merge pick, the user's or the standing one /quest-complete gives a PR
  with no user-facing behavior change, and only after repository checks and
  reviews pass.
- Pull requests land as squash merges.
- Do not comment on repositories outside kixelated/moq-dev without approval.
