# [M] quest usage prices sessions through token-max

## Goal

`quest usage` takes each session's harness, model, effort, branch, working
directory, and cost from token-max's priced-session export. Sub-agent
transcripts are included, so a quest that a `/quest-spawn` or `/quest-run`
sub-agent worked on carries its own cost, not its coordinator's. quest
drops ccusage and its own transcript readers and keeps only the GitHub
records and the attribution of sessions to PRs. Fix PRs count toward
`fixedBy` only once merged, and only through a bulleted
`- [owner/repo#N](url) - why` culprit line, not a context link.

`quest usage --ssh HOST` (repeatable) also attributes the sessions of
other hosts the user names, through `token-max sessions --ssh`. Every
session, local or remote, matches its PR through the repositories token-max
exports for it, read on the host where it ran, never through a checkout on
the host running the report. A host that fails fails the report, naming it.
A session found on several hosts, such as a history copied between them,
counts once, and the report says how many such copies it folded and from
which hosts.

## Plan

Decided 2026-11-11 (user, /quest-plan,
[routing evidence](/quest/m0/routing-evidence/README.md)):

- Where does transcript pricing live?
  - ✅ token-max prices, quest attributes: one transcript reader for both
    tools
  - Rejected: moving all of `quest usage` into token-max, which would widen
    it into quest-specific reporting; fixing quest's own reader and keeping
    ccusage
- Pin token-max as a flake input, the way the other consumers pin quest,
  until its crates.io release.

Decided 2026-11-12 (user, /quest-plan, asked whether the CLIProxyAPI
gateway's request history could replace reading transcripts on each host):

- Source? ✅ transcripts, read on each host by token-max (rejected: the
  gateway's usage records, which v8 drops once read or after at most an
  hour, which carry no session, branch or working directory, and which
  cover only Claude traffic routed through the gateway).
- Other hosts? ✅ a `--ssh HOST` flag passed through to token-max, so
  hosts stay the user's to name (rejected: this host only).
- A session on several hosts? ✅ count it once, keeping its costliest
  copy, and report the fold (rejected: failing on it, which one copied
  history would turn into a blocked report; counting every copy, which
  inflates the cost per PR the writer A/B compares). The costliest copy
  rather than the one with the most requests, since copies continued on
  both hosts diverge and requests differ in price.
- An unreachable host fails the report rather than leaving its spend out,
  since the user named it and a report missing a host would pass for
  complete; drop the host from `--ssh` to report without it.
- Matching a remote session to its repository: today's matcher in
  `src/cli/usage.ts` reads the git remotes of the session's working
  directory on this host, which for another host's path is missing or a
  different checkout. token-max exports each session's repositories,
  resolved on its own host, and quest matches only through them.

The audit found today's failures:

- `quest usage` stops at a Claude Code transcript with an interleaved,
  malformed line in the middle of the file, such as line 1385 of a moq
  session on 2026-11-04. On 2026-11-11 that one line made `quest usage`
  exit 1 in all three repositories, since every report reads every session
  on the host, and the file is Claude Code's, not quest's to repair. The
  reader skips each such line, prints how many it skipped in which
  sessions, and marks the cost totals as lower bounds, so the report never
  passes for complete. Report the corruption upstream to Claude Code.
- ccusage folds sub-agent records into their parent's session ID, and
  quest reads only the parent's log, so 72% of host spend was unattributed.
- `fixedBy` counted context links, such as moq-dev/quest#558 linking #494,
  and fixes still open or closed unmerged, such as moq-dev/moq#8476.
  The 2026-11-11 [mistake audit](/quest/m0/mistake-audit.md) found 9 of
  20 culprit pairs that week were such artifacts: links on a "No single
  PR" or "None" line, a "(fixed by #N)" aside, a note after the bullets,
  a closed duplicate fix, and an unmerged culprit. Test against
  moq-dev/moq#8471, #8426, #8483, #8427, #8371, and #8493.

## Waiting

- kixel-ai/token-max: `token-max sessions` accepts `--ssh` and exports
  each session's repositories, as
  [its quest](https://github.com/kixel-ai/token-max/blob/main/quest/m0/sessions-ssh.md)
  plans; check that `token-max sessions --help` documents both
