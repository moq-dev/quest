# [XS] quest check rejects a misleveled Waiting heading

## Goal

`quest check` fails on a `Waiting` heading at any level other than a
top-level `## Waiting` section, naming the file and line, so a wait cannot
silently drop out of `quest waiting` and `/quest-unblock`.

## Plan

Decided 2026-11-06 (maintainer, moq-dev/moq.pro /quest-complete):

- Where does this quest go?
  - ✅ m0 (recommended)
  - m1
  - Drop it

Evidence: moq-dev/moq.pro had 38 `### Waiting` headings nested under Plan
that `quest waiting` never listed.
[moq-dev/moq.pro#3579](https://github.com/moq-dev/moq.pro/pull/3579)
promoted them, and main gained three more while it was open.

The cause: `Doc.headings` in `src/core/doc.ts` keeps only `#` and `##`
headings, treating deeper levels as free-form prose, so `headings()` in
`src/core/rules.ts` never sees a `### Waiting` and `quest waiting` never
parses its items. The rule needs the deeper headings too, at least those
whose text is `Waiting`; a `# Waiting` that is not the title fails the same
way. Add a test beside the existing heading rules' tests in `test/tree.test.ts`.

Open, recommended, not settled: whether `quest check --fix` promotes a
misleveled heading. It can do so safely only when the `### Waiting` is the
last subsection of its `## Plan` (or other section), since promoting it then
moves no other text into the new section; anywhere else promotion would carry
the following prose with it, so the finding stays for a person. Recommended:
yes for that safe case, since agents already run `--fix` after every merge
and moq.pro's promotions were mechanical, and report the rest without fixing. The implementer may decide otherwise and record why.
