#!/usr/bin/env bash
set -euo pipefail

repo="${LATCH_READONLY_REPO:-$HOME/code/latch-readonly}"

if [ ! -d "$repo/.git" ]; then
  echo "Missing repo: $repo" >&2
  exit 1
fi

chmod -R u+w "$repo"
git -C "$repo" fetch --prune origin
git -C "$repo" checkout main
git -C "$repo" pull --ff-only origin main
chmod -R a-w "$repo"
git -C "$repo" --no-pager log --oneline -1
