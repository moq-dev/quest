set shell := ["bash", "-euo", "pipefail", "-c"]

# List the available development commands.
default:
    @just --list

# Install the locked dependencies.
install:
    bun install --frozen-lockfile

# Expensive recipes wait for host room through `quest gate`; nested calls run at once.
gate := "bun run --silent quest gate just"

# Check code, repository tooling, and the quest tree.
check:
    {{gate}} _check

_check:
    bun run check
    bun run --silent quest check
    bun run --silent quest --root examples/export check
    actionlint
    shellcheck scripts/*.sh
    shfmt -d scripts/*.sh
    nixfmt --check flake.nix nix/*.nix

# Run tests, including the install scripts and the lifecycle of both builds.
test:
    {{gate}} _test

_test:
    bun run test
    bash scripts/install-check.test.sh
    bash scripts/installer.test.sh
    bun run build
    bash scripts/lifecycle-check.sh "$PWD/dist/quest.js"
    bun run compile
    bash scripts/lifecycle-check.sh "$PWD/dist/quest"

# Check that `quest review` runs nothing a reviewed head plants, with the real
# Codex and Claude Code CLIs. Uses each CLI's login and spends its usage; run it
# after upgrading either CLI. Arguments go to vitest, such as `-t codex`.
review-sandbox *args:
    QUEST_LIVE=1 bun run vitest run test/live/review-sandbox {{args}}

# Apply formatters without changing program behavior.
fix:
    bun run fix
    shfmt -w scripts/*.sh
    nixfmt flake.nix nix/*.nix

# Build the bundled CLI into dist/quest.js.
build:
    bun run build

# Compile a standalone binary for this machine into dist/quest.
compile:
    bun run compile

# Run the local CLI, for example `just run ready`.
run *args:
    bun run --silent quest {{args}}
