# Latch on Android

Use the private Tailscale URL first:

```text
http://<windows-tailscale-ip>:8787
```

Requirements:

- Tailscale is installed on the phone.
- The phone is signed into the same tailnet.
- Tailscale is connected on the phone before opening Latch.
- Do not use Tailscale Funnel or router port forwarding.

## Install

1. Open Tailscale on the phone and make sure it says connected.
2. Open Chrome on the phone.
3. Browse to `http://<windows-tailscale-ip>:8787`.
4. Enter the Latch operator key.
5. Open the Chrome menu and choose `Add to Home screen` or `Install app`.

The installed shortcut/app still uses the private Tailscale connection. It will not work when Tailscale is disconnected.

## Notifications

The in-app notification button can only alert reliably while the browser/app is active. For lock-screen notifications, use the configured ntfy topic:

1. Install `ntfy` from Google Play or F-Droid.
2. Subscribe to the private Latch topic already configured on the Windows host.
3. Keep Latch itself for reading details and approving actions.

Latch sends generic notification text only. The task or approval content stays inside Latch.

## HTTPS / PWA Notes

Android may install the app from the private HTTP URL as a home-screen app or shortcut. Full browser notification support usually requires HTTPS.

The intended HTTPS path is Tailscale Serve, which is private to the tailnet and different from public Tailscale Funnel. On this Windows install, the `tailscale serve` CLI did not complete from the Codex shell, so the currently verified phone URL is the direct private Tailscale HTTP URL above.
