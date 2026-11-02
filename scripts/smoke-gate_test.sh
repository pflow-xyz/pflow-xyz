#!/usr/bin/env bash
# smoke-gate.sh's whole job is to report a smoke's own exit status, so that is what this holds it to, with a stand-in
# for deno: no Chrome or server is needed, so it runs in `make test`.
set -u
cd "$(dirname "$0")/.."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cat >"$tmp/deno" <<'STUB'
#!/usr/bin/env bash
echo "stand-in: $3"
case "$3" in
  *landing*) echo "landing output"; exit "${LANDING_RC:-0}" ;;
  *menu*) echo "menu output"; exit "${MENU_RC:-0}" ;;
  *palette*) echo "palette output"; exit "${PALETTE_RC:-0}" ;;
  *) exit "${VIEWS_RC:-0}" ;;
esac
STUB
chmod +x "$tmp/deno"

fails=0
expect() { # want, what, env...
  local want="$1" what="$2"; shift 2
  env PATH="$tmp:$PATH" TMPDIR="$tmp" CHROME=/bin/true "$@" scripts/smoke-gate.sh http://127.0.0.1:1/ >"$tmp/out" 2>&1
  local got=$?
  if [ "$got" -ne "$want" ]; then fails=$((fails + 1)); echo "FAIL $what: exit $got, wanted $want"; cat "$tmp/out"; fi
}
expect 0 "every smoke passes"
expect 1 "the first smoke fails" LANDING_RC=1
expect 1 "only the last smoke fails" VIEWS_RC=1
expect 1 "a smoke crashes (any non-zero status)" LANDING_RC=134
expect 2 "an unknown smoke" SMOKES=nonsense
expect 1 "a failure is followed by a pass" LANDING_RC=1 VIEWS_RC=0
expect 1 "the menu smoke fails" MENU_RC=1
expect 1 "the palette smoke fails" PALETTE_RC=1
expect 0 "the menu smoke alone, passing" SMOKES=menu
expect 1 "the menu smoke alone, failing" SMOKES=menu MENU_RC=1
expect 0 "the palette smoke alone, passing" SMOKES=palette
[ "$fails" -eq 0 ] && echo "smoke-gate: ok" || exit 1
