# [L] Release agent checkouts at handoffs and completion

## Goal

Quest workflows use `quest worktree` checkout ownership through Claude Code's
lifecycle hooks. A completed or suspended worker releases its checkout without
waiting for the parent chat to end or the PR to merge. Headless Codex turns
already use the shared checkout supervisor.

## Plan

Remaining work:

- Claude hooks: a `quest` subcommand (for example `quest worktree hook
  <event>`) handles `WorktreeCreate` and `WorktreeRemove` through `quest
  worktree create` and `remove`, releases the stopped subagent's checkout on
  `SubagentStop`, and restores it on `SubagentStart`. `/quest-spawn` cleanup
  calls `quest worktree remove`, since Claude never removes a hook-created
  subagent worktree.
- `quest init` adds the static hook entries to `.claude/settings.json`,
  merging into an existing file, and `quest uninstall` removes exactly those
  entries.
- Derived defaults for a checkout the hook creates, which gets only a `name`.
- Exercise Claude with a finished worker under a still-live parent,
  a suspended decision, a crash, and a restored session. Confirm live that
  `SubagentStop`'s `cwd` is the subagent's worktree, and that a hook-created
  worktree passes Claude's isolation identity check. Reconcile existing
  cleanup mechanisms instead of adding an unrelated competing sweeper. Run
  these from a session that is not itself worktree-isolated: Claude's
  isolation checks refuse git in any other repository, including a scratch
  test repository.

Decisions:

- Decided 2026-10-15: use `quest worktree` for checkout lifetime and `quest gate`
  for expensive phases. Disk capacity gates checkout allocation, not the number
  of reasoning agents.
- Decided 2026-10-26 (user): Claude integrates through a
  `WorktreeCreate`/`WorktreeRemove` hook pair backed by `quest worktree`, with
  `SubagentStop` releasing and `SubagentStart` restoring. It matches the
  ownership model, and native cleanup does not reclaim finished workers. The
  accepted cost: the hook replaces every Claude worktree in the repository.
  Rejected: pruning build output in place on `SubagentStop`, and prose alone.
- Decided 2026-10-26 (user): the hooks live in the repository's
  `.claude/settings.json`, written by `quest init`, not in user settings. The
  entries are static stubs that only call a `quest` subcommand, with all logic
  in the binary like the skill stubs, so upgrades never rewrite them. The m0
  Plan's vendoring bullet was amended to allow this.
- Decided 2026-10-26 (user): a hook-created checkout derives its defaults.
  Scratch is the main checkout's top-level ignored entries, excluding
  `.worktrees/`, `.claude/worktrees/`, and nested repositories. The reserve is
  the main checkout's disk usage. An unset `capacity` admits whatever the
  free-space check admits, instead of refusing everything.
- Decided 2026-10-26 (user): Codex, which documents no worktree hooks, is
  covered by `quest agent` running it inside `quest worktree run`, which
  releases on exit and restores on resume. Codex app threads stay on Codex's
  native archive. The independent Codex integration now uses this lifecycle
  for registered Quest-owned Linux checkouts, with ownership and host checks
  before credential resolution (user choice 2026-10-27).
- Decided 2026-10-26 (user): agents are capped only at the harness's
  concurrent sub-agent limit, stated once in the guide; the core-count cap is
  gone, since `quest gate` holds expensive commands. The 2026-10-15 decision
  stands over [moq-dev/quest#227](https://github.com/moq-dev/quest/pull/227)'s
  wording, which kept the core count only incidentally.

Context:

- Landed: `quest worktree run` supervises a job and releases its scratch,
  `remove` deletes a finished checkout without losing work (a squash-merged
  head counts only with exact PR-head evidence), and `stop` ends a crashed
  supervisor's leftover processes. The guide's Workspace section asks for a
  checkpoint before a decision or handoff and a clean checkout at the end
  ([moq-dev/quest#223](https://github.com/moq-dev/quest/pull/223)), routes
  expensive commands through `quest gate`, keeps read-only discovery out of
  new checkouts, and caps sub-agents only at the harness's own limit.
- Measured: this repository's main checkout held 65 Claude subagent worktrees
  under `.claude/worktrees/` (8.2 GB) on 2026-10-23, and still 20 (6.5 GB) on
  2026-10-26 after manual cleanup, the oldest from 2026-10-07. Finished workers
  are not reclaimed today.
- A foreground CLI wrapper only owns its child commands. Native agent tools
  need explicit ownership and suspend/resume integration; a helper that exits
  after creating a directory cannot infer when such an agent has finished.
- Reuse native worktree/archive APIs where they preserve the required state.
  Test actual completion, not merely an accepted or queued archive request.
  Recover failed archives and stale ownership without bypassing active locks.
- Claude: a `WorktreeCreate` hook replaces every worktree Claude creates in the
  repository (`--worktree`, `EnterWorktree`, subagent isolation, background and
  remote-control sessions) and prints the path; `.worktreeinclude` is then not
  processed. Claude never removes a hook-created subagent or workflow worktree
  and never runs `WorktreeRemove` for one; it runs `WorktreeRemove` only for
  session exits, `ExitWorktree`, background-session deletes, and remote-control
  cleanup. `SubagentStop` fires when a subagent finishes responding, which
  covers both completion and a suspended decision, and `SubagentStart` fires on
  resume; their `cwd` follows the agent. Without a hook, Claude removes a clean
  subagent worktree only when it finishes with no changes and otherwise leaves
  it to the `cleanupPeriodDays` sweep.
- Codex can archive recoverably but refuses unsupported nested repositories,
  and keeps its 15 most recent managed worktrees by default.
  Sources: [Claude worktrees](https://code.claude.com/docs/en/worktrees),
  [Claude removal hooks](https://code.claude.com/docs/en/hooks#worktreeremove),
  [Codex worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees).
