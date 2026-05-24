#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo on the OpenClaw Ubuntu VM."
  exit 1
fi

install -o root -g root -m 0755 latch-agent-bridge.py /usr/local/bin/latch-agent-bridge.py
install -o root -g root -m 0644 latch-agent-bridge.service /etc/systemd/system/latch-agent-bridge.service

if [[ ! -f /etc/latch-agent-bridge.env ]]; then
  install -o root -g root -m 0600 latch-agent-bridge.env.example /etc/latch-agent-bridge.env
  echo "Created /etc/latch-agent-bridge.env. Edit it before enabling the service."
else
  chmod 0600 /etc/latch-agent-bridge.env
fi

systemctl daemon-reload
echo "Installed. Edit /etc/latch-agent-bridge.env, then run:"
echo "  sudo systemctl enable --now latch-agent-bridge"
