---
description: Start work on a quest.
guide: Model, Format, Creation, Execution, Summaries, Questions
---

Implement the quest the argument names, or as much of it as possible, in its PR.

Claim it with `quest start <quest>`; if it refuses, report what it printed and stop.
If you cannot go on before pushing any work, release the claim with `quest start --release <quest>`.

Implement the quest until it is complete or blocked, then push to its PR and update the description.

If the quest is complete and no decision is left for the maintainer beyond its follow-ups', run `/quest-review` on it right away.
Otherwise ask the user each open decision with your recommendation, record the answers in the PR body's `## Decisions` section, and run `/quest-review` once the quest is complete and the PR reflects them.
When you cannot prompt, leave the PR a draft instead, with each decision and your recommendation under `## Waiting`.
