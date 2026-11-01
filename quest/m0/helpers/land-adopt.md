# [S] moq-dev/quest lands through quest land

## Goal

PRs to moq-dev/quest's `main` land only through
`quest land`, on a hosted runner, running
`just check` and `just test` once per batch. GitHub's merge button cannot
land around it. A PR from a fork lands through it too.

## Plan

Decided 2026-10-26 (user): the repository adopts its own gate first.

[moq-dev/quest#236](https://github.com/moq-dev/quest/pull/236) added the
Land workflow and `CONTRIBUTING.md`'s landing rule. The setup was finished on
2026-10-29, and [moq-dev/quest#283](https://github.com/moq-dev/quest/pull/283)
landed through the gate on 2026-10-30, verifying the same-repository path.
What remains is the fork path.

- **Push credential (user, 2026-10-30).** The repository moved to the moq-dev
  organization, where moq-bot is installed on every repository and has
  Workflows write, which lets it land PRs that change `.github/workflows`.
  No secret holds its key here: the land job trades its GitHub ID token at
  `token.moq.dev` ([moq-dev/moq#7275](https://github.com/moq-dev/moq/pull/7275)),
  which issues a moq-bot token scoped to this repository only for its
  `land.yml` on `main` ([moq-dev/quest#284](https://github.com/moq-dev/quest/pull/284)).
  So no other job may request an ID token, which `test/workflows.test.ts`
  guards.
- **Ruleset (done 2026-10-29).** `main`'s ruleset blocks deletion and non-fast-forward
  pushes and requires two checks: `check` from GitHub Actions, and
  `quest land` pinned to moq-bot, which has no checks or statuses
  permission and so never reports it. Its bypass actors are moq-bot and
  the admin role, which keeps an emergency bypass. It replaced the classic
  protection that required `check`.
- **Forks (user, 2026-10-27).** The fork path was never verified live. This
  quest is done only once a fork PR lands through the host gate's squash-merge
  API and shows as merged; any fix it needs lands here. The API merge needs
  no maintainer edits to the fork.
- **Host gate (user, 2026-10-30).** The gate moves to the maintainer's host
  ([gate host](/quest/m0/host-land/host.md)), which merges through the API with moq-bot's
  App key instead of the `token.moq.dev` exchange above, and land.yml goes
  away. Verify the fork path on the host gate.

## Required

- [Gate host](/quest/m0/host-land/host.md) - the live gate the fork path is verified on
