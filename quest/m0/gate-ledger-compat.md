# [S] A gate never loses a running command's admission from the ledger

## Goal

Every gate on a host, whatever quest build runs it, keeps a running
command's admission in the shared ledger
(`~/.cache/quest/admissions/<host>`) until the command ends, so other
gates keep counting its cores.

## Plan

Found while measuring [moq-dev/quest#673](https://github.com/moq-dev/quest/pull/673)
on the maintainer's host: one gated moq check, longer than a minute, failed
with `gate lost its admission ... from the ledger` while another session ran
a `quest-0.1.0` gate. That label does not identify the build: the dev
shell's `quest-pinned` reported 0.1.0 at every revision through 7fe97931
(2026-11-08), and every pin since
e3b292b7 (2026-11-03) already keeps running admissions
(`running.has(admission)` in `src/cli/gate.ts`). So the cause is not yet
known; first reproduce it, such as with two current gates, or a current
gate beside the pinned one, each running a command over a minute.

The loss is also silent when the dropped command's measured cores stay
constant: `measure` reads the ledger every sample but looks for its own
admission only when the cores change, so the
command finishes and the other gates undercount it the whole time.

Open decisions, once the cause is known:

- If an older build drops entries it cannot recognize as running: version
  the ledger's path or format so such builds never share it (recommended if
  the cause is a format disagreement), or only bump `quest-pinned`, which
  leaves any other old install exposed.
- Should a gate whose admission vanished re-record it and keep its command
  running, rather than fail or keep going unnoticed? Recommended: re-record
  it with a warning, and check for it on every sample, not only when the
  cores change.
