---
description: Scope and create quests through an interactive interview. Use when the user invokes /quest-plan, asks to plan a quest, or wants unsettled work split into quests.
guide: Model, Format, Creation, Execution, Summaries, Prompting
skills: grill
---

Before anything else, search for existing and planned work: the quest tree, git history for deleted quests, open PRs touching `quest/`, and the quest trees of related repositories that plan work here.
Search by the code and behavior the work touches, not only its keywords: a quest that will change, replace, or delete them may already settle the question or make the request moot.
Show any overlap in the first round.

Interview the user with the grill skill.
Run it in the foreground.

Search other quests and epics to keep the larger plan consistent.
Docs a change makes stale stay in that change.

Begin the interview by scoping the goal: the observable outcome, why it matters, and its important boundaries and non-goals.
Restate the goal in one sentence and get it confirmed before moving on to implementation decisions.

Choose the structure yourself rather than asking: one quest per independently completable outcome, an epic for related ones, and an edit to an existing quest that already owns the work.
Prefix each quest title with `[XS]`, `[S]`, `[M]`, `[L]`, or `[XL]` by the agent's effort to implement, verify, and land it, judgment included.
Much code that is mechanical stays small, such as applying one rename the same way across the tree, sized XS.
Little code that is mostly judgment is larger, such as a 30-line rewording of a skill, sized M rather than XS.
Show that structure as a recommendation; of the structure, ask the user only which milestone each new quest joins.
When the user has stated a milestone rule earlier in this session, such as "CI and flakes join m0", apply it to each quest it covers without asking, and still show the milestone it picked and the rule behind it.
Once complete, create, update, or delete the relevant quests and epics.
Record each settled decision and its reason in the quest's Plan, so later sessions don't ask it again, and the decision prompts in the PR.
A fix quest's Plan names the PR that caused the problem when it is known, so its implementer lists it under `## Caused by` without searching again.
When the PR deletes the quest, record its decisions in the PR body's `## Decisions` section instead, since the deletion takes the Plan with it.
New work joins the milestone the user picked, in its directory or an epic's there; an epic groups related quests, and its README holds the work no child owns (the end-to-end test, the docs page).

When done, commit, open the PR as a draft, and run `/quest-review` on it, which reviews the branch, records the `## Review` section, and marks the PR ready.
