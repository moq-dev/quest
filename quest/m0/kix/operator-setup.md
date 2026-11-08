# [S] Turn on kix for moq-dev's repositories

## Goal

kixel-quest is installed on moq-dev/moq and moq-dev/quest, both are
enrolled on quest.moq.dev, and a real issue event and a bounded test PR show
the integration works against GitHub rather than the fake.

## Plan

- The Worker is live at quest.moq.dev (deployed 2026-11-04, /quest-unblock)
  with the production App
  [kixel-quest](https://github.com/apps/kixel-quest) (ID 5622964, owned by
  moq-dev); its registration and secrets were part of that deploy.
- Repositories decided 2026-10-27 (user): moq-dev/quest and moq-dev/moq,
  ranked first so kix is usable on moq-dev/moq soonest. Decided 2026-10-30
  (user): start with moq-dev/moq; the private moq-dev/moq.pro follows in
  [Private repositories](/quest/m0/kix/private.md). Job branches publish on
  the upstream itself (decided the same day), so there is no fork namespace
  to set up.
- Decided 2026-11-08 (maintainer, /quest-unblock): Quest serves moq-dev
  only, so this is turning kix on for our own repositories, not a pilot ahead
  of outside contributors. ✅ Keep the quest and drop its outsider steps
  (rejected: delete this quest only; drop hosted kix entirely, which belongs
  to the factory re-scope's /quest-plan rounds if anywhere). Dropped: the
  check that each setup page shows no Pull-request CI warning before
  contributors are invited.
- Once installed, an agent validates what only a real installation shows:
  - Installation tokens, which publication's tests only mock (Publication in
    `cloudflare/GITHUB.md`): a job branch pushed to the upstream under its
    branch rules, GitHub's signature on the App's API commits, a
    same-repository pull request opened by the App, and an iteration pushing
    an upstream pull request head under branch rules.
  - A runner's review against the real checks API, which
    [moq-dev/quest#417](https://github.com/moq-dev/quest/pull/417) tests only
    against the fake: a merge job's delivered head gets the App's
    `quest review` check run, a failing round followed by a passing one
    leaves the passing run as the latest, and kix lands the head with no
    human approval. The installation needs **Checks: write** for it.
  - Reading a deleted issue by number, which the background reconcile from
    [moq-dev/quest#170](https://github.com/moq-dev/quest/pull/170) only
    tests against the fake.
  - What GitHub does to an open pull request when "Start over" resets its
    head branch to the base, which
    [moq-dev/quest#190](https://github.com/moq-dev/quest/pull/190) handles
    either way (adopt it if open, open a new one if closed) but tests only
    against the fake. Added 2026-10-22 (user).
- Rehearse on the maintainer's own runner and an explicitly selected
  account.
- Record nonsecret setup and run instructions and deployment identifiers,
  then delete this quest.

## Waiting

- Maintainer: install kixel-quest on moq-dev/moq and moq-dev/quest and
  enroll both on quest.moq.dev. An agent can't: installing an App and
  enrolling need the maintainer's signed-in GitHub session. Check that
  `gh api orgs/moq-dev/installations` lists `kixel-quest` with both
  repositories and that quest.moq.dev shows both enrolled.
- Maintainer: install the PWA and receive a push notification on real
  Android, iOS, and desktop devices (from
  [moq-dev/quest#165](https://github.com/moq-dev/quest/pull/165), whose
  tests use fakes). An agent can't hold the devices. Check by the
  maintainer's report.
