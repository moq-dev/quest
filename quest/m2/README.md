# Later work

## Goal

Extend kix.quest with cloud runners, a native mobile app, runners shared
with other projects, donated reviews and CI, stronger isolation, and
additional login providers. This milestone does not gate the public release.

## Required

- [Cloud runners](/quest/m2/cloud/README.md) - one-click free cloud runners, API-key and donor funding, then paid compute
- [Native mobile app](/quest/m2/mobile-app.md) - push notifications with quick replies to decisions
- [Shared runners](/quest/m2/donor-runner.md) - offer your runner and accounts to other projects
- [Review and check automation](/quest/m2/automation/README.md) - donated reviews, CI, and a shared Nix cache
- [Donor isolation](/quest/m2/donor-isolation.md) - stronger boundaries for untrusted shared jobs
- [ChatGPT hosted runs](/quest/m2/chatgpt-hosted.md) - conditional on provider approval and current terms
- [ChatGPT approval](/quest/m2/chatgpt-waitlist.md) - resolve hosted-use approval before implementation
- [Delete the legacy hold labels](/quest/m2/legacy-labels.md) - once every gated repository pins quest past #326, only `quest:active` and `quest:kix` are holds
