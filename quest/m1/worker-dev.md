# [S] Tighten the Worker's local and test setup

## Goal

Parallel agents can run seeded local servers without signing each other out,
the seed exercises every inbox section, and every Worker test uses the shared
fake GitHub and stays independent of the others.

## Plan

Decided 2026-10-24 (user) as follow-ups of
[moq-dev/quest#213](https://github.com/moq-dev/quest/pull/213),
[#208](https://github.com/moq-dev/quest/pull/208), and
[#215](https://github.com/moq-dev/quest/pull/215), ranked after launch:

- **Session cookies.** Seeded servers on different localhost ports overwrite
  each other's session cookie, causing false "Sign in required" errors. Give
  each dev server its own cookie name or host.
- **Seeded raw output.** Seed raw output in `cloudflare/dev/seed.ts` so the
  agent cards' "Raw output" disclosure has something to show.
- **Static assets.** The seeded dev server doesn't serve the built static
  assets; #258 verified with a scratch adapter instead (decided 2026-10-28,
  user, from [moq-dev/quest#258](https://github.com/moq-dev/quest/pull/258)).
- **Shared fake.** The `projects`, `inbox`, `jobs`, and `push` Worker tests
  still mock `fetch` themselves; move them onto `cloudflare/dev/github.ts`
  where it models their flows.
- **Each test alone.** #208's global reset clears storage but not
  module-level state. Add a scheduled CI job that runs each Worker test case
  in its own process, which is too slow for every PR.
