---
description: Settle open decisions through an interactive interview with the user. Use when the user invokes /quest-grill or wants unsettled thinking challenged before action.
guide: Questions
---

Interview the user until you reach a shared understanding.
Map the decisions as a design tree: every material decision branches into the decisions that hang off it.
A background agent that cannot prompt never picks an answer: it puts each open decision in its report with its context, the options, and a recommendation, so its caller can ask the user.

Work the tree in **rounds**.
The **frontier** is every decision whose prerequisites are already settled.
Ask the whole frontier in one synchronous round, following the guide's Questions section.
Open each question with the context it needs, including the settled answers it builds on, since a later round's question often hangs off a decision made rounds earlier.
Mark one answer per question as (recommended) and wait for the user's answers (never guess) before the next round.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them.
Recompute the frontier and ask the next round.
A question whose answer depends on another question still open in this round belongs to a *later* round, not this one.

Finding *facts* is your job, never the user's.
When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it.
Don't block on it, ask the rest of the frontier now.
The *decisions* are the user's: put each to them and wait.

When the frontier conflicts with a settled decision, an existing quest, or the existing design, challenge the user and resolve the conflict.

The interview is done when the frontier is empty and nothing is left silently assumed.
Record each settled decision and its reason where the calling skill keeps its paper trail, including every decision prompt.
Mark the chosen option with ✅ and label the rest as rejected, as in `✅ m0 (rejected: m1, m2)`, so no reader takes a rejected option for a qualifier of the chosen one.
Run on its own, summarize the decisions and get the user's confirmation before acting on them.
