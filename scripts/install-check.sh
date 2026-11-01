#!/usr/bin/env bash
# Check a published release without using an existing Quest or install cache.
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
method=${1:?usage: install-check.sh mise|shell target-triple}
target=${2:?usage: install-check.sh mise|shell target-triple}
tag=${RELEASE_TAG:-}
if [[ ! $tag =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]]; then
    printf 'Invalid release tag: %s\n' "$tag" >&2
    exit 1
fi
case "$method" in mise | shell) ;; *)
    echo "Unknown installer: $method" >&2
    exit 1
    ;;
esac
case "$(uname -s)/$(uname -m)" in
    Linux/x86_64) native_target=x86_64-unknown-linux-gnu ;;
    Linux/aarch64 | Linux/arm64) native_target=aarch64-unknown-linux-gnu ;;
    Darwin/x86_64) native_target=x86_64-apple-darwin ;;
    Darwin/arm64) native_target=aarch64-apple-darwin ;;
    *)
        echo 'Unsupported runner platform' >&2
        exit 1
        ;;
esac
if [[ $native_target != "$target" ]]; then
    printf 'Expected native %s runner, got %s\n' "$target" "$native_target" >&2
    exit 1
fi

work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/quest-install.XXXXXX")
trap 'rm -rf "$work"' EXIT
case "$method" in
    mise)
        # Run outside the checkout with fresh configuration, downloads and installs.
        export MISE_CONFIG_DIR="$work/config"
        export MISE_DATA_DIR="$work/data"
        export MISE_CACHE_DIR="$work/cache"
        mkdir -p "$work/project"
        cd "$work/project"
        mise use --pin "github:moq-dev/quest@$tag"
        binary=$(mise which quest)
        case "$binary" in
            "$MISE_DATA_DIR"/*) ;;
            *)
                echo "mise did not select the fresh install: $binary" >&2
                exit 1
                ;;
        esac
        ;;
    shell)
        curl --proto '=https' --tlsv1.2 -fLsS \
            "https://github.com/moq-dev/quest/releases/download/$tag/quest-installer.sh" \
            -o "$work/quest-installer.sh"
        QUEST_INSTALL_DIR="$work/shell" sh "$work/quest-installer.sh"
        binary="$work/shell/quest"
        ;;
esac
bash "$script_dir/arch-check.sh" "$binary" "$target"
actual=$("$binary" --version)
expected="quest ${tag#v}"
if [[ $actual != "$expected" ]]; then
    printf '%s installed %s; expected %s\n' "$method" "$actual" "$expected" >&2
    exit 1
fi
printf '%s (%s): %s\n' "$method" "$target" "$actual"
