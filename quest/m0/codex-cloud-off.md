# [XS] Turn off Codex cloud reviews

## Goal

Codex cloud stops reviewing PRs automatically in every repository that uses
quest, once none still relies on it. The condition is that local review
(`quest review` and `/quest-review`) has landed, each adopting
repository's review policy no longer names Codex, and no open PR in those
repositories was opened before its repository adopted local review without
having merged main since. To check, list each repository's open PRs and
compare them with the adoption merge. To advance it, update the stragglers to
main. Then the maintainer turns off automatic reviews in Codex's settings, and
this quest is deleted.
