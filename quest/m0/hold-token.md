# [S] A refused session cannot pick up the holder's token

## Goal

Nothing `quest` prints to a session that does not hold a PR gives it the holder's token: not the refusal from `quest iterate`, `quest ready`, or `quest merge`, and not the `hold` record of `quest status`.
Taking over a stale hold is its own explicit command, which the skills run only on the user's choice, so "the refusal named a token" can no longer read as permission to keep going.

Non-goals: stopping a session that edits the PR's labels by hand, since a hold is cooperative.

## Plan

Decided 2026-11-12 (maintainer, `/quest-plan`), from an agent memory note that recorded the workaround ("never pass a token taken from a refusal") instead of a fix:

- **Scope.** ✅ Fix the tool (rejected: keep the rule as a line in `/quest-run` and `/quest-iterate`).
- **Milestone.** ✅ m0 (rejected: m1, m2).

The failure, 2026-11-11: two of the maintainer's machines ran `/quest-unblock` on one repository and worked the same PRs at once ([moq-dev/rust2#687](https://github.com/moq-dev/rust2/pull/687), [#697](https://github.com/moq-dev/rust2/pull/697), [#700](https://github.com/moq-dev/rust2/pull/700)).
A sub-agent that `quest iterate` refused reused the token the refusal printed ("held by quest:active, added 3m ago as token ..."), reasoning that it belonged to its own dispatcher, and kept pushing.
Both machines share one GitHub account, so the token is the only thing that tells sessions apart.

Guidance, for the implementer to confirm:

- `holder` in `src/cli/hold.ts` writes the refusal, and `src/cli/status.ts` prints `hold <label> <token> ...`. Both can name the hold by its age and event URL instead.
- A stale hold is released today with `quest release <pr> <token>`, using the token the refusal printed. It needs a replacement that says what it is, such as a flag on `quest release`, and the skills that offer a takeover (`/quest-run`, `/quest-unblock`, `/quest-review`) name it.
- The token is the node ID of the PR's label event, which any session can read from GitHub. Not printing it removes the copy an agent reached for; it is not secrecy.

Open questions for the implementer to put to the maintainer:

- Whether the token should be a secret only the taking session ever sees, with the PR recording only its hash, so a second session cannot derive it at all. Recommended against unless the simple fix proves not enough: it adds state to every hold, and a session set on continuing can still remove the label.
- The same incident had a resumed agent push with no hold at all. Whether the hook should refuse a push to an open PR's head branch that another session holds, or whether that stays a skill rule.
