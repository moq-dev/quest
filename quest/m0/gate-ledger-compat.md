# [S] An older quest build never drops a running admission from the gate ledger

## Goal

Gates from different quest builds share one host's admission ledger
(`~/.cache/quest/admissions/<host>`) without losing each other's
admissions. Today an older build, such as the dev shell's pinned
`quest-0.1.0`, rebuilds the ledger from only the last minute's admissions,
dropping a running one, so the newer gate holding it fails with
`gate lost its admission` once its command runs past a minute.

## Plan

Found while measuring [moq-dev/quest#673](https://github.com/moq-dev/quest/pull/673):
one gated moq check failed this way while another session ran the pinned
build's gate on the same host. Any gated command longer than a minute is
exposed while such a build runs.

Open decisions:

- How to stop the loss? Options: version the ledger's path or format so
  builds that disagree never share a ledger (recommended: simplest, and
  nothing is in production, though builds that disagree then stop seeing
  each other's load); make every build keep admissions it cannot read or
  that are still running; or only bump the dev shell's `quest-pinned` input
  more often, which narrows the window but leaves any other old install
  exposed.
- Should a newer gate whose admission vanished re-record it and keep its
  command running rather than fail? Recommended: yes, with a warning, since
  the command is already running and failing it wastes its work.
