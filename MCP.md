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
- **`argConstraints`** — optional per-tool argument bounds enforced host-side before a call runs
  (e.g. `{ "read_file": { "path": { "prefix": "/home/you/shared" } } }`), for tools that don't
  self-sandbox. Independently, every call's arguments are validated against the tool's own declared
  `inputSchema` (required fields, types, enums, no unexpected fields) — a typed tool with unbounded
  arguments is not treated as safe.

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

## Bridge-side (natural language → tool call)

You don't have to hand-craft the approval. When a task or Inbox message explicitly mentions MCP
("use MCP to read notes.txt", "via the … MCP server"), the bridge's `detect_mcp_tool_call` flags the
intent and `plan_mcp_tool_call` asks the LLM to pick a concrete `(server, tool, args)` — **only from
the tool catalog delivered in that poll** (the host sends the catalog, minus credentials, in
`/api/agent/poll`). The choice is validated against the catalog before the approval is created, so
the model can't invent a server or tool; if nothing fits, it falls back to a plain operator review.

## Autonomy

Every MCP call requires a human by default. The one exception: under **Full access**, a tool the
operator has listed in that server's `autoApprove` array auto-approves (computed as
`mcpAutoApprovable` at creation). A newly-reachable tool never runs unattended without that explicit
per-tool opt-in.

## Results

On a successful call the result is stored on the approval **and** posted back into the loop as an
Inbox message tied to the source task/message, and the originating task is closed (`done`, or
`failed` if the tool errored).

## UI

**Settings → MCP → Tool servers** lists configured servers, their allowlist/auto-approve badges,
and (via **Refresh**) their live tools. Read-only — servers are configured in `data/mcp.json`.

## Status

Fully implemented across host and worker: the MCP client (stdio + mock transports), config
load/redaction, `/api/mcp/servers`, the `mcp_tool_call` approval type + host-side execution,
bridge-side detection + LLM planning against the poll catalog, Full-access auto-approve for
`autoApprove` tools, result feedback into the Inbox/task, and the Settings UI. Covered by
`test/mcp.mjs` (incl. the real stdio transport), `test/worker-readonly-templates.py` (detection +
planning), and the end-to-end path in `test/smoke.mjs`.

**Takes effect on:** host restart (server) + bridge redeploy (worker detection/planning). The
Settings UI is static (PWA reload).
