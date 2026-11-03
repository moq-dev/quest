---
description: Scope and create quests through an interactive interview. Use when the user invokes /quest-plan, asks to plan a quest, or wants unsettled work split into quests.
---

Before you begin, run `quest guide` and `quest skill grill`, and read their output completely.

Before anything else, search for existing and planned work: the quest tree, git history for deleted quests, open PRs touching `quest/`, and the quest trees of related repositories that plan work here.
Search by the code and behavior the work touches, not only its keywords: a quest that will change, replace, or delete them may already settle the question or make the request moot.
Show any overlap in the first round.

Interview the user with the grill skill.
Every follow-up the user picks goes through this interview, including edits to existing quests and to quests in other repositories.
A background agent that cannot prompt never creates or edits quests itself, so this skill can run in the foreground.

Search other quests and epics to keep the larger plan consistent.
Docs a change makes stale stay in that change.

Begin the interview by scoping the goal: the observable outcome, why it matters, and its important boundaries and non-goals.
Restate the goal in one sentence and get it confirmed before moving on to implementation decisions.

Choose the structure yourself rather than asking: one quest per independently completable outcome, an epic for related ones, and an edit to an existing quest that already owns the work.
Prefix each quest title with `[XS]`, `[S]`, `[M]`, `[L]`, or `[XL]`, including implementation, verification, and landing work.
Show that structure as a recommendation; of the structure, ask the user only which milestone each new quest joins.
Once complete, create, update, or delete the relevant quests and epics.
Record each settled decision and its reason in the quest's Plan, so later sessions don't ask it again, and the decision prompts in the PR.
New work joins the milestone the user picked, at its rank; an epic groups related quests, and its README holds the work no child owns (the end-to-end test, the docs page).

When done, commit, open the PR as a draft, and run `/quest-review` on it, which reviews the branch, records the `## Review` section, and marks the PR ready.
Quests planned as follow-ups of an open PR may be committed to that PR instead, whose next push is reviewed as the guide's Reviews section describes.
