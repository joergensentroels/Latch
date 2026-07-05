# "Draft with Latch" — Outlook add-in

A button in Outlook that drafts a reply with your Compass/Latch companion. It reads the message
you're viewing and opens a **prefilled reply you review and send yourself**. Latch never gets your
mailbox credentials.

## Why it's the safest option

The add-in runs inside your already-authenticated Outlook session. It hands Latch only the *one
message you're looking at* (via the scoped `/api/draft` endpoint), gets back suggested text, and drops
it into a reply. So:

- **No account credentials on Latch** — not even send-only. Outlook stays the reader and sender.
- **No standing access** — Latch only ever sees the message you explicitly draft against.
- **Scoped key** — the add-in uses the `draftToken` (in `data/auth.json`), which works **only** on
  `/api/draft`. It cannot read state, approve anything, or send. Even if it leaked, all it can do is
  request drafts.
- Drafting runs on your host's **local** model by default, so the (untrusted) message content stays
  local; the composer is injection-resistant.

## Setup

1. **Get your draft key:** `Show-CommandCenter-Keys.ps1` (or read `data/auth.json`) → `draftToken`.
2. **Expose Latch over HTTPS** (Office add-ins require it) — you already have this via Tailscale Serve
   (`https://<you>.tail<xxxx>.ts.net`). The device running Outlook must be on your tailnet.
3. **Point the manifest at your host:** in [`outlook-addin/manifest.xml`](./outlook-addin/manifest.xml),
   replace every `https://YOUR-LATCH-HOST` with your Tailscale Serve URL. (The taskpane + icons are
   served by Latch from `/addin` and `/icons`.)
4. **Sideload:** Outlook on the web → Settings → Add-ins → *Custom add-ins* → *Add from file* →
   the edited `manifest.xml`.
5. **First run:** open a message → **Draft with Latch** → in the taskpane's *Settings*, confirm the
   Latch base URL and paste your draft key (stored locally in the add-in) → Save.

## Use

Open a message → **Draft with Latch** → pick what to do (**Draft a reply / Summarize / Extract
action items / Rewrite**) → optional guidance → **Run**. For a reply, edit the suggestion and *Open
reply with this* → review and **Send** in Outlook. Summaries/action items are read-only — copy them or
just read.

## Attachments & meeting invites

The add-in works on the **message text** (subject + body). It does **not** yet read attachments or
calendar invites:

- **Attachments/files** — not sent to Latch. Latch has no built-in PDF/Office parser (Node
  built-ins only), so a file's contents would need a text extractor (a future MCP tool) or you paste
  the text. Plain-text you paste in works fine.
- **Meeting invitations** — the add-in currently targets *message* reads, not calendar items.
  Summarizing an invite (read-only) is an easy future extension (read the invite's fields and send
  them to `/api/assist`); *accepting/declining* would stay an action you take in Outlook (a calendar
  write is a boundary, like sending).

## Notes

- Permission is `ReadItem` only — the add-in reads the current message and opens a reply; it never
  sends.
- Same idea works for any client that can POST to `/api/draft` with the draft key (a shortcut, a
  bookmarklet, a mobile Shortcut). The add-in is just the nicest Outlook wrapper.
- Not yet tested in a live Outlook client — see [TESTING-STATUS.md](./TESTING-STATUS.md).
