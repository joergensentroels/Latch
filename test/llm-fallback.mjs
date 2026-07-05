// Integration test for the local-primary + own-external-fallback LLM routing.
//
// Starts a real Latch server whose PRIMARY provider points at a dead port (so the primary call
// fails) and whose FALLBACK provider points at a working mock. Then:
//   - routingPreference "backup" -> the request succeeds via the operator's own external fallback.
//   - routingPreference "local"  -> the request does NOT fall back; it fails on the dead primary.
//   - /api/llm/config exposes the fallback model (redacted key) so the UI can show both.
// Ephemeral ports + temp data dir, so it never touches a live instance.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = await mkdtemp(path.join(tmpdir(), "latch-llmfb-"));
const port = String(25000 + Math.floor(Math.random() * 2000));
const fallbackPort = String(27000 + Math.floor(Math.random() * 2000));
const deadPrimaryPort = String(29000 + Math.floor(Math.random() * 2000)); // nothing listens here
const baseUrl = `http://127.0.0.1:${port}`;
const operatorToken = "op_llmfb_test";
const operatorHeaders = { authorization: `Bearer ${operatorToken}` };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The fallback provider (a tiny OpenAI-compatible mock).
const fallbackLlm = http.createServer(async (req, res) => {
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "mock-fallback",
      choices: [{ message: { content: `fallback answered with ${body.model}` } }],
      usage: { prompt_tokens: 3, completion_tokens: 4 }
    }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => fallbackLlm.listen(Number(fallbackPort), "127.0.0.1", resolve));

let child = null;
let stderr = "";

function startServer() {
  child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      HOST: "127.0.0.1",
      PORT: port,
      OPERATOR_TOKEN: operatorToken,
      AGENT_TOKEN: "agent_llmfb_test",
      // Primary points at a dead port so the primary call fails fast.
      LLM_PROVIDER: "openai-compatible",
      LLM_BASE_URL: `http://127.0.0.1:${deadPrimaryPort}/v1`,
      LLM_MODEL: "local-primary-model",
      LLM_API_KEY: "primary-key",
      LLM_TIMEOUT_MS: "4000",
      // Fallback = the operator's own working external provider.
      LLM_FALLBACK_PROVIDER: "openai-compatible",
      LLM_FALLBACK_BASE_URL: `http://127.0.0.1:${fallbackPort}/v1`,
      LLM_FALLBACK_MODEL: "external-backup-model",
      LLM_FALLBACK_API_KEY: "fallback-key"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
}

async function stopServer() {
  if (!child) return;
  const current = child;
  child = null;
  current.kill("SIGTERM");
  await new Promise((resolve) => { current.on("exit", resolve); setTimeout(resolve, 3000); });
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  return { status: response.status, json };
}

async function waitForHealth() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const { json } = await request("/api/health");
      if (json.ok) return;
    } catch {
      await delay(120);
    }
  }
  throw new Error(`server did not become healthy\nstderr:\n${stderr}`);
}

try {
  startServer();
  await waitForHealth();

  // /api/llm/config exposes both the primary and the fallback model.
  const cfg = (await request("/api/llm/config", { headers: operatorHeaders })).json;
  assert.equal(cfg.model, "local-primary-model", "config exposes the primary model");
  assert.ok(cfg.fallback && cfg.fallback.model === "external-backup-model", "config exposes the fallback model");
  assert.ok(!JSON.stringify(cfg).includes("fallback-key"), "fallback api key must not be exposed");

  // "backup": primary (dead) fails -> answered by the operator's own external fallback.
  const backup = (await request("/api/llm/chat", {
    method: "POST",
    headers: operatorHeaders,
    body: { messages: [{ role: "user", content: "hi" }], routingPreference: "backup" }
  })).json;
  assert.equal(backup.ok, true, "backup routing should succeed via the fallback provider");
  assert.equal(backup.routing.usedFallback, true, "backup routing should record that it used the fallback");
  assert.ok(String(backup.text || "").includes("fallback answered"), "response should come from the fallback provider");

  // "local": no fallback allowed -> the dead primary just fails.
  const local = (await request("/api/llm/chat", {
    method: "POST",
    headers: operatorHeaders,
    body: { messages: [{ role: "user", content: "hi" }], routingPreference: "local" }
  })).json;
  assert.notEqual(local.ok, true, "local-only routing must not fall back to the external provider");
  assert.ok(!local.routing || !local.routing.usedFallback, "local-only routing must not record a fallback");

  console.log("LLM fallback routing integration test passed.");
} finally {
  await stopServer();
  fallbackLlm.close();
  await rm(dataDir, { recursive: true, force: true });
}
