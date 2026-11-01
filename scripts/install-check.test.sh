#!/usr/bin/env bash
# Offline regressions for tag selection, native targets and fresh installations.
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/quest-install-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/tmp"
export RUNNER_TEMP="$work/tmp"
export INSTALL_TEST_LOG="$work/log"
export PATH="$work/bin:$PATH"
export INSTALL_TEST_OS=Linux INSTALL_TEST_ARCH=x86_64
export INSTALL_TEST_VERSION='quest 0.1.0'

cat >"$work/bin/uname" <<'MOCK'
#!/usr/bin/env bash
case "$1" in
  -s) echo "$INSTALL_TEST_OS" ;;
  -m) echo "$INSTALL_TEST_ARCH" ;;
  *) exit 1 ;;
esac
MOCK
cat >"$work/bin/mise" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  use)
    [[ $2 == --pin && $3 == github:moq-dev/quest@v0.1.0 ]]
    [[ ! -e $MISE_DATA_DIR && ! -e $MISE_CACHE_DIR && ! -e $MISE_CONFIG_DIR ]]
    [[ $PWD == "$RUNNER_TEMP"/quest-install.*/project ]]
    printf '%s\n' "mise $3" >> "$INSTALL_TEST_LOG"
    if [[ ${INSTALL_TEST_MISSING:-0} == 1 ]]; then exit 0; fi
    mkdir -p "$MISE_DATA_DIR/installs/quest"
    cat > "$MISE_DATA_DIR/installs/quest/quest" <<'QUEST'
#!/usr/bin/env bash
[[ $1 == --version ]] || exit 1
printf '%s\n' "$INSTALL_TEST_VERSION"
QUEST
    chmod +x "$MISE_DATA_DIR/installs/quest/quest"
    ;;
  which)
    if [[ ${INSTALL_TEST_FALLBACK:-0} == 1 ]]; then
      echo "$RUNNER_TEMP/stale-quest"
    else
      echo "$MISE_DATA_DIR/installs/quest/quest"
    fi
    ;;
  *) exit 1 ;;
esac
MOCK
cat >"$work/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ $1 == --proto && $2 == =https && $3 == --tlsv1.2 && $4 == -fLsS ]]
[[ $5 == https://github.com/moq-dev/quest/releases/download/v0.1.0/quest-installer.sh && $6 == -o ]]
printf '%s\n' "shell $5" >> "$INSTALL_TEST_LOG"
if [[ ${INSTALL_TEST_DOWNLOAD_FAIL:-0} == 1 ]]; then exit 22; fi
cat > "$7" <<'INSTALLER'
#!/bin/sh
set -eu
if [ "${INSTALL_TEST_MISSING:-0}" = 1 ]; then exit 0; fi
mkdir -p "$QUEST_INSTALL_DIR"
cat > "$QUEST_INSTALL_DIR/quest" <<'QUEST'
#!/usr/bin/env bash
[[ $1 == --version ]] || exit 1
printf '%s\n' "$INSTALL_TEST_VERSION"
QUEST
chmod +x "$QUEST_INSTALL_DIR/quest"
INSTALLER
MOCK
# The installed binary's architecture: the runner's own unless a test overrides it.
cat >"$work/bin/file" <<'MOCK'
#!/usr/bin/env bash
[[ $1 == -bL ]]
case "$INSTALL_TEST_OS/${INSTALL_TEST_INSTALLED_ARCH:-$INSTALL_TEST_ARCH}" in
  Linux/x86_64) echo 'ELF 64-bit LSB executable, x86-64, version 1 (SYSV)' ;;
  Linux/aarch64) echo 'ELF 64-bit LSB executable, ARM aarch64, version 1 (SYSV)' ;;
  Darwin/arm64) echo 'Mach-O 64-bit executable arm64' ;;
  Darwin/x86_64) echo 'Mach-O 64-bit executable x86_64' ;;
  *) echo data ;;
esac
MOCK
# A system Quest must never be used as a substitute for a missing installation.
cat >"$work/bin/quest" <<'MOCK'
#!/bin/sh
exit 99
MOCK
chmod +x "$work/bin/"*

check() {
    local status=0
    bash "$script_dir/install-check.sh" "$@" >"$work/output" 2>&1 || status=$?
    [[ -z $(ls -A "$work/tmp") ]] || {
        echo 'Install directory was not cleaned up' >&2
        exit 1
    }
    return "$status"
}
reject() {
    if check "$@"; then
        echo "Expected install check to fail: $*" >&2
        exit 1
    fi
    [[ -z $(ls -A "$work/tmp") ]]
}

# Each installer installs the requested tag.
export RELEASE_TAG=v0.1.0
check mise x86_64-unknown-linux-gnu
check shell x86_64-unknown-linux-gnu
(($(wc -l <"$work/log") == 2))

# Incorrect/missing output and failed downloads must turn the job red.
export INSTALL_TEST_VERSION='quest 0.0.9'
reject mise x86_64-unknown-linux-gnu
reject shell x86_64-unknown-linux-gnu
export INSTALL_TEST_VERSION=''
reject mise x86_64-unknown-linux-gnu
reject shell x86_64-unknown-linux-gnu
export INSTALL_TEST_VERSION='quest 0.1.0'
export INSTALL_TEST_MISSING=1
reject mise x86_64-unknown-linux-gnu
reject shell x86_64-unknown-linux-gnu
unset INSTALL_TEST_MISSING
export INSTALL_TEST_FALLBACK=1
reject mise x86_64-unknown-linux-gnu
unset INSTALL_TEST_FALLBACK
export INSTALL_TEST_DOWNLOAD_FAIL=1
reject shell x86_64-unknown-linux-gnu
unset INSTALL_TEST_DOWNLOAD_FAIL

# Invalid inputs fail before either installer is invoked.
log_lines=$(wc -l <"$work/log")
for tag in '' '../v0.1.0' 'v0.1' 'latest'; do
    export RELEASE_TAG="$tag"
    reject shell x86_64-unknown-linux-gnu
done
export RELEASE_TAG=v0.1.0
reject unknown x86_64-unknown-linux-gnu
reject shell aarch64-unknown-linux-gnu
(($(wc -l <"$work/log") == log_lines))

# Enforce native Linux/macOS architecture for all matrix targets.
export INSTALL_TEST_ARCH=aarch64
check shell aarch64-unknown-linux-gnu
export INSTALL_TEST_OS=Darwin INSTALL_TEST_ARCH=arm64
check shell aarch64-apple-darwin
export INSTALL_TEST_ARCH=x86_64
check shell x86_64-apple-darwin

# A binary for the wrong architecture fails, even where Rosetta would run it.
export INSTALL_TEST_ARCH=arm64 INSTALL_TEST_INSTALLED_ARCH=x86_64
reject mise aarch64-apple-darwin
grep -qF 'is not built for aarch64-apple-darwin: Mach-O 64-bit executable x86_64' "$work/output"
reject shell aarch64-apple-darwin
grep -qF 'is not built for' "$work/output"
export INSTALL_TEST_OS=Linux INSTALL_TEST_ARCH=x86_64 INSTALL_TEST_INSTALLED_ARCH=aarch64
reject mise x86_64-unknown-linux-gnu
grep -qF 'is not built for' "$work/output"
unset INSTALL_TEST_INSTALLED_ARCH
check mise x86_64-unknown-linux-gnu
export INSTALL_TEST_OS=Windows
reject shell x86_64-apple-darwin

echo 'release install check: regression tests passed'
