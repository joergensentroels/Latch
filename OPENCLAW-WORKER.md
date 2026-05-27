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
Bridge mode: approval-gated planning and reporting
Optional executor service: latch-agent-executor
```

The bridge has been installed as a systemd service and verified to report into Latch. It may answer Latch tasks and new inbox instructions by calling Latch's external LLM gateway. It may route its own internal Latch replies into a requested Latch channel, such as `operations` or `research`. If a request looks like it needs a command, browser action, credential, account setup, human verification, outbound contact, or purchase, the bridge creates a Latch approval card instead of pretending the action already happened.

Approving a card records the operator decision and reports it back into Latch. For non-sensitive approvals with an operator note, the bridge may use that note to draft a follow-up response through the LLM gateway. Sensitive notes are not forwarded to the external LLM. The bridge itself does not run arbitrary shell/browser actions; approved shell/browser plans run only through the separate `latch-agent-executor` service.

Reboot persistence:

```text
tailscaled: enabled and active
docker: enabled and active
openclaw-openclaw-gateway-1: restart=unless-stopped, healthy
openclaw-openclaw-cli-1: restart=unless-stopped, healthy
latch-agent-bridge: enabled and active
latch-agent-executor: optional, enabled only after explicit install
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

## Install The Latch Bridge

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

The bridge is intentionally not root-capable. It does not control finance, access credentials, receive provider API keys, send external messages, or use personal browser profiles.

Approved read-only diagnostics are the only exception inside the bridge. The bridge can run fixed internal templates such as bridge status, recent bridge logs, OpenClaw Gateway health, Docker status, Tailscale status, and read-only repo status.

Compass autonomy modes can auto-approve some approval cards before the worker sees them. `Auto review` can release low-risk read-only diagnostics and bounded exact-URL public research. `Full access` can release non-sensitive VM shell/browser plans and `CompassProjects` file updates for operator tasks and operator-managed Pro users. Credentials, purchases, account setup, external contact, GitHub repo creation, human verification, and context answers still require a human.

## Install The Approved Executor

The executor is a separate root-owned service. It installs Playwright-managed Firefox and runs only approved `executionPlan` records with `executionMode` set to `shell` or `browser`.

```bash
cd /path/to/worker
sudo bash install-latch-agent-executor.sh
sudo nano /etc/latch-agent-executor.env
sudo systemctl enable --now latch-agent-executor
```

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

Latch executor:

```bash
sudo systemctl status latch-agent-executor
sudo journalctl -u latch-agent-executor -f
sudo systemctl restart latch-agent-executor
sudo systemctl stop latch-agent-executor
sudo systemctl disable latch-agent-executor
```

From the trusted Windows host, copy updated bridge/executor files to the VM:

```powershell
powershell -ExecutionPolicy Bypass -File .\Deploy-Bridge-To-VM.ps1 -VmHost "<openclaw-vm-tailscale-ip>"
```

For one-command deploy, activation, restart, and health checks:

```powershell
powershell -ExecutionPolicy Bypass -File .\Deploy-Worker-To-VM.ps1 `
  -VmHost "<openclaw-vm-tailscale-ip>" `
  -HostAddress "<windows-tailscale-ip>" `
  -Activate `
  -RunDoctor
```

The helper stages files under `~/latch-worker-next`, installs them with sudo when `-Activate` is set, restarts the affected services, verifies service status, and can run the local doctor. Use `-BridgeOnly`, `-ExecutorOnly`, or `-VerifyOnly` for narrower maintenance.

If sudo asks for a password, add `-InteractiveSudo`. When Codex starts the deploy and you want a visible password prompt, use `-InteractiveWindow`; it opens a separate PowerShell window for SSH/sudo interaction. For fully unattended deploys, configure narrow passwordless sudo for these install and systemctl commands.

When changes are ready to push and deploy together, use the wrapper from the trusted Windows host:

```powershell
powershell -ExecutionPolicy Bypass -File .\Push-And-Deploy.ps1 `
  -VmHost "<openclaw-vm-tailscale-ip>" `
  -HostAddress "<windows-tailscale-ip>" `
  -InteractiveWindow
```

It runs `git push` first and deploys the worker only after the push succeeds.
By default it refuses to deploy with uncommitted local changes, so the pushed code and deployed code stay aligned. Use `-AllowDirtyDeploy` only for an intentional hot deploy while testing.

Read-only diagnostic templates exposed through Latch approvals:

```text
bridge.status
bridge.logs
openclaw.gateway.health
docker.status
tailscale.status
repo.status
```

Bridge one-shot test:

```bash
sudo env $(sudo grep -v '^#' /etc/latch-agent-bridge.env | xargs) \
  /usr/local/bin/latch-agent-bridge.py \
  --once \
  --state-path /tmp/latch-agent-bridge-test.json
```

## Context And Memory

Use the Latch Context tab for normal operator-provided memory: goals, personality, boundaries, project notes, and small supporting files. The Agent Profile section is sent first as structured identity/direction when shared. The bridge receives a compact context briefing with the shared profile, explicitly shared notes, and selected small text files.

The worker may ask for missing durable context by creating a `context_question` approval. When the operator answers that card, Latch saves the answer as shared Context for future responses.

For larger files, copy them to the VM over SSH only when needed for VM-local work. Direct SSH uploads are not part of Latch Context unless the operator also adds a note or a future import step records them.

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

## Read-Only Latch Source Checkout

The OpenClaw VM may inspect the Latch source through a GitHub deploy key with read-only access to this single repo.

Confirmed layout:

```text
Repo checkout: ~/code/latch-readonly
SSH alias: github-latch-readonly
Deploy key file: ~/.ssh/latch_repo_readonly_ed25519
Remote: git@github-latch-readonly:joergensentroels/Latch.git
```

GitHub deploy key settings:

```text
Title: OpenClaw-Readonly
Allow write access: off
```

After cloning or updating, the checkout is made read-only at the filesystem level. To fast-forward it:

```bash
~/update-latch-readonly.sh
```

This temporarily unlocks the checkout, runs a fast-forward pull, then relocks the files. The deploy key itself still cannot push to GitHub.
