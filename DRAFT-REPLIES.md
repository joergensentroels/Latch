# Draft-a-reply (host-brokered personal replies)

Get the companion to draft replies to your *personal* messages (email, chat, etc.) without ever
giving it your accounts. You hand it the message; it suggests a reply; the trusted host sends it from
your address only after you approve.

## The flow

1. **You load the message** — Tasks → *Draft a reply to a message*: paste the message you received,
   the reply-to address, an optional subject, and an optional line of guidance.
2. **The worker drafts** — it reads only what you pasted (treated as untrusted input) and suggests a
   reply. It has no account access, no credentials, and no send button.
3. **You review & edit** — a Review card shows the draft; you edit it in place and approve, or deny.
4. **The host sends** — on approval, the trusted host sends the (edited) reply from your address via
   the operator send connector, and logs it.

## Why it's safe

- The worker never holds your account credentials and never sends — it only ever produces text you
  review. Even a compromised/prompt-injected worker can at most propose a draft you'll reject.
- No standing access: it only sees the specific message you pasted, so there's nothing to fish from
  your inbox.
- Sending as you is a **hard human boundary** (`external_contact` / `approved_connector`): it never
  auto-approves and is never grantable, even under Full access.
- **WYSIWYG**: the host sends exactly the body you approved (your edits included).

## Setup (email)

Copy [`operator-email.example.json`](./operator-email.example.json) to `data/operator-email.json` and
fill in your address. Prefer a **send-only** SMTP app-password — because you paste the messages in,
the host never needs to *read* your inbox, only send. This connector is separate from the companion's
own mailbox ([AGENT-BOUNDARY.md](./AGENT-BOUNDARY.md#agent-email-agent-owned-mailbox)).

The one secret this places on the host is a send-only key for your address. That's consistent with
the trust model (the host holds all secrets); a host compromise is a separate, higher bar.

## Other channels

Email has a clean send path, so it's fully host-brokered. Messenger / WhatsApp have no safe send API,
so for those the companion still just drafts and you paste/send it yourself.
