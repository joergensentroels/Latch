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

## In Outlook directly

Instead of pasting, you can drive this from a **"Draft with Latch" button inside Outlook** — an
add-in that reads the message you're viewing, gets a draft from Latch's scoped `/api/draft` endpoint,
and opens a prefilled reply you send yourself. That path needs **no account credential on Latch at
all** (Outlook stays the sender). See [OUTLOOK-ADDIN.md](./OUTLOOK-ADDIN.md).

## On your phone (Android)

Two ways, both work from any app's Share button:

**A. Share → Compass (no extra app).** The Compass PWA registers as an Android share target. In any
app (Gmail, Outlook, Messenger, SMS…), select the message → **Share → Compass**. Compass opens with
the text already in the *Draft a reply* composer — add the reply-to address and get a draft, review,
and (if the operator send connector is set up) send, or copy it. Requires the Compass PWA installed
and Tailscale up on the phone (as you already have).

**B. Instant draft with the [HTTP Shortcuts](https://http-shortcuts.rmy.ch/) app (fastest).** For a
"just give me a draft to paste" flow that doesn't open Compass:
1. Install *HTTP Shortcuts* (Play Store / F-Droid, open source).
2. New shortcut → **POST** `https://<your-tailnet-host>.ts.net/api/draft`.
3. Header: `Authorization: Bearer <your draft key>` (Settings → Drafting → Draft key → Copy).
4. Request body (JSON): `{"message": "{{shared_text}}", "guidance": "{{guidance}}"}` — use the app's
   variables: bind `shared_text` to the share-intent text, and add an optional prompt variable
   `guidance`.
5. Enable **"Add to share menu"**, and set the response handling to show/copy `{{response}}` (the
   `draft` field). Now: select a message anywhere → Share → your shortcut → draft appears → paste.

Both use the scoped draft key, so they can only request drafts — never read, approve, or send.

## Other channels

Email has a clean send path, so it's fully host-brokered. Messenger / WhatsApp have no safe send API,
so for those the companion still just drafts and you paste/send it yourself.
