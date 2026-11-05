# [L] User state in their RunnerHub

## Goal

Everything one kix user owns lives in that user's SQLite-backed
`RunnerHub` Durable Object, keyed by their kix user ID as it is today
(`hub(env, job.actor)`), so dispatch, approvals, publication, and runner
messages read and write it serialized, with none of the interleaving races
that D1's awaits allow. D1 keeps only truly global state: lookups and
facts shared across users.

That moves runners and runner accounts; jobs with their events, output
(attempts, chunk index, and cleanup), and questions; the inbox's read
state; and push subscriptions. D1 keeps better-auth's tables (users,
sessions, accounts, passkeys, verification), GitHub installations, webhook
delivery dedup, and each repository's data, which several users maintain:
projects and their state, members, setups, activity, and head approvals.
D1 also keeps the one-active-job-per-repository-target rule, which spans
users, and the routing hints that name which users' hubs hold a
repository's jobs.

## Plan

Decided 2026-11-04 (user, /quest-complete follow-up of
[moq-dev/quest#464](https://github.com/moq-dev/quest/pull/464), whose
three review rounds each fixed a race between a dispatch pass and an
approval or publication interleaved at a D1 await). This replaces the
2026-10-16 decision to keep D1 as the record of every job, recorded in
[the kix epic](/quest/m0/kix/README.md).

- What should the quest's goal be?
  - ✅ Move state into Durable Objects, keeping D1 for truly global state
    (first picked "drop D1 entirely"; the user then allowed D1 for truly
    global state)
  - Rejected: keep D1 for everything; only record a policy for new state
- What is the main reason to leave D1?
  - ✅ No interleaving races: a DO's SQLite calls are synchronous and its
    requests serialized
  - Rejected as the driver: latency and cost; simpler schema and deploy
- Which state counts as truly global and stays in D1?
  - ✅ Cross-owner lookups: auth (better-auth keeps its D1 adapter), GitHub
    installations, the repository-to-owner index, and delivery dedup.
    Under the per-user hub below, that index is the routing hints from a
    repository to the users' hubs holding its jobs.
  - Rejected: only routing indexes in D1, with auth in per-user and
    installations in per-installation DOs; moving only the jobs path
- What should a Durable Object's "owner" be?
  - ✅ Keep the hub per user: `RunnerHub` stays keyed by kix user ID.
    Runners, runner accounts, jobs with their events, output, and
    questions, the inbox, and push subscriptions move into the user's hub.
    Repository data (projects and their state, members, setups, activity,
    head approvals) and the one-active-job-per-repository-target rule stay
    in D1 as cross-owner state.
    Settled in /quest-complete after this plan's review found the hub
    keyed by user while the first Goal moved per-repository facts into it.
  - Rejected: keying an object by GitHub account; adding per-repository
    objects
- How do steps spanning D1 and DOs stay safe?
  - ✅ One authority per fact: each fact lives in exactly one store, and
    its authority writes it. Anything another store holds, such as a
    repository's routing hints, is a hint the authority re-checks before
    acting, rejecting a stale route. No cross-store transactions or locks.
  - Rejected: sagas with compensating steps; refusing every cross-store write
- What happens to user data already in production D1?
  - ✅ Start fresh: kix is not public until [Open kix.quest](/quest/m1/open.md),
    so the moved tables are dropped rather than copied, and the operator
    re-adds runners (projects stay in D1 under the per-user hub, so no
    repository is re-enrolled)
  - Rejected: a one-shot copy from D1
- Which milestone?
  - ✅ m1, ahead of [Open kix.quest](/quest/m1/open.md), so no other
    user's data exists yet when it lands
  - Rejected: m0; m2

Implementation guidance:

- The hub's schema migrates in code when the object starts (for example
  `ctx.blockConcurrencyWhile` running versioned `CREATE`/`ALTER`
  statements), replacing D1 migrations for the moved tables. A D1
  migration drops them.
- Every route that reads or writes a user's state goes through that
  user's hub (`env.RUNNERS.idFromName(user)`), including the web pages,
  the inbox, the setup PR flow, and the webhook handlers.
- The one-active-job rule, today the `jobs_active` partial index on
  `jobs`, becomes a D1 claim row per repository target naming the job and
  its actor. D1 is that claim's authority and the hub is the job's: a hub
  takes the claim before it creates the job and releases it when the job
  ends, and a claim whose job its hub reports ended or missing is stale
  and may be taken.
- Repository-wide reads and fan-outs that query `jobs` across actors
  today, such as `resume`, the merge-job `wake` on a check or status
  webhook, a project's job list, and the inbox's latest job per target
  and follow-ups, use D1's routing hints to reach each hub holding the
  repository's jobs, and each hub filters for itself. Per-user periodic
  work on moved tables, such as output cleanup, runs from the hub's alarm
  instead of the Worker cron.
- Remove guards in `cloudflare/src/jobs/hub.ts` that exist only because
  handlers interleave at D1 awaits, and the tests that pin only those
  races. Keep the `#serial` promise chain, or an equivalent, while a
  dispatch pass still awaits anything outside the object's SQLite, such
  as `classify`'s GitHub trust read inside `store.dispatch`, or a D1 read
  of a project, its head approvals, or an active-target claim: a Durable
  Object's input gate does not hold across an outgoing `fetch` or binding
  call, so runner messages and approvals still interleave there.
- Cross-user reads, such as an operator overview, fan out to the hubs or
  are dropped; none may move a user's state back into D1.
- Update `cloudflare/README.md`'s Deployment section for the start-fresh
  deploy, and keep the dev and test fixtures working.

## Related

- [Open kix.quest](/quest/m1/open.md) - requires this, so the fresh start
  touches only the allowlisted owners' own data
