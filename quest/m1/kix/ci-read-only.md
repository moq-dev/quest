# [M] Require read-only pull-request CI

## Goal

Every kix trust boundary is written down, and enrolled repositories keep
pull-request CI read-only. kix publishes job branches on the repository
itself, where GitHub gives a branch's workflows the repository's secrets and
default token. So code no maintainer has reviewed must meet only a read-only
`GITHUB_TOKEN` and no write credentials. kix checks this when a repository is
enrolled and warns the maintainer about what to fix. `cloudflare/GITHUB.md`
states the trust rule for each stage of a job.

## Plan

Decided 2026-10-28 (user, /quest-plan trust audit started from
moq-dev/quest#246's Codex Security P1):

- **Rule over gates.** Read-only CI replaces a service fork or a per-push
  review gate as the answer to agent-written code reaching CI. Fork PRs
  already get no secrets; same-repository branches need the repository's own
  settings to match. The guide states the rule for agents
  ([moq-dev/quest#263](https://github.com/moq-dev/quest/pull/263)).
- **Check and warn, don't refuse.** At enrollment, and on the project's
  settings page, kix reports each problem it finds:
  - the default workflow token can write;
  - Actions secrets at repository level;
  - an environment with secrets but no protected-branch deployment policy.

  Jobs still run. Check which App permission reads secret and environment
  metadata; adding one is an operator step in `cloudflare/GITHUB.md`.
- **Runner claims are the owner's attestation.** Jobs go only to the
  requester's own runners, so a runner's self-declared `vm` flag and its
  request to mark a PR ready are its owner's statements. kix doesn't verify
  them. Under read-only CI, a runner marking its PR ready starts only harmless
  CI.
- Rewrite `cloudflare/GITHUB.md`'s trust section as a stage-by-stage table:
  intake, job creation, routing, devShell, agent run, publication, CI, review,
  and land. For each stage, name what is trusted and why. Fix the
  contradiction between `cloudflare/README.md` ("route only to Linux runners
  that declare VM builds") and the root README (every runner refuses untrusted
  jobs).
- `SETUP.md` recommends the same settings when a repository adopts Quest,
  beside its advice to skip CI on drafts.
- The pilot repositories pass the check before contributors are invited:
  moq-dev/quest's `land` environment was limited to `main` on 2026-10-28,
  and moq-dev/moq tracks its fix in
  [read-only secrets](https://github.com/moq-dev/moq/blob/main/quest/m0/ci/read-only-secrets.md).
- Noted 2026-11-01 (user, /quest-plan, from
  [moq-dev/quest#246](https://github.com/moq-dev/quest/pull/246)):
  moq-dev/moq's `.github/workflows/check.yml` passes the
  `MBX_R2_ACCESS_KEY_ID` and `MBX_R2_SECRET_ACCESS_KEY` secrets to its
  `pull_request` checks. They must move to an environment limited to
  protected branches before moq enrolls.

## Related

- [Operator setup](/quest/m0/kix/operator-setup.md) - pilot repositories should pass this check
- [Head approval](/quest/m0/kix/sandbox/head-approval.md) - the devShell stage's trust rule for heads without signatures
