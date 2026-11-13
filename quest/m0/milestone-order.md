# [S] Reject Required links to a later milestone

## Goal

`quest check` fails on a `Required` entry whose target sits in a later
milestone than the document listing it, such as an m1 quest requiring an m2
one. The finding names both documents and their milestones, and says to move
one of them with `quest mv`. Quests, epic READMEs, and milestone READMEs are
all covered; the root README, which belongs to no milestone, and links to
other repositories are not.

`quest unblocked` ranks a blocker by its own milestone, so an inverted link
leaves the earlier quest stalled behind all of the later milestone's work. On
2026-11-13, moq-dev/moq's main held six such links, moq.pro's one, and rind's
one.

## Plan

Decided 2026-11-13 (user, /quest-plan):

- How is an inverted link prevented?
  - ✅ `quest check` rejects it (recommended): the tree then states each
    quest's real priority, and `/quest-audit` no longer has to spot it by eye
    (rejected: ranking a blocker at its dependents' earliest milestone instead,
    which hides the misplaced quest; both, which is redundant once check holds)
- Milestone?
  - ✅ m0 (recommended): it fixes stalls in moq-dev's own repositories (rejected:
    m1, m2)
- What about the links already on main in moq, moq.pro, and rind?
  - ✅ Fix them now, in one PR per repository, before this rule ships
    (rejected: list them here and leave them to each repository's pin bump):
    [moq-dev/moq#8637](https://github.com/moq-dev/moq/pull/8637), the
    pre-cut audit, which supersedes the closed moq-dev/moq#8645, and
    [moq-dev/moq.pro#3992](https://github.com/moq-dev/moq.pro/pull/3992).
- Challenged the same day: moq splits m1 and m2 by kind, not priority, and
  its 2026-11-12 audit kept additive m1 quests requiring breaking m2 work on
  purpose. Should ranking instead give a blocker its dependents' earliest
  milestone?
  - ✅ Keep the check rule (user: "I definitely don't want earlier milestones
    blocked on later milestones") (rejected: ranking inheritance instead;
    both). moq moves those quests to m3.
    rind's one link goes when
    [kixel-ai/rind#606](https://github.com/kixel-ai/rind/pull/606) merges
    and deletes the quest it points to. Before this rule ships, re-scan
    each repository's main for links added since.

Implementation guidance:

- A document's milestone is the root child directory that holds it, ordered
  as `quest unblocked` orders milestones, so `m10` follows `m9`.
- There is no `--fix`: which side moves is a priority decision for the
  maintainer, as `/quest-audit` already treats moving a quest between
  milestones.
- Every check finding also makes `quest unblocked` and `quest start` fail, so
  a repository whose tree holds an inverted link cannot rank work until it
  fixes it. That is intended; the fixes above clear moq-dev's trees first.
- Update the guide's `Required` rules in `assets/AGENTS.md` beside
  "`Required` must be acyclic", and narrow `/quest-audit`'s "misaligned
  priorities" item in `assets/skills/audit.md` to what check cannot see.
