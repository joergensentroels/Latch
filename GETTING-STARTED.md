# Getting Started with Compass

This is the "zero to first task" guide. For the what-and-why, see [README.md](./README.md); for the security model, read [SECURITY.md](./SECURITY.md) **before you expose anything**.

## The two halves

Compass always runs as two cooperating parts, connected privately over [Tailscale](https://tailscale.com):

| Part | Runs | Holds | Job |
| --- | --- | --- | --- |
| **Trusted host** | Compass/Latch server (`server.js`) | **All secrets** — operator key, agent key, GitHub token, mailbox creds, LLM key (in `data/`, gitignored) | Where you operate from. The UI, approvals, routing, and every credentialed action happen here. |
| **Disposable worker** | OpenClaw + `latch-agent-bridge` (+ optional `latch-agent-executor`) | **Only the agent key** | Does the real browsing/shell/file work — but only through approvals, and it never sees your credentials. Treat it as untrusted and replaceable. |

That split is the whole point: a compromised or prompt-injected worker still can't reach your accounts, because it never holds the keys. Read [AGENT-BOUNDARY.md](./AGENT-BOUNDARY.md) for the full boundary.

## Choose your topology

Both halves need to run *somewhere separate*. Two supported layouts — the software steps are identical, only **where** each half lives differs:

### Option A — Two machines
Host on one computer (your daily desktop/laptop), worker on a **second Linux box** (a spare PC, mini-PC, or NUC).
- Best if you have spare hardware.
- Strongest isolation — the worker is physically separate.

### Option B — Two VMs
One capable machine running a hypervisor (e.g. Proxmox), with a **host VM** and a **worker VM**. (Or — how the maintainer runs it — your daily machine as the host plus a single worker VM.)
- Best if you have one powerful box.
- Isolation is at the VM level: put the worker VM on its own network segment so it can't reach your LAN/secrets, and give it enough resources for OpenClaw (~6 vCPU / 12 GB RAM if it runs the browser and a local model).
- Both VMs are usually **Ubuntu**. In that case the **host** follows the Linux commands throughout this guide — the `.ps1` scripts are Windows-only conveniences, and everything they do has a plain `node`/`tailscale`/`systemd` equivalent noted below.

> Whichever you pick, the worker must **not** be able to read the host's `data/` folder or your other credentials. Physical separation (A) gives that for free; with VMs (B) you enforce it with network isolation.

## Prerequisites

- A **Tailscale** account (free tier is fine). Both halves join the same tailnet.
- **Trusted host:** Node.js 22+ (a bundled runtime ships for Windows; on Ubuntu install it via [NodeSource](https://github.com/nodesource/distributions) or `nvm`).
- **Worker (Ubuntu/Debian recommended):** Docker + Docker Compose, Python 3.11+, and Tailscale.

---

## Step 1 — Trusted host (Compass/Latch server)

1. Install Tailscale on the host and sign in.
2. Clone this repo onto the host.
3. Start the server, bound to your Tailscale IP (not the public internet):
   - **Windows:** `powershell -ExecutionPolicy Bypass -File .\Start-Latch-Tailscale.ps1` (auto-detects your Tailscale IP, binds `127.0.0.1` + that IP on port 8787).
   - **Linux/macOS:** `HOST=<your-tailscale-ip> PORT=8787 node server.js`
4. First run generates your keys into `data/auth.json`. View them with:
   - **Windows:** `powershell -ExecutionPolicy Bypass -File .\Show-CommandCenter-Keys.ps1`
   - **Linux/macOS:** read `data/auth.json`
   You get two keys:
   - **Operator key** — logs you into Compass. Save it in a password manager.
   - **Agent key** — goes on the worker in Step 2. Nothing else.
5. Open Compass at `http://<host-tailscale-ip>:8787`, paste the operator key, and unlock.
6. **Phone (optional):** expose an HTTPS address over Tailscale Serve so the installable PWA can reach it — `powershell -ExecutionPolicy Bypass -File .\Serve-Over-Tailscale.ps1` (or `tailscale serve --bg 8787`). Details in [PHONE-SETUP.md](./PHONE-SETUP.md).

At this point you have **Compass Simple** — chat, memory, tasks, approvals. Real browser/shell/file agency needs the worker.

## Step 2 — Disposable worker (OpenClaw + bridge)

Provision the worker per your topology (Option A: a Linux machine; Option B: a Linux VM), then:

1. Install **Tailscale** on the worker and sign in to the **same tailnet**. Install **Docker + Compose** and **Python 3.11+**.
2. **Install OpenClaw itself.** OpenClaw is a separate upstream project, not bundled here — follow its own quickstart at <https://github.com/openclaw/openclaw> to bring up its gateway with Docker Compose (it creates a `docker-compose.yml` + `.env`, typically under `~/apps/openclaw`). What Latch needs from it:
   - the gateway reachable at `http://127.0.0.1:18789` (health endpoint `/healthz`);
   - bound to **localhost / your Tailscale IP only** — never `0.0.0.0` or the public internet.

   Latch ships a helper that locks OpenClaw's published ports to your Tailscale IP and keeps the containers restarting. Copy this repo's `worker/` folder onto the worker, then from it:
   ```bash
   OPENCLAW_PROJECT_DIR=~/apps/openclaw \
   OPENCLAW_GATEWAY_HOST=<worker-tailscale-ip> \
   python3 patch-openclaw-compose.py
   docker compose -f ~/apps/openclaw/docker-compose.yml up -d
   curl -fsS http://127.0.0.1:18789/healthz   # confirm the gateway is healthy
   ```
   (If your OpenClaw version serves `/health` instead of `/healthz`, use whichever its gateway answers — and match it in `OPENCLAW_HEALTH_URL` below.)
3. Install the **bridge** (from that same `worker/` folder):
   ```bash
   cd worker
   sudo bash install-latch-agent-bridge.sh
   sudo nano /etc/latch-agent-bridge.env
   ```
   Set:
   ```ini
   LATCH_BASE_URL=http://<host-tailscale-ip>:8787
   LATCH_AGENT_KEY=agent_...          # the agent key from Step 1 — the ONLY secret on the worker
   LATCH_WORKER_NAME=openclaw-worker
   OPENCLAW_HEALTH_URL=http://127.0.0.1:18789/healthz
   ```
   Then: `sudo systemctl enable --now latch-agent-bridge`
4. **Optional — real shell/browser actions.** The bridge only plans and reports; approved shell/browser plans run in a separate root-owned service (installs Playwright Firefox):
   ```bash
   sudo bash install-latch-agent-executor.sh
   sudo systemctl enable --now latch-agent-executor
   ```

Full worker reference, deploy helpers, and start/stop commands: [OPENCLAW-WORKER.md](./OPENCLAW-WORKER.md).

## Step 3 — Pair and verify

- From the **worker**, confirm it can reach the host: `curl -fsS http://<host-tailscale-ip>:8787/api/health` → should return `{"ok":true,...}`.
- In Compass, the **Inbox** shows the worker posting an "online" message once the bridge connects.
- Leave autonomy on **Approve everything** to start (**Settings → Review Policy**). Loosen it later only on a worker you trust and have isolated.

## Step 4 — Your first task

- Message the Companion in the Inbox: *"Browse https://example.com and give me a short summary."* → a **research** card appears in **Review** → approve it → the summary comes back.
- Or queue work in **Tasks**. Anything that needs a real action (shell, browser, a commit, sending mail) becomes an approval card you review first.

---

## Where secrets live (recap)

- **Host:** operator key, agent key, GitHub token, mailbox credentials, LLM provider key — all under `data/` (gitignored). Never commit them.
- **Worker:** the agent key, and nothing else. Never put the operator key, provider keys, or GitHub write tokens on the worker.

## Going further

- **LLM** — local (Ollama, OpenAI-compatible endpoint) or a hosted provider: [LLM-PROVIDER.md](./LLM-PROVIDER.md) / `Configure-External-LLM.ps1`.
- **Agent email** — the companion's own mailbox: [AGENT-BOUNDARY.md](./AGENT-BOUNDARY.md#agent-email-agent-owned-mailbox) / [MAILBOX-BROWSER.md](./MAILBOX-BROWSER.md).
- **MCP tool servers** — connect the companion to the MCP ecosystem, approval-gated, credentials on the host only: [MCP.md](./MCP.md).
- **Scheduled tasks** — recurring instructions (daily/weekly/interval): [SCHEDULING.md](./SCHEDULING.md).
- **Notifications** — push to your phone: [NOTIFICATIONS.md](./NOTIFICATIONS.md).
- **Auto-start on boot** — Windows: `Install-Latch-StartupTask.ps1`. Linux host: run `node server.js` under a small `systemd` unit (with `Environment=HOST=<tailscale-ip>` `Environment=PORT=8787`) so it starts on boot, the same way the worker's bridge/executor do.
- **If something's wrong** — `Invoke-Latch-Doctor.ps1` / `Status-Latch.ps1`, and `sudo journalctl -u latch-agent-bridge -f` on the worker.
- **Emergency** — `Emergency-Latch-Lockdown.ps1` rotates keys and cuts the worker off.
