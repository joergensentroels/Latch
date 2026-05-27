#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo on the OpenClaw Ubuntu VM."
  exit 1
fi

python3 -m venv /opt/latch-agent-executor
/opt/latch-agent-executor/bin/python -m pip install --upgrade pip
/opt/latch-agent-executor/bin/python -m pip install playwright
/opt/latch-agent-executor/bin/python -m playwright install firefox
/opt/latch-agent-executor/bin/python -m playwright install-deps firefox

install -o root -g root -m 0755 latch-agent-executor.py /usr/local/bin/latch-agent-executor.py
install -o root -g root -m 0644 latch-agent-executor.service /etc/systemd/system/latch-agent-executor.service

if [[ ! -f /etc/latch-agent-executor.env ]]; then
  install -o root -g root -m 0600 latch-agent-executor.env.example /etc/latch-agent-executor.env
  echo "Created /etc/latch-agent-executor.env. Edit it before enabling the service."
else
  chmod 0600 /etc/latch-agent-executor.env
fi

install -d -o root -g root -m 0750 /var/lib/latch-agent-executor
install -d -o root -g root -m 0750 /var/lib/latch-agent-executor/work
install -d -o root -g root -m 0750 /var/lib/latch-agent-executor/browser
install -d -o root -g root -m 0750 /var/lib/latch-agent-executor/downloads

systemctl daemon-reload
echo "Installed. Edit /etc/latch-agent-executor.env, then run:"
echo "  sudo systemctl enable --now latch-agent-executor"
