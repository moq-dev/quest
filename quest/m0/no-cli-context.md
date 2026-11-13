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
learnings: five moq-dev repositories had learnings that only worked around
`quest context` failing on Pullfrog's runner, which has no Nix and no
`quest`.

- How should an agent without the CLI get the rules?
  - ✅ Both: a fallback in the reference line for any agent, and a setup step
    where a repository's reviews need its dev shell (rejected: only the
    fallback; only Pullfrog's `hooks.setup`). The setup step is its own quest,
    since each lands independently.

Recommended: extend `REFERENCE_LINE` in `src/core/init.ts` with one clause,
such as "or, where `quest` is not installed, read
https://github.com/moq-dev/quest/blob/main/assets/CONTEXT.md". It stays one
line under the `Quests: ` marker. That copy may be newer than a repository's
pinned version, which is acceptable for review bots. Keep the line agent- and
host-neutral: it names no bot.

Roll the new line out to the moq-dev repositories that install Quest by
bumping their pin and running `quest init`. If
[worker-leftovers](/quest/m1/worker-leftovers.md) has removed
`OLD_REFERENCE_LINES` by then, init leaves the old line as a reworded one, so
edit it by hand in the same PRs.
