# External LLM Provider

Latch can proxy LLM calls to an external OpenAI-compatible API while Ollama/GPU serving is paused.

The intended flow is:

1. OpenClaw calls Latch over Tailscale with the agent key.
2. Latch calls the external LLM provider.
3. The external provider API key stays on this Windows machine in `data/llm-provider.json`.
4. Later, OpenClaw can switch back to Ollama by changing provider/base URL/model settings.

## Configure Later

Run this from `openclaw-command-center` when you have the key:

```powershell
powershell -ExecutionPolicy Bypass -File .\Configure-External-LLM.ps1 `
  -Provider "openai-compatible" `
  -BaseUrl "https://api.openai.com/v1" `
  -Model "replace-with-model-name" `
  -PromptForApiKey
```

The generated file lives under `data\`, which is intentionally ignored by source control.

You can also configure through environment variables before starting the server:

```powershell
$env:LLM_PROVIDER="openai-compatible"
$env:LLM_BASE_URL="https://api.openai.com/v1"
$env:LLM_MODEL="replace-with-model-name"
$env:LLM_API_KEY="replace-with-api-key"
powershell -ExecutionPolicy Bypass -File .\Start-CommandCenter.ps1
```

## Test

Start Latch, then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\Test-External-LLM.ps1
```

If no API key is configured, the test reports that the external LLM is not enabled yet.

## Primary + your own external fallback

You can configure two providers: a **primary** (the flat `provider`/`baseUrl`/`model`/`apiKey`
fields — point it at your local Ollama for a local-first setup) and an optional **`fallback`** block
(your OWN external provider, e.g. a hosted API). Both keys stay on this host; the worker never
receives them.

```jsonc
{
  "baseUrl": "http://127.0.0.1:11434/v1", "model": "qwen3:14b", "apiKey": "ollama",
  "fallback": {
    "baseUrl": "https://api.mistral.ai/v1", "model": "mistral-large-latest", "apiKey": "..."
  }
}
```

Or via env: `LLM_*` for the primary, `LLM_FALLBACK_*` for the fallback.

The send/task **routing** control chooses how these are used:

- **Local only** — primary model only; never falls back.
- **Local + external backup** — try the primary; if it fails, use your external fallback.
- **Latch network** — the shared community-compute network (not yet implemented; shown disabled).

The fallback is only reached when the primary call fails and the routing preference is not
"Local only". The UI shows both the primary and the fallback model.

## Agent Call Shape

OpenClaw can call the private gateway with the agent key:

```http
POST /api/llm/chat
Authorization: Bearer agent_...
Content-Type: application/json

{
  "prompt": "Summarize the current task.",
  "temperature": 0.2,
  "maxTokens": 500
}
```

The response shape is:

```json
{
  "ok": true,
  "provider": "openai-compatible",
  "model": "configured-model",
  "text": "model response",
  "usage": null,
  "id": null
}
```

From the Ubuntu OpenClaw VM, a quick curl test can use the included helper:

```bash
export BASE_URL="https://<host>.<tailnet>.ts.net"
export AGENT_KEY="agent_..."
bash openclaw-agent-llm-test.sh
```

## Security Notes

- Do not commit `data/llm-provider.json`.
- Do not paste the API key into task messages or logs.
- Use a project-specific key with spending limits if the provider supports it.
- Keep this app private over Tailscale. Do not expose it with router port forwarding or Tailscale Funnel.
