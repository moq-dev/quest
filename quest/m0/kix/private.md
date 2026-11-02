# [M] Enroll private repositories

## Goal

A maintainer enrolls a private repository, starting with moq-dev/moq.pro,
and kix works on it as on a public one. Every page, board, inbox item, push
notification, raw output, and API response about it is shown only to a
signed-in user whose GitHub access can read that repository, checked against
GitHub when served. No repository needs an OSI license to enroll.

## Plan

Decided 2026-10-30 (user, /quest-plan), after moq-dev/moq is enrolled:

- How should private repositories be allowed?
  - Owners on an allowlist skip the public and license checks
  - Drop the checks entirely
  - Private only for allowlisted owners, public open to anyone
  - ✅ (user's answer) Start with moq-dev/moq, then plan private
    repositories like moq.pro, where viewers must be signed in with
    permission to see the repository
- What happens to the OSI-license check?
  - Skip it only for private repositories
  - ✅ Drop it everywhere

- Remove `#public` (`cloudflare/src/github/service.ts`) and its callers'
  "Select a public repository" refusals, the `osiApproved` check and
  `cloudflare/src/licenses.ts` if nothing else uses it, and the license
  rechecks on observation. Update the eligibility copy and `cloudflare/README.md`
  and `cloudflare/GITHUB.md`.
- Reads already recheck maintainer authority; extend that so any reader of a
  private repository's views needs GitHub read access, and anonymous routes
  such as the public boards (`/repos/...`) and the project board never show a
  private repository. A repository that turns private after enrolling loses
  its public views at the next observation.
- Push notifications and raw output carry no private content to users who
  lost access: recheck access before sending and on expanding output.
- Check the App's requested permissions cover private repositories' contents,
  issues, and pull requests; changing them is an operator step in
  `cloudflare/GITHUB.md`.
- Enroll moq-dev/moq.pro and run one start job through to its PR as the live
  check.
- Test a private repository viewed by a maintainer, a reader without
  maintain rights, a signed-in stranger, and an anonymous visitor, and a
  public repository that turns private.

## Required

- [Operator setup](/quest/m0/kix/operator-setup.md) - moq-dev/moq and moq-dev/quest work first
