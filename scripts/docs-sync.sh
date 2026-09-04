#!/usr/bin/env bash
#
# docs-sync.sh — keep prose vendored from go-pflow honest.
#
# go-pflow/docs/engine-selection.md is the canonical "which engine for
# which question" page. This repo carries its own copy because each repo
# is read on its own — a doc that says "see go-pflow" is a doc nobody
# reads — but the copies must never diverge from the source they claim to
# be. Same shape as the ecosystem's shared-JS contract
# (scripts/pflow-js.sh in bitwrap-io/stackedup-gg): a lock file records a
# sha256 per vendored file plus the go-pflow commit it came from.
#
#   ./scripts/docs-sync.sh check   verify each vendored file still matches
#                                  the sha256 in docs.lock. Offline, no
#                                  go-pflow checkout needed.
#   ./scripts/docs-sync.sh sync    re-copy from a go-pflow checkout and
#                                  rewrite the lock. Point at it with
#                                  GO_PFLOW=...; defaults to ../go-pflow.
#   ./scripts/docs-sync.sh status  report staleness without changing
#                                  anything.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="$REPO_ROOT/docs.lock"
GO_PFLOW="${GO_PFLOW:-$REPO_ROOT/../go-pflow}"

die() { printf '%s\n' "$*" >&2; exit 1; }
sha() { sha256sum "$1" | cut -d' ' -f1; }

[[ -f "$LOCK" ]] || die "docs-sync.sh: no $LOCK"
rows() { grep -vE '^\s*(#|$)' "$LOCK"; }

cmd="${1:-check}"

case "$cmd" in
check)
    fail=0
    while read -r want_sha local_path upstream_path; do
        f="$REPO_ROOT/$local_path"
        [[ -f "$f" ]] || { echo "MISSING $local_path"; fail=1; continue; }
        got_sha="$(sha "$f")"
        if [[ "$got_sha" != "$want_sha" ]]; then
            echo "STALE $local_path (want $want_sha, got $got_sha)"
            fail=1
        fi
    done < <(rows)
    [[ $fail -eq 0 ]] && echo "docs-sync: all vendored docs match docs.lock"
    exit $fail
    ;;
status)
    [[ -d "$GO_PFLOW" ]] || die "docs-sync.sh: no go-pflow checkout at $GO_PFLOW"
    while read -r want_sha local_path upstream_path; do
        up="$GO_PFLOW/$upstream_path"
        [[ -f "$up" ]] || { echo "$local_path: upstream $upstream_path missing"; continue; }
        up_sha="$(sha "$up")"
        if [[ "$up_sha" == "$want_sha" ]]; then
            echo "$local_path: in sync"
        else
            echo "$local_path: STALE — upstream is $up_sha, locked at $want_sha"
        fi
    done < <(rows)
    ;;
sync)
    [[ -d "$GO_PFLOW" ]] || die "docs-sync.sh: no go-pflow checkout at $GO_PFLOW"
    commit="$(git -C "$GO_PFLOW" rev-parse HEAD)"
    dirty=""
    git -C "$GO_PFLOW" diff --quiet || dirty="-dirty"
    tmp="$(mktemp)"
    echo "# docs.lock — prose vendored from go-pflow." >"$tmp"
    echo "#" >>"$tmp"
    echo "# DO NOT EDIT THE VENDORED FILES IN THIS REPO. Change them in go-pflow" >>"$tmp"
    echo "# and re-run ./scripts/docs-sync.sh sync. 'check' fails the build otherwise." >>"$tmp"
    echo "#" >>"$tmp"
    echo "# source: github.com/pflow-xyz/go-pflow @ ${commit}${dirty}" >>"$tmp"
    echo "#" >>"$tmp"
    echo "# <sha256>  <path in this repo>  <path in go-pflow>" >>"$tmp"
    while read -r _ local_path upstream_path; do
        up="$GO_PFLOW/$upstream_path"
        [[ -f "$up" ]] || die "docs-sync.sh: upstream $upstream_path not found"
        mkdir -p "$(dirname "$REPO_ROOT/$local_path")"
        cp "$up" "$REPO_ROOT/$local_path"
        echo "$(sha "$up")  $local_path  $upstream_path" >>"$tmp"
    done < <(rows)
    mv "$tmp" "$LOCK"
    echo "docs-sync: synced from go-pflow @ ${commit}${dirty}"
    ;;
*)
    die "docs-sync.sh: unknown command '$cmd' (check|sync|status)"
    ;;
esac
