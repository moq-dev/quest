# [S] Start the sandbox on stock Ubuntu

## Goal

A runner started from an ordinary terminal on Ubuntu 23.10 or later runs
sandboxed jobs, or refuses to start with an explanation, instead of failing
each job.

## Plan

Found on [moq-dev/quest#212](https://github.com/moq-dev/quest/pull/212):
Ubuntu's AppArmor restriction on unprivileged user namespaces made the system
`/usr/bin/bwrap` fail. The Nix-pinned bwrap worked only because that process
tree ran under the Claude desktop app's profile, which allows them.

- Document an AppArmor profile for the runner's pinned bwrap.
- At startup, when a Claude Code account needs the sandbox, run a trivial
  sandboxed command and refuse with the profile's install hint if it fails.
- Test on a stock Ubuntu image, from a normal login shell.
