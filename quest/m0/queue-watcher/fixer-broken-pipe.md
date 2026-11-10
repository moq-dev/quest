# [XS] The land fixer survives a closed pipe

## Goal

A fixer run on a dropped PR finishes with a fix, a flaky verdict, or a
handback that names a decision, never a crash from a closed pipe. A test
closes the reader of the step that crashed and finds the run still reports.

## Plan

Planned 2026-11-10 (maintainer, /quest-complete in moq-dev/moq). Milestone:
✅ m0, in this epic (rejected: m0 standalone, m1).

On moq-dev/moq the fixer handed back two ordinary drops with
`fixer crashed (exit 1); run /quest-iterate` and the output
`quest land check: [Errno 32] Broken pipe`:
[moq-dev/moq#8406](https://github.com/moq-dev/moq/pull/8406) (a failed
`merge_group` build, caused by a dead quest link) and
[moq-dev/moq#8429](https://github.com/moq-dev/moq/pull/8429) (a merge
conflict). Each then needed a person. On 2026-11-10 moq-dev/moq.pro's gate
handed back three more the same way, which hid each drop's real cause:

- moq-dev/moq.pro#3816 (markdown only), handed back 20:18Z: its batch with
  moq-dev/moq.pro#3818 failed `dev/check-instructions.sh`, as
  `.claude/skills/quest-review/SKILL.md` is 287 bytes against a 280-byte
  budget. It landed after a requeue.
- moq-dev/moq.pro#3822 (billing display) and moq-dev/moq.pro#3820 (fonts),
  handed back 22:01Z: their batch failed `just api check` with two TS2362
  errors at `api/test/account-free-tier.test.ts:885-886`, a file
  moq-dev/moq.pro#3822 changes.
- moq-dev/moq.pro#3820 again, 22:13Z: its batch with moq-dev/moq.pro#3687
  failed `dev/check-migrations.py`, which lists live deploy tags from
  `origin`, a remote the gate's checkout lacks.

Found 2026-11-10: Quest is not at fault. The `[Errno 32]` comes from the
host's fixer wrapper, `scripts/quest-land-check.py` in kixelated/nixos. Its
fixer launcher refused every request with `failure log must be a .log path
below the repository state directory`, because quest 0.2.0 keeps state in
`owner-repo@main` directories and the launcher's path pattern lacked `@`. The
wrapper, still uploading, then hit `EPIPE` and printed that instead of the
refusal. The host journal (`journalctl -u 'quest-land-fixer@*'`) shows all 53
fixer runs from 00:33Z, a minute after a host switch, refused this way. kixelated/nixos#46 fixed both the pattern and the lost
refusal at 19:12Z, with a protocol test that closes the upload mid-stream, but
the host still runs its 01:33Z system.

Public API: none. Wire: none.

## Waiting

- Maintainer: switch nixos to a system with kixelated/nixos#46, since an
  agent may not switch the host; check that `journalctl -u
  'quest-land-fixer@*'` shows no `failure log must be` refusal after it and
  the next parked PR gets a real verdict, then delete this quest.
