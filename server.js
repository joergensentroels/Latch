import http from "node:http";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data");
const publicDir = path.join(__dirname, "public");
const dbPath = path.join(dataDir, "db.json");
const authPath = path.join(dataDir, "auth.json");
const llmConfigPath = path.join(dataDir, "llm-provider.json");
const notificationConfigPath = path.join(dataDir, "notifications.json");
const contextFilesDir = path.join(dataDir, "context-files");
const maxUploadBytes = 2_000_000;
const maxUploadBodyBytes = 3_000_000;
const maxSharedFileBytes = 200_000;
const contextCategories = ["goals", "personality", "security", "project", "memory", "reference", "other"];
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
  attachments: [],
  contextItems: []
};

await mkdir(dataDir, { recursive: true });
await mkdir(contextFilesDir, { recursive: true });
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
    return normalizeDb(db);
  } catch {
    await writeFile(dbPath, JSON.stringify(emptyDb, null, 2));
    return structuredClone(emptyDb);
  }
}

async function writeDb(db) {
  normalizeDb(db);
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
      type: cleanChoice(body.type || body.kind, ["command", "human_verification", "context_question", "account_setup", "purchase", "credential", "other"], "other"),
      title: cleanText(body.title || "Approval requested", 160),
      details: cleanText(body.details || "", 6000),
      command: cleanText(body.command || "", 4000),
      expectedResponse: cleanText(body.expectedResponse || body.resultNeeded || "", 1000),
      contextCategory: cleanCategory(body.contextCategory || body.category || "memory"),
      contextTags: cleanTags(body.contextTags || body.tags),
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
      body: approval.type === "human_verification" || approval.type === "context_question"
        ? "Human input is needed. Open Latch to review."
        : "Approval requested. Open Latch to review.",
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
    if (approval.type === "context_question" && approval.status === "approved" && approval.responseNote) {
      const contextItem = createContextNote({
        title: approval.title,
        text: approval.responseNote,
        category: approval.contextCategory || "memory",
        tags: approval.contextTags || ["operator-answer"],
        shareWithAgent: true,
        source: "operator",
        originApprovalId: approval.id
      });
      db.contextItems.unshift(contextItem);
      db.events.unshift(event("context.answer.saved", "operator", contextItem.id, contextItem.title));
    }
    await writeDb(db);
    sendJson(res, 200, approval);
    return;
  }

  if (url.pathname === "/api/context/notes" && req.method === "POST") {
    requireOperator(role, res);
    if (res.writableEnded) return;

    const body = await readJsonBody(req);
    const text = cleanText(body.text, 12000);
    if (!text) {
      sendJson(res, 400, { error: "context_text_required" });
      return;
    }

    const db = await readDb();
    const item = createContextNote({
      title: body.title || firstLine(text) || "Context note",
      text,
      category: body.category || "memory",
      tags: body.tags,
      shareWithAgent: cleanBoolean(body.shareWithAgent, true),
      source: "operator"
    });
    db.contextItems.unshift(item);
    db.events.unshift(event("context.note.created", "operator", item.id, item.title));
    await writeDb(db);
    sendJson(res, 201, item);
    return;
  }

  if (url.pathname === "/api/context/files" && req.method === "POST") {
    requireOperator(role, res);
    if (res.writableEnded) return;

    const body = await readJsonBody(req, maxUploadBodyBytes);
    const name = safeFileName(body.name || "context-file");
    const contentBase64 = cleanText(body.contentBase64, maxUploadBodyBytes);
    if (!contentBase64) {
      sendJson(res, 400, { error: "file_content_required" });
      return;
    }

    let bytes;
    try {
      bytes = Buffer.from(contentBase64, "base64");
    } catch {
      sendJson(res, 400, { error: "invalid_base64" });
      return;
    }

    if (!bytes.length || bytes.length > maxUploadBytes) {
      sendJson(res, 413, { error: "file_too_large", maxBytes: maxUploadBytes });
      return;
    }

    await mkdir(contextFilesDir, { recursive: true });
    const db = await readDb();
    const id = newId("ctx");
    const storedName = `${id}-${name}`;
    const storedPath = path.join(contextFilesDir, storedName);
    if (!isInsideDirectory(storedPath, contextFilesDir)) {
      sendJson(res, 400, { error: "invalid_file_name" });
      return;
    }

    await writeFile(storedPath, bytes);
    const item = {
      id,
      kind: "file",
      title: name,
      name,
      mimeType: cleanText(body.type || "application/octet-stream", 120),
      size: bytes.length,
      storedName,
      category: cleanCategory(body.category || "reference"),
      tags: cleanTags(body.tags),
      shareWithAgent: cleanBoolean(body.shareWithAgent, false),
      shareStatus: fileShareStatus(cleanText(body.type || "application/octet-stream", 120), bytes.length, name),
      source: "operator",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    db.contextItems.unshift(item);
    db.events.unshift(event("context.file.uploaded", "operator", item.id, `${item.name} (${formatBytes(item.size)})`));
    await writeDb(db);
    sendJson(res, 201, publicContextItem(item));
    return;
  }

  if (url.pathname.startsWith("/api/context/files/") && req.method === "GET") {
    requireOperator(role, res);
    if (res.writableEnded) return;

    const id = url.pathname.split("/").at(-1);
    const db = await readDb();
    const item = db.contextItems.find((entry) => entry.id === id && entry.kind === "file");
    if (!item?.storedName) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    const storedPath = path.join(contextFilesDir, item.storedName);
    if (!isInsideDirectory(storedPath, contextFilesDir)) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }

    try {
      await stat(storedPath);
      res.writeHead(200, {
        "content-type": item.mimeType || "application/octet-stream",
        "content-disposition": `attachment; filename="${downloadFileName(item.name)}"`,
        "cache-control": "no-store"
      });
      createReadStream(storedPath).pipe(res);
    } catch {
      sendJson(res, 404, { error: "file_missing" });
    }
    return;
  }

  if (url.pathname.startsWith("/api/context/") && req.method === "PATCH") {
    requireOperator(role, res);
    if (res.writableEnded) return;

    const body = await readJsonBody(req);
    const id = url.pathname.split("/").at(-1);
    const db = await readDb();
    const item = db.contextItems.find((entry) => entry.id === id);
    if (!item) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    if (body.category !== undefined) item.category = cleanCategory(body.category);
    if (body.tags !== undefined) item.tags = cleanTags(body.tags);
    if (body.shareWithAgent !== undefined) item.shareWithAgent = cleanBoolean(body.shareWithAgent, item.shareWithAgent);
    if (item.kind === "file") item.shareStatus = fileShareStatus(item.mimeType || "", item.size || 0, item.name || "");
    item.updatedAt = new Date().toISOString();
    db.events.unshift(event("context.updated", "operator", item.id, item.title || item.name || "Context"));
    await writeDb(db);
    sendJson(res, 200, operatorContextItem(item));
    return;
  }

  if (url.pathname === "/api/agent/poll" && req.method === "GET") {
    requireAgent(role, res);
    if (res.writableEnded) return;

    const db = await readDb();
    sendJson(res, 200, {
      tasks: db.tasks.filter((task) => ["queued", "running", "waiting"].includes(task.status)),
      messages: db.messages.slice(0, 20),
      approvals: db.approvals.slice(0, 50),
      contextItems: await agentContextItems(db.contextItems.slice(0, 50))
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
    events: db.events.slice(0, 100),
    contextItems: db.contextItems.slice(0, 100).map(operatorContextItem)
  };
}

function normalizeDb(db) {
  db.meta = db.meta || {};
  db.messages = Array.isArray(db.messages) ? db.messages : [];
  db.tasks = Array.isArray(db.tasks) ? db.tasks : [];
  db.approvals = Array.isArray(db.approvals) ? db.approvals : [];
  db.events = Array.isArray(db.events) ? db.events : [];
  db.attachments = Array.isArray(db.attachments) ? db.attachments : [];
  db.contextItems = Array.isArray(db.contextItems) ? db.contextItems : [];
  return db;
}

function publicContextItem(item) {
  const base = {
    id: item.id,
    kind: item.kind,
    title: item.title || item.name || "Context",
    category: item.category || "memory",
    tags: Array.isArray(item.tags) ? item.tags : [],
    shareWithAgent: Boolean(item.shareWithAgent),
    source: item.source || "operator",
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
  if (item.kind === "file") {
    return {
      ...base,
      name: item.name,
      mimeType: item.mimeType,
      size: item.size,
      shareStatus: item.shareStatus || fileShareStatus(item.mimeType || "", item.size || 0, item.name || "")
    };
  }
  return {
    ...base,
    preview: item.preview || cleanText(item.text, 500)
  };
}

function operatorContextItem(item) {
  if (item.kind === "note") {
    return {
      ...publicContextItem(item),
      text: item.text || "",
      originApprovalId: item.originApprovalId || ""
    };
  }
  return {
    ...publicContextItem(item),
    originApprovalId: item.originApprovalId || ""
  };
}

async function agentContextItems(items) {
  const result = [];
  for (const item of items) {
    const visible = publicContextItem(item);
    if (item.shareWithAgent) {
      if (item.kind === "note") {
        visible.text = cleanText(item.text, 4000);
      } else if (item.kind === "file" && canShareFileContent(item)) {
        visible.contentText = await readSharedFileText(item);
      }
    }
    result.push(visible);
  }
  return result;
}

function createContextNote({ title, text, category, tags, shareWithAgent, source, originApprovalId = "" }) {
  const cleanedText = cleanText(text, 12000);
  return {
    id: newId("ctx"),
    kind: "note",
    title: cleanText(title || firstLine(cleanedText) || "Context note", 160),
    text: cleanedText,
    preview: cleanedText.slice(0, 500),
    category: cleanCategory(category || "memory"),
    tags: cleanTags(tags),
    shareWithAgent: Boolean(shareWithAgent),
    source: cleanText(source || "operator", 80),
    originApprovalId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
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

function cleanCategory(value) {
  return cleanChoice(String(value || "memory").toLowerCase(), contextCategories, "memory");
}

function cleanTags(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  return raw
    .map((item) => cleanText(item, 40).toLowerCase())
    .map((item) => item.replace(/[^a-z0-9._ -]/g, "").trim())
    .filter(Boolean)
    .slice(0, 8);
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/).find((line) => line.trim())?.trim() || "";
}

function safeFileName(value) {
  const name = path.basename(String(value || "context-file"));
  const safe = name.replace(/[^a-zA-Z0-9._ -]/g, "_").replace(/\s+/g, " ").trim();
  return safe.slice(0, 120) || "context-file";
}

function downloadFileName(value) {
  return safeFileName(value).replaceAll('"', "");
}

function isInsideDirectory(targetPath, parentPath) {
  const relative = path.relative(parentPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function isTextLike(mimeType, name = "") {
  const type = String(mimeType || "").toLowerCase();
  const ext = path.extname(String(name || "")).toLowerCase();
  return type.startsWith("text/")
    || ["application/json", "application/xml", "application/javascript"].includes(type)
    || [".txt", ".md", ".json", ".csv", ".tsv", ".xml", ".yaml", ".yml", ".log"].includes(ext);
}

function fileShareStatus(mimeType, size, name = "") {
  if (size > maxSharedFileBytes) return `Too large to share automatically (${formatBytes(maxSharedFileBytes)} max).`;
  if (!isTextLike(mimeType, name)) return "Only text-like files can be shared with the worker.";
  return "Ready to share when enabled.";
}

function canShareFileContent(item) {
  return Boolean(item.shareWithAgent)
    && item.kind === "file"
    && Number(item.size || 0) <= maxSharedFileBytes
    && isTextLike(item.mimeType, item.name);
}

async function readSharedFileText(item) {
  try {
    const storedPath = path.join(contextFilesDir, item.storedName || "");
    if (!isInsideDirectory(storedPath, contextFilesDir)) return "";
    const text = await readFile(storedPath, "utf8");
    return cleanText(text, 8000);
  } catch {
    return "";
  }
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

async function readJsonBody(req, maxBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      throw error;
    }
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
