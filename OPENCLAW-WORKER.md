# OpenClaw Worker Setup

Goal: run the Ubuntu VM as a controlled OpenClaw worker connected to Latch over Tailscale/private LAN.

Do not debug Ollama/GPU here. Do not expose services publicly. Do not use Tailscale Funnel.

## Current Deployment

Confirmed on 2026-05-24:

```text
OpenClaw VM hostname: openclaw
OpenClaw VM Tailscale IP: <openclaw-vm-tailscale-ip>
Windows/Latch Tailscale IP: <windows-tailscale-ip>
OpenClaw Gateway local URL: http://127.0.0.1:18789
OpenClaw Gateway Tailscale URL: http://<openclaw-vm-tailscale-ip>:18789
OpenClaw Gateway health URL: http://<openclaw-vm-tailscale-ip>:18789/healthz
Latch private URL for worker: http://<windows-tailscale-ip>:8787
Latch bridge service: latch-agent-bridge
Bridge mode: safe text-only assistant
```

The bridge has been installed as a systemd service and verified to report into Latch. It may answer Latch tasks and new inbox instructions by calling Latch's external LLM gateway. If a request looks like it needs a command, credential, account setup, human verification, or purchase, the bridge creates a Latch approval card instead of answering as if it can act.

Approving a card records the operator decision and reports it back into Latch. In the current safe text-only mode, approval does not cause the bridge to execute commands, use credentials, control a browser, or make purchases.

Reboot persistence:

```text
tailscaled: enabled and active
docker: enabled and active
openclaw-openclaw-gateway-1: restart=unless-stopped, healthy
openclaw-openclaw-cli-1: restart=unless-stopped, healthy
latch-agent-bridge: enabled and active
```

OpenClaw Gateway is now bound to the VM Tailscale IP:

```text
<openclaw-vm-tailscale-ip>:18789-18790 -> container ports 18789-18790
```

## Information To Collect On The VM

Run these on the OpenClaw Ubuntu VM and paste the output back for review before changing security-sensitive config:

```bash
hostname
tailscale status
tailscale ip -4
docker compose ps
docker compose logs --tail=120
sed -n '1,220p' docker-compose.yml
sed -n '1,220p' ~/.openclaw/openclaw.json
```

For `.env`, mask secrets:

```bash
sed -E 's/(KEY|TOKEN|SECRET|PASSWORD|PASS|API_KEY)=.*/\1=REDACTED/i' .env
```

## Confirm Gateway Health

First inspect exposed container ports:

```bash
docker compose ps
```

Then test the likely local URL from the VM:

```bash
curl -fsS http://127.0.0.1:<gateway-port>/health || true
curl -fsS http://127.0.0.1:<gateway-port>/ || true
```

Document both:

```text
OpenClaw Gateway local URL: http://127.0.0.1:<gateway-port>
OpenClaw Gateway Tailscale URL: http://<openclaw-vm-tailscale-ip>:<gateway-port>
Latch URL: https://<windows-latch-tailscale-serve-name>
```

Keep the OpenClaw Gateway private. If it must listen beyond localhost, bind it only to Tailscale/private LAN and firewall it.

## Install The Report-Only Latch Bridge

Copy the files from `worker/` to the Ubuntu VM, then:

```bash
cd /path/to/worker
sudo bash install-latch-agent-bridge.sh
sudo nano /etc/latch-agent-bridge.env
```

Set:

```text
LATCH_BASE_URL=https://<windows-latch-tailscale-serve-name>
LATCH_AGENT_KEY=agent_...
LATCH_WORKER_NAME=openclaw-vm
OPENCLAW_HEALTH_URL=http://127.0.0.1:<gateway-port>/health
```

The bridge is intentionally text-only. It does not execute commands, control finance, access credentials, control a browser, or receive provider API keys.

Test once:

```bash
sudo env $(sudo grep -v '^#' /etc/latch-agent-bridge.env | xargs) \
  /usr/local/bin/latch-agent-bridge.py \
  --once \
  --state-path /tmp/latch-agent-bridge-test.json
```

Enable after the one-shot test succeeds:

```bash
sudo systemctl enable --now latch-agent-bridge
```

## Start/Stop/Status Commands

OpenClaw Gateway:

```bash
docker compose up -d
docker compose ps
docker compose logs -f --tail=120
docker compose down
```

Latch bridge:

```bash
sudo systemctl status latch-agent-bridge
sudo journalctl -u latch-agent-bridge -f
sudo systemctl restart latch-agent-bridge
sudo systemctl stop latch-agent-bridge
sudo systemctl disable latch-agent-bridge
```

Bridge one-shot test:

```bash
sudo env $(sudo grep -v '^#' /etc/latch-agent-bridge.env | xargs) \
  /usr/local/bin/latch-agent-bridge.py \
  --once \
  --state-path /tmp/latch-agent-bridge-test.json
```

Latch health from the VM:

```bash
curl -fsS http://<windows-tailscale-ip>:8787/api/health
```

Tailscale:

```bash
tailscale status
tailscale ip -4
```

## Security Rules

- Give the VM only the Latch agent key.
- Do not put the operator key on the VM.
- Do not put external LLM provider keys on the VM.
- Do not put GitHub write tokens on the VM.
- Do not give OpenClaw Revolut, banking, payment, password manager, or browser profile access.
- Human verification, account creation, purchases, and credentials should become Latch approval requests.
- Ask before changing `docker-compose.yml`, `.env`, firewall rules, Tailscale ACLs, or `~/.openclaw/openclaw.json`.
