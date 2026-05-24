# Notifications

Latch supports two notification paths:

1. In-app PWA notifications while the phone app can receive updates.
2. Optional server-side phone push through a webhook provider such as ntfy.

## PWA Notifications

Open Latch on your phone and tap the `!` button in the top bar. The browser will ask for notification permission.

This is useful, but mobile browsers may pause web apps in the background. For reliable lock-screen notifications, configure server-side push.

## Reliable Phone Push

The simplest self-host-friendly option is ntfy:

1. Install the ntfy app on your phone.
2. Subscribe to a private random topic.
3. Configure Latch with the topic URL.

Example:

```powershell
powershell -ExecutionPolicy Bypass -File .\Configure-Notifications.ps1 `
  -Provider "ntfy" `
  -Url "https://ntfy.sh/replace-with-private-random-topic" `
  -Enable
```

Then start Latch and test:

```powershell
powershell -ExecutionPolicy Bypass -File .\Test-Notifications.ps1
```

For ntfy servers that require auth, add `-PromptForToken`.

## What Triggers Notifications

Latch sends notifications for:

- agent reports
- approval requests
- human verification requests

It does not notify for every operator action by default.

Notification content is intentionally generic. Push providers should only see wake-up text such as `Open Latch to review`, not task details, verification details, account names, commands, or message contents.

## Security Notes

- Keep `data/notifications.json` private.
- Do not give notification tokens to OpenClaw.
- Use a hard-to-guess ntfy topic or authenticated ntfy server.
- Do not put sensitive details in notification titles or bodies.
