# [XS] Sizes include judgment

## Goal

The guide and `/quest-plan` define a quest's size as the agent's effort to
implement, verify, and land it, judgment included, so a short but subtle
change, such as a 30-line rewording of a skill, is sized M rather than XS.
`quest`'s built-in tables route by size, so the size has to say how capable a model the
quest needs.

## Plan

Decided 2026-11-04 (user, /quest-plan):

- How are small judgment-heavy quests told apart from easy ones?
  - ✅ Fold judgment into size
  - A separate difficulty marker
- Should open quests be re-sized under the new definition?
  - ✅ No, new quests only; existing sizes stay until someone edits them
  - One pass over the open quests

Change the sizing sentence in the guide's Format section
(`assets/AGENTS.md`) and its copy in `assets/skills/plan.md`, and add one
example of each kind: much code but mechanical, and little code but mostly
judgment.
