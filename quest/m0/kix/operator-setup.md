# [S] Set up the Kix bot's pilot repositories

## Goal

The operator installs the registered GitHub App on the pilot repositories,
moq-dev/moq and moq-dev/quest, and enrolls them on quest.moq.dev. A real issue event and a
bounded test PR verify the integration before contributors are invited.

## Plan

- This is an operator/setup outcome. App registration and its secrets belong
  to [Deploy quest.moq.dev](/quest/m0/kix/deploy.md), because every deploy needs them.
- Pilot repositories decided 2026-10-27 (user): moq-dev/quest and
  moq-dev/moq, ranked first so kix is usable on moq-dev/moq soonest.
  Decided 2026-10-30 (user): start with moq-dev/moq; the private
  moq-dev/moq.pro follows in [Private repositories](/quest/m0/kix/private.md).
  Job branches publish on the upstream itself (decided the same day), so
  there is no fork namespace to set up.
- Validate real installation-token behavior, which publication's tests only
  mock (Publication in `cloudflare/GITHUB.md`): a job branch pushed to the
  upstream under its branch rules, GitHub's signature on the App's API
  commits, a same-repository pull request opened by the App, and an
  iteration pushing an upstream pull request head under branch rules.
- Install the PWA and receive a push notification on real Android, iOS, and
  desktop devices (from
  [moq-dev/quest#165](https://github.com/moq-dev/quest/pull/165), whose
  tests use fakes).
- Read a deleted issue by number against a real installation, which the
  background reconcile from
  [moq-dev/quest#170](https://github.com/moq-dev/quest/pull/170) only
  tests against the fake.
- Check what GitHub does to an open pull request when "Start over" resets
  its head branch to the base, which
  [moq-dev/quest#190](https://github.com/moq-dev/quest/pull/190) handles
  either way (adopt it if open, open a new one if closed) but tests only
  against the fake. Added 2026-10-22 (user).
- Rehearse on the operator's own runner and an explicitly selected
  operator account.
- Record nonsecret setup/run instructions and deployment identifiers.
  Remove the quest when the setup condition is fulfilled.

## Required

- [Deploy quest.moq.dev](/quest/m0/kix/deploy.md) - the live origin and registered App
- [Owner allowlist](/quest/m0/kix/owners.md) - only moq-dev can enroll before contributors are invited
