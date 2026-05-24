#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-}"
AGENT_KEY="${AGENT_KEY:-}"
PROMPT="${PROMPT:-Reply with one short sentence confirming the Latch LLM gateway works.}"

if [[ -z "$BASE_URL" ]]; then
  echo "Set BASE_URL to the command center URL, for example https://host.tailnet.ts.net"
  exit 1
fi

if [[ -z "$AGENT_KEY" ]]; then
  echo "Set AGENT_KEY to the command center agent key."
  exit 1
fi

curl -sS \
  -X POST "$BASE_URL/api/llm/chat" \
  -H "Authorization: Bearer $AGENT_KEY" \
  -H "Content-Type: application/json" \
  --data "$(printf '{"prompt":%s,"temperature":0.2,"maxTokens":120}' "$(python3 -c 'import json, os; print(json.dumps(os.environ.get("PROMPT", "")))')")"
