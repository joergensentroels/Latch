#!/usr/bin/env bash
# Checks whether the running OpenClaw gateway is on the latest STABLE upstream release, and
# sends a phone notification (via ntfy or any webhook-style endpoint) if it's behind.
#
# Deliberately needs no filesystem access to the actual deployment checkout and no sudo:
#   - the running version is read straight from the live container's package.json
#   - the latest stable tag is read straight from the GitHub remote (git ls-remote)
# so this can run as the low-privilege service account (only needs `docker` group membership).
#
# Stable release tags look like vYYYY.M.D with no -alpha/-beta/-rc suffix; those pre-release
# suffixes are excluded on purpose -- this checks for the latest STABLE release, not latest tag.
set -euo pipefail

CONTAINER="${OPENCLAW_GATEWAY_CONTAINER:-openclaw-openclaw-gateway-1}"
REPO_URL="${OPENCLAW_REPO_URL:-https://github.com/openclaw/openclaw.git}"
NOTIFY_URL="${OPENCLAW_VERSION_NOTIFY_URL:-}"
STATE_FILE="${OPENCLAW_VERSION_STATE_FILE:-$HOME/.cache/openclaw-version-check-last-notified}"

mkdir -p "$(dirname "$STATE_FILE")"

running_version=$(docker exec "$CONTAINER" sh -c "grep -m1 '\"version\"' package.json" \
  | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/') || true
if [ -z "$running_version" ]; then
  echo "Could not read the running OpenClaw version from container $CONTAINER." >&2
  exit 1
fi

latest_stable_tag=$(git ls-remote --tags --refs "$REPO_URL" \
  | awk '{print $2}' | sed 's#refs/tags/##' \
  | grep -E '^v[0-9]{4}\.[0-9]+\.[0-9]+$' \
  | sort -V | tail -1) || true
if [ -z "$latest_stable_tag" ]; then
  echo "Could not determine the latest stable OpenClaw release from $REPO_URL." >&2
  exit 1
fi
latest_stable_version="${latest_stable_tag#v}"

echo "Running: $running_version   Latest stable: $latest_stable_version"

if [ "$running_version" = "$latest_stable_version" ]; then
  echo "OpenClaw is up to date."
  exit 0
fi

last_notified=""
[ -f "$STATE_FILE" ] && last_notified=$(cat "$STATE_FILE")
if [ "$last_notified" = "$latest_stable_version" ]; then
  echo "Already notified about $latest_stable_version; not spamming again."
  exit 0
fi

echo "OpenClaw is behind: running $running_version, latest stable is $latest_stable_version."

if [ -n "$NOTIFY_URL" ]; then
  curl -fsS \
    -H "Title: OpenClaw update available" \
    -H "Priority: default" \
    -d "Running $running_version, latest stable is $latest_stable_version. SSH in and update when convenient." \
    "$NOTIFY_URL" >/dev/null
  echo "$latest_stable_version" > "$STATE_FILE"
  echo "Notification sent."
else
  echo "No notify URL configured (set OPENCLAW_VERSION_NOTIFY_URL in /etc/openclaw-version-check.env); skipping notification." >&2
fi
