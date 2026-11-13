# [S] Quest's rules reach agents without the CLI

## Goal

An agent that runs where `quest` is not installed, such as Pullfrog's review
runner, still gets Quest's rules when a repository's root instructions point
it at `quest context`. The reference line `quest init` writes says where to
read them instead, so no repository needs its own workaround.

Out of scope: installing the CLI on such runners, which
[pullfrog-setup](/quest/m0/pullfrog-setup.md) does where a repository's
reviews need its dev shell.

## Plan

Decided 2026-11-12 (user, /quest-plan), after trimming Pullfrog's per-repo
learnings: studio, rust2, quest, and web-transport had learnings that worked
around a missing `quest`, `nix`, or `just` on Pullfrog's runner, which has
no Nix and no `quest`. Rind's worked around its test vectors instead, which
[pullfrog-setup](/quest/m0/pullfrog-setup.md) has it check in.

- How should an agent without the CLI get the rules?
  - ✅ Both: a fallback in the reference line for any agent, and a setup step
    where a repository's reviews need its dev shell (rejected: only the
    fallback; only Pullfrog's `hooks.setup`). The setup step is its own quest,
    since each lands independently.

Recommended: extend `REFERENCE_LINE` in `src/core/init.ts` with one clause,
such as "or, where `quest` is not installed, read
https://github.com/moq-dev/quest/blob/main/assets/CONTEXT.md". It stays one
line under the `Quests: ` marker. That copy may be newer than a repository's
pinned version, which the decision above accepts for any agent without the
CLI, not only review bots, since the fallback is for any agent. Keep the line
agent- and host-neutral: it names no bot.

Roll the new line out to the moq-dev repositories that install Quest, this
one included, by editing their `Quests: ` line by hand in the PRs that bump
their pin. `quest init` will not do it: `appendLine` in `src/core/init.ts`
replaces only a line listed in `OLD_REFERENCE_LINES`, which the current line
is not, and keeps any other line under the marker as a reworded one. Add no
entry to that table, since [worker-leftovers](/quest/m1/worker-leftovers.md)
deletes it under the no-shims rule.
