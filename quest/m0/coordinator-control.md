# [S] Coordinator control and dead-agent recovery

## Goal

A coordinator (`/quest-complete`, `/quest-spawn`, `/quest-afk`) responds to
"finish up", "pause", and "status" in a defined way, and resumes or
re-dispatches an agent whose report is an API error or a cancellation, so no
pick is silently dropped and no hold goes stale.

## Plan

Decided 2026-11-02 (maintainer, /quest-plan of the follow-ups from a scan of
the maintainer's Claude Code and Codex transcripts since 2026-10-12):

- Plan it? ✅ Plan it; only dead-agent recovery; drop it.
- Which milestone? ✅ m0, after the land work and before Kix; m0 last; m1.

Evidence from the scan:

- "finish up" 8 times in 5 sessions ("finish up please, don't have any
  monitoring agents"), "pause spawning new agents" in 3 sessions, and
  "what's the status?" 8 times in 7 sessions.
- Claude API 429s on 2026-10-29 hit 68 sessions; about ten hours later a
  coordinator re-dispatched 16 PRs whose agents had died, with stale holds.
  About 40 later refusals read "is held by quest:iterate, added N hours ago".

Files: `assets/skills/complete.md`, `assets/skills/spawn.md`,
`assets/skills/afk.md`.

- "finish up": start nothing new, plan follow-ups now, let running agents
  report, clean up, and write the final summary.
- "pause": dispatch nothing new until told to resume; running agents
  continue.
- "status": a compact list of each agent and PR with its state and age.
- A report that is an API error or cancellation is not a result: resume the
  agent, or re-dispatch it with the same brief, after releasing its hold with
  its token.
