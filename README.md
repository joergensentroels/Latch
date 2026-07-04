# Compass, powered by Latch

> **New here? Start with [GETTING-STARTED.md](./GETTING-STARTED.md)** — zero to first task, for both a two-machine and a two-VM setup.

Compass is the user-facing companion app for sending instructions, receiving status updates, managing context, and reviewing approvals. Latch is the private infrastructure layer underneath it: routing, approvals, keys, bridges, nodes, and worker trust boundaries.

The mission is to help people bring good ideas to life when time, energy, or cognitive load would otherwise keep those ideas unrealized. Compass and Latch are intended to be community-based and not-for-profit in spirit: a shared service for enabling people, not extracting attention, dependency, or profit. Read [COMMUNITY-MISSION.md](./COMMUNITY-MISSION.md) and [COMPANION-ANCHOR.md](./COMPANION-ANCHOR.md) for the values every companion starts from.

Naming:

- **Compass**: the installed app and operator UI.
- **Compass Companion**: the default agent/persona inside Compass.
- **Latch**: the private infrastructure, nodes, approvals, routing, bridges, and keys.
- **OpenClaw**: the local/VM worker runtime that gives Compass real browser, shell, file, download, and automation agency.

Product tiers:

- **Chat-only**: conversation only.
- **Compass Simple**: durable memory, goals, task queue, approvals, continuity, history, and credit-backed stronger reasoning. It does not have direct browser, shell, file, download, or external-action powers.
- **Compass Pro/self-hosted**: Compass Simple plus a paired OpenClaw worker for real agency under Latch approvals and audit.
- **Future hosted Compass**: Compass Simple plus a managed hosted worker using the same scoped worker contract, so nontechnical users do not need to run their own VM.

Credits and Latch Network compute can make reasoning stronger, but they are not an agent runtime. Real action requires a worker somewhere: self-hosted, community-operated, or future hosted.

> ⚠️ **Security first.** Latch is designed so the worker running your AI agent never holds your credentials — but it is still early software. Do not expose it beyond localhost or your private Tailscale network before reading [SECURITY.md](./SECURITY.md), and don't run "Full auto" autonomy against anything you can't afford to lose. Found a vulnerability? See [Reporting a Vulnerability](./SECURITY.md#reporting-a-vulnerability).

Read [SECURITY.md](./SECURITY.md) before exposing it beyond localhost.

If this is prepared for a public GitHub repository, also read [OPEN-SOURCE.md](./OPEN-SOURCE.md), [AGENT-BOUNDARY.md](./AGENT-BOUNDARY.md), [HUMAN-REQUESTS.md](./HUMAN-REQUESTS.md), [SECURITY-REVIEW.md](./SECURITY-REVIEW.md), [SECURITY-REVIEW-PACKET.md](./SECURITY-REVIEW-PACKET.md), [MAILBOX-BROWSER.md](./MAILBOX-BROWSER.md), and [NOTIFICATIONS.md](./NOTIFICATIONS.md). The short version: the code can become public, but live keys, GitHub write credentials, provider API keys, notification tokens, and `data\` must stay private.

For the Ubuntu OpenClaw worker VM, see [OPENCLAW-WORKER.md](./OPENCLAW-WORKER.md).

OpenClaw should inspect this project from its own VM-local read-only checkout, not from the trusted Windows working tree.

## Current Powers

| Capability | Status |
| --- | --- |
| Compass text responses through Latch | Enabled |
| Read-only VM diagnostics | Approval-gated |
| Exact-URL web research | Approval-gated |
| GitHub repository creation | Approval-gated trusted-host connector |
| External contact drafts | Manual send only |
| Email sending | Not enabled |
| Interactive browser automation | Full-access executor gated |
| Write/system commands | Full-access executor gated |

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

Include OpenClaw VM checks after SSH is configured:

```powershell
powershell -ExecutionPolicy Bypass -File .\Invoke-Latch-Doctor.ps1 -VmHost "<openclaw-vm-tailscale-ip>"
```

Run a local health/key check:

```powershell
powershell -ExecutionPolicy Bypass -File .\Test-CommandCenter.ps1
```

Run the full local test suite:

```powershell
npm test
```

## Publishing changes

Use the repo-local push helper when you want to commit and push Latch changes from the trusted Windows working tree:

```powershell
powershell -ExecutionPolicy Bypass -File .\Push-Latch.ps1 -DryRun
powershell -ExecutionPolicy Bypass -File .\Push-Latch.ps1 -Yes -Message "Update Latch"
```

The helper resolves Git from common Windows install locations, shows the files it will include, refuses paths that look secret-like unless explicitly allowed, commits, rebases from `origin/main`, and pushes.

For worker releases, use [OPENCLAW-WORKER.md](./OPENCLAW-WORKER.md)'s `Push-And-Deploy.ps1` flow so the pushed GitHub code and deployed VM worker stay aligned.

## External LLM fallback

While Ollama/GPU serving is paused, Latch can act as Compass's private external-API gateway. OpenClaw calls this app with the agent key, and this app calls an OpenAI-compatible provider with an API key stored only on the Windows machine.

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

## Latch Network private alpha

Latch can now coordinate trusted private compute workers. This is a private-alpha worker marketplace: operators create one-time worker invites in Timeline > Latch Network, workers poll Latch over Tailscale/HTTPS, and eligible non-sensitive LLM calls can route to them with internal credits.

Run a lending worker on a trusted machine with either Ollama or an OpenAI-compatible local endpoint:

```bash
python3 worker/latch-network-worker.py \
  --base-url "https://<windows-latch-tailscale-serve-name>" \
  --worker-token "worker_..." \
  --backend ollama \
  --backend-url "http://127.0.0.1:11434" \
  --models "qwen2.5-coder:14b" \
  --default-model "qwen2.5-coder:14b"
```

The worker receives only assigned chat jobs and never receives the operator key, agent key, external provider API keys, or unshared Context. Context has a separate `Share with network compute` control; ordinary `Share with worker` notes are not sent to network workers.

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

## GitHub Repo Creation

Compass can request a new GitHub repository through Latch without giving the worker a GitHub token. The token is stored only on the trusted Windows host under `data\github.json` or provided through host environment variables.

Configure it on the trusted host:

```powershell
powershell -ExecutionPolicy Bypass -File .\Configure-GitHub.ps1 -PromptForToken
```

Use a fine-grained GitHub token with the narrowest permission you can. For an existing repository such as `CompassProjects`, select only that repository and grant **Contents: read/write**. Then configure the target:

```powershell
powershell -ExecutionPolicy Bypass -File .\Configure-GitHub.ps1 -Owner "your-github-username" -DefaultRepo "CompassProjects" -PromptForToken
```

When the companion asks for development work, code, websites, a README, or another file update, Latch creates a `github_file` approval card with the repository, path, commit message, and proposed content. Development and code/file updates default to `CompassProjects` unless another repository is named. In Full access, non-sensitive `CompassProjects` file updates from the operator or operator-managed Pro users can auto-approve and commit through the trusted host connector. The worker never receives the GitHub token.

Repository creation is still supported with `github_repo`, but it requires broader GitHub administration permission because the repository does not exist yet. Prefer creating the repo yourself and using `github_file` updates for day-to-day companion work.

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

For normal context, use the Compass browser/app upload flow. SSH is still fine for large files, VM administration, or one-off maintenance, but files copied directly over SSH are not automatically tracked in Latch Context unless you add a note or future import step.

Use the Timeline tab for local operations:

- `Backup` writes a timestamped copy of `data\db.json` to `data\backups\`
- `Export Context` downloads the current Context library as JSON
- Archive buttons remove test items from active views without deleting them
- Archived items can be restored or permanently deleted from Timeline

## App Lock

The `P` button in the top bar sets or activates a local app lock for the current browser/device. This is meant for the practical phone-handoff case: if your phone is unlocked, Compass can still require a PIN or passkey before showing notes and messages.

The PIN and passkey registration are local to that installed app/browser profile. They do not replace the operator key, phone OS lock, or Tailscale. Passkey unlock requires private HTTPS, such as Tailscale Serve, because browser biometrics require a secure context.

Compass also warns when it is opened from a route that does not look like localhost, a Tailscale `100.x.y.z` address, or a `.ts.net` private URL.

## Emergency Lockdown

If you accidentally expose a key or something feels wrong, rotate both Latch keys immediately:

```powershell
cd "C:\path\to\openclaw-command-center"
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

The default worker bridge is an approval-planning bridge. It answers tasks through Latch's LLM gateway, creates approval cards for risky work, and stores exact execution plans when VM action is needed. Approved shell/browser execution is handled only by the separate `latch-agent-executor` service on the OpenClaw VM.

Non-sensitive approval notes can be used for follow-up answers. Sensitive approval notes stay inside Latch and are not forwarded to the external LLM.

Read-only diagnostics still use fixed templates:

- `bridge.status`
- `bridge.logs`
- `openclaw.gateway.health`
- `docker.status`
- `tailscale.status`
- `repo.status`

Latch shows the template summary first and keeps exact commands behind an expandable details section. Execution results are stored as concise audit summaries under Timeline > Operations.

Full access can also auto-approve non-sensitive `shell` and `browser` execution plans, plus non-sensitive `CompassProjects` file updates, for operator tasks and operator-managed Pro users. Standard signed-in users stay approval-limited. Credentials, purchases, account setup, external contact, GitHub repo creation, human verification, and context answers remain human-boundary approvals.

The VM executor uses Playwright-managed Firefox for headless browser plans. Browser actions support opening pages, extracting text, screenshots, clicks, fills, key presses, waits, and controlled downloads. Shell plans run through `bash -lc` with a timeout and audit logging.

```http
Authorization: Bearer agent_...
```

Poll work:

```http
GET /api/agent/poll
```

The poll response includes queued tasks, recent messages, approvals, active Latch channels, the companion profile, and recent context. The profile includes the repo-defined Companion Anchor from `COMPANION-ANCHOR.md`; it is shown as read-only in the UI and treated as higher priority than user-editable profile fields. Anchor changes should be proposed and voted on in GitHub issues or pull requests labeled `companion-anchor`. Only explicitly shared notes and small text-like file contents are included for the worker.

Report status:

```http
POST /api/agent/report
Content-Type: application/json

{
  "text": "Started task.",
  "taskId": "task_...",
  "channel": "operations"
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

Request an approved shell execution plan:

```http
POST /api/approvals
Content-Type: application/json

{
  "type": "command",
  "title": "Run VM command",
  "details": "Run whoami on the OpenClaw VM.",
  "riskLevel": "low",
  "executionMode": "shell",
  "executionPlan": {
    "mode": "shell",
    "summary": "Run whoami",
    "sensitive": false,
    "riskLevel": "low",
    "timeoutSeconds": 30,
    "commands": ["whoami"],
    "expectedResult": "Current VM user"
  }
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
- `external_contact`
- `web_research`
- `github_repo`
- `github_file`
- `other`

## Legacy PowerShell bridge stub

The included PowerShell bridge is a legacy safe polling stub. The active Ubuntu worker path is `worker/latch-agent-bridge.py` plus the optional `worker/latch-agent-executor.py` service. The PowerShell stub only connects, polls, and reports queued work.

```powershell
powershell -ExecutionPolicy Bypass -File .\openclaw-agent-bridge.ps1 `
  -BaseUrl "https://<host>.<tailnet>.ts.net" `
  -AgentKey "agent_..."
```

For VM-local shell/browser actions, use the Ubuntu bridge/executor services instead.

Bridge smoke test:

```powershell
powershell -ExecutionPolicy Bypass -File .\openclaw-agent-bridge.ps1 `
  -BaseUrl "http://127.0.0.1:8787" `
  -AgentKey "agent_..." `
  -Once
```

Copy the latest worker bundle to the VM:

```powershell
powershell -ExecutionPolicy Bypass -File .\Deploy-Bridge-To-VM.ps1 -VmHost "<openclaw-vm-tailscale-ip>"
```

Deploy and restart the VM services in one step:

```powershell
powershell -ExecutionPolicy Bypass -File .\Deploy-Worker-To-VM.ps1 `
  -VmHost "<openclaw-vm-tailscale-ip>" `
  -HostAddress "<windows-tailscale-ip>" `
  -Activate `
  -RunDoctor
```

The deploy helper copies bridge and executor files to `~/latch-worker-next`, installs them into `/usr/local/bin` and `/etc/systemd/system` when `-Activate` is set, restarts the affected services, verifies status, and can run the local doctor. Use `-BridgeOnly` or `-ExecutorOnly` when you want a narrower update.

If the VM requires a sudo password, add `-InteractiveSudo`. When Codex or another tool starts the deploy and you want a visible password prompt, use `-InteractiveWindow`; it opens a separate PowerShell window for SSH/sudo interaction. For fully unattended deploys, configure narrow passwordless sudo for the install and systemctl commands.

Push to GitHub and deploy the VM worker after the push succeeds:

```powershell
powershell -ExecutionPolicy Bypass -File .\Push-And-Deploy.ps1 `
  -VmHost "<openclaw-vm-tailscale-ip>" `
  -HostAddress "<windows-tailscale-ip>" `
  -InteractiveWindow
```

This is the preferred local workflow when Codex changes worker code. Git has a `pre-push` hook but no reliable `post-push` hook, so the wrapper is safer than a hook: it runs `git push` first, then deploys only after the push succeeds.

By default the wrapper refuses to deploy when the working tree has uncommitted changes, because that would push one version and deploy another. Use `-AllowDirtyDeploy` only for an intentional hot deploy while testing.

Install the optional executor on the VM:

```bash
cd /path/to/worker
sudo bash install-latch-agent-executor.sh
sudo nano /etc/latch-agent-executor.env
sudo systemctl enable --now latch-agent-executor
```
