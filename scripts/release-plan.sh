#!/usr/bin/env bash
# Plan a Release run from git alone, so each of its decisions is testable offline.
#
#   release-plan.sh ships
#       Read paths on stdin; exit 0 when any changes what a release ships.
#   release-plan.sh next <released> <head>
#       Print `version=X.Y.Z`, the release after every vX.Y.Z tag, and
#       `release=true` or `release=false`: whether the commits in
#       <released>..<head> change what a release ships. An empty <released>
#       means nothing is released yet, so every commit up to <head> counts.
set -euo pipefail

usage() {
    echo 'usage: release-plan.sh ships | release-plan.sh next <released-tag-or-empty> <head>' >&2
    exit 2
}

# What a release ships or is built and checked by: everything the binaries and
# the flake package build from (`assets/` is bundled into the binary), every
# file Release publishes, such as `scripts/installer.sh`, and the workflows that
# build, check, and publish it. Release's pull request runs and its releases on
# `main` both decide with this one predicate.
ships() {
    grep -E '^(src/|assets/|nix/|scripts/|package\.json$|bun\.lock$|bunfig\.toml$|tsconfig\.json$|flake\.(nix|lock)$|\.github/workflows/(release|gate-macos|install-check)\.yml$)' >/dev/null
}

next() {
    local released=$1 head=$2 range latest major minor patch
    range=$head
    if [[ -n $released ]]; then range="$released..$head"; fi
    # Greater than every tag, even one whose release never published.
    latest=$(git tag -l 'v*' | { grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true; } | sort -V | tail -n 1)
    IFS=. read -r major minor patch <<<"${latest#v}"
    major=${major:-0} minor=${minor:-0} patch=${patch:-0}
    # A conventional commit subject with `!` before its colon breaks compatibility.
    if git log --format=%s "$range" | grep -E '^[A-Za-z]+(\([^)]*\))?!:' >/dev/null; then
        if ((major == 0)); then
            minor=$((minor + 1))
        else
            major=$((major + 1)) minor=0
        fi
        patch=0
    else
        patch=$((patch + 1))
    fi
    echo "version=$major.$minor.$patch"
    if git log --format= --name-only --no-renames "$range" | ships; then
        echo release=true
    else
        echo release=false
    fi
}

case "${1:-}" in
    ships)
        (($# == 1)) || usage
        ships
        ;;
    next)
        (($# == 3)) || usage
        next "$2" "$3"
        ;;
    *) usage ;;
esac
