# [L] Coordinators start an agent only when the host and the account can carry it

## Goal

Every skill that starts agents, such as `/quest-run`, `/quest-spawn`,
`/quest-complete`, and `/quest-audit`, and `quest agent start` and
`quest agent resume`, starts or resumes an agent only while the host's gate
would admit work at once and the account's remaining usage covers the agents
already in flight. A fan-out, including the resumes after a usage limit
resets, never dies en masse on a usage limit, and a started agent rarely
stalls in the gate with its prompt cache going cold. Agents already running
are never paused or stopped by this; it only delays starting the next one.

Non-goals: capping the user's own top-level sessions, querying a
particular credential gateway, and changing how the gate admits commands.

## Plan

Found 2026-11-12 from transcripts on the maintainer's three Linux hosts,
2026-10-22 to 11-12:

- Fan-outs peaked at 20 to 26 concurrent sub-agents per session (Claude
  Code caps native sub-agents at 20 per session, "Concurrent subagent limit
  reached"), and up to 59 top-level sessions were active on one host within
  five minutes. Nothing caps headless `quest agent start` agents or Codex.
- The shared quota is the main harm: 157 "All credentials ... cooling
  down" errors on one host, 143 of them on the day of the 59-session peak;
  weekly and session limits hit on several days; 156 background agents
  ended "terminated early due to an API error", 26 of them within seconds
  in one moq session.
- Gate waits: of 2,482 gated commands on one host, 191 waited over 10
  minutes, 77 over 30, and 11 were still queued at the 55-minute command
  timeout. A waiting agent's turn blocks, so its cache can expire.
- Agent processes themselves are cheap: about 100 to 250 MB and 1% CPU
  each.

Decided 2026-11-12 (maintainer, /quest-plan):

- What outcome? ✅ Admission on both quota and host (rejected: quota only,
  which leaves the gate waits; host only, which lets several hosts drain one
  account; a fixed smaller fan-out in skill text, which is blind to quota
  and load).
- What says the host can carry one more agent? ✅ The gate would admit a
  command at once (rejected: a fixed agent count per host, a guess; a
  count derived from cores and memory, a poor proxy for gated load). It
  targets the measured harm and adds no constant.
- What says the account can? ✅ The usage each harness reports, such as
  Codex's `rate_limits.used_percent` in its session log and Claude's
  5-hour and weekly utilization where its login or gateway exposes it.
  Stop starting once the budget left cannot cover what the agents in flight
  are expected to spend, estimated from `quest usage`'s per-size history
  (rejected: asking the credential gateway's management API, which ties the
  core to one gateway against AGENTS.md; starting in small waves with no
  signal). Decide at a coordinator's start which setups give a signal, and
  say once when one gives none, rather than trying and falling back.
- Milestone: ✅ m0 (rejected: m1), since both harms are live.

What the decisions above require, found in review:

- "Would admit at once" is the gate's own admission decision (load,
  memory, and the headroom recent admissions take), not an empty queue: a
  host can be full with nothing queued, and an agent just started adds no
  gated load until its first build minutes later. So agents started but
  not yet building must count against the headroom too, as the gate counts
  its recent admissions, or a whole fan-out passes the check at once.
- Harnesses report a percentage of a window, while `quest usage` reports
  tokens and list cost, and neither reports the window's capacity. Convert
  through the account's own history, such as tokens spent per percentage
  point over recent sessions, or an absolute budget where a harness exposes
  one.

Agent's choices, for the implementer to revisit:

- Admission waits in the coordinator before it starts or resumes an agent,
  never inside a started agent, so only one cheap context waits. `quest
  agent start` and `quest agent resume` can admit themselves; native
  sub-agents need a step the coordinator runs first, since Claude Code's
  `SubagentStart` hook fires once the sub-agent exists and runs `quest
  hook` by default (`quest worktree hook` only with `quest setup
  --worktrees`). Keep the coordinator able to handle reports while it
  waits.
- Verify whether Claude's utilization reaches a session through the
  maintainer's credential-pool gateway (`ANTHROPIC_BASE_URL` on a local
  port); if not, that setup reports no signal rather than a wrong one.
- `assets/CONTEXT.md` tells agents "never work around the queue by
  polling the load average or capping agents yourself". Keep the ban on
  agents improvising caps, and point to the admission instead. The
  "as many at once as the harness allows" line in `assets/skills/run.md`
  changes with it.
- Measure on a real `/quest-spawn` fan-out: limit errors, agents lost,
  gate wait times, and total wall time, against the numbers above.

## Related

- [The gate records each run for the process that started the agent](/quest/m0/gate-record.md) - per-agent gate waits, to measure this against
- [Cut agent token waste](/quest/m0/token-waste/README.md) - kept the 1-hour cache TTL and capped commands just under it, which a long gate wait can still outlast
