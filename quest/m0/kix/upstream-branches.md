# [M] Publish job branches on the upstream

## Goal

kix's `plan`, `start`, and `bootstrap` jobs push their branch to the enrolled
repository itself, and the App opens the pull request from that branch. A
deployment needs no fork namespace, `GITHUB_FORK_OWNER`, or hand-made forks:
installing the App and enrolling the repository is enough for jobs to
publish. Contributor-fork pull requests keep today's behavior: `iterate`
pauses with a decision, since the App cannot write to them.

## Plan

Decided 2026-10-27 (user) while setting up kix.quest for moq-dev/quest and
moq-dev/moq, replacing the per-project forks quest (planned 2026-10-19 as a
follow-up of [moq-dev/quest#145](https://github.com/moq-dev/quest/pull/145)):

- How should kix publish its job branches?
  - Keep forks for launch
  - ✅ Push to the real repo
  - Let kix create forks itself

  Forks cost the operator an extra account and a hand-made fork per enrolled
  repository. The accepted cost: a same-repository pull request runs the
  upstream's `pull_request` workflows with its secrets (moq-dev/moq's
  `check.yml` passes R2 keys), so agent-written code runs with them. Say so
  in `cloudflare/GITHUB.md`'s trusted boundary, next to the existing advice
  to treat kix pull requests as untrusted contributions.
- What happens to the existing service-fork code path?
  - ✅ Remove it
  - Keep as an option

  Nothing in production uses it, and one path is simpler. Remove
  `GITHUB_FORK_OWNER`, the fork lookup and parent check in
  `cloudflare/src/github/service.ts`, the fork parts of `dev/github.ts`, the
  seed, and the tests, and the fork steps in `cloudflare/GITHUB.md` and
  `cloudflare/README.md`. Fork writes become upstream writes with the same
  per-repository `contents: write` token. `maintainer_can_modify` stops
  mattering, since maintainers can push to a same-repository branch.
- When a job finds its own branch moved or left over, what should the
  maintainer be offered?
  - ✅ Keep Start over
  - No Start over

  Start over keeps today's semantics on the upstream: only on the
  maintainer's click, only on the job's own branch, never a pull request's
  head or the default branch. If the repository's branch rules refuse the
  reset, the job keeps waiting on the same decision. Update the inbox copy,
  which says the reset happens "on its fork".
- Branch names stay as they are: `start` uses the quest's branch, so a kix
  job's pull request is the same claim a local `quest start` makes, and
  plans use `plan/<id>` and `plan/issue-<n>`. `bootstrap`'s `quest/devshell`
  sits in the claim namespace, which the guide reserves for quests; rename
  it outside `quest/` (for example `kix/devshell`).
- A reassigned job's runner fetches the commit kix published from the
  upstream itself, so the kix epic's open question about fetching from the
  service fork goes away.
- Test a plan, start, and bootstrap publication against the seeded fake
  without any fork, Start over on an upstream branch, and a refused reset.

## Related

- [Operator setup](/quest/m0/kix/operator-setup.md) - verifies this path live on the pilot repositories
