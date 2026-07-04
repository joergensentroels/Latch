# Deploy + verify runbook

Compass has **three** things that ship independently. Know which a change touches so you deploy only
what's needed:

| Deployable | Holds | How it updates | Applies changes in |
| --- | --- | --- | --- |
| **Host server** | all secrets, the API, approvals, scheduler | restart `node server.js` on the trusted host | `server.js`, `email.mjs`, `mcp.mjs`, `schedule.mjs` |
| **Worker** | only the agent key | copy `worker/` to the VM + restart the systemd units | `worker/latch-agent-bridge.py`, `worker/latch-agent-executor.py`, the `.service` files |
| **Frontend (PWA)** | nothing | served static by the host; reload the app | `public/**` (HTML/JS/CSS/service-worker) |

> A frontend-only change is live on a browser reload once the host is running the new files — no
> restart or worker redeploy. Bump `public/service-worker.js` `CACHE_NAME` so the PWA re-caches.

## Before you deploy

1. `npm test` is green (secret-scan, python worker tests via `py -3`, agent-email, mcp, schedule, smoke).
2. Changes are committed and pushed (`Push-Latch.ps1 -Yes -Message "..."`).

## Step 1 — Host server

```powershell
powershell -ExecutionPolicy Bypass -File .\Start-Latch-Tailscale.ps1
```

Binds `127.0.0.1` + the Tailscale IP on port 8787 (and re-applies Tailscale Serve for the phone). If
an old instance is already bound, stop it first (if it was started elevated, from an elevated shell:
`Get-NetTCPConnection -LocalPort 8787 -State Listen | ... Stop-Process`).

Verify:
- From the host: `curl http://<host-tailscale-ip>:8787/api/health` → `{"ok":true,...}`.
- Open Compass, unlock with the operator key (`Show-CommandCenter-Keys.ps1` if you need it).

## Step 2 — Worker (bridge + executor)

Copies `worker/` to the VM and installs + restarts the units in one go:

```powershell
powershell -ExecutionPolicy Bypass -File .\Deploy-Worker-To-VM.ps1 `
  -VmHost "<worker-tailscale-ip>" -Activate -InteractiveSudo -RunDoctor
```

- `-Activate` runs the `install -o root … && systemctl daemon-reload && systemctl restart` on the VM
  (bridge + executor). `-InteractiveSudo` prompts for the VM sudo password.
- Bridge only / executor only: add `-BridgeOnly` or `-ExecutorOnly`.
- Push and deploy in one shot: `Push-And-Deploy.ps1 -Yes -InteractiveSudo`.

Verify (the script does this with `-RunDoctor`, or run manually over SSH):
- `systemctl is-active latch-agent-bridge` → `active`; `NRestarts` not climbing.
- `systemctl is-active latch-agent-executor` → `active`.
- Gateway health on the VM: `curl -fsS http://127.0.0.1:18789/healthz`.
- Bridge log tail: `sudo journalctl -u latch-agent-bridge -n 50 -f`.

## Step 3 — Frontend

Reload the app (desktop refresh; on the installed PWA, close/reopen or pull-to-refresh) while on the
network so the service worker fetches the new shell.

## Rollback

- Host: restart the previous commit's `server.js` (`git checkout <prev> -- server.js …` then restart),
  or `git revert` and redeploy. `data/` is untouched by deploys.
- Worker: re-run the deploy from the previous commit. The bridge is stateless beyond
  `~/.local/state`/`--state-path`; the executor only runs approved plans.

---

## Pending batch — 2026-07-04 (dated snapshot)

Everything below is committed + pushed but **not yet deployed**. One host restart + one worker
redeploy ships all of it. Verify each after deploying.

**Ships on the host restart (Step 1):**
- **Security F1** — approval card shows exactly the shell commands the executor runs. *Verify:* create/queue a shell task; the "exact commands" you approve match what runs.
- **Security F2** — `/api/state` is operator-only. *Verify:* the worker still works (it uses `/api/agent/poll`); an agent-key GET of `/api/state` returns 403.
- **Reply-cap slider** — Settings → Agent email drives the bridge's per-thread cap.
- **MCP host** — Settings → MCP lists servers/tools (add `data/mcp.json` from `mcp.example.json` first); an `mcp_tool_call` approval runs the tool host-side and posts the result to the Inbox.
- **Scheduling** — Settings → Automation; **Run now** queues a task immediately; a due schedule fires on the 15s loop.

**Ships on the worker redeploy (Step 2):**
- **Security F3** — executor confines `screenshot`/`download` paths to the download dir.
- **Bridge LLM timeout** — cold local-model calls no longer time out at 15s (now 120s).
- **Inbound auto-reply** — replies only to already-known contacts, per-thread cap → `email_thread_continue` review.
- **LLM-compose** — an email send with no explicit `Body:` is drafted by the LLM before the approval.
- **Email-before-github ordering** + **watchdog** (Type=notify / WatchdogSec).
- **MCP bridge detection** — "use MCP to …" in a task/Inbox resolves to a tool call via the poll catalog.

**End-to-end smoke after both:**
1. Message the companion: *"Browse https://example.com and give me a short summary."* → research card → approve → summary returns. (Confirms the OpenClaw integration survived the version jump.)
2. If `data/mcp.json` is configured: *"Use MCP to read <file>."* → `mcp_tool_call` approval → approve → result in the Inbox.
3. Settings → Automation → add a daily schedule → **Run now** → a task appears and runs.

## Follow-ons (not deploy steps)
- **Send the Emil onboarding email** (Danish) via the `email_campaign` approval once the bridge is live.
- **Reclaim VM disk** if tight: `docker builder prune -af && docker image rm openclaw:local`.
