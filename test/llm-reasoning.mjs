// The reasoning-control allowlist on /api/llm/chat.
//
// Latch holds the provider API key so that nothing else has to. That makes "what may a caller put into the
// outgoing request" a security question, not a convenience one — so this is an ALLOWLIST, and half of this file
// exists to prove that the things NOT on it really do not travel.
//
// Why the allowlist exists at all, measured on a live agent round: 29,125 of 29,246 output tokens went to
// reasoning and 121 tokens of content came back across twelve calls. Eleven turns in a row were empty, the run
// finished "clean" with no findings, and the caller's retry logic answered by RAISING the output budget — which on
// a reasoning model buys more reasoning and never content. Without a way to say "think less", the caller cannot
// fix that from its own side, however good its retry logic is.
//
// The mock provider RECORDS the payload it is handed, so every assertion below is about the bytes that reached the
// provider rather than about what Latch says it sent.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = await mkdtemp(path.join(tmpdir(), "latch-reason-"));
const port = String(25000 + Math.floor(Math.random() * 2000));
const llmPort = String(27000 + Math.floor(Math.random() * 2000));
const baseUrl = `http://127.0.0.1:${port}`;
const operatorToken = "op_reason_test";
const operatorHeaders = { authorization: `Bearer ${operatorToken}` };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let lastPayload = null;
const mockLlm = http.createServer(async (req, res) => {
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    lastPayload = raw ? JSON.parse(raw) : {};
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "mock",
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 3, completion_tokens: 4 }
    }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => mockLlm.listen(Number(llmPort), "127.0.0.1", resolve));

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
      AGENT_TOKEN: "agent_reason_test",
      LLM_PROVIDER: "openai-compatible",
      LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
      LLM_MODEL: "mock-model",
      LLM_API_KEY: "mock-key",
      LLM_TIMEOUT_MS: "4000"
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

// Sends one chat request and returns the payload the PROVIDER received.
async function sent(extra) {
  lastPayload = null;
  const { json } = await request("/api/llm/chat", {
    method: "POST",
    headers: operatorHeaders,
    body: { messages: [{ role: "user", content: "hi" }], routingPreference: "external", ...extra }
  });
  assert.equal(json.ok, true, `the call itself must succeed, got: ${JSON.stringify(json).slice(0, 200)}`);
  assert.ok(lastPayload, "the mock provider recorded no payload");
  return lastPayload;
}

try {
  startServer();
  await waitForHealth();

  // The baseline. Without it, "the field is absent" proves nothing — it could be absent from every request.
  const plain = await sent({});
  assert.ok(!("reasoning_effort" in plain), "no reasoning_effort unless asked for");
  assert.ok(!("thinking" in plain), "no thinking block unless asked for");
  assert.equal(plain.model, "mock-model", "the baseline request is otherwise normal");

  // What IS on the allowlist.
  assert.equal((await sent({ reasoningEffort: "low" })).reasoning_effort, "low", "camelCase effort travels");
  assert.equal((await sent({ reasoning_effort: "max" })).reasoning_effort, "max", "snake_case effort travels too");
  assert.deepEqual((await sent({ thinking: { type: "disabled" } })).thinking, { type: "disabled" },
    "a disabled thinking block travels");
  assert.deepEqual((await sent({ thinking: { type: "enabled" } })).thinking, { type: "enabled" },
    "and an enabled one does");

  // JSON mode, the third allowlisted field. Only the exact documented shape travels, rebuilt.
  assert.deepEqual((await sent({ responseFormat: { type: "json_object" } })).response_format, { type: "json_object" },
    "camelCase json mode travels, snake_cased");
  assert.deepEqual((await sent({ response_format: { type: "json_object" } })).response_format, { type: "json_object" },
    "snake_case json mode travels too");
  const rfExtras = await sent({ response_format: { type: "json_object", schema: { evil: true }, junk: 1 } });
  assert.deepEqual(rfExtras.response_format, { type: "json_object" },
    "only `type` survives — the block is rebuilt, not copied");
  const rfSchema = await sent({ response_format: { type: "json_schema", json_schema: { name: "x" } } });
  assert.ok(!("response_format" in rfSchema),
    "json_schema is dropped — a schema is caller-authored content, not a fixed switch");
  const rfString = await sent({ response_format: "json_object" });
  assert.ok(!("response_format" in rfString), "a bare string is the wrong shape and is dropped");

  // What is NOT. Each of these is a way the boundary could leak if the code were a passthrough instead.
  const junkEffort = await sent({ reasoningEffort: "banana" });
  assert.ok(!("reasoning_effort" in junkEffort), "an unlisted effort value is dropped, not forwarded");
  const junkThinking = await sent({ thinking: { type: "banana" } });
  assert.ok(!("thinking" in junkThinking), "an unlisted thinking type is dropped");
  const stringThinking = await sent({ thinking: "disabled" });
  assert.ok(!("thinking" in stringThinking), "a thinking field of the wrong shape is dropped");
  const extraKeys = await sent({ thinking: { type: "disabled", budget_tokens: 99999, secret: "x" } });
  assert.deepEqual(extraKeys.thinking, { type: "disabled" }, "only `type` survives — the block is rebuilt, not copied");

  // The ones that matter for the credential boundary: a caller must not be able to change WHAT THE KEY IS USED FOR.
  const smuggle = await sent({
    stream: true,
    tools: [{ type: "function", function: { name: "exfiltrate" } }],
    tool_choice: "required",
    top_p: 0.01,
    n: 8,
    // json_schema, not json_object: the allowlisted shape now travels by design, so the smuggling case has to use
    // a shape that must NOT — otherwise this block would fail for the wrong reason and prove nothing.
    response_format: { type: "json_schema", json_schema: { name: "exfil" } },
    user: "someone-else"
  });
  for (const key of ["stream", "tools", "tool_choice", "top_p", "n", "response_format", "user"]) {
    assert.ok(!(key in smuggle), `${key} must not reach the provider — this is an allowlist, not a passthrough`);
  }
  assert.deepEqual(Object.keys(smuggle).sort(), ["messages", "model", "temperature"],
    "a request asking for everything still sends only the fields Latch builds itself");

  // And the API key never appears in what a caller can read back.
  const cfg = (await request("/api/llm/config", { headers: operatorHeaders })).json;
  assert.ok(!JSON.stringify(cfg).includes("mock-key"), "the api key must not be exposed");

  console.log("LLM reasoning-control allowlist test passed.");
} finally {
  await stopServer();
  await new Promise((resolve) => mockLlm.close(resolve));
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}
