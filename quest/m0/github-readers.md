# [M] PR status and claims as a library

## Goal

A hosted service with no checkout, `git`, or Node APIs, such as a Cloudflare Worker that indexes repositories from GitHub webhooks, derives a PR's status and a quest's claim with Quest's own code instead of a second implementation that drifts.
The package exports, beside `./core`, a module that reads both through GitHub's API with the caller's `fetch` and token:

- `pullRequestStatus`, giving what `quest status` prints: draft, holds, the hand-back, the review record, checks, auto-merge and the head it was enabled on, the merge queue entry, and why landing stopped.
- The claims on a list of quest branches, as `quest unblocked --unclaimed` and `quest start` decide them: a branch upstream or in the head fork, unless its tip is a merged PR's head, or the earliest open PR from it.

`quest status`, `quest wait`, and the claim checks call the same code, so the CLI and a hosted caller cannot disagree.
`hosts` is exported from `./core` too, so a caller lists a quest's hosts as `quest unblocked --json` reports them.

## Plan

Agent's choices, for the implementer to revisit:

- Split the GitHub client in `src/cli/github.ts`: requests, GraphQL, paging, retries, and the deadline move to `src/github/`, which already holds code shared with a Worker (`checks.ts`), and the CLI keeps reading remotes and resolving its token. `GitHubDependencies` (`fetch`, `now`, `sleep`, `token`, `warn`) already fits a Worker.
- Move `pullRequestStatus` there with what it calls: the summary, `classifyCheck`, the ejection reader and `EJECTED`, `pinned`, the review record's comparison, `enabledHead` and `headBefore`, and the read half of `readHoldStatus`.
- Add a `handedBack` field to `Status`, read from the PR body it already fetches with `handedBack` from `./core`, since today a caller cannot tell a handed-back draft from another draft.
- Claims: `held` already takes branch tips as a parameter; the library form takes the repository and head fork as `owner/repo` and reads tips through GitHub's matching-refs API when not given, so only finding the upstream through `git` remotes stays in the CLI.
- Export the module as `./github`, type-checked with `types: []` like `src/core`, so a stray `node:` import fails `just check`.
- The package stays private: a consumer depends on a pinned commit (`github:moq-dev/quest#<sha>`), so no release is needed.
- A webhook-driven caller re-reads a PR's status on each event about it; nothing here parses webhook payloads.

Tests: the moved code keeps its tests, and `quest status` prints the same lines for the same GitHub responses; a test reads `handedBack` from `pullRequestStatus` directly.
