# Agent Boundary

OpenClaw agents should interact with a deployed Latch instance through authenticated API endpoints. They do not need source repository access to do that.

## Allowed For Agents

- Latch base URL over Tailscale
- Agent key only
- `GET /api/agent/poll`
- `POST /api/agent/report`
- `POST /api/approvals`
- `POST /api/llm/chat` if external LLM fallback is enabled
- human verification requests through `POST /api/approvals` with `type: "human_verification"`
- approval requests for commands, credentials, account setup, purchases, and other sensitive actions
- approved non-sensitive `shell` and `browser` execution plans through the separate VM executor service

## Keep Away From Agents

- Operator key
- External provider API keys
- GitHub personal access tokens
- SSH deploy keys with write access
- `data/` directory contents
- Windows user profile files
- Tailscale admin credentials
- Browser sessions or password managers
- Revolut or bank sessions

## If The Project Becomes Public

Open source means the source code can be read by anyone, including an internet-capable agent. Security must not depend on hiding the code.

The real boundary is capability:

- An agent can know how the API works.
- An agent must not have secrets that grant operator, provider, GitHub, finance, or host-admin powers.
- GitHub publishing should happen from a trusted human workstation, not from the disposable OpenClaw VM.
- If OpenClaw needs code context later, give it a read-only checkout or a specific exported task bundle, never a write-capable GitHub token.

## Good Default

Run OpenClaw with:

- no GitHub credentials
- no provider API key
- only the Latch agent key
- network access limited to what the task needs
- approval-gated executor plans for VM shell/browser actions
- human approval for purchases, infrastructure changes, credential changes, and sensitive account steps
- human presence for CAPTCHA, account creation, and email verification steps
- separate bridge and executor services so chat/planning stays distinct from root VM execution

If OpenClaw needs project source context, give it a VM-local read-only checkout. Do not let it use the trusted Windows working tree or a write-capable GitHub credential.
