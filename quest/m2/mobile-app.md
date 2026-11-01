# [L] Answer decisions from a native mobile app

## Goal

A maintainer installs a native iOS or Android app, receives push
notifications for the same decision items as the web app, and answers simple
choices straight from the notification. Anything that needs context opens the
full prompt in the app.

## Plan

- Decided 2026-10-15: the native app follows the m0 PWA. It adds what Web
  Push cannot do on every platform: notification quick replies and native
  delivery.
- Extend the PWA's push events and coalescing (`cloudflare/src/push/`)
  rather than defining a second set.
- Reuse the service's decision API, authorization, and stale/duplicate-answer
  checks. A quick reply is a normal answer bound to the decision's revision,
  not a second path with weaker checks.
- Keep the summaries-first rule: the app shows prompts, summaries, and agent
  activity, and raw output only behind the same maintainer-only disclosure.
- Open question: wrap the PWA (for example Capacitor) or build natively (for
  example React Native/Expo). Research the current options when this starts
  and choose with the user. Split any app-store account setup that waits on a
  human into its own quest.
