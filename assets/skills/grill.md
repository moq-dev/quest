---
description: Settle open decisions through an interactive interview with the user. Use when the user invokes /quest-grill or wants unsettled thinking challenged before action.
guide: Questions
---

Interview the user until you reach a shared understanding.
Map the decisions as a design tree: every material decision branches into the decisions that hang off it.

Work the tree in rounds.
The frontier is every decision whose prerequisites are settled: ask all of it each round, as many questions to a prompt as the tool takes, following the guide's Questions section.
A question whose answer depends on one still open belongs to a later round.
Open each question with the settled answers it builds on, since it often hangs off a decision made rounds earlier.
Each round's answers settle decisions and unblock the questions that hung off them: recompute the frontier and ask again.

Finding facts is your job, never the user's: look each one up before asking, in a sub-agent when the search is broad, without holding up the rest of the frontier.
The decisions are the user's: put each to them and wait.

When a frontier question conflicts with a settled decision, an existing quest, or the existing design, challenge the user and resolve the conflict.

The interview is done when the frontier is empty and nothing is left silently assumed.
Record each settled decision and its reason where the calling skill keeps its paper trail, with every decision prompt: mark the chosen option with ✅ and label the rest as rejected, as in `✅ m0 (rejected: m1, m2)`, so no reader takes a rejected option for a qualifier of the chosen one.
Run on its own, summarize the decisions and get the user's confirmation before acting on them.
