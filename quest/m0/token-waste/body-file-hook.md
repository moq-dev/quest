# [S] Check PR bodies posted from a file

## Goal

The PreToolUse hook checks a GitHub post whose body comes from a file the same
way it checks one on stdin: `gh ... --body-file <path>` and `-F <path>` are
denied when the file lacks the `(Written by ...)` footer or holds an em dash.
No prose rule tells agents how to pass a body.

## Plan

Decided 2026-11-11 (maintainer, while trimming `quest context`): the rule that
routed PR bodies through a here-document left `quest context`, since agents
got around it with `--body-file - < file` and it sat beside the rule that keeps
PR bodies in `.tmp/`.

Guidance, for the implementer to confirm:

- Read the file the flag names, relative to the call's working directory, and
  also the file a `<` redirect feeds to `--body-file -`.
- A file the hook cannot read is let through, as the hook lets through
  whatever it cannot tell apart.
- Text on a `>` quote line keeps its em dashes, as on stdin.
