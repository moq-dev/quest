# [L] Owner state in its RunnerHub

## Goal

Everything one owner owns lives in that owner's SQLite-backed `RunnerHub`
Durable Object, so dispatch, approvals, publication, and runner messages
read and write it serialized, with none of the interleaving races that
D1's awaits allow. D1 keeps only truly global state: cross-owner lookups.

That moves projects and their state, members, setups, and activity; jobs
with their events, output, and questions; head approvals; runners and
runner accounts; the inbox; and push subscriptions. D1 keeps better-auth's
tables (users, sessions, accounts, passkeys, verification), GitHub
installations, the repository-to-owner index that webhooks route by, and
webhook delivery dedup.

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
    installations, the repository-to-owner index, and delivery dedup
  - Rejected: only routing indexes in D1, with auth in per-user and
    installations in per-installation DOs; moving only the jobs path
- How do steps spanning D1 and DOs stay safe?
  - ✅ One authority per fact: each fact lives in exactly one store, and
    its authority writes it. Anything another store holds, such as the
    repository-to-owner index, is a routing hint the authority re-checks
    before acting, rejecting a stale route. No cross-store transactions or
    locks.
  - Rejected: sagas with compensating steps; refusing every cross-store write
- What happens to owner data already in production D1?
  - ✅ Start fresh: kix is not public until [Open kix.quest](/quest/m1/open.md),
    so the moved tables are dropped rather than copied, and the operator
    re-enrolls moq-dev's repositories and re-adds runners
  - Rejected: a one-shot copy from D1
- Which milestone?
  - ✅ m1, ahead of [Open kix.quest](/quest/m1/open.md), so no other
    owner's data exists yet when it lands
  - Rejected: m0; m2

Implementation guidance:

- The hub's schema migrates in code when the object starts (for example
  `ctx.blockConcurrencyWhile` running versioned `CREATE`/`ALTER`
  statements), replacing D1 migrations for the moved tables. A D1
  migration drops them.
- Every route that reads or writes owner state goes through the owner's
  hub (`env.RUNNERS.idFromName(owner)`), including the web pages, the
  inbox, the setup PR flow, and the webhook handlers once they resolve
  the owner from D1.
- Remove guards in `cloudflare/src/jobs/hub.ts` that exist only because
  handlers interleave at D1 awaits, and the tests that pin only those
  races. Keep the `#serial` promise chain, or an equivalent, while a
  dispatch pass still awaits anything outside the object's SQLite, such
  as `classify`'s GitHub trust read inside `store.dispatch` or a D1 read
  of an installation: a Durable Object's input gate does not hold across
  an outgoing `fetch`, so runner messages and approvals still interleave
  there.
- Cross-owner reads, such as an operator overview, fan out to the hubs or
  are dropped; none may move owner state back into D1.
- Update `quest/m0/kix/deploy.md` and `cloudflare/README.md` for the
  start-fresh deploy, and keep the dev and test fixtures working.

## Waiting

- Maintainer: pick what one hub's "owner" is, since it decides which
  tables can move. `RunnerHub` is keyed by a kix user ID today: a runner's
  `owner` and a job's `actor` both reference `user(id)`, and every route
  calls `hub(env, job.actor)` or `hub(env, runner.owner)`
  (`cloudflare/src/jobs/routes.ts`). Projects, setups, activity, and head
  approvals instead belong to a repository under a GitHub account
  (`github_projects.owner` is its login), several users maintain one
  (`github_project_members`), and `jobs_active` allows one active job per
  repository target across all actors. Options:
  (a) keep the hub per kix user: runners, runner accounts, jobs, their
  events, output, and questions, the inbox, and push subscriptions move;
  repository facts (projects and their state, members, setups, activity,
  head approvals, and the active-target index) count as cross-owner and
  stay in D1, which the hub re-checks under the one-authority rule;
  (b) re-key the object by GitHub account, so repository facts and jobs
  move too, but a user's runners, which serve every account they
  maintain, must connect to or be fed by several objects;
  (c) a per-repository object for repository facts beside the per-user
  hub. Recommend (a): it matches every current hub route, the races
  [moq-dev/quest#464](https://github.com/moq-dev/quest/pull/464) fixed
  were all inside one actor's hub, and it fits the decision that
  cross-owner lookups stay in D1. It narrows the Goal's list of moved
  tables, a recorded decision, so an agent cannot pick it. Done when the
  Goal names the key and its list matches it.

## Related

- [Open kix.quest](/quest/m1/open.md) - requires this, so the fresh start
  touches only the allowlisted owners' own data
