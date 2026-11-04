# Set up Quest

Instructions for a coding agent. A user pastes a line like
"Follow https://github.com/moq-dev/quest/blob/main/SETUP.md to set up Quest here"
(or "... to remove Quest"). Work from the repository root and show the user
every file you changed before committing.

Quest is a CLI that carries its skills and guide. A repository pins the binary
with its own tool manager and keeps only one-line skill stubs and one reference
line in its root instructions.

## Install and pin

Pin the latest [release](https://github.com/moq-dev/quest/releases) tag.
Releases ship binaries for macOS, Linux, and native Windows on arm64 and x64.
Check that the chosen release includes the Windows archives; older tags do not. If there is no
release yet and the repository uses a nix flake (not on Intel Macs), pin the
latest commit on `main`, which the flake builds from source; otherwise tell the
user Quest has no release to install yet and stop.

Use the tool manager the repository already has:

- **mise** (`mise.toml` or `.mise.toml`):
  `mise use github:moq-dev/quest@<tag>`.
- **nix flake** (`flake.nix`): add the input
  `quest.url = "github:moq-dev/quest/<tag-or-sha>"`, put
  `quest.packages.${system}.default` in the dev shell, and update `flake.lock`.
  The flake doesn't build for Intel Macs (`x86_64-darwin`); use mise there, or
  the shell installer as described below.
- **Neither:** ask the user before installing anything globally. With consent,
  run the release's shell installer,
  `curl -LsSf https://github.com/moq-dev/quest/releases/download/<tag>/quest-installer.sh | sh`,
  which puts `quest` in `~/.local/bin` (set `QUEST_INSTALL_DIR` to change it)
  and edits no shell configuration. On native Windows, use the verified ZIP
  installation in [the Windows guide](docs/windows.md) with consent instead of
  the shell installer. Tell the user this install is unpinned.

Confirm `quest --version` runs before continuing.

## Initialize

```sh
quest init
```

Init writes a stub per skill under both `.claude/skills/` and `.agents/skills/`
without creating symbolic links (existing linked layouts continue to work), creates `quest/README.md` when missing, and appends a line
starting with `Quests: ` to the root `AGENTS.md`, or `CLAUDE.md` when only that
exists. It also appends `quest/** merge=quest` to `.gitattributes` and sets
`merge.quest.driver` in the clone's git config, so local merges resolve
concurrent edits to quest link lists. It writes no Claude Code hooks. It
prints each path it changed and is safe to rerun. Rerun after an upgrade, it
also rewrites the unmodified stubs whose description or setup link changed and
removes the unmodified stubs of skills the new version no longer ships.

If init refuses, it names the conflicting path. Report it and ask the user how
to proceed; never delete or rename their files to get past it.

## Opt into worktree hooks

Quest can create and reclaim Claude Code's worktrees, sharing one disk budget
across the user's repositories, through hooks in the user's own Claude Code
settings rather than the repository's, since repository settings apply to
every contributor. Offer them, explaining that they then apply in every
repository the user opens in Claude Code and need `quest` on the `PATH`
Claude Code runs hooks with. With consent, merge the entries in
[Claude Code checkouts](README.md#claude-code-checkouts) into
`~/.claude/settings.json`, keeping its other settings. If it already has a
`WorktreeCreate` or `WorktreeRemove` hook, ask the user which to keep.

## Adapt the instructions

Read the root instructions with the new line in place:

- Make sure the agents the user runs load the file holding the `Quests: ` line.
  For example, Claude Code reads `CLAUDE.md` and may not read `AGENTS.md`.
- Reword the line to match the file's style if needed, keeping the `Quests: `
  prefix so `quest uninstall` can find it.
- Point out existing rules that overlap with Quest, such as a planning doc, a
  TODO list, or rules about tracking work in issues. Propose how to reconcile
  them and let the user decide; do not rewrite them unasked.
- If `quest/README.md` was just created, ask the user what the project is
  working toward and write that as its Goal.

`quest start` claims each quest with a draft PR that holds only an empty
commit. If the repository's CI runs on pull requests, recommend skipping
drafts, since agents run the checks locally until a PR is ready for review. In
GitHub Actions, add `ready_for_review` to the `pull_request` trigger's `types`
(alongside the defaults `opened`, `synchronize`, and `reopened`) and give each
job the condition
`github.event_name != 'pull_request' || github.event.pull_request.draft == false`.
Change workflows only if the user agrees.

Agents push their quest branches to the repository itself, and GitHub gives
workflows on those branches the repository's secrets and default token, so
recommend keeping that CI read-only: code no maintainer has reviewed should
meet only a read-only `GITHUB_TOKEN` and no write credentials. In GitHub, set
Settings → Actions → General → Workflow permissions to read; move repository
secrets, and organization secrets shared with the repository, into
environments whose deployment branches are limited to protected branches; and
keep write `permissions:` out of jobs that pull requests and pushes to other
branches run. kix checks the same settings when a repository enrolls.
Change settings and workflows only if the user agrees.

Run `quest check`, then suggest next steps: restart the agent session so it
loads the new skills, then `/quest-plan` (`$quest-plan` in Codex) to plan
work or `/quest-import` to bring in open GitHub issues.

## Remove

1. Run `quest skill export` and follow it, so active quests become GitHub
   issues. Skip this only if the user says so.
2. Run `quest uninstall`. It removes only unmodified stubs of any version, the
   `Quests: ` line, and the merge driver, and never deletes the quest tree.
3. Remove the pin added above: the mise entry, or the flake input and dev
   shell package. For an unpinned install, delete the `quest` binary the
   installer placed (`~/.local/bin/quest` by default, or `quest.exe` in the
   chosen Windows install directory). Remove any PATH entry you added. If the
   user opted into Quest's worktree hooks and Claude Code no longer finds
   `quest`, remove those entries from `~/.claude/settings.json`, since without
   it they stop Claude Code making worktrees.
4. Ask the user whether to delete `quest/`. Git history keeps the plans either
   way.
