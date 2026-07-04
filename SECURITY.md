# Security Notes

## Reporting a Vulnerability

Please report security vulnerabilities privately through **[GitHub Security Advisories](https://github.com/joergensentroels/Latch/security/advisories/new)** rather than a public issue. This keeps the details private between you and the maintainer until a fix is ready.

Include, if possible: the affected file/endpoint, a reproduction, and the impact you believe it has. There's no bug bounty here — this is a solo/community project — but every report will get a response and, once fixed, credit in the release notes if you'd like it.

This is a young project (first public release) with a single maintained line (`main`); there isn't yet a versioned support policy beyond "the latest commit on `main`."

## Intended Exposure

Latch is intended for private use over Tailscale.

Use:

- Tailscale private network
- Tailscale Serve for private HTTPS
- Operator key for the human web app
- Agent key for the OpenClaw machine

Avoid:

- router port forwarding
- Tailscale Funnel
- public reverse proxies
- sharing keys in chat apps
- giving OpenClaw GitHub write credentials

## Deployment Topology and Isolation

Latch's safety comes from an *isolation boundary*, not from any particular hardware. The control plane (this Latch app) holds the secrets — operator/agent keys, provider keys, GitHub token, and `data/` — while the OpenClaw worker holds none of them and reaches the control plane only through the authenticated agent API. That invariant is what contains a compromised or prompt-injected agent, and it holds whether the two sides run on two physical machines or two VMs.

**The reference setup (two separate machines) is a choice, not a requirement.** It is the maximum-isolation end of a spectrum. Pick the point that fits your threat model:

- **Separate physical machines** — strongest. No shared hypervisor or host, so an escape from the worker cannot reach the control plane.
- **Two VMs on one host** — recommended default for most users. Same *logical* boundary (separate OS, kernel, and memory; the worker is confined to its guest), and effectively as safe against the threat Latch is built for: a misbehaving or prompt-injected agent trying to reach credentials.
- **Worker in a microVM (e.g. Firecracker) or gVisor sandbox** — a middle ground with a much smaller escape surface than a plain container, close to VM-grade isolation on a single host.
- **Containers or same-host processes** — weakest; a container escape is a lower bar. Suitable only for low-risk local experimentation.

**Caveats when the control plane and worker share one machine (VMs or containers):**

- **Shared hypervisor** — a VM-escape vulnerability (guest → hypervisor → other guest) collapses the boundary. Rare and high-severity, but a vector that separate hardware does not have.
- **Shared host** — if the host OS is compromised by another route, both sides fall together.
- **Side channels** — co-resident guests share CPU/cache hardware. Largely irrelevant to the agent threat model; relevant only against a sophisticated co-resident attacker.

**To keep the boundary intact on a single host:**

- Put the worker on a host-only or internal network that can reach only the Latch control plane's endpoint — not the wider LAN or the internet unless a task requires it.
- Do not enable shared folders or a shared clipboard between the worker and the control plane. Shared folders are the usual accidental hole that exposes `data/`.
- Give the worker no host-management access — no host agent, no back-channel to the hypervisor.
- Keep the "worker never holds secrets" rule (see Keys below and [AGENT-BOUNDARY.md](./AGENT-BOUNDARY.md)) regardless of topology. Isolation is the second line of defence, not the first.

**Bottom line:** run on separate hardware for maximum separation; two VMs on one host is a reasonable and far more accessible default; do not run the worker as an unisolated same-host process for anything you would not hand a stranger.

## Keys

Keys live in:

```text
data/auth.json
```

The operator key unlocks the web app. The agent key is for the disposable OpenClaw machine.

The agent key is intentionally narrower than the operator key. Agents should not receive the operator key, GitHub write tokens, provider API keys, or access to the live `data\` directory.

External LLM provider keys live in:

```text
data/llm-provider.json
```

That file is intentionally kept under `data\` so it stays local to this Windows machine. The OpenClaw machine should call the Latch gateway with its agent key instead of storing the external provider API key directly.

Notification provider tokens live in:

```text
data/notifications.json
```

Agents should not receive notification provider tokens. Latch should send phone alerts on the operator's behalf.

GitHub repository-creation tokens live in:

```text
data/github.json
```

or in trusted-host environment variables such as `GITHUB_TOKEN`. The OpenClaw worker should never receive the GitHub token. It can request a `github_file` approval for an existing repository or a broader `github_repo` approval for repository creation; after operator approval, or Full access auto-approval for the configured `CompassProjects` repo, the trusted Latch host performs the GitHub action and returns only the URL/name to the worker.

Operator-provided context lives in:

```text
data/db.json
data/context-files/
data/backups/
```

Treat this as private data. It can contain goals, notes, uploaded documents, and other sensitive context.

Agents receive:

- metadata for recent context items
- full note text only when the item is marked `shareWithAgent`
- text-like uploaded file contents only when explicitly shared and no larger than 200 KB

Keep secrets, recovery codes, payment data, and long-lived credentials out of shared context.

Use the built-in backup/export controls before manual maintenance. Backups remain local under `data\` and are not tracked by Git.

## Local App Lock

The Latch web app can use a local PIN lock on each browser/device. On private HTTPS, it can also register a local passkey/biometric unlock. This protects against casual access when a phone is already unlocked, but it is not a replacement for the operator key, Tailscale, or the phone's OS-level lock.

The PIN verifier and passkey credential ID are stored in browser storage on that device. Current passkey unlock is a local device gate; it relies on the browser/OS user-verification prompt and does not replace server-side authentication. Browser passkeys require private HTTPS, for example via Tailscale Serve, because WebAuthn is not available on ordinary `http://100.x.y.z` pages.

To rotate keys:

1. Stop the app.
2. Rename or delete `data/auth.json`.
3. Start the app again.
4. Update the phone and OpenClaw bridge with the new keys.

## Current Bridge Safety

`worker/latch-agent-bridge.py` does not execute shell/browser plans directly. It:

- connects to Latch
- polls queued work
- sends bounded prompts through the Latch LLM gateway
- uses explicitly shared context as a briefing
- creates approval cards, context questions, and exact VM execution plans

Execution is split into a separate `latch-agent-executor` service. The bridge remains a planning/reporting process; the executor polls approved non-sensitive command approvals with `executionMode` set to `shell` or `browser`, runs the exact stored plan once, and records an execution audit.

Auto-approval rests only on **host-verifiable typed operations**, never on worker-asserted risk, and **arbitrary shell/browser plans are never auto-approved in any tier** — a human always reads the exact plan. Under Full access the auto-approvable set is: read-only diagnostic templates, bounded exact-URL research, operator-listed MCP tools, and `CompassProjects` file commits (operator / operator-managed Pro users only). The operator can additionally allow specific typed operations via host-side grants (see [AUTONOMY.md](./AUTONOMY.md)). Credentials, purchases, account setup, external contact, GitHub repo creation, human verification, and context answers always require a human. This design follows external review: worker self-assessed sensitivity is not a security boundary, and arbitrary operations cannot be validated host-side.

Shell plans run on the OpenClaw VM through `bash -lc` with a timeout and audit logs. Browser plans use Playwright-managed Firefox in a headless isolated profile under `/var/lib/latch-agent-executor/browser`.

## External LLM Gateway

The `/api/llm/chat` endpoint lets an authenticated operator or agent ask the configured external provider for a response. Keep this endpoint private over Tailscale, use provider spending limits where possible, and rotate the provider key if the disposable machine is compromised.

## Human Verification

Agents may request human help with CAPTCHA, email confirmation, account setup, or similar steps by creating an approval with `type: "human_verification"`.

The operator should complete those steps only on a trusted device and return the minimum useful result. Do not give the agent your main account, password manager, 2FA seed, recovery email, banking session, or long-lived personal credentials.

## External Contact

The agent never holds a mailbox credential, social account, or unrestricted browser session. There are two supported outbound paths, both with the operator on the boundary:

- **`external_contact` (draft-only).** For operator-identity messages (e.g. reaching a named collaborator or security reviewer). The agent drafts in Latch; approval does **not** send — the operator sends manually. Unchanged.
- **Agent email (host-brokered).** The companion may operate its *own* mailbox and send from it, but the SMTP/IMAP credentials live only on the trusted host (`email.mjs`) — never on the worker. The worker can only *request* a send by creating an `email_campaign` approval; the host performs the actual send after approval. First contact with a new recipient always requires operator approval (cold contact is gated server-side). Replies to already-known contacts can send without a fresh approval, backstopped by a per-thread reply cap and mailbox rate limits. The LLM only writes/summarizes content — recipient selection is programmatic, never model-chosen.

The design invariant holds across both: a compromised or prompt-injected worker still cannot send on its own, because it holds no mail credential and every first send is host-brokered behind an operator approval.

See [AGENT-BOUNDARY.md](./AGENT-BOUNDARY.md#agent-email-agent-owned-mailbox), [MAILBOX-BROWSER.md](./MAILBOX-BROWSER.md), and the dated [SECURITY-FINDINGS-2026-07.md](./SECURITY-FINDINGS-2026-07.md) for the full model and the latest self-review.

## Web Research

Agents should not scrape broadly or browse without a reviewed plan. Latch supports `web_research` approval records for bounded source-note research (which can auto-approve) and `browser` execution plans (which always require operator approval — arbitrary browsing is never auto-run). Browser downloads are audited and are not automatically opened or executed.

## GitHub Repository Creation

GitHub repository updates are host-side connectors, not VM credentials. Keep the GitHub token narrow, rotate it if exposed, and prefer a fine-grained token scoped to one existing repository with `Contents: read/write`. Repo creation always stays on the human-boundary approval path. File updates to the configured `CompassProjects` repo may auto-commit in Full access for operator or Pro-user sources; file updates to other repositories still require human review.

## Phone Install

For phone installation, prefer the HTTPS URL created by Tailscale Serve. Some mobile browsers limit PWA installation on plain HTTP.

## First-Run Checklist

- Open Latch through Tailscale, preferably the private `https://*.ts.net` Serve URL.
- Set the local app PIN with the `P` button.
- Add a passkey from the same dialog if the phone/browser offers it.
- Keep Tailscale Funnel off for Latch.
- Confirm `Status-Latch.ps1` shows only private URLs.
