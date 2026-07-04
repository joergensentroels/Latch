# MCP (Model Context Protocol) — host-brokered

Latch can act as an **approval-gating MCP host**. This is how Compass reaches the wider tool
ecosystem (filesystem, calendars, databases, search, SaaS APIs, …) *without* breaking its core
promise that the worker never holds credentials.

## Why it fits Latch

MCP's client/server split maps exactly onto Latch's trusted-host / disposable-worker split:

| MCP role | Runs in Latch as | Holds |
| --- | --- | --- |
| MCP **servers** | subprocesses of the **trusted host** | their own credentials (`env` in `data/mcp.json`) |
| MCP **client/host** | the **trusted host** (`server.js` + `mcp.mjs`) | connects to the servers |
| the **worker** | — | nothing; it only *requests* a tool call |

A worker (or a prompt-injected one) can **request** an MCP tool call, but it can't run one: the
request becomes an `mcp_tool_call` approval, and the **host** executes it after you approve. The
result comes back; the credentials never leave the host. Same broker model as the GitHub and email
connectors.

## Configure

Copy [`mcp.example.json`](./mcp.example.json) to `data/mcp.json` (gitignored) and enable it
(`enabled: true`, or set `MCP_ENABLED=1`). Each server entry:

```json
{
  "name": "filesystem",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/you/shared"],
  "env": {},
  "allowedTools": ["read_file", "list_directory"],
  "autoApprove": []
}
```

- **`transport`** — `stdio` spawns the server as a subprocess and speaks newline-delimited JSON-RPC
  2.0 over stdin/stdout. (`mock` exists for tests.)
- **`env`** — credentials for that server. Live only on the host; **never** exposed. The operator
  API shows env *key names* but not values.
- **`allowedTools`** — optional hard allowlist. If non-empty, only those tool names can be called at
  all, even with approval.
- **`autoApprove`** — optional; tools pre-authorised for autonomy auto-approval once bridge-side
  detection lands (see "Not yet" below). Still audited.

No npm dependency is added: the MCP stdio client is implemented directly on Node built-ins
(`mcp.mjs`), consistent with the rest of the host.

## Flow

1. Operator lists configured servers and their live tools: `GET /api/mcp/servers` (operator-only).
2. A tool call is requested by creating an approval of `type: "mcp_tool_call"` with `mcpServer`,
   `mcpTool`, and `mcpArgs`.
3. On operator approval, the host runs the tool (`mcp.mjs` → `callTool`) and stores the result on
   the approval (`mcpResult`, `mcpRanAt`, `mcpIsError`). A tool that returns an error keeps the
   approval approved and records the error; a transport/config failure reverts it to pending so you
   can fix config and retry.

## Status

**Implemented:** the host MCP client (stdio + mock transports, handshake, `tools/list`,
`tools/call`), config loading + redaction, the `/api/mcp/servers` operator endpoint, the
`mcp_tool_call` approval type, and host-side execution on approval. Covered by `test/mcp.mjs`
(incl. the real stdio transport) and the end-to-end path in `test/smoke.mjs`.

**Not yet (next slices):**
- Bridge-side intent detection so a natural-language task can *propose* an `mcp_tool_call`.
- Autonomy auto-approval for `autoApprove` tools (currently every MCP call requires a human, even
  under Full access — the safe default).
- A Settings UI for MCP servers/tools (today it's config file + API).
- Returning tool results to the worker's task loop (today the result is stored on the approval).
