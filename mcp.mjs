// Host-brokered MCP (Model Context Protocol) client for Compass / Latch.
//
// Latch acts as an approval-gating MCP *host*: the trusted host connects to configured MCP
// *servers* (each holding its own credentials), the worker only ever *requests* a tool call via an
// approval, and the host runs the call after approval. The worker never sees MCP server credentials
// -- same broker model as the GitHub and email connectors.
//
// Transports:
//   - "stdio": spawn the MCP server as a subprocess and speak newline-delimited JSON-RPC 2.0 over
//     its stdin/stdout. Connections are ephemeral (spawn -> handshake -> one op -> shut down) to
//     keep the first version simple and robust; tools/list results are cached briefly.
//   - "mock": no subprocess; returns seeded tools and echoes tool calls. Used by tests and dry-runs.
//
// No external npm dependencies: JSON-RPC over stdio is implemented directly on node:child_process,
// matching Latch's "Node built-ins only" property.

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

// Latch speaks TWO eras of MCP, as a client only. MCP-PROTOCOL-SUPPORT.md records what each covers and
// what it deliberately does not. Change that file in the same commit as these lists: a version number
// with no written scope is how a client ends up claiming a protocol it cannot speak.
//
// The eras are not interchangeable and the transport decides which are reachable:
//   stdio  — legacy only. An ephemeral spawn with an `initialize` handshake, unchanged.
//   http   — dual-era. Probes for a modern server and falls back to `initialize`, see negotiateHttpEra.
const MODERN_VERSION = "2026-07-28";                      // per-request `_meta`, no handshake
const PROTOCOL_VERSION = "2025-06-18";                    // what Latch announces in `initialize`
// What Latch will proceed against, MODERN FIRST. Order matters: it is the preference order offered when a
// server answers -32022 by naming the revisions it supports.
const SUPPORTED_PROTOCOL_VERSIONS = [MODERN_VERSION, PROTOCOL_VERSION];
// Legacy-era revisions — the ones reachable through `initialize`. Kept separate from the list above for the
// same reason Bureau's server keeps its own separate: announcing a MODERN revision in `initialize` would name
// a version that has no handshake, so the peer would believe it had agreed a session the revision does not
// have. `initialize` is how a client SELECTS legacy semantics; it can only ever offer a legacy revision.
const LEGACY_PROTOCOL_VERSIONS = [PROTOCOL_VERSION];
// Namespace for `_meta` keys in the modern era. The fields are not bare names.
const MCP_NS = "io.modelcontextprotocol/";
// Errors in -32020..-32099 are RESERVED for the MCP spec, and only a modern server emits them. Receiving one
// is therefore positive evidence about the peer's era — which is what makes the fallback decision safe rather
// than a guess. -32021 MissingRequiredClientCapability is included though Latch requests no capability that
// could be missing: the point of the set is "this code proves a modern peer", not "we expect this code".
const MODERN_ERROR_CODES = new Set([-32020, -32021, -32022]);
const DEFAULT_OP_TIMEOUT_MS = 20_000;
const TOOLS_CACHE_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export async function loadMcpConfig(configPath, env = process.env) {
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(stripBom(await readFile(configPath, "utf8")));
  } catch {
    fileConfig = {};
  }

  const rawServers = Array.isArray(fileConfig.servers) ? fileConfig.servers : [];
  const servers = rawServers.map(normalizeServer).filter((server) => server.name && server.transport);

  const enabledFlag = env.MCP_ENABLED === "1" || env.MCP_ENABLED === "true" || fileConfig.enabled === true;
  const config = {
    enabled: Boolean(enabledFlag) && servers.length > 0,
    servers,
    configPath,
    fileLoaded: Object.keys(fileConfig).length > 0
  };
  return config;
}

function normalizeServer(raw = {}) {
  const transport = String(raw.transport || "stdio").trim();
  const autoApprove = Array.isArray(raw.autoApprove)
    ? raw.autoApprove.map((name) => String(name || "").trim()).filter(Boolean)
    : [];
  return {
    name: String(raw.name || "").trim(),
    description: String(raw.description || "").trim(),
    transport: transport === "mock" ? "mock" : transport === "http" ? "http" : "stdio",
    command: String(raw.command || "").trim(),
    args: Array.isArray(raw.args) ? raw.args.map((a) => String(a)) : [],
    env: raw.env && typeof raw.env === "object" ? raw.env : {},
    cwd: String(raw.cwd || "").trim(),
    // ---- http transport --------------------------------------------------------------------------
    // The endpoint, and the headers that authenticate to it. Operator-supplied via data/mcp.json; no
    // model-reachable path writes either, which is what keeps this from being an SSRF surface.
    url: String(raw.url || "").trim(),
    // Credentials. These are to `url` what `env` is to `command`, and they get the same treatment in
    // publicMcpConfig: names only, never values.
    headers: raw.headers && typeof raw.headers === "object" ? raw.headers : {},
    // Sending operator credentials to a remote host is a different act from spawning a local subprocess,
    // so it is opt-in per server rather than implied by giving a URL. Default false means a typo in a
    // hostname fails closed instead of posting a bearer token somewhere unintended.
    allowRemote: raw.allowRemote === true,
    // Tools the operator has pre-authorised for autonomy auto-approval (still recorded/audited).
    autoApprove,
    // Optional allowlist: if non-empty, only these tools may be called at all.
    allowedTools: Array.isArray(raw.allowedTools)
      ? raw.allowedTools.map((name) => String(name || "").trim()).filter(Boolean)
      : [],
    // Optional per-tool argument constraints for tools that do not self-sandbox, e.g.
    // { "read_file": { "path": { "prefix": "/home/you/shared" } } }. Enforced host-side.
    argConstraints: raw.argConstraints && typeof raw.argConstraints === "object" ? raw.argConstraints : {},
    // Test-only seeded tools for the mock transport.
    mockTools: Array.isArray(raw.mockTools) ? raw.mockTools : []
  };
}

export function findServer(config, name) {
  const target = String(name || "").trim().toLowerCase();
  return (config.servers || []).find((server) => server.name.toLowerCase() === target) || null;
}

// Never leak env values (that is where API keys live), header values (where they live for the http
// transport), or the mock tool seeds. Both credential holders are reduced to their KEY NAMES: an operator
// needs to see that `Authorization` is configured, and never needs this endpoint to read it back.
export function publicMcpConfig(config) {
  return {
    enabled: Boolean(config.enabled),
    fileLoaded: Boolean(config.fileLoaded),
    servers: (config.servers || []).map((server) => ({
      name: server.name,
      description: server.description,
      transport: server.transport,
      command: server.command,
      args: server.args,
      envKeys: Object.keys(server.env || {}),
      // The url is shown: it is a routing fact the operator has to be able to confirm, and it carries no
      // secret — unless somebody put one in a query string, which is why the credential field exists.
      url: server.url || "",
      headerKeys: Object.keys(server.headers || {}),
      allowRemote: Boolean(server.allowRemote),
      autoApprove: server.autoApprove,
      allowedTools: server.allowedTools,
      argConstraints: server.argConstraints || {}
    }))
  };
}

export function isToolAllowed(server, toolName) {
  const name = String(toolName || "").trim();
  if (!name) return false;
  if (!server.allowedTools || server.allowedTools.length === 0) return true;
  return server.allowedTools.includes(name);
}

export function isToolAutoApprovable(server, toolName) {
  return (server.autoApprove || []).includes(String(toolName || "").trim());
}

// Stable JSON stringify: sort object keys recursively so inputSchema key-order variations between
// server runs don't change the fingerprint. Arrays keep their order (semantically meaningful).
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

// Fingerprint the security-relevant, model-visible surface of a tool: its name, its description
// (the tool-poisoning channel), and its declared inputSchema. A change here means the tool the
// worker/model now sees is not the tool the operator allowlisted -- so auto-approval must not
// carry over to the changed definition.
export function toolFingerprint(tool) {
  const canonical = stableStringify({
    name: String(tool?.name || ""),
    description: String(tool?.description || ""),
    inputSchema: tool?.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : {}
  });
  return createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// Tool discovery + calls
// ---------------------------------------------------------------------------

const toolsCache = new Map(); // server.name -> { at, tools }

export async function listTools(server, { timeoutMs = DEFAULT_OP_TIMEOUT_MS, useCache = true } = {}) {
  if (useCache) {
    const cached = toolsCache.get(server.name);
    if (cached && Date.now() - cached.at < TOOLS_CACHE_TTL_MS) return cached.tools;
  }
  if (server.transport === "mock") {
    const tools = normalizeTools(server.mockTools);
    toolsCache.set(server.name, { at: Date.now(), tools });
    return tools;
  }
  const result = await runOps(server, [{ method: "tools/list", params: {} }], timeoutMs);
  const tools = normalizeTools(result[0]?.tools);
  toolsCache.set(server.name, { at: Date.now(), tools });
  return tools;
}

// One entry point per transport, so callers never branch on it. `mock` is handled by its callers, which
// short-circuit before reaching here.
function runOps(server, ops, timeoutMs) {
  return server.transport === "http" ? runHttpOps(server, ops, timeoutMs) : runStdioOps(server, ops, timeoutMs);
}

export async function callTool(server, toolName, args = {}, { timeoutMs = DEFAULT_OP_TIMEOUT_MS } = {}) {
  if (!isToolAllowed(server, toolName)) {
    throw new Error(`Tool "${toolName}" is not in the allowlist for MCP server "${server.name}".`);
  }
  // A typed tool is not enough -- its ARGUMENTS must be bounded too. Validate the worker-supplied
  // args against the tool's own declared inputSchema and any operator argConstraints before running.
  let tool = null;
  try {
    tool = (await listTools(server, { timeoutMs })).find((item) => item.name === toolName);
  } catch {
    tool = null; // if discovery fails we still enforce operator constraints below
  }
  const check = validateToolArgs(tool?.inputSchema, server.argConstraints?.[toolName], args || {});
  if (!check.ok) {
    throw new Error(`Arguments for "${toolName}" were rejected: ${check.error}`);
  }
  if (server.transport === "mock") {
    return mockCall(server, toolName, args);
  }
  const result = await runOps(
    server,
    [{ method: "tools/call", params: { name: toolName, arguments: args || {} } }],
    timeoutMs
  );
  return normalizeToolResult(result[0]);
}

function matchesJsonType(value, type) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => {
    switch (t) {
      case "string": return typeof value === "string";
      case "number": return typeof value === "number";
      case "integer": return typeof value === "number" && Number.isInteger(value);
      case "boolean": return typeof value === "boolean";
      case "array": return Array.isArray(value);
      case "object": return Boolean(value) && typeof value === "object" && !Array.isArray(value);
      case "null": return value === null;
      default: return true; // unknown/absent type constraint -> don't block
    }
  });
}

// Lightweight, dependency-free validation: a useful JSON-Schema subset (required, type, enum,
// additionalProperties:false) plus operator argument constraints (equals / enum / prefix).
export function validateToolArgs(schema, constraints, rawArgs) {
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : {};

  if (schema && typeof schema === "object" && schema.type === "object") {
    const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!(key in args)) return { ok: false, error: `missing required field "${key}"` };
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(args)) {
        if (!(key in props)) return { ok: false, error: `unexpected field "${key}"` };
      }
    }
    for (const [key, value] of Object.entries(args)) {
      const spec = props[key];
      if (!spec || typeof spec !== "object") continue;
      if (spec.type && !matchesJsonType(value, spec.type)) return { ok: false, error: `field "${key}" must be ${Array.isArray(spec.type) ? spec.type.join("|") : spec.type}` };
      if (Array.isArray(spec.enum) && !spec.enum.includes(value)) return { ok: false, error: `field "${key}" is not an allowed value` };
    }
  }

  if (constraints && typeof constraints === "object") {
    for (const [key, rule] of Object.entries(constraints)) {
      if (!rule || typeof rule !== "object") continue;
      const value = args[key];
      if ("equals" in rule && value !== rule.equals) return { ok: false, error: `field "${key}" must equal the configured value` };
      if (Array.isArray(rule.enum) && !rule.enum.includes(value)) return { ok: false, error: `field "${key}" is not in the allowed set` };
      if ("prefix" in rule && (typeof value !== "string" || !value.startsWith(rule.prefix))) {
        return { ok: false, error: `field "${key}" must start with "${rule.prefix}"` };
      }
    }
  }

  return { ok: true };
}

function mockCall(server, toolName, args) {
  const tool = normalizeTools(server.mockTools).find((t) => t.name === toolName);
  if (!tool) {
    return { ok: false, isError: true, text: `Unknown tool "${toolName}".`, content: [] };
  }
  const text = `mock:${server.name}:${toolName}(${JSON.stringify(args || {})})`;
  return { ok: true, isError: false, text, content: [{ type: "text", text }] };
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool) => tool && typeof tool === "object" && tool.name)
    .map((tool) => ({
      name: String(tool.name),
      description: String(tool.description || ""),
      inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : {}
    }));
}

function normalizeToolResult(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return {
    ok: !result?.isError,
    isError: Boolean(result?.isError),
    text,
    content
  };
}

// ---------------------------------------------------------------------------
// stdio JSON-RPC transport
// ---------------------------------------------------------------------------

// Spawn the server, complete the MCP handshake, run the given ops in order, then shut down.
// Returns an array of op results aligned with `ops`.
function runStdioOps(server, ops, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!server.command) {
      reject(new Error(`MCP server "${server.name}" has no command configured.`));
      return;
    }

    let child;
    try {
      child = spawn(server.command, server.args, {
        cwd: server.cwd || undefined,
        env: { ...process.env, ...server.env },
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      reject(new Error(`Failed to start MCP server "${server.name}": ${error.message}`));
      return;
    }

    let settled = false;
    let nextId = 1;
    let buffer = "";
    let stderr = "";
    const pending = new Map(); // id -> {resolve, reject}
    const results = [];

    const timer = setTimeout(() => finish(new Error(`MCP server "${server.name}" timed out after ${timeoutMs}ms.`)), timeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
      if (error) reject(error);
      else resolve(value);
    }

    function send(message) {
      try {
        child.stdin.write(JSON.stringify(message) + "\n");
      } catch (error) {
        finish(new Error(`Failed to write to MCP server "${server.name}": ${error.message}`));
      }
    }

    function request(method, params) {
      const id = nextId++;
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        send({ jsonrpc: "2.0", id, method, params: params || {} });
      });
    }

    child.on("error", (error) => finish(new Error(`MCP server "${server.name}" failed: ${error.message}`)));
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); if (stderr.length > 20_000) stderr = stderr.slice(-20_000); });
    child.on("exit", (code) => {
      if (settled) return;
      if (pending.size > 0) finish(new Error(`MCP server "${server.name}" exited (code ${code}) before responding. ${stderr.trim().slice(-500)}`.trim()));
    });

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // ignore non-JSON log noise on stdout
        }
        if (message.id === undefined || message.id === null) continue; // a notification from the server
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(mcpErrorText(message.error)));
        else waiter.resolve(message.result);
      }
    });

    // Handshake, then the requested ops.
    (async () => {
      try {
        const hello = await request("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "latch", version: "0.1.0" }
        });
        // The server picks the revision, and it is allowed to pick one we did not ask for: "otherwise,
        // the server MUST respond with another protocol version it supports". The decision is then ours
        // — "if the client does not support the version in the server's response, it SHOULD disconnect" —
        // and disconnecting is the honest move here, because every op Latch runs over this connection is
        // a credential-bearing tool call the operator approved on the understanding that the host could
        // actually speak to the server. finish() ends stdin and kills the child, which is the stdio
        // shutdown the spec describes.
        // Checked against the LEGACY list, not the full one. This line read SUPPORTED_PROTOCOL_VERSIONS
        // until that list gained the modern revision for the HTTP transport — at which point a stdio server
        // answering `initialize` with "2026-07-28" would have been ACCEPTED here, and Latch would have gone
        // on to run credential-bearing ops believing it had agreed a revision whose handshake and session do
        // not exist. Precisely the defect MCP-PROTOCOL-SUPPORT.md was written to close, reintroduced by
        // widening a constant one transport away. The existing assertion in test/mcp.mjs caught it.
        const agreed = hello?.protocolVersion;
        if (!LEGACY_PROTOCOL_VERSIONS.includes(agreed)) {
          throw new Error(`MCP server "${server.name}" negotiated protocol ${agreed ? `"${agreed}"` : "(none announced)"}, but Latch speaks ${LEGACY_PROTOCOL_VERSIONS.join(", ")} over the legacy handshake. Disconnecting rather than guessing.`);
        }
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        for (const op of ops) {
          // Same completion gate as the HTTP path. A legacy server has no reason to send resultType and an
          // absent one means complete, so this is a no-op here in practice — applied anyway because "which
          // transport happens to check" is not a property worth having, and a legacy-era server is free to
          // include the field once it exists.
          results.push(assertComplete(server, op.method, await request(op.method, op.params)));
        }
        finish(null, results);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}

// ---------------------------------------------------------------------------
// Streamable HTTP transport, dual-era
// ---------------------------------------------------------------------------

// Is this endpoint on this machine? Sending operator credentials off-box is a different act from spawning a
// local subprocess, so it needs `allowRemote: true` in the config rather than being implied by a URL.
//
// Deliberately a HOSTNAME test and not a DNS resolution. Resolving would introduce a TOCTOU gap — the name
// could resolve to loopback here and to something else at request time — and would make an offline check
// depend on a resolver. A hostname that is literally loopback cannot be repointed by DNS at all; anything
// else is treated as remote and must be declared. That is a narrower claim than "this address is local",
// and it is the one that holds without a network.
export function isLoopbackUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0:0:0:0:0:0:0:1";
}

// `Mcp-Name` mirrors params.name into a header. Header values are latin-1 on the wire, so a tool name with
// anything outside it has to be encoded — the transport defines the `=?base64?…?=` sentinel for exactly that.
// Encoding only when needed keeps the common case readable to an intermediary, which is the point of
// mirroring in the first place.
export function encodeMcpName(name) {
  const s = String(name ?? "");
  // Printable ASCII minus the sentinel's own delimiters. Anything else goes to base64.
  return /^[\x20-\x7E]*$/.test(s) && !s.includes("=?") && !s.includes("?=")
    ? s
    : `=?base64?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

// The modern envelope: version, capabilities and identity travel on EVERY request because there is no
// session to hold them. Bureau's server requires protocolVersion and clientCapabilities and treats a missing
// one as -32602; clientInfo is only SHOULD, and is sent anyway so an operator reading server logs can tell
// which client called.
function modernParams(params, version) {
  return {
    ...(params || {}),
    _meta: {
      ...((params || {})._meta || {}),
      [MCP_NS + "protocolVersion"]: version,
      // Latch consumes tools and nothing else. No sampling, no elicitation, no roots — and saying so
      // truthfully matters: a server may gate a tool on a capability, and claiming one Latch does not have
      // would earn a tool call it cannot complete.
      [MCP_NS + "clientCapabilities"]: {},
      [MCP_NS + "clientInfo"]: { name: "latch", version: "0.1.0" }
    }
  };
}

// The headers that must agree with the body, or a compliant server answers -32020. Built from the same
// message object that is about to be serialised, so the two cannot drift.
function modernHeaders(method, params, version) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    "MCP-Protocol-Version": version,
    "Mcp-Method": method
  };
  if (method === "tools/call" || method === "prompts/get") headers["Mcp-Name"] = encodeMcpName(params?.name);
  else if (method === "resources/read") headers["Mcp-Name"] = encodeMcpName(params?.uri);
  return headers;
}

// One HTTP POST. Returns the parsed body alongside the status, because in the modern era the two carry the
// error TOGETHER: a modern server answers a protocol error with HTTP 400 and a JSON-RPC body, and reading
// only the status would lose the code that identifies its era.
async function httpPost(server, { method, params, headers, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(server.url, {
      method: "POST",
      headers: { ...headers, ...(server.headers || {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params || {} }),
      signal: controller.signal,
      redirect: "manual"   // a redirect would re-send the credential headers to wherever it points
    });
  } catch (error) {
    clearTimeout(timer);
    if (error?.name === "AbortError") throw new Error(`MCP server "${server.name}" timed out after ${timeoutMs}ms.`);
    throw new Error(`MCP server "${server.name}" is unreachable: ${error.message}`);
  }
  clearTimeout(timer);
  const text = await res.text().catch(() => "");
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, text };
}

// Which era does this endpoint speak? Decided by PROBING, then cached per server for the process.
//
// The probe is `server/discover`, which the modern spec says a server MUST implement. The interesting part
// is how its failures are read, because the wrong reading is silent:
//
//   modern error code (-32020..-32022)  -> the peer IS modern. Do NOT fall back. These codes are reserved
//                                          for the spec and only a modern server emits them, so receiving
//                                          one is evidence about the peer — and if it says our request was
//                                          malformed, falling back to `initialize` would bury OUR bug under
//                                          a working legacy path and call it success.
//   -32602 on a modern-shaped request   -> same. That is Bureau's code for a missing `_meta` field, which
//                                          only a server that parses `_meta` can complain about.
//   -32601 / 404 / anything else        -> no evidence of a modern peer. Fall back to `initialize`.
//
// -32022 is the one that is actionable rather than terminal: the server names what it does support, so the
// client retries on the best shared revision instead of failing over a preference.
const eraCache = new Map(); // server.name -> { at, era, version }
const ERA_CACHE_TTL_MS = 60_000;

export async function negotiateHttpEra(server, { timeoutMs = DEFAULT_OP_TIMEOUT_MS, useCache = true } = {}) {
  if (useCache) {
    const cached = eraCache.get(server.name);
    if (cached && Date.now() - cached.at < ERA_CACHE_TTL_MS) return { era: cached.era, version: cached.version };
  }
  const decided = await probeHttpEra(server, timeoutMs);
  eraCache.set(server.name, { at: Date.now(), era: decided.era, version: decided.version });
  return decided;
}

async function probeHttpEra(server, timeoutMs, offer = MODERN_VERSION, attempt = 1) {
  const params = modernParams({}, offer);
  const { status, body } = await httpPost(server, {
    method: "server/discover",
    params,
    headers: modernHeaders("server/discover", params, offer),
    timeoutMs
  });

  if (status >= 200 && status < 300 && body && body.result) {
    return { era: "modern", version: offer, discovery: body.result };
  }

  // AUTH is not evidence about the era, and conflating the two sends the operator after the wrong problem.
  // Found by a control rather than by reading: pointing this client at Bureau with a WRONG TOKEN produced
  // "fell back to the initialize handshake" — Bureau 401s the probe, a 401 carries no modern error code, so
  // the fallback fired and the report named a protocol difference that did not exist. The handshake then
  // failed too, for the same unmentioned reason. Refusing here keeps a credential fault legible as one.
  if (status === 401 || status === 403) {
    throw new Error(
      `MCP server "${server.name}" refused the request with HTTP ${status}. That is an authentication `
      + `failure, not a protocol one — check the credentials configured for this server. Latch cannot `
      + `determine which MCP era it speaks until a request is accepted.`
    );
  }

  const code = body?.error?.code;
  if (code === -32022) {
    // The server named what it supports. Retry on the best revision both sides speak, in OUR preference
    // order — and only once, so a server that keeps answering -32022 cannot spin this.
    const offered = Array.isArray(body?.error?.data?.supported) ? body.error.data.supported.map(String) : [];
    const shared = SUPPORTED_PROTOCOL_VERSIONS.filter((v) => offered.includes(v));
    if (attempt === 1 && shared.length && shared[0] !== offer) {
      return probeHttpEra(server, timeoutMs, shared[0], attempt + 1);
    }
    // No overlap: the peer is modern and speaks nothing Latch does. Refusing is the honest end — the same
    // reasoning as the stdio handshake's refusal, and for the same stakes.
    throw new Error(
      `MCP server "${server.name}" supports ${offered.length ? offered.join(", ") : "(none named)"}, `
      + `but Latch speaks ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}. Refusing rather than guessing.`
    );
  }
  if (MODERN_ERROR_CODES.has(code) || code === -32602) {
    // A modern peer rejecting a modern request: that is Latch's bug, not a legacy server. Say so, rather
    // than falling back and passing off the legacy path as a success.
    throw new Error(
      `MCP server "${server.name}" is a modern (${MODERN_VERSION}) server and rejected Latch's request: `
      + `${mcpErrorText(body.error)}. This is a client defect, not an unsupported server — Latch is not `
      + `falling back to the legacy handshake, which would hide it.`
    );
  }
  return { era: "legacy", version: PROTOCOL_VERSION };
}

// Run ops over HTTP in the era this server actually speaks. Each op is its own POST: the modern era has no
// session, and the legacy era's `initialize` is re-done per batch of ops because this transport keeps no
// connection either — the same ephemeral shape as the stdio path, for the same reason.
async function runHttpOps(server, ops, timeoutMs) {
  if (!server.url) throw new Error(`MCP server "${server.name}" has no url configured.`);
  if (!isLoopbackUrl(server.url) && !server.allowRemote) {
    throw new Error(
      `MCP server "${server.name}" points at a non-loopback url and does not set allowRemote: true. `
      + `Latch will not send its configured credentials off this machine without that being stated.`
    );
  }

  const { era, version } = await negotiateHttpEra(server, { timeoutMs });
  const results = [];

  if (era === "legacy") {
    // Legacy over HTTP: the same handshake discipline as stdio, including reading the answer. Offered from
    // the LEGACY list — announcing MODERN_VERSION here would name a revision with no handshake.
    const hello = await httpCall(server, "initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "latch", version: "0.1.0" }
    }, { timeoutMs });
    const agreed = hello?.protocolVersion;
    if (!LEGACY_PROTOCOL_VERSIONS.includes(agreed)) {
      throw new Error(
        `MCP server "${server.name}" negotiated protocol ${agreed ? `"${agreed}"` : "(none announced)"}, `
        + `but Latch speaks ${LEGACY_PROTOCOL_VERSIONS.join(", ")} over the legacy handshake. Disconnecting rather than guessing.`
      );
    }
    // Notification: one-way, no id, and no response to wait for.
    await httpNotify(server, "notifications/initialized", {}, { timeoutMs }).catch(() => {});
    for (const op of ops) results.push(await httpCall(server, op.method, op.params, { timeoutMs }));
    return results;
  }

  for (const op of ops) results.push(await httpCall(server, op.method, op.params, { timeoutMs, version }));
  return results;
}

// One JSON-RPC call. `version` present means the modern envelope; absent means legacy.
async function httpCall(server, method, params, { timeoutMs, version = null } = {}) {
  const body = version ? modernParams(params, version) : (params || {});
  const headers = version
    ? modernHeaders(method, params, version)
    : { "content-type": "application/json", accept: "application/json" };
  const res = await httpPost(server, { method, params: body, headers, timeoutMs });
  if (!res.body || typeof res.body !== "object") {
    throw new Error(`MCP server "${server.name}" answered ${res.status} with no JSON-RPC body.`);
  }
  if (res.body.error) throw new Error(mcpErrorText(res.body.error));
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`MCP server "${server.name}" answered HTTP ${res.status}.`);
  }
  return assertComplete(server, method, res.body.result);
}

async function httpNotify(server, method, params, { timeoutMs } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(server.headers || {}) },
      body: JSON.stringify({ jsonrpc: "2.0", method, params: params || {} }),
      signal: controller.signal,
      redirect: "manual"
    });
  } finally { clearTimeout(timer); }
}

// A result Latch may act on has actually COMPLETED.
//
// The modern era stamps `resultType` on every result and defines values other than "complete" — a Task
// handle being the one that matters, since it means "ask again later", not "here is your answer". Latch
// implements no Tasks extension, so a task handle reaching normalizeToolResult would surface as a tool
// call that ran and returned nothing much: an approval for one thing quietly turned into another. Same
// class of defect as proceeding on a guessed protocol, which is what this file exists to prevent.
//
// Absent is accepted, and that is not laxity: legacy results carry no resultType and clients of earlier
// revisions are told to read its absence as "complete".
export function assertComplete(server, method, result) {
  const kind = result && typeof result === "object" ? result.resultType : undefined;
  if (kind === undefined || kind === "complete") return result;
  throw new Error(
    `MCP server "${server?.name || "?"}" answered ${method} with resultType "${kind}", not "complete". `
    + `Latch implements no Tasks extension, so it cannot follow that up — refusing rather than reporting `
    + `an unfinished call as a result.`
  );
}

// A modern (2026-07-28+) server has no `initialize` at all and rejects ours with a JSON-RPC error. The
// spec asks such a server to name the versions it supports in that error precisely because a legacy
// client like Latch has no fall-forward mechanism and "this message may be the only diagnostic they can
// surface to users". Carrying `data.supported` through turns an opaque failure into an actionable one.
function mcpErrorText(error) {
  const base = error?.message || "MCP error";
  const supported = error?.data?.supported;
  return Array.isArray(supported) && supported.length
    ? `${base} (server supports: ${supported.join(", ")})`
    : base;
}

function stripBom(text) {
  return String(text || "").replace(/^﻿/, "");
}
