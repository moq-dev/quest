# [XS] Drop the deleted Worker's leftovers

## Goal

No comment in `src/` or `test/` describes the deleted Cloudflare Worker as a
caller, and `quest init` carries no upgrade table for earlier releases'
reference lines, per the no-shims rule in `AGENTS.md`.

Comments about the core staying portable to Worker runtimes, such as
`src/core/path.ts:1` and `src/core/tsconfig.json`, stay: a hosted caller like
the one [github-readers](/quest/m0/github-readers.md) serves still needs it.

## Plan

Decided 2026-11-12 (user, /quest-plan), from the trimmed Pullfrog learnings.

Known leftovers on main: `src/core/claim.ts:4` and `:132`,
`src/core/index.ts:6`, `src/core/init.ts:3-4`, `src/github/checks.ts:1`,
`src/github/merge.ts:1`, and `test/github.ts:363`, plus
`OLD_REFERENCE_LINES` in `src/core/init.ts:29-34` and its use in the plan.
Reword the comments to the callers that exist (the CLI, and the library
github-readers exports), and delete the shim and its tests.

[github-readers](/quest/m0/github-readers.md) says `src/github/` "already
holds code shared with a Worker"; reword it to the library's hosted caller.
