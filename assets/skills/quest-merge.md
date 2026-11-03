---
name: quest-merge
description: Merge a GitHub PR once reviews and CI pass.
---

Land a pull request.
If unsure about any course of action, interactively prompt the user for guidance.
Continue any non-blocking tasks asynchrnously.

- Parse the arguments to determine the PR number, otherwise resolve it from the current context/branch.
- Fix any issues with the PR, such as merge conflicts and failing CI checks.
- If a draft, flip it to "Ready for Review" then wait for at least one automated review to complete. Never wait on CodeRabbit.
- Fix any review feedback you agree with, and leave a comment if you disagree. Don't wait for another review round after narrow fixes.

If everything looks good, leave a summary of the changes made, then enable auto-merge with the full 40-character head SHA.
Enable it only once every open decision is resolved: prompt the user for each with your recommendation, or, as a background agent, list them in your report.
Record the outcome as a PR comment when it isn't already in the PR: each decision and its reason, and any follow-up the user declined.
When done, explain the result in a few lines and offer any follow-ups as a multi-select.
Never close a PR to unstick it, and never work around a refused merge; ask instead.
