#!/usr/bin/env bash
# Offline regressions for Release's plan: what ships, and the next version.
set -euo pipefail

plan="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/release-plan.sh"
work=$(mktemp -d "${TMPDIR:-/tmp}/quest-release-plan-test.XXXXXX")
trap 'rm -rf "$work"' EXIT

fail() {
    printf 'release-plan: %s\n' "$*" >&2
    exit 1
}
expect() {
    local want=$1 got
    shift
    got=$(bash "$plan" "$@")
    [[ $got == "$want" ]] || fail "$* printed '${got//$'\n'/ }', not '${want//$'\n'/ }'"
}

for path in src/cli/main.ts assets/skills/x/SKILL.md nix/package.nix scripts/installer.sh package.json \
    bun.lock bunfig.toml tsconfig.json flake.nix flake.lock .github/workflows/release.yml \
    .github/workflows/install-check.yml .github/workflows/gate-macos.yml; do
    bash "$plan" ships <<<"$path" || fail "$path should ship"
done
for path in README.md quest/m0/x.md test/cli.test.ts docs/windows.md .github/workflows/check.yml \
    package.json.bak srcs/x.ts; do
    if bash "$plan" ships <<<"$path"; then fail "$path should not ship"; fi
done
printf 'README.md\nsrc/cli/main.ts\n' | bash "$plan" ships || fail 'a list with one shipping path should ship'

git init --quiet "$work/repo"
cd "$work/repo"
git config user.name test
git config user.email test@example.com
commit() {
    mkdir -p "$(dirname -- "$1")"
    echo "$RANDOM" >>"$1"
    git add "$1"
    git commit --quiet -m "$2"
}

# Nothing released or tagged yet.
commit README.md 'docs: start'
expect $'version=0.0.1\nrelease=false' next '' HEAD
commit src/a.ts 'feat: ship'
expect $'version=0.0.1\nrelease=true' next '' HEAD

git tag v0.1.0
expect $'version=0.1.1\nrelease=false' next v0.1.0 HEAD
commit README.md 'feat(docs)!: only docs'
expect $'version=0.2.0\nrelease=false' next v0.1.0 HEAD
commit assets/x.md 'fix(skills): ship a skill'
expect $'version=0.2.0\nrelease=true' next v0.1.0 HEAD

# A tag whose release never published is skipped, as are prerelease and odd tags.
git tag v0.2.0
git tag v0.9.0-rc.1
git tag vnext
expect $'version=0.3.0\nrelease=true' next v0.1.0 HEAD
commit src/b.ts 'fix: patch'
expect $'version=0.2.1\nrelease=true' next v0.2.0 HEAD
commit src/b.ts 'refactor!: break'
expect $'version=0.3.0\nrelease=true' next v0.1.0 HEAD

# A release at or past the head leaves nothing to release.
git tag v0.3.0
expect $'version=0.3.1\nrelease=false' next v0.3.0 HEAD
expect $'version=0.3.1\nrelease=false' next v0.3.0 HEAD~1

# A subject merely mentioning `!` is not breaking; after 1.0, `!` bumps the major.
git tag v1.4.2
commit src/c.ts 'fix: handle "a!: b"'
expect $'version=1.4.3\nrelease=true' next v1.4.2 HEAD
commit nix/package.nix 'build(nix)!: change'
expect $'version=2.0.0\nrelease=true' next v1.4.2 HEAD

# Moving a file out of a shipping path ships, though git would report only the destination.
git tag v2.0.0
mkdir -p docs && git mv src/c.ts docs/c.ts
git commit --quiet -m 'docs: move'
expect $'version=2.0.1\nrelease=true' next v2.0.0 HEAD

if bash "$plan" next v1.4.2 2>/dev/null; then fail 'a missing head should be a usage error'; fi

echo 'release plan: shipping paths and next versions passed'
