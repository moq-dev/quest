# [XS] The land daemon's lock tests pass on macOS

## Goal

`just test` in the dev shell on macOS passes `test/land.test.ts`'s
`host daemon` lock tests, which fail there today.

## Plan

Found 2026-11-28 while validating the land fixer tests on a macOS host: three
tests ("holds one OS lock per checkout and releases it", "shares the
repository lock across linked worktrees", "starts one daemon per base from one
checkout and refuses a second on the same base") fail with `Executable not
found in $PATH: "flock"`. `lockCheckout` in `src/cli/land-daemon.ts` spawns
`flock --nonblock`, and `flake.nix` adds `util-linux`, which ships it, only on
Linux.

Recommended: add nixpkgs' portable `flock` to the dev shell on Darwin, after
checking that it supports `--nonblock` and holds the lock the way
`lockCheckout` expects, so the tests keep exercising the real lock. If it
cannot, skip the `host daemon` cases off Linux, since the watcher daemon runs
on a Linux host.

## Hosts

- macos - where the tests fail
