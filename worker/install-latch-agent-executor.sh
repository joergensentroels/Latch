#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo on the OpenClaw Ubuntu VM."
  exit 1
fi

# Least-privilege (pre-public hardening #5): a dedicated non-root system user runs the executor.
EXEC_USER="latch-executor"
if ! id -u "${EXEC_USER}" >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir /var/lib/latch-agent-executor --shell /usr/sbin/nologin "${EXEC_USER}"
fi

python3 -m venv /opt/latch-agent-executor
/opt/latch-agent-executor/bin/python -m pip install --upgrade pip
/opt/latch-agent-executor/bin/python -m pip install playwright
# Install the browser into a SHARED path the non-root user can read; its OS deps need root.
export PLAYWRIGHT_BROWSERS_PATH=/opt/latch-agent-executor/ms-playwright
/opt/latch-agent-executor/bin/python -m playwright install firefox
/opt/latch-agent-executor/bin/python -m playwright install-deps firefox
chmod -R a+rX /opt/latch-agent-executor

install -o root -g root -m 0755 latch-agent-executor.py /usr/local/bin/latch-agent-executor.py
install -o root -g root -m 0644 latch-agent-executor.service /etc/systemd/system/latch-agent-executor.service

# The env file holds the agent key. systemd reads it as root before dropping to ${EXEC_USER}, so it
# stays root-only 0600 -- the unprivileged executor process gets the value but cannot read the file.
if [[ ! -f /etc/latch-agent-executor.env ]]; then
  install -o root -g root -m 0600 latch-agent-executor.env.example /etc/latch-agent-executor.env
  echo "Created /etc/latch-agent-executor.env. Edit it before enabling the service."
else
  chmod 0600 /etc/latch-agent-executor.env
fi

# Writable area owned by the non-root executor user (state, working dir, browser profile, downloads).
install -d -o "${EXEC_USER}" -g "${EXEC_USER}" -m 0750 /var/lib/latch-agent-executor
install -d -o "${EXEC_USER}" -g "${EXEC_USER}" -m 0750 /var/lib/latch-agent-executor/work
install -d -o "${EXEC_USER}" -g "${EXEC_USER}" -m 0750 /var/lib/latch-agent-executor/browser
install -d -o "${EXEC_USER}" -g "${EXEC_USER}" -m 0750 /var/lib/latch-agent-executor/downloads
# Re-own any pre-existing (previously root-owned) files from an earlier root install.
chown -R "${EXEC_USER}:${EXEC_USER}" /var/lib/latch-agent-executor

systemctl daemon-reload
echo "Installed (runs as non-root user '${EXEC_USER}'). Edit /etc/latch-agent-executor.env, then run:"
echo "  sudo systemctl enable --now latch-agent-executor"
