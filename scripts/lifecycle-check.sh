#!/usr/bin/env bash
# Exercise an installed CLI in fresh repositories without remote writes.
set -euo pipefail

binary=${1:?usage: lifecycle-check.sh /absolute/path/to/quest expected-version}
version=${2:?usage: lifecycle-check.sh /absolute/path/to/quest expected-version}
case "$binary" in
    /*) ;;
    *)
        echo 'Expected an absolute path to the installed binary' >&2
        exit 1
        ;;
esac
"$binary" --version
work=$(mktemp -d "${TMPDIR:-/tmp}/quest-lifecycle.XXXXXX")
trap 'rm -rf "$work"' EXIT

# The shared lifecycle is also run directly by native Windows CI. It runs the
# binary in place, so give it a path with spaces.
mkdir "$work/tool bin"
cp "$binary" "$work/tool bin/"
bun "$(dirname -- "${BASH_SOURCE[0]}")/lifecycle-check.mjs" "$work/tool bin/$(basename -- "$binary")" "$version"

# A reader that closes stdout early, like `quest unblocked | head -1`, ends the
# command quietly. The writer waits on a FIFO until the reader has closed, so
# every write fails with EPIPE rather than racing into the pipe buffer.
mkfifo "$work/reader-closed"
for command in guide skill; do
    status=0
    { read -r <"$work/reader-closed" && "$binary" "$command" 2>"$work/epipe"; } |
        { exec <&- && echo >"$work/reader-closed"; } || status=$?
    if ((status != 0)) || [[ -s $work/epipe ]]; then
        printf 'quest %s exited %d when stdout closed early; stderr:\n' "$command" "$status" >&2
        cat "$work/epipe" >&2
        exit 1
    fi
done

# A gated command gets the environment its caller started Quest with, never the
# working directory's `.env` files, which Bun loads by default.
mkdir "$work/dotenv"
for file in .env .env.development .env.local; do
    printf 'QUEST_DOTENV_LEAK=%s\n' "$file" >"$work/dotenv/$file"
done
seen=$(cd "$work/dotenv" && QUEST_DOTENV_CALLER=kept "$binary" gate --quick env)
if [[ $seen == *QUEST_DOTENV_LEAK=* || $seen != *QUEST_DOTENV_CALLER=kept* ]]; then
    echo "quest gate passed its working directory's .env files to its command, or dropped its caller's environment:" >&2
    grep '^QUEST_DOTENV_' <<<"$seen" >&2
    exit 1
fi

echo 'quest lifecycle: fresh repositories, ownership, conflict refusal, early-closed stdout, and .env isolation passed'
