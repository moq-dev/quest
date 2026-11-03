# [M] /quest-spawn keeps finding work

## Goal

`/quest-spawn` recomputes the ready quests after each agent reports and
starts the newly ready ones. An agent resumes its quest's leftover local
branch instead of stopping on it, and spawn checks open PRs for overlapping
work before claiming and passes what it found in the brief. Once its agents
finish, spawn ends; its summary names the queued PRs whose merge would make
more work ready.

## Plan

Decided 2026-11-02 (maintainer, /quest-plan of the follow-ups from a scan of
the maintainer's Claude Code and Codex transcripts since 2026-10-12):

- Is that the goal? ✅ Yes, as stated; without the overlap check; drop it.
- When only queued merges block more work, should spawn wait for them?
  ✅ End, and rerun with `/loop` or by hand; wait on the queued merges with
  `quest wait`. The maintainer said on 2026-10-29 "I really don't want to
  block on github at all"; a session that re-ran spawn every 15 minutes for
  10.5 hours mostly did nothing.
- Which milestone? ✅ m0, after the land work and before Kix; m0 last; m1.

Evidence from the scan:

- The maintainer asked for more after spawns ended in about 7 threads
  ("continue? Any other quests to work on?", "when you're done, check for new
  quests and spawn any more").
- Five agents stopped on "local branch … already exists; merge the claim
  commit … into it before pushing" and each opened and closed an empty claim
  PR (moq-dev/moq #7409, #7412, #7429, #7431, #7478). That is `quest start`'s
  warning after a successful claim (`checkout` in `src/cli/start.ts`), not the
  remote "branch in the way" refusal the guide's Execution section tells
  agents to stop on; agents conflated the two.
- Six agents found their quest already implemented or overlapped by an open
  PR only after claiming ("#7328 already implements this exact fix").

Files: `assets/skills/spawn.md`, `assets/skills/start.md`, and the guide's
Execution section in `assets/AGENTS.md`.

- Spawn recomputes `quest unblocked --unclaimed` as each agent reports and
  dispatches newly ready quests within the harness's agent limit.
- The guide separates the local-branch warning (switch to it, merge the
  claim commit, resume the earlier attempt) from the remote refusal (stop).
- Before dispatching, spawn searches open PRs for the quest's path and the
  files its plan names, and puts the matches in the brief; the agent stops
  only on a real semantic overlap, not a shared filename.

## Related

- [Kix decision UI](/quest/m0/kix/README.md) - its execution quest starts
  ready work whenever a runner slot frees; this is the local skill
