# [M] Delete pull requests from the decision inbox

## Goal

A pull request's decision item in kix offers delete beside merge, iterate,
mark ready, and skip, completing the `/quest-complete` action set, one
decision per PR. Deleting a quest's PR abandons that quest as
`/quest-delete` does; deleting any other PR closes it.

## Plan

Starting ready work (by click and, per maintainer opt-in, on every free
runner slot in `quest unblocked` order), the start job's worth-starting
decision, owned PRs naming their holder, quiet-draft takeover, and mark ready
shipped with this quest's first PR. The integration cases the plan listed
(racing starts, a moved PR head, a blocked decision, an exhausted account, a
runner going offline mid-job) are covered by the Worker's job and seed tests.

- Decided 2026-10-20 (user): a PR decision offers the `/quest-complete`
  actions: mark ready, merge, iterate, skip, or delete.
- A quest PR (head branch `quest/...` naming a quest in the tree) deletes
  through a job, since `/quest-delete` repurposes the PR to delete the quest
  with `quest rm`, edits the mentions it reports, and lands it. Reuse the
  start and merge jobs' runner, publication, and landing paths rather than a
  separate executor; the job holds the PR with `quest:kix` as a merge job does.
- Any other PR closes as the App at the head on screen, refused while one of
  its jobs is active. Closing leaves a quest branch in place, which still
  claims its quest, so a quest PR never closes this way.
- Only a free PR offers delete: never a draft its starter holds or one a
  `quest:*` label holds.
