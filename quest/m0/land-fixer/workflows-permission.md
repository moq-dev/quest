# [XS] moq-bot can push workflow changes

## Goal

The moq-bot GitHub App (ID 1039466) has the `workflows: write` repository
permission, and every installation that lands through the host gate has
accepted it: moq-dev/moq, moq.pro, rust2, rind and quest. GitHub then accepts
a fixer push that touches `.github/workflows`, including a base merge pushed
to a fork's branch. This quest waits on the maintainer. To check, open the
App's settings under Permissions; GitHub lists pending permission requests on
each installation.

## Plan

Decided 2026-11-01 (user, /quest-plan):

- What happens when a fixer push touches `.github/workflows`:
  - ✅ Grant moq-bot `workflows`
  - The fixer avoids workflows, and the PR parks for a decision

GitHub refused the fixer's push on
[moq-dev/moq#7439](https://github.com/moq-dev/moq/pull/7439) (twice),
[#7467](https://github.com/moq-dev/moq/pull/7467), and
[#7370](https://github.com/moq-dev/moq/pull/7370); a maintainer session pushed
each by hand. Once this permission is granted, the refusal that
[moq-dev/quest#358](https://github.com/moq-dev/quest/pull/358)'s
`quest land apply` handback handles should stop happening.

Delete this quest once the permission is granted and accepted.
