# [L] The watcher runs its own serial queue where GitHub has none

## Goal

`quest land watch` lands a base whose rules have no `merge_queue` rule, such
as private moq-dev/moq.pro on GitHub Team, through its own serial queue, and
keeps watching GitHub's queue where the rule exists. Each pass picks the mode
from the base's rules, so enabling GitHub's queue on a repository switches its
watcher with no host change.

The own queue tests one pick at a time on top of the base, in the
repository's own queue workflow, and lands exactly the tested tree with
moq-bot. A failed build or a conflict goes through the same fixer, flaky,
attempt, and re-enqueue-at-the-back handling as a PR GitHub's queue drops.
Each PR in the own queue carries a check run showing its position, the build
in progress with a link to its run, and the outcome. `--method squash|merge`
lands squash or merge commits, as `quest land serve` does, so a `release`
base can use merge commits.

Non-goals: deleting `quest land serve` (the
[retire quest](/quest/m0/queue-watcher/retire.md)), moq.pro's own switch
([its cutover](/quest/m0/queue-watcher/pro-cutover.md)), and the kix.quest
page ([queue page](/quest/m0/queue-watcher/queue-page.md)).

## Plan

Decided 2026-11-06 (maintainer, /quest-plan). Decision prompts, selected
options marked ✅:

- Goal:
  - ✅ Use GitHub's merge queue where the repository has one, otherwise quest's
    own serial queue in `quest land watch`; the batching `quest land serve`
    is then deleted. The maintainer expects the own queue to become the queue
    everywhere, for visibility.
  - Move every repository onto the own queue now
  - A separate subcommand, such as a slimmed `quest land serve`
- Build:
  - ✅ The repository's queue workflow: the daemon pushes the test merge to a
    queue branch and runs the same `queue.yml` build GitHub's `merge_group`
    runs, on the repository's self-hosted runner. One check definition per
    repository in both modes, logs in Actions, and the watcher's failed-job
    log reading (`failedBuild` in `src/cli/land-watch.ts`) is reused.
  - A local sandbox, as `quest land serve`'s `--sandbox`
- Mode:
  - ✅ Detected each pass from the base's rules
    (`GET /repos/{owner}/{repo}/rules/branches/{base}`): a `merge_queue` rule
    means GitHub's queue, none means the own queue. A pass that cannot read
    the rules does nothing.
  - An explicit `--queue github|own` flag
- Concurrency stays 1, as the [epic](/quest/m0/queue-watcher/README.md)
  decided: each build holds one PR on the base, so a failure blames that PR
  with no triage.

Implementation guidance:

- Picks are PRs whose auto-merge a writer armed, in `enabledAt` order, as
  `quest land watch` and `quest land serve` read them today. The base keeps
  requiring a context no one reports (moq.pro's `quest land`), so GitHub never
  merges a pick itself. Re-enqueueing at the back re-arms auto-merge, giving a
  new `enabledAt`. A push by anyone but the fixer, or a person disarming
  auto-merge, ends the pick, as a removal from GitHub's queue does.
- Build the test merge as `quest land serve` does today: merge the base into
  the pick with `quest resolve` and the quest merge driver, and treat what
  still conflicts as a GitHub `MERGE_CONFLICT` removal. Push it with moq-bot to
  a queue branch outside the reserved `quest/` namespace, such as
  `quest-queue/<base>/<number>`, and start the queue workflow on it. The
  workflow's build job runs as it does for `merge_group`, and its required
  job reports the result. Document the trigger in the repository's
  `queue.yml` header, since every own-queue repository adds it.
- Land through `quest land serve`'s landing path (`src/cli/land-head.ts`):
  lease-push the tested head, merge it with GitHub's merge API pinned to that
  head, verify the landed tree against the tested one, and fall back to a
  leased fast-forward of the base when the branch push is refused. If the
  base moved while building, rebuild on the new base without counting an
  attempt. Move these helpers out of serve's files so the retire quest can
  delete serve without touching them.
- The check run is informational and never the required context. moq-bot's
  App posts it with `checks: write`, which `watchPermissions` adds only in
  own-queue mode.
- Delete the queue branch once its pick lands or leaves the queue, and on
  start prune stale ones the daemon left behind.
- Update `quest land watch`'s description in `src/cli/main.ts`, the README's
  landing section, and `CONTRIBUTING.md` in the same change.

## Related

- [Merge through a host gate](/quest/m0/host-land/README.md) - the gate whose landing path this reuses
