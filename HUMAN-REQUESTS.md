# Human Requests

Latch treats CAPTCHA, email confirmation, and account setup as human-presence requests, not as automation tasks.

The principle is:

```text
Agents can request human presence.
Agents should not borrow human identity.
```

The default VM bridge creates approval requests automatically when a task or inbox instruction appears to need a command, browser action, credential, account setup, human verification, or purchase. Approval records are the control surface. Non-sensitive shell/browser approvals may be executed by the separate `latch-agent-executor` service; sensitive human-boundary actions are never delegated to the executor.

## Autonomy Modes

Operators can choose an autonomy mode in Compass:

- `Default permissions`: every approval card waits for the operator.
- `Auto review`: low-risk fixed read-only diagnostics and tightly bounded public URL research can be approved by policy.
- `Full access`: non-sensitive VM shell/browser execution plans and `CompassProjects` file updates for the operator and operator-managed Pro users can be approved by policy.

Credentials, purchases, external contact, account setup, GitHub repo creation, human verification, and context questions remain human-boundary requests in every mode.

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
