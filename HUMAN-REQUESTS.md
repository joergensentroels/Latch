# Human Requests

Latch treats CAPTCHA, email confirmation, and account setup as human-presence requests, not as automation tasks.

The principle is:

```text
Agents can request human presence.
Agents should not borrow human identity.
```

The default VM bridge creates approval requests automatically when a task or inbox instruction appears to need a command, browser action, credential, account setup, human verification, or purchase. Approval records are the control surface. Non-sensitive shell/browser approvals may be executed by the separate `latch-agent-executor` service; sensitive human-boundary actions are never delegated to the executor.

## Autonomy Modes

Operators can choose one of **four** autonomy modes in Compass. Each one adds *types* of operation the
host can verify; none of them adds arbitrary execution.

- **Approve everything** (`default_permissions`): every approval card waits for the operator.
- **Auto read-only** (`auto_review`): low-risk fixed read-only diagnostic templates and tightly bounded exact-URL public research can be approved by policy.
- **Auto typed tools** (`auto_browse`): the above, plus operator-listed MCP tools whose arguments the host validates against the tool's declared schema.
- **Auto all typed ops** (`full_access`): the above, plus `CompassProjects` file updates for the operator and operator-managed Pro users.

_Corrected 2026-08-15. This list named three modes and omitted `auto_browse` entirely, so a reader of
this file believed there were three tiers; and it described `Full access` as releasing "non-sensitive VM
shell/browser execution plans", which has never been true — those require a human at **every** tier and
are not grantable. See [AGENT-BOUNDARY.md](./AGENT-BOUNDARY.md) for the same table with the code
reference._

**Arbitrary `shell` and `browser` execution plans are never auto-approved in any tier, and are never
grantable.** Nor is anything the worker marks `sensitive`, any browser/research plan using an HTTP URL,
credentials embedded in a URL, or a login/credential step — plus every approval type on the human
boundary. That
list is enumerated with its type identifiers in [SECURITY.md](./SECURITY.md#autonomy-and-auto-approval),
which is the authoritative copy.

## Request Shape

An agent can ask for help through the approval endpoint:

```http
POST /api/approvals
Authorization: Bearer agent_...
Content-Type: application/json

{
  "type": "human_verification",
  "title": "Verification needed",
  "details": "Please complete the verification on your trusted device.",
  "expectedResponse": "Reply when done, or paste only the short verification code if one is required.",
  "sensitive": true
}
```

## Operator Guidance

- Create project-specific accounts when possible.
- Use unique passwords.
- Avoid linking agent accounts to primary personal accounts.
- Return only the minimum result needed.
- Do not share password manager access, 2FA seeds, recovery codes, banking sessions, or main inbox access.

## Status Meaning

- `pending`: waiting for the operator.
- `approved`: human step is complete or permission is granted.
- `denied`: operator declined or could not complete it.

Approving a shell/browser execution plan lets the separate VM executor run the exact approved plan and record an audit result. Approving credentials, purchases, account setup, external contact, human verification, or context questions records a human decision only; those categories are not executed by the bridge or executor.

For non-sensitive approvals with an operator note, the bridge may use the note to draft a follow-up answer through the LLM gateway. Sensitive approval notes are not forwarded to the external LLM.
