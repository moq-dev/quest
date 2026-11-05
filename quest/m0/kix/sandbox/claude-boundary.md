# [M] The Claude Code sandbox's boundary test runs nightly in CI

## Goal

Claude Code jobs get the same checked-in hostile-repository boundary test
that opencode jobs got in
[moq-dev/quest#404](https://github.com/moq-dev/quest/pull/404): a scripted
fake model, set as the account's endpoint in its home, drives the pinned
Claude Code through the runner's launch path in the nightly sandbox workflow
on Linux, and every escape attempt is refused.
A Claude Code bump that weakens the boundary fails the next nightly run.

## Plan

Decided 2026-11-02 (coordinator, /quest-spawn follow-ups, after the user
asked the coordinator to decide follow-ups from evidence): plan it, [M],
in this epic after the seccomp fix.

Evidence, gathered 2026-11-02:

- The only Claude Code coverage is unit tests of its settings and
  environment (`test/runner.test.ts`). The boundary was last checked by hand
  ("verified live on Linux with Claude Code 2.1.291 and 2.1.305"), and
  [moq-dev/quest#242](https://github.com/moq-dev/quest/pull/242) bumped the
  pin without a rerun although 2.1.305 added `allowNestedUserNamespaces`.
- The opencode test, once it probed Unix sockets, found a real hole (srt
  ran without its seccomp helper, fixed in
  [moq-dev/quest#465](https://github.com/moq-dev/quest/pull/465)), so these
  tests pay off.

Work:

- Reuse the attempts and layout of opencode's test,
  `test/live/runner-sandbox.test.ts`: denied reads by path and symlink,
  writes outside the checkout and job temp directory, planted project
  settings and hooks, the network directly and through the proxy, the Nix
  daemon's and a host Unix socket, and the check that a command inherits no
  socket beyond its stdio.
- Assert that `TMPDIR` inside a command is the job's private directory and
  is writable. Reading Claude Code 2.1.305 says its strict policy exports
  `TMPDIR=<CLAUDE_CODE_TMPDIR or os.tmpdir()>/claude-<uid>`, which the
  runner's `TMPDIR` (`src/runner/claude.ts`) puts inside `allowWrite`; the
  test confirms it instead of trusting the read.
- Point the account at the fake model in its home, as that test's `signIn`
  configures opencode's provider: `ANTHROPIC_BASE_URL` in the `env` of
  `$CLAUDE_CONFIG_DIR/settings.json`, which `--setting-sources user` loads.
  An ambient `ANTHROPIC_BASE_URL` never reaches Claude Code, since
  `jobEnvironment` (`src/runner/claude.ts`) keeps only `keptEnvironment`'s
  allowlist (`src/runner/sandbox.ts`); leave that allowlist as it is. If
  settings' `env` also reaches the commands, the fake key there is no
  secret, so the unreadable-secret attempt reads a planted credential file
  in the home instead.
- Like opencode's test, each shell attempt first succeeds outside the
  sandbox, and the test fails rather than skips on Linux when the sandbox
  can't start.
- Run it where opencode's test runs: name it
  `test/live/runner-sandbox-claude.test.ts` (or extend
  `runner-sandbox.test.ts`), so `just runner-sandbox` and the nightly
  `.github/workflows/sandbox.yml` pick it up, and keep it out of
  `just test` and the merge queue. Decided 2026-11-03 (user,
  /quest-complete) for opencode's test: its own CI, nightly, so landing
  never blocks on it.
