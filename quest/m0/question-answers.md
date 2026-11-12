# [S] quest messages prints the answers to agents' questions

## Goal

`quest messages` prints each answer a person gave to an agent's blocking
question, such as Claude Code's `AskUserQuestion`, Codex's
`request_user_input`, or T3 Code's structured questions, with the option
the agent marked recommended and the option picked. The
[mistake audit](/quest/m0/mistake-audit.md) then tallies how often each
skill's prompts were answered with the recommendation, the measure its
Plan asks for before any change to how agents ask.

## Plan

Today `quest messages` drops most of these answers: T3 Code records them
as server-created (`readT3Messages` in `src/cli/messages.ts`), and Claude
Code returns them as tool results, not human turns. Codex's replies come
through as text, without the option it recommended. The 2026-11-11 audit
found only 6 structured replies among 1,452 messages, and so could count
only typed answers that picked the recommendation.

Agent's choices, for the implementer to revisit:

- Print an answer as its own kind of record beside typed messages, with
  the question's header and the skill the session ran, when its log names
  one. Keep messages' rules: stdout only, nothing stored or posted.
- Read Codex's question from its log beside the reply `quest messages`
  already returns, so its recommended option is known too.
