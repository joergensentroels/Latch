#!/usr/bin/env bash
# Installs a weekly systemd timer that checks whether the running OpenClaw gateway is behind
# the latest stable upstream release, and notifies over the configured webhook/ntfy URL if so.
# Run as root: sudo bash install-openclaw-version-check.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

install -m 755 "$SCRIPT_DIR/check-openclaw-version.sh" /usr/local/bin/openclaw-version-check.sh
install -m 644 "$SCRIPT_DIR/openclaw-version-check.service" /etc/systemd/system/openclaw-version-check.service
install -m 644 "$SCRIPT_DIR/openclaw-version-check.timer" /etc/systemd/system/openclaw-version-check.timer

if [ ! -f /etc/openclaw-version-check.env ]; then
  cat > /etc/openclaw-version-check.env <<'EOF'
# ntfy.sh (or any webhook-style) URL to notify when a new stable OpenClaw release exists.
# Reuse the same private ntfy topic Latch already uses for phone notifications
# (see data/notifications.json on the trusted Windows host) rather than creating a second one.
OPENCLAW_VERSION_NOTIFY_URL=
EOF
  chmod 600 /etc/openclaw-version-check.env
  echo "Created /etc/openclaw-version-check.env -- set OPENCLAW_VERSION_NOTIFY_URL before this can notify you."
fi

systemctl daemon-reload
systemctl enable --now openclaw-version-check.timer

echo "Installed."
echo "Test immediately with:   sudo -u latchsetup /usr/local/bin/openclaw-version-check.sh"
echo "Check schedule with:     systemctl list-timers openclaw-version-check.timer"
echo "Check last run with:     journalctl -u openclaw-version-check.service -n 30"
