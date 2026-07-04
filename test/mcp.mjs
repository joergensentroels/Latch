// Unit tests for the host-brokered MCP client (mcp.mjs).
// Covers config loading + redaction, the allowlist, the mock transport, and — importantly — the
// real stdio JSON-RPC transport against a tiny inline MCP server subprocess.

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {
  loadMcpConfig,
  publicMcpConfig,
  findServer,
  listTools,
  callTool,
  isToolAllowed,
  isToolAutoApprovable,
  validateToolArgs
} from "../mcp.mjs";

// A minimal MCP server that speaks newline-delimited JSON-RPC 2.0 over stdio.
const FAKE_SERVER = `
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1" } } });
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "greet", description: "Greet someone", inputSchema: { type: "object" } }] } });
    } else if (message.method === "tools/call") {
      const args = (message.params && message.params.arguments) || {};
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "hello " + (args.name || "world") }], isError: false } });
    }
  }
});
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
`;

const dir = await mkdtemp(path.join(tmpdir(), "latch-mcp-"));
const configPath = path.join(dir, "mcp.json");

try {
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    servers: [
      {
        name: "fake",
        description: "inline stdio server",
        transport: "stdio",
        command: process.execPath,
        args: ["-e", FAKE_SERVER],
        env: { SECRET_KEY: "do-not-leak" },
        allowedTools: ["greet"]
      },
      {
        name: "mockecho",
        transport: "mock",
        allowedTools: ["echo", "write"],
        autoApprove: ["echo"],
        argConstraints: { write: { path: { prefix: "/allowed/" } } },
        mockTools: [
          { name: "echo", description: "echo" },
          { name: "blocked", description: "blocked" },
          { name: "write", description: "write", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }
        ]
      }
    ]
  }));

  const config = await loadMcpConfig(configPath, {});
  assert.equal(config.enabled, true, "config with servers + enabled should be enabled");
  assert.equal(config.servers.length, 2, "both servers should load");

  // Redaction: env values never surface; env key names may.
  const pub = publicMcpConfig(config);
  const serialized = JSON.stringify(pub);
  assert.ok(!serialized.includes("do-not-leak"), "env values must be redacted");
  const fakePub = pub.servers.find((s) => s.name === "fake");
  assert.ok(fakePub.envKeys.includes("SECRET_KEY"), "env key names should be visible");
  assert.ok(!("env" in fakePub), "raw env object must not be present in public config");

  // Allowlist logic.
  const fake = findServer(config, "fake");
  assert.equal(isToolAllowed(fake, "greet"), true, "allowlisted tool is allowed");
  assert.equal(isToolAllowed(fake, "rm"), false, "non-allowlisted tool is blocked");
  const mock = findServer(config, "mockecho");
  assert.equal(isToolAutoApprovable(mock, "echo"), true, "autoApprove tool flagged");
  assert.equal(isToolAutoApprovable(mock, "blocked"), false, "non-autoApprove tool not flagged");

  // Mock transport.
  const mockTools = await listTools(mock, { useCache: false });
  assert.ok(mockTools.some((t) => t.name === "echo"), "mock lists its tools");
  const mockResult = await callTool(mock, "echo", { a: 1 });
  assert.ok(mockResult.ok && mockResult.text.includes("mock:mockecho:echo"), "mock echoes the call");
  await assert.rejects(() => callTool(mock, "blocked", {}), /allowlist/, "mock enforces the allowlist");

  // Argument validation (typed args): schema subset.
  const wSchema = { type: "object", properties: { path: { type: "string" }, count: { type: "integer" } }, required: ["path"], additionalProperties: false };
  assert.equal(validateToolArgs(wSchema, null, { path: "x" }).ok, true, "valid args pass");
  assert.equal(validateToolArgs(wSchema, null, {}).ok, false, "missing required field fails");
  assert.equal(validateToolArgs(wSchema, null, { path: 5 }).ok, false, "wrong type fails");
  assert.equal(validateToolArgs(wSchema, null, { path: "x", extra: 1 }).ok, false, "unexpected field fails (additionalProperties:false)");
  assert.equal(validateToolArgs({ type: "object", properties: { m: { enum: ["a", "b"] } } }, null, { m: "c" }).ok, false, "enum violation fails");
  // Operator argument constraints (prefix).
  assert.equal(validateToolArgs(null, { path: { prefix: "/allowed/" } }, { path: "/allowed/f" }).ok, true, "prefix ok");
  assert.equal(validateToolArgs(null, { path: { prefix: "/allowed/" } }, { path: "/etc/shadow" }).ok, false, "prefix violation fails");

  // callTool enforces both schema and constraints before running the tool.
  assert.ok((await callTool(mock, "write", { path: "/allowed/note.txt" })).ok, "write with a permitted path runs");
  await assert.rejects(() => callTool(mock, "write", {}), /required/, "write without required path is rejected");
  await assert.rejects(() => callTool(mock, "write", { path: "/etc/shadow" }), /must start with/, "write outside the allowed prefix is rejected");
  await assert.rejects(() => callTool(mock, "write", { path: "/allowed/x", extra: 1 }), /unexpected field/, "write with an unexpected field is rejected");

  // Real stdio transport: handshake + tools/list + tools/call.
  const tools = await listTools(fake, { useCache: false });
  assert.ok(tools.length === 1 && tools[0].name === "greet", "stdio server tools/list works");
  const result = await callTool(fake, "greet", { name: "Emil" });
  assert.equal(result.ok, true, "stdio tool call succeeds");
  assert.equal(result.text, "hello Emil", "stdio tool call returns the tool's text content");

  // A server that exits immediately should fail with a clear error, not hang.
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    servers: [{ name: "broken", transport: "stdio", command: process.execPath, args: ["-e", "process.exit(1)"] }]
  }));
  const brokenConfig = await loadMcpConfig(configPath, {});
  const broken = findServer(brokenConfig, "broken");
  await assert.rejects(() => listTools(broken, { useCache: false, timeoutMs: 5000 }), "a crashing MCP server should reject, not hang");

  console.log("MCP unit tests passed.");
} finally {
  await rm(dir, { recursive: true, force: true });
}
