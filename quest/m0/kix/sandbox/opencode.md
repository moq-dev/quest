# [L] Sandbox opencode jobs' commands

## Goal

opencode jobs' commands run inside the same boundary as Claude Code's: writes
only to the checkout and the attempt's private directory, network only to
the policy's hosts, and no read access to account logins or other homes.
The `opencode serve` process, which holds the account's provider
credentials, the server password, and the kix tools' token, stays outside
that boundary, and its own file tools stay inside the checkout.

## Plan

Decided 2026-10-27 (user) in `/quest-plan`, replacing the 2026-10-15 plan to
run the whole `opencode serve` under sandbox-runtime: that would put
`auth.json`, the providers' hosts, `OPENCODE_SERVER_PASSWORD`, and the bearer
token in `OPENCODE_CONFIG_CONTENT` inside the commands' boundary. Mirror
Claude Code instead, whose sandbox covers shell commands while the CLI and
its file tools follow permission rules. Checked against the pinned opencode
1.19.0 and sandbox-runtime 0.0.81.

- Commands: set opencode's `shell` config to a runner script that runs
  `srt -s <settings> -c <cmd>`, with settings generated from the runner's
  `Sandbox` policy (`src/runner/sandbox.ts`) and srt pinned in the runner's
  closure. opencode's permission parsing still sees the agent's own command,
  and the same key covers the `!` shell. Rejected: rewriting `args.command`
  in a `tool.execute.before` plugin, since opencode's checks would then parse
  the wrapper, and replacing the bash tool, which would reimplement its
  timeout, truncation, and process-tree kill. Each command pays srt's startup
  (about 0.5 to 1 s measured); srt runs outermost, so no nesting is needed.
- The server's environment is not the commands': commands inherit it, so
  the wrapper strips `OPENCODE_SERVER_PASSWORD`, `OPENCODE_CONFIG_CONTENT`,
  and the other `OPENCODE_*` variables before starting srt. The sandbox's
  filesystem and network policy does not substitute for this (from Codex's
  review of [moq-dev/quest#248](https://github.com/moq-dev/quest/pull/248)).
- File tools: today `permission: { "*": "allow" }` overrides opencode's
  `external_directory` check, so the read tool can read the account's
  `auth.json`. Add `external_directory: "deny"` and `webfetch: "deny"` after
  `"*"` (the last matching rule wins). opencode's check is lexical, so a
  symlink in the checkout escapes it: the runner's plugin also realpaths
  file-tool path arguments in `tool.execute.before` and throws outside the
  checkout and the attempt's directory.
- Repo-controlled code: set `OPENCODE_DISABLE_PROJECT_CONFIG`, the
  counterpart of Claude Code's `--setting-sources user`, so a project's
  `opencode.json` and `.opencode/` plugins, tools, and local MCP servers do
  not run in the server. Turn off `lsp` and `formatter`, which run the
  repository's tools unconfined. The flag also drops `AGENTS.md`, so the
  runner adds the checkout's instruction file back through `instructions`.
- One quest, not split: each piece alone leaves the boundary open.
- Rerun the hostile-repository boundary test from
  [moq-dev/quest#212](https://github.com/moq-dev/quest/pull/212) against
  an opencode account on Linux, including a symlink to `auth.json`, a
  project plugin, a `.opencode` MCP server, and a bash tool and a `!` command
  that print the server password and the tools' token. Then remove the "opencode
  runs unconfined" notes from the README, `src/runner/opencode.ts`, and
  `src/runner/cli.ts`, and the epic's 2026-10-24 decision.
- [macOS sandbox](/quest/m1/kix/sandbox/macos.md) reruns the test for
  opencode under Seatbelt.
