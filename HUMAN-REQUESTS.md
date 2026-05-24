# Human Requests

Latch treats CAPTCHA, email confirmation, and account setup as human-presence requests, not as automation tasks.

The principle is:

```text
Agents can request human presence.
Agents should not borrow human identity.
```

The default VM bridge also creates approval requests automatically when a task or inbox instruction appears to need a command, credential, account setup, human verification, or purchase. Approval records are a control surface, not permission for the current text-only bridge to execute the action.

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

In the current safe text-only mode, approving a request records the decision and notifies the agent bridge, but it does not execute commands, use credentials, or perform purchases.

For non-sensitive approvals with an operator note, the bridge may use the note to draft a follow-up answer through the LLM gateway. Sensitive approval notes are not forwarded to the external LLM.
