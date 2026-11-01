# [XS] Links into an uninitialized submodule aren't broken

## Goal

`quest check` doesn't report a link into a submodule as broken when that
submodule isn't checked out. It still reports a link to a path the submodule's
recorded commit doesn't contain, or skips it with a note when that commit isn't
available locally. A fresh worktree or a scratch checkout of a PR head passes
`quest check` without populating submodules first.

## Plan

From moq.pro's 2026-10-29 merge run, where nearly every merge agent's
pre-land `quest check --base` failed on `quest/m2/wildcard/README.md`'s link
into `moq/rs/moq-pattern/README.md`, only because its scratch checkout hadn't
initialized the `moq` submodule.

`check` resolves links outside the tree through its `exists` callback
(`src/core/rules.ts`; the finding is `link does not resolve`). When a target
falls under a submodule path from `.gitmodules` whose work tree is empty, look
the path up in the recorded commit's tree (`git ls-tree <gitlink> -- <path>`)
when that commit is available. Otherwise don't report the link broken. Test
all three cases: populated, uninitialized with the object available, and
uninitialized without it.

`committed` in `src/cli/tree.ts` already resolves a path at a submodule's
pinned commit for snapshots; reuse that lookup rather than writing a second one.

Decided 2026-10-29 (user, moq.pro follow-ups): plan only this fix upstream. The
label-queue gaps it was planned with retire once moq.pro lands through
`quest land`.

## Related

- [quest merge --land gaps](/quest/m0/helpers/merge-land.md) - the other merge-agent friction from these runs
