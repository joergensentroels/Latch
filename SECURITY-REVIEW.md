# Security Review And Co-Creator Contact

This document is the handoff checklist for a security-minded co-creator before Latch is made public or given broader agent powers.

## Current Trust Model

Latch is a private operator console. The trusted operator uses the Windows host and phone app. The OpenClaw VM is treated as semi-trusted and disposable.

The safe default is:

- Latch is reachable only through Tailscale/private LAN.
- Tailscale Funnel and router port forwarding stay off.
- The operator key stays on trusted operator devices.
- The agent key is the only Latch secret on the OpenClaw VM.
- External LLM provider keys stay on the Windows Latch host.
- GitHub write credentials stay off the OpenClaw VM.
- OpenClaw may inspect source through a read-only checkout only.
- Financial, payment, password manager, browser profile, and personal inbox access remain outside agent control.

## Current Agent Capability Boundary

The bridge can:

- poll Latch for tasks and messages
- send text-only reports
- call the Latch-hosted LLM gateway
- use explicitly shared context
- create approval requests
- run approved read-only diagnostic templates

The bridge cannot:

- run arbitrary commands
- use `sudo`
- install packages
- write or delete files
- restart services
- use shell pipes or redirects
- access payment accounts
- access the operator key
- access provider API keys
- send outbound email or messages to third parties

The bridge may create `external_contact` and `web_research` approval records. These are control records only; they do not grant mail, messaging, or browser powers.

## Future Co-Creator Contact

Eventually an agent may need to contact a potential collaborator, reviewer, or co-creator. That should be built as a supervised workflow, not as a general messaging power.

Recommended first version:

1. Agent drafts a message inside Latch.
2. Latch creates an approval with `type: "external_contact"`.
3. Operator reviews recipient, subject, body, attachments, and purpose.
4. Operator either sends it manually or approves sending through a narrow connector.
5. Latch stores an audit summary.

Do not start by giving the agent a real inbox, SMTP password, social account, or unrestricted browser session.

See [MAILBOX-BROWSER.md](./MAILBOX-BROWSER.md) for the current approval shapes and token-efficiency rules.

## External Contact Approval Shape

If implemented, an external contact request should include structured fields:

```json
{
  "type": "external_contact",
  "riskLevel": "medium",
  "recipient": "reviewer@example.com",
  "subject": "Security review request for Latch",
  "bodyPreview": "Short plain-text preview...",
  "attachments": [],
  "sendMode": "manual|approved_connector",
  "expectedResponse": "Approve to send manually or return edits."
}
```

Security defaults:

- deny by default if the recipient is missing or vague
- no hidden recipients
- no automatic attachments
- no secrets in the body
- no agent-created accounts without operator approval
- no sending through a personal mailbox without explicit operator action

## Messaging Options

Manual sending is safest for the first public-review phase. The agent drafts, the operator sends.

A project mailbox can come later if needed:

- use a project-specific address
- use a narrow app password or API token
- keep credentials only on the trusted Latch host
- require operator approval before each first-contact email
- log only summaries and message IDs, not full private threads unless explicitly needed

The agent should not be allowed to decide its own outbound communication channel. Latch should expose named contact templates and approvals first.

## Security Review Checklist

Before making the repo public, review:

- `data/` is ignored and contains no files staged in Git.
- `.env` and machine-local config files contain placeholders only.
- `data/auth.json`, `data/llm-provider.json`, and notification configs are not tracked.
- Documentation does not include real keys, Tailscale hostnames that should remain private, personal email addresses, or screenshots with secrets.
- The agent key cannot access operator-only endpoints.
- The operator key is never sent to the VM.
- `/api/llm/chat` is private and spending-limited at the provider.
- Approval endpoints reject unauthenticated requests.
- Execution reports require the agent key.
- Read-only command templates cannot be influenced by raw user command strings.
- Command execution uses argv arrays with `shell=False`.
- No route accepts file paths that can escape intended storage directories.
- Uploaded context files have size limits and are not shared with agents unless explicitly enabled.
- Notifications do not leak private message bodies to third-party notification providers beyond the chosen threat model.
- Tailscale Serve is private; Tailscale Funnel is not used.
- GitHub deploy keys on the VM are read-only.
- Emergency key rotation and lockdown scripts work.

## Questions For The Reviewer

- Is the agent/operator key split sufficient for the current API?
- Are approval state transitions clear and hard to spoof?
- Are execution audit records useful without storing excessive logs?
- Are the read-only diagnostic templates narrow enough?
- Should operator auth move from bearer keys to signed sessions before public use?
- Should the phone app require local PIN/passkey before showing private context?
- Should external contact be manual-only until after a second review?
- What minimum tests are needed before enabling any write-capable agent action?

## Pre-Public Release Bar

Latch should not become public until:

- a fresh secret scan passes
- a human security review is complete
- live keys have been rotated
- the README clearly says this is private-first software
- external contact remains manual or approval-gated
- command execution remains read-only or separately reviewed
