---
description: Scope and create quests through an interactive interview. Use when the user invokes /quest-plan, asks to plan a quest, or wants unsettled work split into quests.
guide: Model, Format, Creation, Summaries, Prompting
skills: grill
---

Before anything else, search for existing and planned work: the quest tree, git history for deleted quests, open PRs touching `quest/`, and the quest trees of related repositories that plan work here.
Search by the code and behavior the work touches, not only its keywords: a quest that will change, replace, or delete them may already settle the question or make the request moot.
Show any overlap in the first round.

Interview the user with the grill skill.
The goal is the root of its tree, so the first round asks only it: restate the observable outcome, why it matters, and its boundaries and non-goals in one sentence, and get that confirmed before any other question.

Choose the structure yourself rather than asking: one quest per independently completable outcome, an epic for related ones, an edit to an existing quest that already owns the work, and the milestone each new quest joins, by its urgency and by any milestone rule the user has stated, such as "CI and flakes join m0".
Show that structure in the summary, with each quest's size and milestone and the reason for the milestone, so the user can correct it in the PR's review.

Once the interview is done, create, update, or delete the relevant quests and epics.
Record each settled decision and its reason in the quest's Plan, so later sessions don't ask it again, and the decision prompts in the PR.
A fix quest's Plan names the PR that caused the problem when it is known, so its implementer lists it under `## Caused by` without searching again.
When the PR deletes the quest, record its decisions in the PR body's `## Decisions` section instead, since the deletion takes the Plan with it.

Then commit on a `quest-plan/<slug>` branch, open the PR as a draft, and run `/quest-review` on it.
The interview was the user's pick to merge it: unless the review leaves a decision open, skip its closing question and run `/quest-merge` on the PR.
