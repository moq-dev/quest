# [S] The dev-shell hook allows only trusted, reviewed checkouts

## Goal

The maintainer's user-level dev-shell hook (`bin/dev-shell-hook` in
[kixelated/dotfiles](https://github.com/kixelated/dotfiles)) runs
`direnv allow` on its own only for a checkout of a repository the maintainer
trusts, at code that someone trusted reviewed or pushed. A fresh clone of any
other repository, a fork PR head, and a checkout whose dev-shell files differ
from the default branch still wait for a manual `direnv allow`, and the hook
says why on stderr.

## Plan

Found 2026-11-03 by CodeRabbit's review of
[moq-dev/quest#458](https://github.com/moq-dev/quest/pull/458#discussion_r4460595569)
and reproduced against `bin/dev-shell-hook` as merged in
[kixelated/dotfiles#33](https://github.com/kixelated/dotfiles/pull/33)
(blob `679997db`). The hook approves an unapproved `.envrc` when `.envrc`,
`flake.nix`, and `flake.lock` match `refs/remotes/origin/HEAD`, which
it never fetches. Each case below ran from an isolated `XDG_DATA_HOME`:

- **Any repository's fresh clone:** `origin` is whatever was cloned, so its
  files match its own default branch by construction. A clone whose `.envrc`
  writes a file was allowed and ran. The hook runs in every Claude Code and
  Codex session, not just moq-dev's. A user-level hook also runs whether or
  not the project's own hooks are trusted.
- **A branch that changes another file the dev shell runs:** an `.envrc` that
  sources `dev/hook.sh`, on a branch that changes only `dev/hook.sh`, was
  allowed and ran the branch's script. moq-dev/moq.pro's dev shell has this
  shape: its `shellHook` inlines `builtins.readFile ./dev/mbx-shim.sh`. A fork
  PR head in a trusted clone is such a branch. The maintainer's moq clone
  keeps four contributor remotes.
- A changed `.envrc` was refused, as intended.

So the epic's claim that a fork PR head needs a manual allow does not hold.
The work is in kixelated/dotfiles: `bin/dev-shell-hook`, its docstring, and
the README that describes it.

## Waiting

- Maintainer: pick the hook's allow rule. An agent here can't edit the maintainer's live dotfiles without this choice. A: trust a repository by its identity and by who pushed the code. Auto-allow only when `git remote get-url origin` names a GitHub repository under an allowlisted owner (`moq-dev`, `kixelated`); HEAD is reachable from a branch on `origin` (`git for-each-ref --contains HEAD refs/remotes/origin/`), so someone with write access pushed it; tracked files have no uncommitted changes, submodules included; `.envrc` is tracked; and the three files still match `origin/HEAD`. This keeps fresh worktrees and `/quest-iterate` on write-access PR branches automatic, matching the guide's rule for running a PR's code (recommended). B: same identity check, but only when the tracked tree equals the merge base of HEAD and `origin/HEAD`, so only reviewed, merged code loads. Every session on a branch with changes then needs a manual allow, and once [repo-config](/quest/m0/user-dev-shell/repo-config.md) drops the `nix develop` instructions those sessions lose their documented fallback. C: identity check only, keeping today's three-file match. This closes third-party clones but still auto-allows a fork PR head whose diff touches only a file like moq.pro's `dev/mbx-shim.sh`. Done once the change is merged in kixelated/dotfiles and `bin/install-dev-shell.py` has run on every host that has the hook
