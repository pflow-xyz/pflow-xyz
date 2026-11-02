#!/usr/bin/env bash
# The browser smokes as a gate: run this before a push, and read its exit status.
#
#   scripts/smoke-gate.sh                       build this checkout, serve it on a scratch port and data dir, smoke it
#   scripts/smoke-gate.sh https://pflow.xyz/    smoke a server that is already running
#
# SMOKES (default "landing views menu palette links") picks which. CHROME overrides the browser.
#
# Why this exists: a hand-written `deno run ... | tail -3 || exit 1` tests tail, which always succeeds, so a smoke
# that crashed let a push through. Here nothing stands between a smoke and the line that reads its status, the full
# output goes to a file (a tail cut off the one stack trace that mattered), and the exit status is 1 if any smoke's
# was not 0. Do not pipe this script either, unless with `set -o pipefail`.
set -u
cd "$(dirname "$0")/.."

base="${1:-}"
logs="$(mktemp -d "${TMPDIR:-/tmp}/pflow-smoke.XXXXXX")"
export CHROME="${CHROME:-$(command -v google-chrome || command -v chromium || echo "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")}"

if [ -z "$base" ]; then
  make build >"$logs/build.log" 2>&1 || { cat "$logs/build.log"; echo "smoke-gate: the build failed"; exit 1; }
  port=$((20000 + RANDOM % 20000))
  # The key only turns the chat on, so the signed-out wording shows: the smoke answers every model call in the page.
  GEMINI_API_KEY=smoke-not-a-key ./bin/webserver -port "$port" -data "$logs/data" >"$logs/server.log" 2>&1 &
  server=$!
  trap 'kill "$server" 2>/dev/null' EXIT
  base="http://127.0.0.1:$port/"
  for _ in $(seq 1 100); do curl -fsS -o /dev/null "$base" 2>/dev/null && break; sleep 0.1; done
  curl -fsS -o /dev/null "$base" || { cat "$logs/server.log"; echo "smoke-gate: the server did not come up"; exit 1; }
fi

status=0
for smoke in ${SMOKES:-landing views menu palette links}; do
  case "$smoke" in
    landing) target="$base" ;;
    views) target="${base}compose.html" ;;
    menu) target="$base" ;;
    palette) target="$base" ;;
    links) target="$base" ;;
    *) echo "smoke-gate: no smoke called $smoke"; exit 2 ;;
  esac
  log="$logs/$smoke.log"
  deno run -A "scripts/$smoke-smoke.ts" "$target" >"$log" 2>&1
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "smoke-gate: $smoke passed: $(tail -n 1 "$log")"
  else
    status=1
    echo "smoke-gate: $smoke FAILED with exit status $rc against $target; full log: $log"
    grep -n 'FAIL' "$log" | head -n 40
    tail -n 25 "$log"
  fi
done
exit "$status"
