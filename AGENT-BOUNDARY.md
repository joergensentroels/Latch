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
- human approval for commands, purchases, infrastructure changes, and credential changes
- human presence for CAPTCHA, account creation, and email verification steps
- text-only bridge mode until explicit execution capabilities are added and reviewed
