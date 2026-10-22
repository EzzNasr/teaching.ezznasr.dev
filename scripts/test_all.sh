#!/usr/bin/env bash
# Master test gate. EVERY patch goes through this before commit/push/deploy.
#
#   scripts/test_all.sh                 fast gate: syntax + registry (Node) + drift + lesson paths + orphan check
#   scripts/test_all.sh --e2e           also the Playwright browser tests (slow, ~2 min, needs `pip install playwright`)
#   scripts/test_all.sh --strict        release gate: also fails on pending/TODO registry entries and unregistered tests
#   scripts/test_all.sh --only R-E1     pass-through to the registry runner (id or prefix)
#   scripts/test_all.sh --install-hook  install a git pre-push hook that runs the fast gate (bypass: git push --no-verify)
#
# This wraps scripts/run_registry.js (tests/registry.json is still the single list of cases; see docs/REGRESSION.md).
# Adding a test = add its entry to registry.json. A test file that is not in the registry is reported here.
# Exit 0 = safe to ship. Anything else = do not.
set -u
SITE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QM="$SITE/tools/quiz-maker-v2"
cd "$SITE" || exit 2

E2E=0; STRICT=0; ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --e2e) E2E=1 ;;
    --strict) STRICT=1 ;;
    --only) ONLY="${2:-}"; shift ;;
    --install-hook)
      hook="$(git rev-parse --git-path hooks/pre-push 2>/dev/null)" || { echo "not a git repo"; exit 2; }
      printf '#!/usr/bin/env bash\nexec "$(git rev-parse --show-toplevel)/scripts/test_all.sh"\n' > "$hook"
      chmod +x "$hook"; echo "installed $hook  (skip once with: git push --no-verify)"; exit 0 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
  shift
done

if [ -t 1 ]; then G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; B=$'\e[1m'; N=$'\e[0m'; else G=; R=; Y=; B=; N=; fi
FAILED=(); WARNED=()
stage() { printf '\n%s== %s ==%s\n' "$B" "$1" "$N"; }
bad()   { FAILED+=("$1"); printf '%sFAIL%s %s\n' "$R" "$N" "$1"; }
warn()  { WARNED+=("$1"); printf '%sWARN%s %s\n' "$Y" "$N" "$1"; }
good()  { printf '%sOK%s   %s\n' "$G" "$N" "$1"; }
PY="$(command -v python3 || command -v python || true)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# 1. Syntax: a typo in any shipped file should die here in 1 second, not in front of students.
if [ -z "$ONLY" ]; then
  stage "1. syntax"
  n=0; err=0
  for f in assets/*.js assets_templates/*.js tools/quiz-maker-v2/assets_templates/*.js; do
    [ -f "$f" ] || continue; n=$((n+1))
    node --check "$f" >"$TMP/o" 2>&1 || { err=1; bad "syntax: $f"; head -3 "$TMP/o"; }
  done
  for f in tools/quiz-maker-v2/apps_script/*.gs; do        # Apps Script is plain JS; node only checks *.js
    n=$((n+1)); cp "$f" "$TMP/$(basename "$f").js"
    node --check "$TMP/$(basename "$f").js" >"$TMP/o" 2>&1 || { err=1; bad "syntax: $f"; head -3 "$TMP/o"; }
  done
  if [ -n "$PY" ]; then
    for f in tools/quiz-maker-v2/*.py tools/quiz-maker-v2/modules/*.py scripts/*.py; do
      [ -f "$f" ] || continue; n=$((n+1))
      "$PY" -I -c "import ast,sys; ast.parse(open(sys.argv[1],encoding='utf-8').read())" "$f" 2>"$TMP/o" || { err=1; bad "syntax: $f"; head -3 "$TMP/o"; }
    done
  fi
  [ $err -eq 0 ] && good "$n files parse"
fi

# 2. The registry: all Node cases (and, with --e2e, the browser ones). Includes R-021 (asset drift) and R-001c (lesson paths).
stage "2. regression registry"
ARGS=()
[ $E2E -eq 1 ] && ARGS+=(--e2e)
[ $STRICT -eq 1 ] && ARGS+=(--strict)
[ -n "$ONLY" ] && ARGS+=(--only "$ONLY")
node scripts/run_registry.js "${ARGS[@]}" | tee "$TMP/reg.txt" | grep -v '^PASS '
if grep -q '^BLOCKING' "$TMP/reg.txt"; then bad "registry: $(grep '^BLOCKING' "$TMP/reg.txt" | sed 's/^BLOCKING: //')"; else good "registry clean ($(grep -c '^PASS ' "$TMP/reg.txt") cases passed)"; fi

if [ -z "$ONLY" ]; then
  # 3. A test file nobody registered never runs on a patch, so it protects nothing.
  stage "3. unregistered tests"
  orph=0
  for f in "$QM"/tests/test_*.js "$QM"/tests/test_*.py "$QM"/tests/e2e_*.py "$QM"/tests/e2e_R*.py; do
    [ -f "$f" ] || continue; b="$(basename "$f")"
    grep -q "\"tests/$b\"" "$QM/tests/registry.json" || { orph=1; msg="not in registry.json: tests/$b"; [ $STRICT -eq 1 ] && bad "$msg" || warn "$msg"; }
  done
  [ $orph -eq 0 ] && good "every test file is registered"

  # 4. Working tree vs. what is committed: tell the user what this run actually covered.
  stage "4. what was tested"
  if git rev-parse --git-dir >/dev/null 2>&1; then
    git status --short | head -15
    [ -z "$(git status --short)" ] && echo "(clean tree: this is exactly HEAD $(git rev-parse --short HEAD))"
  fi
fi

stage "RESULT"
[ ${#WARNED[@]} -gt 0 ] && printf '%s%d warning(s)%s\n' "$Y" "${#WARNED[@]}" "$N"
if [ ${#FAILED[@]} -gt 0 ]; then
  printf '%sBLOCKED%s - %d problem(s):\n' "$R" "$N" "${#FAILED[@]}"; printf '  - %s\n' "${FAILED[@]}"; exit 1
fi
printf '%sALL GREEN%s - safe to ship.\n' "$G" "$N"
