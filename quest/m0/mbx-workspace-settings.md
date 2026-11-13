# [XS] The gate asks mbx whether a workspace switches its scheduler off

## Goal

`quest gate` learns whether mbx would schedule a command's builds from mbx
itself, instead of finding the Cargo workspace root and parsing its
`.mbx.toml` the way mbx does. Once a released mbx reports the effective
workspace setting and Quest's hosts run it, `workspaceScheduler` in
`src/cli/gate.ts` calls it and stops reading the file, and this quest is
deleted.

## Plan

Found by [moq-dev/quest#673](https://github.com/moq-dev/quest/pull/673),
which made the gate admit work through mbx's pool. `mbx settings get`, as of
mbx 1.30.0, reads the environment and the global configuration but leaves
workspace `.mbx.toml` settings out, so the gate copies mbx's workspace-root
rule (`workspace_root` in mbx's `crates/mbx/src/util.rs`: the outermost
directory with a `Cargo.lock`, else a `Cargo.toml`) and reads
`scheduler.enabled` itself. That copy can drift from mbx, as it already
skips mbx's boundary at delta worktrees.

Recommended ask: a `--workspace <dir>` option on `mbx settings get`, or a
machine-readable `mbx settings ls --json` that applies the workspace policy
for the working directory. jdx/mr-boxington's CONTRIBUTING.md accepts
AI-assisted issues with the disclosure its CLAUDE.md gives, and asks for bug
reports only from real use, which this is. Search its open issues and
discussions first, and comment on a match instead of opening a duplicate.

## Waiting

- Maintainer: whether to post the ask to jdx/mr-boxington, which lies outside
  the maintainer's organizations, so an agent may not post there unasked.
  Options: post it (recommended: it removes a copy of mbx's rules that can
  drift), or delete this quest and keep reading `.mbx.toml`. Check: the answer
  is recorded in this Plan.
- jdx/mr-boxington: a release reports the effective workspace scheduler
  setting. Check its releases and the issue this quest files.
