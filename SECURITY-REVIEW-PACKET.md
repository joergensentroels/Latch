# Security Review Packet

This is the short handoff for a security reviewer before Latch becomes public or gains broader agent powers.

## Architecture Summary

Latch runs on the trusted Windows host and is exposed only over Tailscale/private LAN. The OpenClaw VM is semi-trusted and talks to Latch with the agent key. The phone app connects to Latch through the private Tailscale route.

OpenClaw should inspect source through its VM-local read-only checkout. It should not use the trusted Windows working tree or any write-capable GitHub credential.

## Trust Boundaries

- Trusted: Windows Latch host, operator phone, operator key, provider API keys.
- Semi-trusted: OpenClaw VM, agent key, VM-local read-only source checkout.
- Out of scope for agents: payment tools, password managers, personal browser profiles, personal mailbox, Tailscale admin credentials, GitHub write credentials.

## Enabled And Disabled Agent Powers

| Capability | Current state |
| --- | --- |
| Poll tasks/messages | Enabled with agent key |
| Text reports | Enabled with agent key |
| LLM gateway calls | Enabled through Latch, provider key stays on Windows |
| Read-only diagnostics | Approval-gated named templates only |
| Exact-URL web research | Approval-gated, public URLs only |
| External contact | Draft/manual only |
| Email sending | Disabled |
| Browser automation | Full-access executor gated |
| Arbitrary shell commands | Full-access executor gated |
| Write/system commands | Full-access executor gated |

## API Key Locations

- Operator key: trusted operator devices only.
- Agent key: OpenClaw VM bridge environment.
- External LLM provider key: Windows Latch host under `data/`.
- Notification token/config: Windows Latch host under `data/`.
- GitHub deploy key on VM: read-only for this repo only.

## Manual Acceptance Checklist

- Latch opens only through localhost, private LAN, or Tailscale.
- Tailscale Funnel is off.
- `data/` is not tracked by Git.
- Smoke test, worker tests, and secret scan pass.
- Read-only diagnostic approval runs only a named template.
- Full-access shell/browser approvals run only stored execution plans and record execution audits.
- Exact-URL research rejects private IPs, localhost, embedded credentials, missing seed URLs, and unapproved domains.
- Timeline Operations displays diagnostic and research summaries clearly.
- External-contact drafts can be copied, but Latch does not send mail.

## Known Limitations

- Bearer keys are simple shared secrets, not signed sessions.
- Local PIN/passkey is a browser/device gate, not server-side authentication.
- Source-note summaries are heuristic and not a substitute for reviewer judgment.
- Research fetches exact approved URLs only; broader browser work requires an approved executor plan and does not use personal browser profiles.
- Approval audit records are summaries, not immutable append-only logs.

## Pre-Public Checklist

- Rotate live operator, agent, provider, notification, and deploy keys.
- Remove or redact private Tailscale hostnames from public docs if needed.
- Confirm no screenshots or logs contain secrets.
- Keep the repo private until the reviewer has checked auth, approval transitions, file boundaries, notification privacy, research URL validation, and read-only deploy-key setup.
