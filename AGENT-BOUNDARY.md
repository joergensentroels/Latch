# Agent Boundary

Latch's safety rests on two independent axes. Keep them separate in your head — most confusion comes from mixing them.

## Axis 1 — Autonomy tier (how much the agent does without asking)

The operator picks one tier (and only the operator can — `/api/autonomy` is operator-gated; the agent can never raise its own level). Default is **Approve everything**.

Every tier auto-approves only **typed, host-verifiable operations**. Raising the tier adds *types*; it
never adds "and now arbitrary things too". **Arbitrary shell and browser plans are never auto-approved in
any tier**, including the highest, and cannot be granted either — `isArbitraryExecution()` in `server.js`
returns them to the operator before any tier is consulted.

| Tier | Adds, unattended | Still always asks the operator |
|------|------------------|-------------------------------|
| **Approve everything** (`default_permissions`) | nothing — plan, draft, suggest | Every real action |
| **Auto read-only** (`auto_review`) | read-only diagnostics (fixed host templates); tightly bounded exact-URL public research | Anything that changes state |
| **Auto typed tools** (`auto_browse`) | the above **plus** operator-listed MCP tools whose arguments the host validates against the tool's declared schema | Arbitrary browsing and shell, commits, using your accounts, and any login/credential/HTTP step |
| **Auto all typed ops** (`full_access`) | the above **plus** `CompassProjects` file commits, for operator or operator-managed Pro sources | Arbitrary shell and browser plans, plus the hard boundaries in Axis 2 below |

> ⚠️ **This table was wrong until 2026-08-15, in the direction that flatters the code.** The
> `auto_browse` row described unattended page navigation and extraction across HTTPS sites, and the
> `full_access` row described the release of non-sensitive shell and browser plans. Neither has ever been
> true: `auto_browse` adds operator-listed MCP tools and nothing else — it says so in its own refusal
> string — and shell and browser plans are refused at every tier. The tiers were also *named* for the
> behaviour the table described, so the names taught the same wrong model; the accurate names are above.
> The code errs safe; the documentation did not. `test/autonomy-vocabulary.mjs` now derives this table's
> tier names from `server.js` and fails if they drift again.
>
> _The old wordings are described here rather than quoted, deliberately. The same test blocks their
> literal strings from reappearing in any document, and prose explaining a forbidden phrase is a
> well-worn way to disarm the check that forbids it._

> ⚠️ Even at **Auto all typed ops**, an operator-listed MCP tool runs without you seeing it. That is an
> explicit opt-in, and the list is yours to keep short — prefer the disposable, network-isolated worker
> (see [SECURITY.md](./SECURITY.md) → Deployment Topology).

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
