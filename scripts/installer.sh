#!/bin/sh
# Install the Quest release binary for this machine.
#
# The Release workflow publishes this as quest-installer.sh with its tag filled
# in. The binary goes to QUEST_INSTALL_DIR (default ~/.local/bin); no shell
# configuration is edited. QUEST_DOWNLOAD_URL replaces the release's download
# URL, for a mirror or a local copy.
set -eu

tag='@TAG@'

# Everything runs from main, so a truncated download runs nothing.
main() {
    fail() {
        printf 'quest-installer: %s\n' "$*" >&2
        exit 1
    }

    case $tag in
        v*) default_url="https://github.com/moq-dev/quest/releases/download/$tag" ;;
        *) default_url= ;;
    esac
    base=${QUEST_DOWNLOAD_URL:-$default_url}
    [ -n "$base" ] || fail 'this is the unreleased template; run quest-installer.sh from a release'
    dir=${QUEST_INSTALL_DIR:-${HOME:?}/.local/bin}

    os=$(uname -s)
    arch=$(uname -m)
    # A shell under Rosetta reports x86_64 on Apple silicon; install the native build.
    if [ "$os/$arch" = Darwin/x86_64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
        arch=arm64
    fi
    case "$os/$arch" in
        Linux/x86_64) target=x86_64-unknown-linux-gnu ;;
        Linux/aarch64 | Linux/arm64) target=aarch64-unknown-linux-gnu ;;
        Darwin/x86_64) target=x86_64-apple-darwin ;;
        Darwin/arm64) target=aarch64-apple-darwin ;;
        *) fail "no release binary for $os/$arch" ;;
    esac
    archive=quest-$target.tar.gz

    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    for file in "$archive" SHA256SUMS; do
        curl --proto '=https,file' --proto-redir '=https' --tlsv1.2 -fLsS "$base/$file" -o "$work/$file" ||
            fail "could not download $base/$file"
    done

    expected=$(awk -v name="$archive" '$2 == name { print $1 }' "$work/SHA256SUMS")
    if command -v sha256sum >/dev/null 2>&1; then
        actual=$(sha256sum "$work/$archive")
    else
        actual=$(shasum -a 256 "$work/$archive")
    fi
    actual=${actual%% *}
    [ -n "$expected" ] && [ "$expected" = "$actual" ] || fail "checksum mismatch for $archive"

    tar -xzf "$work/$archive" -C "$work" quest
    # Check the binary runs here before it replaces a working install.
    version=$("$work/quest" --version) || fail "the $target binary does not run on this machine"
    mkdir -p "$dir"
    # Replace any existing binary in one rename, so a running quest is never half-written.
    cp "$work/quest" "$dir/.quest.tmp"
    chmod 755 "$dir/.quest.tmp"
    mv -f "$dir/.quest.tmp" "$dir/quest"

    printf 'Installed %s (%s)\n' "$dir/quest" "$version"
    case ":$PATH:" in
        *":$dir:"*) ;;
        *) printf 'Add %s to PATH to run quest.\n' "$dir" ;;
    esac
}

main "$@"
