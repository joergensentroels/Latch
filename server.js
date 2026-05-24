import http from "node:http";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "data");
const publicDir = path.join(__dirname, "public");
const dbPath = path.join(dataDir, "db.json");
const authPath = path.join(dataDir, "auth.json");
const llmConfigPath = path.join(dataDir, "llm-provider.json");
const notificationConfigPath = path.join(dataDir, "notifications.json");
const hosts = (process.env.HOSTS || process.env.HOST || "127.0.0.1")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const port = Number(process.env.PORT || 8787);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

const emptyDb = {
  meta: {
    createdAt: new Date().toISOString(),
    name: "Latch"
  },
  messages: [],
  tasks: [],
  approvals: [],
  events: [],
  attachments: []
};

await mkdir(dataDir, { recursive: true });
const auth = await loadAuth();

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
        return;
      }
      await serveStatic(req, res, url);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: "server_error", message: error.message });
    }
  });
}

for (const host of hosts) {
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`Latch listening on http://${host}:${port}`);
  });
}

console.log("Keys loaded. Use Show-CommandCenter-Keys.ps1 on the trusted host to view them.");

async function loadAuth() {
  if (process.env.OPERATOR_TOKEN && process.env.AGENT_TOKEN) {
    return {
      operatorToken: process.env.OPERATOR_TOKEN,
      agentToken: process.env.AGENT_TOKEN
    };
  }

  try {
    return JSON.parse(await readFile(authPath, "utf8"));
  } catch {
    const generated = {
      operatorToken: `op_${crypto.randomBytes(24).toString("base64url")}`,
      agentToken: `agent_${crypto.randomBytes(24).toString("base64url")}`,
      createdAt: new Date().toISOString()
    };
    await writeFile(authPath, JSON.stringify(generated, null, 2));
    return generated;
  }
}

async function readDb() {
  try {
    const db = JSON.parse(await readFile(dbPath, "utf8"));
    db.meta = db.meta || {};
    if (!db.meta.name || db.meta.name === "OpenClaw Command Center") {
      db.meta.name = "Latch";
    }
    return db;
  } catch {
    await writeFile(dbPath, JSON.stringify(emptyDb, null, 2));
    return structuredClone(emptyDb);
  }
}

async function writeDb(db) {
  db.meta.updatedAt = new Date().toISOString();
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/health" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      app: "latch",
      time: new Date().toISOString()
    });
    return;
  }

  const role = authenticate(req);
  if (!role) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (url.pathname === "/api/state" && req.method === "GET") {
    const db = await readDb();
    sendJson(res, 200, visibleState(db));
    return;
  }

  if (url.pathname === "/api/llm/config" && req.method === "GET") {
    requireOperator(role, res);
    if (res.writableEnded) return;

    const config = await loadLlmConfig();
    sendJson(res, 200, publicLlmConfig(config));
    return;
  }

  if (url.pathname === "/api/llm/chat" && req.method === "POST") {
    const body = await readJsonBody(req);
    const config = await loadLlmConfig();
    const result = await callExternalLlm(config, body);
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === "/api/notifications/config" && req.method === "GET") {
    requireOperator(role, res);
    if (res.writableEnded) return;

    const config = await loadNotificationConfig();
    sendJson(res, 200, publicNotificationConfig(config));
    return;
  }

  if (url.pathname === "/api/notifications/test" && req.method === "POST") {
    requireOperator(role, res);
    if (res.writableEnded) return;

    const result = await sendNotification({
      type: "test",
      title: "Latch",
      body: "Test notification. Open Latch to review.",
      url: "/?tab=approvals"
    });
    sendJson(res, result.ok ? 200 : 503, result);
    return;
  }

  if (url.pathname === "/api/messages" && req.method === "POST") {
    requireOperator(role, res);
    if (res.writableEnded) return;

    const body = await readJsonBody(req);
    const db = await readDb();
    const message = {
      id: newId("msg"),
      direction: "operator_to_agent",
      author: "operator",
      text: cleanText(body.text, 6000),
      createdAt: new Date().toISOString()
    };
    db.messages.unshift(message);
    db.events.unshift(event("message.created", "operator", message.id, message.text.slice(0, 120)));
    await writeDb(db);
    sendJson(res, 201, message);
    return;
  }

  if (url.pathname === "/api/tasks" && req.method === "POST") {
    requireOperator(role, res);
    if (res.writableEnded) return;

    const body = await readJsonBody(req);
    const db = await readDb();
    const task = {
      id: newId("task"),
      title: cleanText(body.title || body.text || "Untitled task", 160),
      details: cleanText(body.details || body.text || "", 6000),
      status: "queued",
      priority: cleanChoice(body.priority, ["normal", "high", "low"], "normal"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    db.tasks.unshift(task);
    db.events.unshift(event("task.created", "operator", task.id, task.title));
    await writeDb(db);
    sendJson(res, 201, task);
    return;
  }

  if (url.pathname.startsWith("/api/tasks/") && req.method === "PATCH") {
    const body = await readJsonBody(req);
    const id = url.pathname.split("/").at(-1);
    const db = await readDb();
    const task = db.tasks.find((item) => item.id === id);
    if (!task) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    const allowedStatuses = ["queued", "running", "waiting", "done", "failed", "paused"];
    if (body.status) task.status = cleanChoice(body.status, allowedStatuses, task.status);
    if (body.note) task.note = cleanText(body.note, 2000);
    task.updatedAt = new Date().toISOString();
    db.events.unshift(event("task.updated", role, task.id, `${task.title}: ${task.status}`));
    await writeDb(db);
    sendJson(res, 200, task);
    return;
  }

  if (url.pathname === "/api/approvals" && req.method === "POST") {
    const body = await readJsonBody(req);
    const db = await readDb();
    const approval = {
      id: newId("approval"),
      type: cleanChoice(body.type || body.kind, ["command", "human_verification", "account_setup", "purchase", "credential", "other"], "other"),
      title: cleanText(body.title || "Approval requested", 160),
      details: cleanText(body.details || "", 6000),
      command: cleanText(body.command || "", 4000),
      expectedResponse: cleanText(body.expectedResponse || body.resultNeeded || "", 1000),
      taskId: cleanText(body.taskId || "", 120),
      messageId: cleanText(body.messageId || "", 120),
      sensitive: Boolean(body.sensitive),
      status: "pending",
      requestedBy: role,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    db.approvals.unshift(approval);
    db.events.unshift(event("approval.requested", role, approval.id, `${approval.type}: ${approval.title}`));
    await writeDb(db);
    await sendNotification({
      type: "approval.requested",
      title: "Latch needs attention",
      body: approval.type === "human_verification" ? "Human help is needed. Open Latch to review." : "Approval requested. Open Latch to review.",
      url: "/?tab=approvals"
    });
    sendJson(res, 201, approval);
    return;
  }

  if (url.pathname.startsWith("/api/approvals/") && req.method === "PATCH") {
    requireOperator(role, res);
    if (res.writableEnded) return;

    const body = await readJsonBody(req);
    const id = url.pathname.split("/").at(-1);
    const db = await readDb();
    const approval = db.approvals.find((item) => item.id === id);
    if (!approval) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    approval.status = cleanChoice(body.status, ["approved", "denied", "pending"], approval.status);
    approval.responseNote = cleanText(body.note || "", 2000);
    approval.updatedAt = new Date().toISOString();
    db.events.unshift(event(`approval.${approval.status}`, "operator", approval.id, approval.title));
    await writeDb(db);
    sendJson(res, 200, approval);
    return;
  }

  if (url.pathname === "/api/agent/poll" && req.method === "GET") {
    requireAgent(role, res);
    if (res.writableEnded) return;

    const db = await readDb();
    sendJson(res, 200, {
      tasks: db.tasks.filter((task) => ["queued", "running", "waiting"].includes(task.status)),
      messages: db.messages.slice(0, 20),
      approvals: db.approvals.slice(0, 50)
    });
    return;
  }

  if (url.pathname === "/api/agent/report" && req.method === "POST") {
    requireAgent(role, res);
    if (res.writableEnded) return;

    const body = await readJsonBody(req);
    const db = await readDb();
    const message = {
      id: newId("msg"),
      direction: "agent_to_operator",
      author: "openclaw",
      text: cleanText(body.text || "", 6000),
      taskId: cleanText(body.taskId || "", 120),
      createdAt: new Date().toISOString()
    };
    db.messages.unshift(message);
    db.events.unshift(event("agent.reported", "agent", message.id, message.text.slice(0, 120)));
    await writeDb(db);
    await sendNotification({
      type: "agent.reported",
      title: "Latch agent update",
      body: "Open Latch to read the latest update.",
      url: "/?tab=inbox"
    });
    sendJson(res, 201, message);
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

async function serveStatic(req, res, url) {
  let filePath = path.normalize(decodeURIComponent(url.pathname));
  if (filePath === "\\" || filePath === "/") filePath = "index.html";
  filePath = filePath.replace(/^[/\\]+/, "");

  const absolute = path.join(publicDir, filePath);
  if (!absolute.startsWith(publicDir)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const info = await stat(absolute);
    const finalPath = info.isDirectory() ? path.join(absolute, "index.html") : absolute;
    const ext = path.extname(finalPath).toLowerCase();
    res.writeHead(200, {
      "content-type": mimeTypes[ext] || "application/octet-stream",
      "cache-control": "no-store"
    });
    createReadStream(finalPath).pipe(res);
  } catch {
    sendText(res, 404, "Not found");
  }
}

async function loadLlmConfig() {
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(await readFile(llmConfigPath, "utf8"));
  } catch {
    fileConfig = {};
  }

  const config = {
    provider: process.env.LLM_PROVIDER || fileConfig.provider || "openai-compatible",
    baseUrl: process.env.LLM_BASE_URL || fileConfig.baseUrl || "",
    model: process.env.LLM_MODEL || fileConfig.model || "",
    apiKey: String(process.env.LLM_API_KEY || fileConfig.apiKey || "").trim(),
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || fileConfig.timeoutMs || 60000),
    configPath: llmConfigPath,
    fileLoaded: Object.keys(fileConfig).length > 0
  };
  config.enabled = Boolean(config.baseUrl && config.model && config.apiKey);
  return config;
}

async function loadNotificationConfig() {
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(await readFile(notificationConfigPath, "utf8"));
  } catch {
    fileConfig = {};
  }

  const config = {
    provider: process.env.NOTIFY_PROVIDER || fileConfig.provider || "webhook",
    url: process.env.NOTIFY_URL || process.env.NOTIFY_WEBHOOK_URL || fileConfig.url || "",
    token: process.env.NOTIFY_TOKEN || process.env.NOTIFY_WEBHOOK_TOKEN || fileConfig.token || "",
    enabled: cleanBoolean(process.env.NOTIFY_ENABLED, fileConfig.enabled ?? false),
    timeoutMs: Number(process.env.NOTIFY_TIMEOUT_MS || fileConfig.timeoutMs || 5000)
  };
  config.ready = Boolean(config.enabled && config.url);
  return config;
}

function publicNotificationConfig(config) {
  return {
    provider: config.provider,
    enabled: config.enabled,
    ready: config.ready,
    hasToken: Boolean(config.token),
    urlConfigured: Boolean(config.url)
  };
}

async function sendNotification(notification) {
  const config = await loadNotificationConfig();
  if (!config.ready) return { ok: false, skipped: true, reason: "notifications_not_configured" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(config.url, notificationRequest(config, notification, controller.signal));
    if (!response.ok) {
      return { ok: false, status: response.status, error: "notification_delivery_failed" };
    }
    return { ok: true, provider: config.provider };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    clearTimeout(timeout);
  }
}

function notificationRequest(config, notification, signal) {
  if (config.provider === "ntfy") {
    return {
      method: "POST",
      headers: {
        "title": notification.title,
        "tags": "bell",
        ...(config.token ? { "authorization": `Bearer ${config.token}` } : {})
      },
      body: notification.body,
      signal
    };
  }

  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.token ? { "authorization": `Bearer ${config.token}` } : {})
    },
    body: JSON.stringify({
      ...notification,
      app: "latch",
      createdAt: new Date().toISOString()
    }),
    signal
  };
}

function publicLlmConfig(config) {
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    enabled: config.enabled,
    hasApiKey: Boolean(config.apiKey),
    fileLoaded: config.fileLoaded,
    configPath: config.configPath,
    endpointMode: "openai-compatible-chat-completions",
    note: "Use /api/llm/chat through Latch to keep the external API key off the OpenClaw machine."
  };
}

async function callExternalLlm(config, body) {
  if (!config.enabled) {
    const error = new Error("External LLM is not configured. Set LLM_BASE_URL, LLM_MODEL, and LLM_API_KEY or create data/llm-provider.json.");
    error.statusCode = 503;
    throw error;
  }

  const messages = normalizeMessages(body);
  if (!messages.length) {
    const error = new Error("A prompt or messages array is required.");
    error.statusCode = 400;
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const payload = {
    model: cleanText(body.model || config.model, 160),
    messages,
    temperature: numberOrDefault(body.temperature, 0.2)
  };
  if (body.maxTokens || body.max_tokens) {
    payload.max_tokens = numberOrDefault(body.maxTokens || body.max_tokens, 1024);
  }

  try {
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${config.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (error) {
      return {
        ok: false,
        provider: config.provider,
        model: payload.model,
        status: 0,
        error: "external_llm_connection_failed",
        details: {
          message: error.message,
          cause: error.cause?.code || error.cause?.message || null
        }
      };
    }

    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text.slice(0, 2000) };
    }

    if (!response.ok) {
      return {
        ok: false,
        provider: config.provider,
        model: payload.model,
        status: response.status,
        error: json.error?.message || json.message || "external_llm_error",
        details: json.error || json
      };
    }

    return {
      ok: true,
      provider: config.provider,
      model: payload.model,
      text: json.choices?.[0]?.message?.content || "",
      usage: json.usage || null,
      id: json.id || null
    };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeMessages(body) {
  if (Array.isArray(body.messages)) {
    return body.messages
      .map((message) => ({
        role: cleanChoice(message.role, ["system", "user", "assistant"], "user"),
        content: cleanText(message.content, 12000)
      }))
      .filter((message) => message.content);
  }

  const prompt = cleanText(body.prompt || body.text || "", 12000);
  return prompt ? [{ role: "user", content: prompt }] : [];
}

function authenticate(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : req.headers["x-command-token"];
  if (token === auth.operatorToken) return "operator";
  if (token === auth.agentToken) return "agent";
  return null;
}

function requireOperator(role, res) {
  if (role !== "operator") sendJson(res, 403, { error: "operator_required" });
}

function requireAgent(role, res) {
  if (role !== "agent") sendJson(res, 403, { error: "agent_required" });
}

function visibleState(db) {
  return {
    meta: db.meta,
    messages: db.messages.slice(0, 100),
    tasks: db.tasks.slice(0, 100),
    approvals: db.approvals.slice(0, 100),
    events: db.events.slice(0, 100)
  };
}

function event(type, actor, targetId, summary) {
  return {
    id: newId("evt"),
    type,
    actor,
    targetId,
    summary,
    createdAt: new Date().toISOString()
  };
}

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function cleanChoice(value, choices, fallback) {
  return choices.includes(value) ? value : fallback;
}

function cleanBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return Boolean(fallback);
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function sendText(res, status, value) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(value);
}
