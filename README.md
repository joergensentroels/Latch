# Latch

Latch is a private agent gateway for sending instructions, status updates, model calls, and approvals between an operator and an OpenClaw machine.

Read [SECURITY.md](./SECURITY.md) before exposing it beyond localhost.

If this is prepared for a public GitHub repository, also read [OPEN-SOURCE.md](./OPEN-SOURCE.md), [AGENT-BOUNDARY.md](./AGENT-BOUNDARY.md), [HUMAN-REQUESTS.md](./HUMAN-REQUESTS.md), [SECURITY-REVIEW.md](./SECURITY-REVIEW.md), [MAILBOX-BROWSER.md](./MAILBOX-BROWSER.md), and [NOTIFICATIONS.md](./NOTIFICATIONS.md). The short version: the code can become public, but live keys, GitHub write credentials, provider API keys, notification tokens, and `data\` must stay private.

For the Ubuntu OpenClaw worker VM, see [OPENCLAW-WORKER.md](./OPENCLAW-WORKER.md).

OpenClaw should inspect this project from its own VM-local read-only checkout, not from the trusted Windows working tree.

## Start locally

```powershell
powershell -ExecutionPolicy Bypass -File .\Start-CommandCenter.ps1
```

Open:

```text
http://127.0.0.1:8787
```

Latch creates two keys:

- `Operator key`: use this in the web app.
- `Agent key`: use this from the OpenClaw machine.

Show keys on the trusted Windows host:

```powershell
powershell -ExecutionPolicy Bypass -File .\Show-CommandCenter-Keys.ps1
```

This app uses only Node.js built-ins and no downloaded dependencies.

Run a local operator health check:

```powershell
powershell -ExecutionPolicy Bypass -File .\Invoke-Latch-Doctor.ps1
```

Run a local health/key check:

```powershell
powershell -ExecutionPolicy Bypass -File .\Test-CommandCenter.ps1
```

## External LLM fallback

While Ollama/GPU serving is paused, Latch can act as a private external-API gateway. OpenClaw calls this app with the agent key, and this app calls an OpenAI-compatible provider with an API key stored only on the Windows machine.

Configure it later when you have the key:

```powershell
powershell -ExecutionPolicy Bypass -File .\Configure-External-LLM.ps1 `
  -Provider "openai-compatible" `
  -BaseUrl "https://api.openai.com/v1" `
  -Model "replace-with-model-name" `
  -PromptForApiKey
```

Test it after Latch is running:

```powershell
powershell -ExecutionPolicy Bypass -File .\Test-External-LLM.ps1
```

See [LLM-PROVIDER.md](./LLM-PROVIDER.md) for the agent endpoint and security notes.

## Install on phone

For the current Android setup, see [PHONE-SETUP.md](./PHONE-SETUP.md). The verified private phone URL is:

```text
http://<windows-tailscale-ip>:8787
```

This is a progressive web app. Phone installation works best over HTTPS, so use Tailscale Serve rather than a plain `http://100.x.y.z:8787` URL.

Start the app locally:

```powershell
powershell -ExecutionPolicy Bypass -File .\Start-CommandCenter.ps1
```

In another PowerShell window, publish it privately inside your tailnet:

```powershell
powershell -ExecutionPolicy Bypass -File .\Serve-Over-Tailscale.ps1
```

Open the HTTPS Tailscale URL shown by the script or by `Status-Latch.ps1` on your phone. The script records it in `data\local-settings.json` as `privateHttpsUrl` when Tailscale reports the device DNS name.

If the script says HTTPS certificates are not enabled yet, enable them once in the Tailscale admin console under DNS:

```text
https://login.tailscale.com/admin/dns
```

Do not use Tailscale Funnel for Latch.

- Android Chrome: open the site, then choose `Install app` or `Add to Home screen`.
- iPhone Safari: open the site, tap Share, then choose `Add to Home Screen`.

The installed app keeps the shell cached on the phone. Live messages, tasks, and approvals still require network access to this host.

## Notifications

The phone app can request browser notification permission with the `!` button in the top bar. For more reliable lock-screen alerts, configure a server-side push provider such as ntfy:

```powershell
powershell -ExecutionPolicy Bypass -File .\Configure-Notifications.ps1 `
  -Provider "ntfy" `
  -Url "https://ntfy.sh/replace-with-private-random-topic" `
  -Enable
```

Test after Latch is running:

```powershell
powershell -ExecutionPolicy Bypass -File .\Test-Notifications.ps1
```

See [NOTIFICATIONS.md](./NOTIFICATIONS.md).

## Tailscale mode

Run the server on the host Tailscale address:

```powershell
powershell -ExecutionPolicy Bypass -File .\Start-Latch-Tailscale.ps1
```

Stop or check it:

```powershell
powershell -ExecutionPolicy Bypass -File .\Status-Latch.ps1
powershell -ExecutionPolicy Bypass -File .\Stop-Latch.ps1
```

`Start-Latch-Tailscale.ps1` now restarts existing Latch Node listeners by default before launching. This prevents stale server code from surviving an app update. Use `-NoRestartExisting` only when you intentionally want a no-op if Latch is already healthy.

Optional Windows logon auto-start:

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-Latch-StartupTask.ps1
```

Optional Windows boot auto-start, run from an Administrator PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-Latch-SystemStartupTask.ps1
```

Remove auto-start:

```powershell
powershell -ExecutionPolicy Bypass -File .\Uninstall-Latch-StartupTask.ps1
```

You can also run it manually on a chosen address:

```powershell
$env:HOST="<windows-tailscale-ip>"
$env:PORT="8787"
powershell -ExecutionPolicy Bypass -File .\Start-CommandCenter.ps1
```

Then browse from your phone over Tailscale:

```text
http://<host-tailscale-ip>:8787
```

Plain HTTP is useful for quick testing, but phone app installation usually requires HTTPS. Tailscale Serve provides HTTPS privately inside your tailnet. Do not expose this app with router port forwarding. Use Tailscale private networking, and avoid Tailscale Funnel unless you intentionally want public internet exposure.

To check the currently known URLs:

```powershell
powershell -ExecutionPolicy Bypass -File .\Status-Latch.ps1
```

## Context Library

The Context tab is for operator-provided memory: goals, boundaries, personality notes, background, and small supporting files.

The top of the Context tab has an Agent Profile section for durable identity and direction:

- working name
- purpose
- current goals
- boundaries
- communication style

When `Share with worker` is enabled, this profile is sent to the worker as a structured briefing before ordinary context notes. This is the preferred place to shape the agent's personality and agency over time.

Context notes and uploaded files are stored under:

```text
data\
```

Uploaded files are stored in `data\context-files\`. The whole `data\` folder is ignored by Git, because it may contain private context, keys, logs, and local settings.

Current limits:

- file uploads are limited to 2 MB each
- operators can see full note text and download files
- context items can be categorized as `goals`, `personality`, `security`, `project`, `memory`, `reference`, or `other`
- notes can be shared with the worker as durable memory
- file contents are private by default and are shared only when explicitly enabled
- shared file contents are sent to the worker only for text-like files up to 200 KB

For normal context, use the Latch browser/app upload flow. SSH is still fine for large files, VM administration, or one-off maintenance, but files copied directly over SSH are not automatically tracked in Latch Context unless you add a note or future import step.

Use the Timeline tab for local operations:

- `Backup` writes a timestamped copy of `data\db.json` to `data\backups\`
- `Export Context` downloads the current Context library as JSON
- Archive buttons remove test items from active views without deleting them
- Archived items can be restored or permanently deleted from Timeline

## App Lock

The `P` button in the top bar sets or activates a local app lock for the current browser/device. This is meant for the practical phone-handoff case: if your phone is unlocked, Latch can still require a PIN or passkey before showing notes and messages.

The PIN and passkey registration are local to that installed app/browser profile. They do not replace the operator key, phone OS lock, or Tailscale. Passkey unlock requires private HTTPS, such as Tailscale Serve, because browser biometrics require a secure context.

Latch also warns when it is opened from a route that does not look like localhost, a Tailscale `100.x.y.z` address, or a `.ts.net` private URL.

## Emergency Lockdown

If you accidentally expose a key or something feels wrong, rotate both Latch keys immediately:

```powershell
cd "C:\Users\troel\Documents\LLM server\openclaw-command-center"
powershell -ExecutionPolicy Bypass -File .\Emergency-Latch-Lockdown.ps1
```

This backs up `data\auth.json`, writes a fresh operator key and agent key, and restarts Latch so the old keys stop working. The OpenClaw bridge will be locked out until you update its `LATCH_AGENT_KEY`.

To stop serving as well:

```powershell
powershell -ExecutionPolicy Bypass -File .\Emergency-Latch-Lockdown.ps1 -StopServing
```

After rotation, show the new local operator key only on the trusted Windows machine:

```powershell
powershell -ExecutionPolicy Bypass -File .\Show-CommandCenter-Keys.ps1
```

## Agent API

Use the agent key as a bearer token:

The default worker bridge is safe text-only. It can answer tasks through Latch's LLM gateway and can request operator approvals for risky work, but it does not execute commands, use credentials, control a browser, make purchases, or receive provider API keys.

Non-sensitive approval notes can be used for follow-up answers. Sensitive approval notes stay inside Latch and are not forwarded to the external LLM.

The first execution-capable bridge mode is limited to approved read-only diagnostics. It never runs raw command text from Latch. Instead, approvals may reference one of these fixed templates:

- `bridge.status`
- `bridge.logs`
- `openclaw.gateway.health`
- `docker.status`
- `tailscale.status`
- `repo.status`

Latch shows the template summary first and keeps exact commands behind an expandable details section. Execution results are stored as concise audit summaries under Timeline > Operations.

```http
Authorization: Bearer agent_...
```

Poll work:

```http
GET /api/agent/poll
```

The poll response includes queued tasks, recent messages, approvals, and recent context. Only explicitly shared notes and small text-like file contents are included for the worker.

Report status:

```http
POST /api/agent/report
Content-Type: application/json

{
  "text": "Started task.",
  "taskId": "task_..."
}
```

Request approval:

```http
POST /api/approvals
Content-Type: application/json

{
  "type": "command",
  "title": "Run command",
  "details": "OpenClaw wants to run a command.",
  "command": "example command"
}
```

Request a read-only diagnostic approval:

```http
POST /api/approvals
Content-Type: application/json

{
  "type": "command",
  "title": "Read-only diagnostic approval needed",
  "details": "Check whether the bridge is active.",
  "riskLevel": "low",
  "actionTemplate": "bridge.status",
  "actionPreview": "Check Latch bridge service status",
  "renderedCommands": ["systemctl is-active latch-agent-bridge"],
  "executionMode": "read_only_status"
}
```

Request human help for a verification step:

```http
POST /api/approvals
Content-Type: application/json

{
  "type": "human_verification",
  "title": "Email verification needed",
  "details": "Please create or verify the project email account on your trusted device.",
  "expectedResponse": "Tell me when the account is ready. Do not share your main account password.",
  "sensitive": true
}
```

Ask the operator a context question:

```http
POST /api/approvals
Content-Type: application/json

{
  "type": "context_question",
  "title": "Context question",
  "details": "- What should the worker optimize for?",
  "expectedResponse": "Answer this if you want it saved as worker context.",
  "contextCategory": "personality",
  "contextTags": ["operator-answer"]
}
```

When the operator saves an answer, Latch stores it as a shared Context note.

Supported approval types:

- `command`
- `human_verification`
- `account_setup`
- `purchase`
- `credential`
- `other`

## OpenClaw bridge stub

The included PowerShell bridge is a safe polling stub. It does not execute tasks yet; it only connects, polls, and reports queued work.

```powershell
powershell -ExecutionPolicy Bypass -File .\openclaw-agent-bridge.ps1 `
  -BaseUrl "https://<host>.<tailnet>.ts.net" `
  -AgentKey "agent_..."
```

Later, this bridge can become the place where OpenClaw translates queued Latch tasks into actual local actions.

Bridge smoke test:

```powershell
powershell -ExecutionPolicy Bypass -File .\openclaw-agent-bridge.ps1 `
  -BaseUrl "http://127.0.0.1:8787" `
  -AgentKey "agent_..." `
  -Once
```
