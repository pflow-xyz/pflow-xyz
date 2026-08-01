#!/usr/bin/env bash
#
# pflow-js.sh — keep JS vendored from pflow-xyz honest.
#
# pflow-xyz/public is the canonical source for the shared browser modules
# (petri-sim.js, petri-solver.js, petri-colors.js, petri-view.js, seal-cid.mjs
# and the jsonld vendor bundle). Several repos serve their own copy because
# each embeds its own static assets — so the files must be duplicated on disk,
# but they must never be duplicated *divergently*.
#
# They have diverged before, silently and expensively: a copy of petri-sim.js
# sat 57 lines behind for months, still coercing a [0,2] arc weight to [1,2],
# which makes "this color is not involved" unexpressible. Nothing failed,
# because nothing compared.
#
# This script is that comparison.
#
#   ./scripts/pflow-js.sh check   verify each vendored file still matches the
#                                 sha256 recorded in pflow-js.lock. Offline,
#                                 no network, no pflow-xyz checkout needed —
#                                 safe to run in CI. Catches local edits.
#
#   ./scripts/pflow-js.sh sync    re-copy from a pflow-xyz checkout and rewrite
#                                 the lock. Point at it with PFLOW_XYZ=...;
#                                 defaults to ../pflow-xyz.
#
#   ./scripts/pflow-js.sh status  report how the vendored copies compare to a
#                                 pflow-xyz checkout without changing anything.
#
# The lock records the upstream commit each sync came from, so "how stale are
# we" is answerable from the repo alone.
#
# To vendor a new file, add a row to pflow-js.lock with any sha256 and run
# `sync`. To stop vendoring one, delete its row and the file.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="$REPO_ROOT/pflow-js.lock"
PFLOW_XYZ="${PFLOW_XYZ:-$REPO_ROOT/../pflow-xyz}"

die() { printf '%s\n' "$*" >&2; exit 1; }

sha() { sha256sum "$1" | cut -d' ' -f1; }

[[ -f "$LOCK" ]] || die "pflow-js.sh: no $LOCK"

# Rows are: <sha256> <local path> <upstream path>. Comments and blanks skipped.
rows() { grep -vE '^\s*(#|$)' "$LOCK"; }

cmd_check() {
    local fail=0 n=0
    while read -r want local_path _; do
        n=$((n + 1))
        local full="$REPO_ROOT/$local_path"
        if [[ ! -f "$full" ]]; then
            printf '  MISSING  %s\n' "$local_path"; fail=1; continue
        fi
        local got; got="$(sha "$full")"
        if [[ "$got" != "$want" ]]; then
            printf '  MODIFIED %s\n' "$local_path"
            printf '           locked %s\n           actual %s\n' "${want:0:16}" "${got:0:16}"
            fail=1
        fi
    done < <(rows)

    if (( fail )); then
        cat >&2 <<EOF

These files are vendored from pflow-xyz and must not be edited here.
Change them in pflow-xyz, then: ./scripts/pflow-js.sh sync

If you already synced, commit the updated pflow-js.lock too.
EOF
        exit 1
    fi
    printf 'pflow-js: %d vendored file(s) match pflow-js.lock\n' "$n"
}

cmd_sync() {
    [[ -d "$PFLOW_XYZ" ]] || die "pflow-js.sh: no pflow-xyz checkout at $PFLOW_XYZ (set PFLOW_XYZ=)"

    local commit changed=0
    commit="$(git -C "$PFLOW_XYZ" rev-parse HEAD 2>/dev/null || echo unknown)"
    if [[ -n "$(git -C "$PFLOW_XYZ" status --porcelain 2>/dev/null)" ]]; then
        printf 'warning: %s has uncommitted changes; the recorded commit %s will not describe what was copied\n' \
            "$PFLOW_XYZ" "${commit:0:12}" >&2
    fi

    local tmp; tmp="$(mktemp)"
    {
        printf '# pflow-js.lock — browser modules vendored from pflow-xyz.\n'
        printf '#\n'
        printf '# DO NOT EDIT THE VENDORED FILES IN THIS REPO. Change them in pflow-xyz and\n'
        printf '# re-run ./scripts/pflow-js.sh sync. `check` fails the build otherwise.\n'
        printf '#\n'
        printf '# source: github.com/pflow-xyz/pflow-xyz @ %s\n' "$commit"
        printf '#\n'
        printf '# <sha256>  <path in this repo>  <path in pflow-xyz>\n'
    } > "$tmp"

    while read -r old local_path upstream_path; do
        local src="$PFLOW_XYZ/$upstream_path" dst="$REPO_ROOT/$local_path"
        [[ -f "$src" ]] || die "pflow-js.sh: upstream missing: $src"
        mkdir -p "$(dirname "$dst")"
        if ! cmp -s "$src" "$dst" 2>/dev/null; then
            cp "$src" "$dst"
            printf '  updated  %s\n' "$local_path"
            changed=$((changed + 1))
        fi
        printf '%s  %s  %s\n' "$(sha "$dst")" "$local_path" "$upstream_path" >> "$tmp"
    done < <(rows)

    mv "$tmp" "$LOCK"
    printf 'pflow-js: synced from %s @ %s (%d file(s) changed)\n' "$PFLOW_XYZ" "${commit:0:12}" "$changed"
}

cmd_status() {
    [[ -d "$PFLOW_XYZ" ]] || die "pflow-js.sh: no pflow-xyz checkout at $PFLOW_XYZ (set PFLOW_XYZ=)"
    printf 'locked at: %s\n' "$(grep -m1 '^# source:' "$LOCK" | sed 's/^# source: //')"
    printf 'comparing against %s @ %s\n\n' "$PFLOW_XYZ" \
        "$(git -C "$PFLOW_XYZ" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    local drift=0
    while read -r _ local_path upstream_path; do
        if cmp -s "$PFLOW_XYZ/$upstream_path" "$REPO_ROOT/$local_path" 2>/dev/null; then
            printf '  up-to-date  %s\n' "$local_path"
        else
            printf '  STALE       %s\n' "$local_path"; drift=1
        fi
    done < <(rows)
    (( drift )) && printf '\nrun: ./scripts/pflow-js.sh sync\n'
    return 0
}

case "${1:-check}" in
    check)  cmd_check ;;
    sync)   cmd_sync ;;
    status) cmd_status ;;
    *) die "usage: pflow-js.sh [check|sync|status]" ;;
esac
