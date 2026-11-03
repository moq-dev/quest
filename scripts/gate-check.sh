#!/usr/bin/env bash
# Check that an installed CLI's gate admits a lone command, however loaded the
# host, and owns its command's descendants. Inside another gate or Quest scope
# the enclosing owner holds them instead, so CI runs this on its own rather than
# from `just test`.
set -euo pipefail

binary=${1:?usage: gate-check.sh /absolute/path/to/quest}
unset QUEST_GATE_ADMITTED
work=$(mktemp -d "${TMPDIR:-/tmp}/quest-gate.XXXXXX")
trap 'rm -rf "$work"' EXIT
cd "$work"

# Gone, or a zombie its new parent has not reaped yet: either way it runs no code.
stopped() {
    local state
    state=$(ps -o stat= -p "$1") || return 0
    [[ $state == Z* ]]
}

# Waits up to 10 seconds for a file to appear or a process to stop.
until_true() {
    local tries
    for ((tries = 0; tries < 100; tries++)); do
        "$@" && return 0
        sleep 0.1
    done
    return 1
}

expect_stopped() {
    if ! until_true stopped "$1"; then
        echo "quest gate left $2 (PID $1) running" >&2
        kill -KILL "$1"
        exit 1
    fi
}

# The load this ran under, which a fresh hosted macOS runner holds above its CPUs.
uptime

status=0
"$binary" gate sh -c 'sleep 1000 & echo $! > orphan; exit 7' || status=$?
if ((status != 7)); then
    echo "quest gate exited $status, not the command's 7" >&2
    exit 1
fi
expect_stopped "$(cat orphan)" 'a descendant after its command exited'

"$binary" gate sh -c 'sleep 1000 & echo $! > grandchild; : > ready; wait' &
gate=$!
if ! until_true test -e ready; then
    echo 'the gated command never started' >&2
    exit 1
fi
kill -TERM "$gate"
status=0
wait "$gate" || status=$?
if ((status != 143)); then
    echo "a cancelled quest gate exited $status, not 143" >&2
    exit 1
fi
expect_stopped "$(cat grandchild)" 'a grandchild after cancellation'

echo 'quest gate: exit status and descendant ownership passed'
