# [M] The fixer triages a failing batch before anything is ejected

## Goal

When a batch's check fails, the fixer reads the failure first and names the
PR that caused it. `quest land` ejects only that PR and keeps the rest
queued. When the fixer cannot tell, it checks the base tip alone. If the
base is red, the queue halts and says so, ejecting nothing. If the base is
green, every PR in the batch is ejected, as today. Bisection stays gone, as
the [epic](/quest/m0/host-land/README.md) decided.

## Plan

Decided 2026-10-31 (user, /quest-plan of the follow-ups from a moq-dev/moq
`/quest-complete` run). On 2026-10-31 moq's gate ejected whole batches at
02:38, 03:01, 05:40, 06:21, 07:10, and 09:23. The fixer later found most of
those PRs healthy and requeued them. The user asked: "could the fixer not
figure it out? It should run on each batch before ejecting, instead of
wasting CI on bisection?"

- Goal, restated as "the fixer runs on each failing batch before anything is
  ejected, and blames the PR that caused the failure":
  - ✅ Yes, as restated
  - Keep ejecting the whole batch, and only speed up the requeue
  - Bring back bisection
- The user's refinement: "The fixer reads the failure, tries to identify the
  PR that caused it, and only ejects that PR. If it can't figure it out, it
  ejects all PRs".
- Repairing the blamed PR does not change: one attempt, after it is ejected.
- Blame is unclear, so check the base tip alone. A red base halts the queue
  with one visible notice instead of ejecting PRs that did nothing wrong
  ([moq-dev/moq#7196](https://github.com/moq-dev/moq/pull/7196),
  [moq-dev/moq#7085](https://github.com/moq-dev/moq/pull/7085)). The queue
  resumes once the base passes again.
- A new gate that fails on content already on the base blames the PR that
  adds the gate. [moq-dev/moq#7317](https://github.com/moq-dev/moq/pull/7317)
  added a zizmor check that failed on the base's `pullfrog.yml`, and six
  unrelated PRs were ejected with it.
- The ejection comment keeps the failing module's own output. Today
  `serveBatch` in `src/cli/land-serve.ts` keeps only the log's last 100
  lines, so a failure early in the log is cut off. The cap is
  `EXCERPT` in the same file. Prefer the fixer's diagnosis and the failing
  step's own lines over a plain tail.
- Today a failed check builds one `Failure` whose `ejections` cover every
  link in the chain (`src/cli/land-serve.ts`). `startFixer` in
  `src/cli/land-fixer.ts` then runs on PRs that are already ejected. Triage
  moves the fixer's run before those ejections. Its result needs a blame
  field beside `requeue`, `fixed`, and `handback` in `src/cli/land-fix.ts`.
- Keep the fixer's untrusted-input rules: a PR's content cannot make the
  fixer blame another PR or skip the base check.
- A collateral ejection never counts as the PR's one fix attempt
  (user, 2026-10-31). Today `handbackRepeated` (`src/cli/land-fixer.ts`)
  hands back any PR whose pick or fixer requeue is unchanged, so a PR that
  shared two broken batches in a row was handed back unexamined:
  [moq-dev/moq#7257](https://github.com/moq-dev/moq/pull/7257),
  [#7306](https://github.com/moq-dev/moq/pull/7306),
  [#7284](https://github.com/moq-dev/moq/pull/7284) and
  [#7312](https://github.com/moq-dev/moq/pull/7312). Only the blamed PR's
  attempt is spent. [Attempt budget](/quest/m0/land-fixer/attempts.md)
  owns the counting rule for every outcome (2026-11-01).
- Collect a finished fixer's result without waiting for the running batch
  (user, 2026-10-31). On 2026-10-31 moq's fixer finished at 14:55, having
  fixed [moq-dev/moq#7383](https://github.com/moq-dev/moq/pull/7383) and
  cleared seven collateral PRs, but the daemon collects results only between
  batches, so those PRs stayed out of the queue behind a check that started
  at 14:54 and ran about 45 minutes. Requeued PRs then join the next batch
  as soon as they are collected.

## Related

- [Fixer proxy access](/quest/m0/host-land/fixer.md) - how the fixer reaches its model
