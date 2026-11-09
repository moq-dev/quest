#!/usr/bin/env bash
# Measure `quest gate` under contention. Run inside `nix develop`.
#
#   scripts/gate-bench.sh overhead [runs]
#       Admission cost: `quest gate true` with the gate bypassed, and admission
#       alone against a fresh ledger, so no earlier run counts as recent.
#   scripts/gate-bench.sh gated|ungated <suites> [cpus]
#       Start <suites> unit test suites at once, each in its own detached
#       worktree of HEAD, through the gate or bypassing it. `cpus` is a taskset
#       list that confines the suites to a few cores, to oversubscribe them
#       without saturating a shared host; the gate still sees host-wide load.
#
# Reports failed suites, 5-second test timeouts, admission waits, run times,
# the makespan, and the peak 1-minute load and CPU pressure and least available
# memory while the suites ran. Other work on the host counts too, so record the
# load printed first.
set -euo pipefail

root=$(git -C "$(dirname -- "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
unset QUEST_GATE_ADMITTED
work=$(mktemp -d "${TMPDIR:-/tmp}/quest-gate-bench.XXXXXX")
sampler=
cleanup() {
    [[ -z $sampler ]] || kill "$sampler" 2>/dev/null || true
    for tree in "$work"/tree.*; do
        [[ ! -d $tree ]] || git -C "$root" worktree remove --force "$tree"
    done
    rm -rf "$work"
}
trap cleanup EXIT

usage() {
    echo "usage: $0 overhead [runs] | $0 gated|ungated <suites> [cpus]" >&2
    exit 2
}

now_ms() { echo $((${EPOCHREALTIME/./} / 1000)); }

# Print `<name>_median=` and `<name>_max=` of the remaining arguments.
stats() {
    local name=$1
    shift
    printf '%s\n' "$@" | sort -n | awk -v n="$name" \
        '{ v[NR] = $1 } END { printf "%s_median=%d %s_max=%d ", n, v[int((NR + 1) / 2)], n, v[NR] }'
}

overhead() {
    local runs=${1:-20} i start bypass=() admit=()
    cd "$root"
    for ((i = 0; i < runs; i++)); do
        start=$(now_ms)
        QUEST_GATE_ADMITTED=1 bun run --silent quest gate true
        bypass+=($(($(now_ms) - start)))
    done
    # Every caller shares one ledger, so time admission itself against a fresh one per run.
    # shellcheck disable=SC2016 # Bun expands it.
    mapfile -t admit < <(BENCH_GATE="$root/src/cli/gate.ts" BENCH_WORK="$work" BENCH_RUNS="$runs" bun --eval '
        const { admit, fileHost, hostLimits } = await import(process.env.BENCH_GATE);
        for (let i = 0; i < Number(process.env.BENCH_RUNS); i++) {
            const start = performance.now();
            await admit(hostLimits(), fileHost(`${process.env.BENCH_WORK}/ledger.${i}`), new AbortController().signal);
            console.log(Math.round(performance.now() - start));
        }')
    echo "runs=$runs $(stats bypass_ms "${bypass[@]}")$(stats admit_ms "${admit[@]}")"
}

contend() {
    local mode=$1 suites=${2:-} cpus=${3:-} i start pin=() pids=()
    [[ $suites =~ ^[1-9][0-9]*$ ]] || usage
    [[ -z $cpus ]] || pin=(taskset -c "$cpus")

    for ((i = 0; i < suites; i++)); do
        git -C "$root" worktree add --quiet --detach "$work/tree.$i" HEAD
        (cd "$work/tree.$i" && bun install --frozen-lockfile >/dev/null)
    done

    echo "mode=$mode suites=$suites cpus=${cpus:-all} host_cpus=$(nproc --all) load_before=$(cut -d' ' -f1-3 /proc/loadavg)"
    start=$(now_ms)
    (
        while :; do
            printf '%s %s %s\n' "$(cut -d' ' -f1 /proc/loadavg)" \
                "$(sed -n 's/^some avg10=\([0-9.]*\).*/\1/p' /proc/pressure/cpu 2>/dev/null || echo 0)" \
                "$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)"
            sleep 1
        done
    ) >"$work/samples" &
    sampler=$!

    for ((i = 0; i < suites; i++)); do
        (
            cd "$work/tree.$i"
            begin=$(now_ms)
            [[ $mode == gated ]] || export QUEST_GATE_ADMITTED=1
            status=0
            # shellcheck disable=SC2016 # The admitted command expands it.
            "${pin[@]}" timeout 900 bun run --silent quest gate \
                bash -c 'echo $((${EPOCHREALTIME/./} / 1000)) >admitted; exec bun run test' \
                >log 2>&1 || status=$?
            echo "$begin $(cat admitted 2>/dev/null || echo "$begin") $(now_ms) $status" >result
        ) &
        pids+=($!)
    done
    wait "${pids[@]}"
    kill "$sampler"
    wait "$sampler" || true
    sampler=

    local failed=0 timeouts=0 waits=() runs=() last=0 begin admitted end status
    for ((i = 0; i < suites; i++)); do
        read -r begin admitted end status <"$work/tree.$i/result"
        ((status == 0)) || failed=$((failed + 1))
        timeouts=$((timeouts + $(grep -c 'timed out in [0-9]*ms' "$work/tree.$i/log" || true)))
        waits+=($((admitted - begin)))
        runs+=($((end - admitted)))
        ((end < last)) || last=$end
    done
    printf 'failed_suites=%d/%d test_timeouts=%d %s%s' "$failed" "$suites" "$timeouts" \
        "$(stats wait_ms "${waits[@]}")" "$(stats run_ms "${runs[@]}")"
    awk -v span=$((last - start)) '$1 > l { l = $1 } $2 > p { p = $2 } NR == 1 || $3 < m { m = $3 }
        END { printf "makespan_ms=%d peak_load1=%s peak_cpu_psi10=%s min_mem_available_gib=%.1f\n", span, l, p, m / 2^20 }' \
        "$work/samples"
    # The tests that failed most often, with how many suites they failed in.
    grep -h '^ *FAIL ' "$work"/tree.*/log | sed 's/^ *//' | sort | uniq -c | sort -rn | head -n 10 || true
}

case ${1:-} in
    overhead) overhead "${@:2}" ;;
    gated | ungated) contend "$@" ;;
    *) usage ;;
esac
