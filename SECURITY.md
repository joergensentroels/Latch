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

To rotate keys:

1. Stop the app.
2. Rename or delete `data/auth.json`.
3. Start the app again.
4. Update the phone and OpenClaw bridge with the new keys.

## Current Bridge Safety

`openclaw-agent-bridge.ps1` does not execute tasks. It only:

- connects to Latch
- polls queued work
- reports that it observed queued tasks

Execution should be added only after approval handling and command allowlists are designed.

## External LLM Gateway

The `/api/llm/chat` endpoint lets an authenticated operator or agent ask the configured external provider for a response. Keep this endpoint private over Tailscale, use provider spending limits where possible, and rotate the provider key if the disposable machine is compromised.

## Human Verification

Agents may request human help with CAPTCHA, email confirmation, account setup, or similar steps by creating an approval with `type: "human_verification"`.

The operator should complete those steps only on a trusted device and return the minimum useful result. Do not give the agent your main account, password manager, 2FA seed, recovery email, banking session, or long-lived personal credentials.

## Phone Install

For phone installation, prefer the HTTPS URL created by Tailscale Serve. Some mobile browsers limit PWA installation on plain HTTP.
