# [M] quest merge runs the landing check itself

## Goal

`quest merge --land` refuses a head whose diff leaves its quest
inaccurate, by running what `quest check --base <base> --branch <head>`
checks against the exact head it is about to queue, so `/quest-merge` no
longer tells the agent to fetch the head, check it out apart, and run the
check by hand. Of the paragraph that describes those steps,
`assets/skills/merge.md` keeps only what a program cannot enforce on
itself: run `quest merge` with a `quest` the PR cannot modify.

Non-goal: the other landable conditions `/quest-merge` judges, such as
whose review counts.

## Plan

Found 2026-11-12 while trimming the skills against five days of session
transcripts: 81 sessions ran the hand check 235 times, 219 passed, about 5
found something, and 3 failed because the scratch checkout was missing.
The steps are also the kind of rule prose holds badly: the head's files are
untrusted, so the agent must use a `quest` the PR cannot modify, from a
directory outside the head's checkout, against a freshly fetched base. In
this repository `bun run quest` inside a head checkout would run the
head's own code.

Agent's choices, for the implementer to revisit:

- `quest merge` already reads the head and base from GitHub, so it
  fetches both and checks the head's tree itself, without running anything
  from it. Reading the tree from Git objects avoids a checkout; a
  temporary detached worktree that it removes is the fallback if
  `quest check` needs files on disk.
- The check is only as trusted as the `quest` that runs it. A session that
  reviewed a PR sits in its head's checkout, where a PR that edits the CLI
  or the repository's pin of it could skip the check, so the skill still
  says to run `quest merge` with a `quest` the PR cannot modify, such as
  an installed release from outside the head's checkout. Weigh having
  `quest merge` refuse to run from a checkout of the head it lands.
- A finding is a refusal that names it and says the PR needs
  `/quest-iterate`, like the refusal of a failed check
  ([moq-dev/quest#601](https://github.com/moq-dev/quest/pull/601)).
- A base whose gate already runs the check, as this repository's
  `queue-build.yml` does, still gets it: the refusal arrives before a queue
  build is spent.
