# [XS] Name Kixel Code's record endpoint in each repository

## Goal

Every repository whose sessions Kixel Code should count commits a
`.quest.json` naming the record endpoint Kixel Code serves, so `quest`'s
stop hook sends each session's record there, and the maintainer's hosts
hold a token paired with it in `~/.config/quest/records.json`. One real
session on a moq-dev/quest PR then shows in Kixel Code's store, its
record equal to what `quest usage --json` prints for it.

## Plan

`quest` sends the records since
[moq-dev/quest#718](https://github.com/moq-dev/quest/pull/718): it posts
`{"records": [...]}`, each a `SessionRecord` from `quest/core`, with the
user's token as a bearer token, and takes a 401 or 403 as no access.

- Commit `.quest.json` here first, then in each repository the benchmark
  covers, with the endpoint's final URL.
- Put the token on each host, and start its sender with `quest records
  install`, through kixel-ai/dotfiles, which owns the
  maintainer's host configuration, not by hand.

## Waiting

- kixel-ai/kixel.quest: its record store serves an endpoint that stores
  `quest`'s upload with `parseUpload`, keeps each session's latest upload,
  refuses a token it did not issue
  with 401 or 403, and it says how a person gets a token; check that its
  `quest/m0/records.md` is gone from its tree
