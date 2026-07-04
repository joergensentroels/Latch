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

const PROTOCOL_VERSION = "2025-06-18";
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
    transport: transport === "mock" ? "mock" : "stdio",
    command: String(raw.command || "").trim(),
    args: Array.isArray(raw.args) ? raw.args.map((a) => String(a)) : [],
    env: raw.env && typeof raw.env === "object" ? raw.env : {},
    cwd: String(raw.cwd || "").trim(),
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

// Never leak env values (that is where API keys live) or the mock tool seeds.
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
  const result = await runStdioOps(server, [{ method: "tools/list", params: {} }], timeoutMs);
  const tools = normalizeTools(result[0]?.tools);
  toolsCache.set(server.name, { at: Date.now(), tools });
  return tools;
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
  const result = await runStdioOps(
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
        if (message.error) waiter.reject(new Error(message.error.message || "MCP error"));
        else waiter.resolve(message.result);
      }
    });

    // Handshake, then the requested ops.
    (async () => {
      try {
        await request("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "latch", version: "0.1.0" }
        });
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        for (const op of ops) {
          results.push(await request(op.method, op.params));
        }
        finish(null, results);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}

function stripBom(text) {
  return String(text || "").replace(/^﻿/, "");
}
