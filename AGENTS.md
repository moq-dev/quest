Keep the core independent of a particular repository, agent, or issue tracker.

- Keep the rules every task loads in `assets/CONTEXT.md`, within the 10,000 characters Claude Code shows of a hook's context; the workflow sections skills share in the guide, `assets/AGENTS.md`; and skills in `assets/skills/`, each explaining only its own workflow and naming the guide sections and skills it builds on.
- Installing or running a skill never authorizes remote writes or merges beyond the user's request.
- Plan work on the maintainer's own machines and hosts, such as host services, runners, and deploys, in kixel-ai/nixos's quest tree, not here. Quests here name a host only by its role, such as "the maintainer's host", and point to that repository for its work.

Do not edit `CONTRIBUTING.md`, `assets/CONTEXT.md`, `assets/AGENTS.md`, or
`assets/skills/` unless the user asks for that work.

## Development

- Read `quest guide` completely before starting work, since this repository develops it.
- Keep README examples consistent with the CLI's actual `--help` output.
  In this checkout, `quest` means `bun run --silent quest`; the dev shell's
  `quest` is a pinned build for the merge driver, not this checkout.
- Worktrees live under `.worktrees/`.
- Run `just check` and `just test` before handing off changes. A missing tool is
  a failure, not a check to skip.
- Nothing is in production yet, so skip backwards compatibility: change
  formats, schemas, flags, and on-disk state directly, with no migrations,
  shims, or cleanup of what earlier versions wrote.
- Starting or spawning quests stops at PR creation. It merges only on a
  /quest-merge pick, the user's or the standing one /quest-run gives a PR
  with no user-facing behavior change that adds or expands no quests, and only after repository checks and
  reviews pass.
- Pull requests land as squash merges.
- Do not comment on repositories outside kixelated/moq-dev without approval.

Quests: before any work, run `quest context` and follow it, or read https://github.com/moq-dev/quest/blob/main/docs/context.md where `quest` is not installed, unless this session already holds its rules.
