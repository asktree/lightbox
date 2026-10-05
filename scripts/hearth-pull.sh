#!/bin/bash
# Fast-forward this checkout to origin/main and keep its local changes that
# are not committed. Made for hearth, where the live checkout has such
# changes and `git pull` refuses when an incoming file is one of them.
#
# For each incoming file that has local changes, the script makes a trial
# three-way merge first. If one trial has a conflict, it stops before any
# change. Then it stashes only those files, does the fast-forward, applies
# the stash, and compares each file with its trial. Copies of the local files
# stay in ~/.local/state/lightbox/pulls/<time>/.
#
# Usage: scripts/hearth-pull.sh        (run it in the checkout to update)
set -u
repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo" || exit 1
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$HOME/.local/state/lightbox/pulls/$stamp"
tag="hearth-pull-$stamp-$$"

[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || { echo "ABORT: not on main"; exit 2; }
git fetch -q origin main || { echo "ABORT: fetch failed"; exit 2; }
if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]; then
  echo "already at origin/main ($(git log --oneline -1))"
  exit 0
fi
git merge-base --is-ancestor HEAD origin/main || { echo "ABORT: not a fast-forward"; exit 2; }

mkdir -p "$work" || exit 1
git status --porcelain > "$work/status-before.txt"
git diff --name-only HEAD origin/main | sort > "$work/incoming.txt"
git diff --name-only HEAD | sort > "$work/dirty.txt"
comm -12 "$work/incoming.txt" "$work/dirty.txt" > "$work/overlap.txt"
echo "incoming files: $(wc -l < "$work/incoming.txt" | tr -d ' '); with local changes: $(wc -l < "$work/overlap.txt" | tr -d ' ')"

files=()
while IFS= read -r f; do
  [ -n "$f" ] && files+=("$f")
done < "$work/overlap.txt"
n="${#files[@]}"

i=0
while [ "$i" -lt "$n" ]; do
  f="${files[$i]}"
  cp "$f" "$work/$i.live" || { echo "ABORT: no local file $f"; exit 2; }
  git show "HEAD:$f" > "$work/$i.base" || { echo "ABORT: no base for $f"; exit 2; }
  git show "origin/main:$f" > "$work/$i.theirs" || { echo "ABORT: main deletes $f, which has local changes"; exit 2; }
  cp "$work/$i.live" "$work/$i.merged"
  if ! git merge-file -q "$work/$i.merged" "$work/$i.base" "$work/$i.theirs"; then
    echo "ABORT: trial merge conflict in $f. Nothing is changed. See $work/$i.merged"
    exit 5
  fi
  echo "trial merge clean: $f"
  i=$((i + 1))
done

sha=""
if [ "$n" -gt 0 ]; then
  git stash push -q -m "$tag" -- "${files[@]}" || { echo "ABORT: stash failed"; exit 3; }
  sha="$(git stash list --format='%H %gs' | grep -F "$tag" | cut -d' ' -f1)"
  [ -n "$sha" ] || { echo "ABORT: no stash entry. The local files are in $work/*.live"; exit 3; }
fi

if ! git merge -q --ff-only origin/main; then
  echo "ABORT: fast-forward failed. Put the local changes back."
  [ -n "$sha" ] && git stash apply -q "$sha"
  exit 4
fi

ok=1
if [ "$n" -gt 0 ]; then
  git stash apply -q "$sha" || echo "NOTE: stash apply gave a conflict"
  i=0
  while [ "$i" -lt "$n" ]; do
    f="${files[$i]}"
    if ! cmp -s "$f" "$work/$i.merged"; then
      echo "not equal to the trial merge, write the trial merge: $f"
      git checkout -q HEAD -- "$f"
      cp "$work/$i.merged" "$f"
    fi
    cmp -s "$f" "$work/$i.merged" || ok=0
    i=$((i + 1))
  done
  if [ "$ok" = 1 ]; then
    ref="$(git stash list --format='%gd %gs' | grep -F "$tag" | cut -d' ' -f1)"
    [ -n "$ref" ] && git stash drop -q "$ref"
    # The files changed three times in a short time. Make sure that the
    # dev server (tsx watch) starts one more time with the last version.
    sleep 1
    touch "${files[@]}"
  else
    echo "KEEP stash entry $sha ($tag): a file is not as expected"
  fi
fi

echo "now at $(git log --oneline -1)"
git status --porcelain > "$work/status-after.txt"
if diff "$work/status-before.txt" "$work/status-after.txt" > "$work/status.diff"; then
  echo "git status: same as before ($(wc -l < "$work/status-after.txt" | tr -d ' ') lines)"
else
  echo "git status changed:"
  cat "$work/status.diff"
fi
[ "$ok" = 1 ]
