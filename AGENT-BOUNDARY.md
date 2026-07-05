# Agent Boundary

Latch's safety rests on two independent axes. Keep them separate in your head — most confusion comes from mixing them.

## Axis 1 — Autonomy tier (how much the agent does without asking)

The operator picks one tier (and only the operator can — `/api/autonomy` is operator-gated; the agent can never raise its own level). Default is **Approve everything**.

| Tier | The agent may do, unattended | Still always asks the operator |
|------|------------------------------|-------------------------------|
| **Approve everything** (`default_permissions`) | Plan, draft, suggest | Every real action |
| **Auto read-only** (`auto_review`) | Read-only diagnostics; tightly bounded exact-URL public research | Anything that changes state |
| **Auto-browse** (`auto_browse`) | The above **plus** navigate/read/extract on HTTPS sites unattended | Shell, commits, using your accounts, and any login/credential/HTTP step |
| **Full auto** (`full_access`) | Non-sensitive shell + browser plans + CompassProjects commits | The hard boundaries in Axis 2 below |

> ⚠️ **Full auto** lets a compromised or prompt-injected agent run code on the worker without asking. It is an explicit operator opt-in — only enable it on the disposable, network-isolated worker (see [SECURITY.md](./SECURITY.md) → Deployment Topology).

## Axis 2 — Whose account an action uses (a hard boundary at *every* tier)

This axis does not relax as you raise the tier. It is about **identity**, not volume.

### The agent's own accounts — the agent controls these
The agent may be given its **own** dedicated, low-trust, revocable accounts (e.g. its own email mailbox, its own scratch logins). It operates them itself, governed by the autonomy tier above. Its email is *its* email.

### The operator's ("your") accounts — the agent may never hold these
Your personal email, your GitHub token, provider API keys, notification tokens, bank/finance sessions, your main logins. The agent **never receives these credentials**. When a task needs one, the agent creates an approval; after you approve, the **trusted host** performs the action with your credential and returns only the result. The worker never sees the secret.

**The template already exists: GitHub.** The agent asks for a `github_file`/`github_repo` approval; the host commits with the token; the worker never touches it. Every operator-owned account follows this same broker pattern.

## Allowed For Agents (via the agent API, agent key only)

- Latch base URL over Tailscale; agent key only
- `GET /api/agent/poll`, `POST /api/agent/report`, `POST /api/approvals`, `POST /api/agent/executions`
- `POST /api/llm/chat` if external LLM fallback is enabled
- Approval requests for commands, browser/research plans, human verification, and other sensitive actions
- Approved execution plans (per the active tier) through the separate VM executor service
- Its **own** accounts (e.g. the agent mailbox), operated per the tier and the agent-email rules below

## Keep Away From Agents (operator-owned — broker via approval instead)

- Operator key
- Your email account credentials (as opposed to the agent's own mailbox)
- External provider API keys
- GitHub personal access tokens
- SSH deploy keys with write access
- `data/` directory contents
- Windows user profile files
- Tailscale admin credentials
- Your browser sessions or password managers
- Revolut / bank sessions

## Agent email (agent-owned mailbox)

The agent may operate its **own** mailbox. Rules:

- **Host-brokered:** the mailbox credentials live on the host, not the worker. The agent calls the host to send/read; the worker never holds SMTP/IMAP credentials.
- **Never your mailbox:** sending as *you* remains an operator-owned action (broker + approval). The agent sends only as itself.
- **Cold first-contact needs approval with a stated plan:** before the first message to a *new* recipient, the agent files an approval that states the outreach plan — how many recipients it expects to contact and why. The operator approves the campaign scope; the agent then sends first-contacts within that approved scope and handles the ongoing reply threads autonomously (subject to the tier). Exceeding the approved count/scope needs a new approval.
- **Rate-limited and audited:** even on its own account, the host enforces a send rate limit and logs every send/read, so a compromised agent cannot quietly blast mail.
- Reputational/legal note: autonomous outreach still carries real-world constraints (GDPR consent, CAN-SPAM, deliverability). Those are policy decisions layered on top of this technical boundary.

**Mailbox provider is your choice, not Latch's.** `email.mjs` speaks generic SMTP + IMAP and nothing else — it has no code path specific to any provider. Gmail/Fastmail/Zoho with an app password, Proton via Bridge, a self-hosted Mailu/Mail-in-a-Box instance, anything that speaks standard SMTP+IMAP over TLS: all equally supported, none of them "the intended way." The maintainer's own instance currently uses a standard hosted mailbox with an app password, picked for zero setup friction and reliable delivery. A fully self-hosted mailbox (matching this project's not-for-profit/self-hosting spirit more completely) is a real candidate for later, once the tradeoffs are worth it — chiefly, outbound deliverability from a residential IP to large providers (e.g. Microsoft) is unreliable regardless of correct configuration, and receiving mail requires exposing something to the public internet on port 25, unlike every other Latch/OpenClaw component. Pick whatever fits your own values, budget, and deliverability needs; `agent-email.example.json` only needs a host/port/user/pass, same as any other mail client would.

## If The Project Becomes Public

Open source means anyone — including an internet-capable agent — can read every line. Security must not depend on hiding code. The real boundary is capability:

- An agent can know how the API works.
- An agent must not hold secrets that grant operator, provider, GitHub, finance, or host-admin powers, nor your account credentials.
- Publishing happens from a trusted human workstation, not the disposable worker.
- If the worker needs source context, give it a read-only checkout, never a write-capable credential.

## Good Default

Run the worker with: no GitHub credentials, no provider API key, only the Latch agent key, its own dedicated low-trust accounts (never yours), network access limited to what the task needs, approval-gated executor plans for VM shell/browser actions, and human approval for anything using your accounts, purchases, infrastructure changes, credential changes, and account/verification steps. Keep bridge and executor as separate services so chat/planning stays distinct from VM execution.
