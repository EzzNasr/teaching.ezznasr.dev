#!/usr/bin/env bash
# Lists commits whose added lines are (mostly) missing now: the sign of an old copy overwriting newer work.
#   bash scripts/find_reverts.sh            last 25 commits, compared with the working tree
#   bash scripts/find_reverts.sh 60 3       last 60 commits, report a file when more than 3 of its added lines are gone
# A line counts only if it is longer than 25 characters (ignores braces, blank lines). Each hit is either a deliberate
# later edit (fine) or a revert to put back (git show <commit> | git apply --3way). Found 99d91f0 / 5c6efc9 on 2026-11-03.
set -u
N="${1:-25}"; MIN="${2:-2}"
cd "$(git rev-parse --show-toplevel)" || exit 2
for c in $(git rev-list --reverse -n "$N" HEAD); do
  for f in $(git diff-tree --no-commit-id --name-only -r "$c"); do
    case "$f" in *.png|*.jpg|*.pdf|*.zip|*.webp) continue ;; esac
    if [ ! -f "$f" ]; then echo "$(git log -1 --format='%h %ad' --date=short "$c")  $f: file no longer exists"; continue; fi
    added=$(git show "$c" -- "$f" | grep '^+' | grep -v '^+++' | sed 's/^+//' | tr -d '\r' | sed 's/^[[:space:]]*//' | awk 'length>25' | sort -u)
    [ -z "$added" ] && continue
    tot=$(printf '%s\n' "$added" | wc -l)
    miss=$(printf '%s\n' "$added" | grep -vxFf <(tr -d '\r' < "$f" | sed 's/^[[:space:]]*//') | wc -l)
    [ "$miss" -gt "$MIN" ] && echo "$(git log -1 --format='%h %ad' --date=short "$c")  $f: $miss of $tot added lines are gone   ($(git log -1 --format=%s "$c" | cut -c1-60))"
  done
done
exit 0
