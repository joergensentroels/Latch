# Security Notes

## Intended Exposure

Latch is intended for private use over Tailscale.

Use:

- Tailscale private network
- Tailscale Serve for private HTTPS
- Operator key for the human web app
- Agent key for the OpenClaw machine

Avoid:

- router port forwarding
- Tailscale Funnel
- public reverse proxies
- sharing keys in chat apps
- giving OpenClaw GitHub write credentials

## Keys

Keys live in:

```text
data/auth.json
```

The operator key unlocks the web app. The agent key is for the disposable OpenClaw machine.

The agent key is intentionally narrower than the operator key. Agents should not receive the operator key, GitHub write tokens, provider API keys, or access to the live `data\` directory.

External LLM provider keys live in:

```text
data/llm-provider.json
```

That file is intentionally kept under `data\` so it stays local to this Windows machine. The OpenClaw machine should call the Latch gateway with its agent key instead of storing the external provider API key directly.

Notification provider tokens live in:

```text
data/notifications.json
```

Agents should not receive notification provider tokens. Latch should send phone alerts on the operator's behalf.

Operator-provided context lives in:

```text
data/db.json
data/context-files/
data/backups/
```

Treat this as private data. It can contain goals, notes, uploaded documents, and other sensitive context.

Agents receive:

- metadata for recent context items
- full note text only when the item is marked `shareWithAgent`
- text-like uploaded file contents only when explicitly shared and no larger than 200 KB

Keep secrets, recovery codes, payment data, and long-lived credentials out of shared context.

Use the built-in backup/export controls before manual maintenance. Backups remain local under `data\` and are not tracked by Git.

## Local App Lock

The Latch web app can use a local PIN lock on each browser/device. On private HTTPS, it can also register a local passkey/biometric unlock. This protects against casual access when a phone is already unlocked, but it is not a replacement for the operator key, Tailscale, or the phone's OS-level lock.

The PIN verifier and passkey credential ID are stored in browser storage on that device. Current passkey unlock is a local device gate; it relies on the browser/OS user-verification prompt and does not replace server-side authentication. Browser passkeys require private HTTPS, for example via Tailscale Serve, because WebAuthn is not available on ordinary `http://100.x.y.z` pages.

To rotate keys:

1. Stop the app.
2. Rename or delete `data/auth.json`.
3. Start the app again.
4. Update the phone and OpenClaw bridge with the new keys.

## Current Bridge Safety

`worker/latch-agent-bridge.py` does not execute tasks. It only:

- connects to Latch
- polls queued work
- sends safe text-only prompts through the Latch LLM gateway
- uses explicitly shared context as a briefing
- creates approval cards for risky actions and context questions

Execution should be added only after approval handling and command allowlists are designed.

## External LLM Gateway

The `/api/llm/chat` endpoint lets an authenticated operator or agent ask the configured external provider for a response. Keep this endpoint private over Tailscale, use provider spending limits where possible, and rotate the provider key if the disposable machine is compromised.

## Human Verification

Agents may request human help with CAPTCHA, email confirmation, account setup, or similar steps by creating an approval with `type: "human_verification"`.

The operator should complete those steps only on a trusted device and return the minimum useful result. Do not give the agent your main account, password manager, 2FA seed, recovery email, banking session, or long-lived personal credentials.

## Phone Install

For phone installation, prefer the HTTPS URL created by Tailscale Serve. Some mobile browsers limit PWA installation on plain HTTP.

## First-Run Checklist

- Open Latch through Tailscale, preferably the private `https://*.ts.net` Serve URL.
- Set the local app PIN with the `P` button.
- Add a passkey from the same dialog if the phone/browser offers it.
- Keep Tailscale Funnel off for Latch.
- Confirm `Status-Latch.ps1` shows only private URLs.
