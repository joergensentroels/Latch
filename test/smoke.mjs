import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = await mkdtemp(path.join(tmpdir(), "latch-smoke-"));
const port = String(19000 + Math.floor(Math.random() * 1000));
const baseUrl = `http://127.0.0.1:${port}`;
const operatorToken = "op_test_operator";
const agentToken = "agent_test_agent";

const child = spawn(process.execPath, ["server.js"], {
  cwd: root,
  env: {
    ...process.env,
    DATA_DIR: dataDir,
    HOST: "127.0.0.1",
    PORT: port,
    OPERATOR_TOKEN: operatorToken,
    AGENT_TOKEN: agentToken
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  await waitForHealth();
  await expectStatus("/api/state", {}, 401);

  const operatorHeaders = authHeaders(operatorToken);
  const agentHeaders = authHeaders(agentToken);

  const initialState = await request("/api/state", { headers: operatorHeaders });
  assert(initialState.channels.some((channel) => channel.id === "compass"), "state should expose default channels");

  await expectStatus("/api/channels", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...agentHeaders
    },
    body: JSON.stringify({ label: "Should fail" })
  }, 403);

  const customChannel = await request("/api/channels", {
    method: "POST",
    headers: operatorHeaders,
    body: { label: "Experiments", description: "Trial conversations" }
  });
  assert(customChannel.id === "experiments", "custom channel should use a stable slug");
  assert(!customChannel.builtIn, "custom channel should not be built in");

  const message = await request("/api/messages", {
    method: "POST",
    headers: operatorHeaders,
    body: { text: "hello worker", channel: customChannel.id }
  });
  assert(message.direction === "operator_to_agent", "operator message should be stored");
  assert(message.channel === customChannel.id, "operator message should keep custom channel");

  const movedMessage = await request(`/api/messages/${message.id}`, {
    method: "PATCH",
    headers: operatorHeaders,
    body: { channel: "operations" }
  });
  assert(movedMessage.channel === "operations", "operator should move messages between channels");

  const archivedChannel = await request(`/api/channels/${customChannel.id}`, {
    method: "PATCH",
    headers: operatorHeaders,
    body: { archived: true }
  });
  assert(archivedChannel.archivedAt, "custom channel archive should set archivedAt");
  const afterChannelArchive = await request("/api/state", { headers: operatorHeaders });
  assert(!afterChannelArchive.channels.some((channel) => channel.id === customChannel.id), "archived channel should leave active state");
  assert(afterChannelArchive.archives.channels.some((channel) => channel.id === customChannel.id), "archived channel should appear in archives");
  await expectStatus(`/api/channels/compass`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...operatorHeaders
    },
    body: JSON.stringify({ archived: true })
  }, 400);

  const task = await request("/api/tasks", {
    method: "POST",
    headers: operatorHeaders,
    body: {
      title: "Smoke task",
      goal: "Smoke task",
      instructions: "Keep the smoke test bounded.",
      details: "test details",
      priority: "low"
    }
  });
  assert(task.status === "queued", "task should start queued");
  assert(task.goal === "Smoke task", "task should store goal");
  assert(task.instructions.includes("bounded"), "task should store optional instructions");

  const approval = await request("/api/approvals", {
    method: "POST",
    headers: agentHeaders,
    body: {
      type: "command",
      title: "Command approval",
      details: "Test command approval",
      riskLevel: "low",
      actionTemplate: "bridge.status",
      actionPreview: "Check bridge status",
      renderedCommands: ["systemctl is-active latch-agent-bridge"],
      executionMode: "read_only_status",
      taskId: task.id
    }
  });
  assert(approval.requestedBy === "agent", "approval should record agent requester");
  assert(approval.taskId === task.id, "approval should keep source task id");
  assert(approval.actionTemplate === "bridge.status", "approval should store action template");
  assert(approval.executionMode === "read_only_status", "approval should store execution mode");
  assert(approval.renderedCommands[0].includes("systemctl"), "approval should store rendered commands");

  const contactApproval = await request("/api/approvals", {
    method: "POST",
    headers: agentHeaders,
    body: {
      type: "external_contact",
      title: "External contact",
      details: "Draft contact request",
      recipient: "reviewer@example.com",
      subject: "Security review request",
      contactPurpose: "Ask a trusted reviewer to inspect Latch before public release.",
      bodyPreview: "Could you review Latch?",
      sendMode: "manual",
      riskLevel: "medium",
      sensitive: true
    }
  });
  assert(contactApproval.type === "external_contact", "external contact approval type should be accepted");
  assert(contactApproval.recipient === "reviewer@example.com", "external contact recipient should be stored");
  assert(contactApproval.contactPurpose.includes("trusted reviewer"), "external contact purpose should be stored");
  assert(contactApproval.bodyPreview.includes("review"), "external contact draft preview should be stored");

  const researchApproval = await request("/api/approvals", {
    method: "POST",
    headers: agentHeaders,
    body: {
      type: "web_research",
      title: "Bounded research",
      details: "Research docs with budget",
      researchQuestion: "How should Latch add a browser sandbox?",
      allowedDomains: ["example.com", "docs.example.com"],
      seedUrls: ["https://example.com/docs"],
      maxPages: 5,
      tokenBudget: 3000,
      refreshResearch: true,
      riskLevel: "medium"
    }
  });
  assert(researchApproval.type === "web_research", "web research approval type should be accepted");
  assert(researchApproval.allowedDomains.length === 2, "research allowed domains should be stored");
  assert(researchApproval.seedUrls[0] === "https://example.com/docs", "research seed urls should be stored");
  assert(researchApproval.maxPages === 5, "research page budget should be stored");
  assert(researchApproval.tokenBudget === 3000, "research token budget should be stored");
  assert(researchApproval.refreshResearch === true, "research refresh flag should be stored");

  const note = await request("/api/context/notes", {
    method: "POST",
    headers: operatorHeaders,
    body: {
      title: "Agent goals",
      text: "Be useful, bounded, and explicit about uncertainty.",
      category: "goals",
      tags: ["agency"],
      shareWithAgent: true
    }
  });
  assert(note.kind === "note", "context note should be stored");
  assert(note.text.includes("bounded"), "operator state should keep full note text");

  const fileContent = Buffer.from("small context file", "utf8").toString("base64");
  const fileItem = await request("/api/context/files", {
    method: "POST",
    headers: operatorHeaders,
    body: {
      name: "context.txt",
      type: "text/plain",
      shareWithAgent: true,
      contentBase64: fileContent
    }
  });
  assert(fileItem.kind === "file", "context file should be stored");
  assert(fileItem.size === 18, "context file should report stored size");

  const contextQuestion = await request("/api/approvals", {
    method: "POST",
    headers: agentHeaders,
    body: {
      type: "context_question",
      title: "Context question",
      details: "- What should the worker optimize for?",
      contextCategory: "personality",
      contextTags: ["question"]
    }
  });
  await request(`/api/approvals/${contextQuestion.id}`, {
    method: "PATCH",
    headers: operatorHeaders,
    body: { status: "approved", note: "Optimize for careful, transparent progress." }
  });

  const poll = await request("/api/agent/poll", { headers: agentHeaders });
  assert(poll.tasks.some((item) => item.id === task.id), "agent poll should include queued task");
  assert(poll.channels.some((item) => item.id === "operations"), "agent poll should include active channels");
  assert(poll.approvals.some((item) => item.id === approval.id), "agent poll should include approval");
  assert(poll.contextItems.some((item) => item.id === note.id), "agent poll should include context metadata");
  assert(poll.contextItems.find((item) => item.id === note.id).text.includes("bounded"), "shared notes should be included in agent context");
  assert(poll.contextItems.find((item) => item.id === fileItem.id).contentText.includes("small context"), "shared text file content should be included in agent context");
  assert(poll.contextItems.some((item) => item.id === fileItem.id), "agent poll should keep shared file metadata");

  await expectStatus("/api/agent/executions", {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({ template: "bridge.status" })
  }, 403);

  const execution = await request("/api/agent/executions", {
    method: "POST",
    headers: agentHeaders,
    body: {
      approvalId: approval.id,
      taskId: task.id,
      template: "bridge.status",
      commands: ["systemctl is-active latch-agent-bridge"],
      exitCode: 0,
      stdout: "active",
      stderr: "",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString()
    }
  });
  assert(execution.template === "bridge.status", "execution report should store template");
  assert(execution.stdout === "active", "execution report should store trimmed stdout");

  await expectStatus("/api/agent/research-results", {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({ question: "operator should not report research" })
  }, 403);

  const researchRun = await request("/api/agent/research-results", {
    method: "POST",
    headers: agentHeaders,
    body: {
      approvalId: researchApproval.id,
      taskId: task.id,
      question: "How should Latch add a browser sandbox?",
      allowedDomains: ["example.com"],
      seedUrls: ["https://example.com/docs"],
      pagesFetched: 1,
      tokenBudget: 3000,
      status: "completed",
      summary: "Use a bounded read-only browser sandbox.",
      sources: [{
        requestedUrl: "https://example.com/docs",
        finalUrl: "https://example.com/docs",
        url: "https://example.com/docs",
        title: "Docs",
        status: 200,
        summary: "A compact source note",
        excerpt: "Short excerpt",
        fetchedAt: new Date().toISOString(),
        cached: true
      }],
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString()
    }
  });
  assert(researchRun.status === "completed", "research result status should be stored");
  assert(researchRun.sources[0].summary.includes("compact"), "research source summary should be stored");
  assert(researchRun.sources[0].cached === true, "research source cache marker should be stored");

  const visible = await request("/api/state", { headers: operatorHeaders });
  assert(visible.contextItems.some((item) => item.id === fileItem.id), "operator state should include context items");
  assert(visible.contextItems.some((item) => item.originApprovalId === contextQuestion.id), "approved context questions should save operator answers");
  assert(visible.executions.some((item) => item.id === execution.id), "operator state should include execution audits");
  assert(visible.researchRuns.some((item) => item.id === researchRun.id), "operator state should include research run summaries");

  const about = await request("/api/about", { headers: operatorHeaders });
  assert(about.version, "about endpoint should expose version");
  assert(about.counts.contextItems >= 3, "about endpoint should expose context counts");

  const backup = await request("/api/backups", {
    method: "POST",
    headers: operatorHeaders,
    body: {}
  });
  assert(backup.ok && backup.fileName.endsWith(".json"), "backup endpoint should create a JSON backup");

  const exportResponse = await fetch(`${baseUrl}/api/context/export`, { headers: operatorHeaders });
  assert(exportResponse.ok, "context export should succeed");
  const exported = await exportResponse.json();
  assert(exported.contextItems.some((item) => item.id === note.id), "context export should include notes");

  const archivedMessage = await request(`/api/messages/${message.id}`, {
    method: "PATCH",
    headers: operatorHeaders,
    body: { archived: true }
  });
  assert(archivedMessage.archivedAt, "message archive should set archivedAt");
  const afterArchive = await request("/api/state", { headers: operatorHeaders });
  assert(!afterArchive.messages.some((item) => item.id === message.id), "archived messages should leave active state");
  assert(afterArchive.archives.messages.some((item) => item.id === message.id), "archived messages should appear in archives");
  await request(`/api/messages/${message.id}`, {
    method: "DELETE",
    headers: operatorHeaders
  });
  const afterDelete = await request("/api/state", { headers: operatorHeaders });
  assert(!afterDelete.archives.messages.some((item) => item.id === message.id), "deleted archived message should be removed");

  const report = await request("/api/agent/report", {
    method: "POST",
    headers: agentHeaders,
    body: { text: "report ok", taskId: task.id, channel: "operations" }
  });
  assert(report.direction === "agent_to_operator", "agent report should be stored");
  assert(report.channel === "operations", "agent report should keep channel");

  const patched = await request(`/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: agentHeaders,
    body: { status: "done", note: "completed" }
  });
  assert(patched.status === "done", "agent should patch task status");

  console.log("Latch smoke tests passed.");
} finally {
  child.kill();
  await onceExit(child);
  await rm(dataDir, { recursive: true, force: true });
}

async function waitForHealth() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const health = await request("/api/health");
      if (health.ok) return;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`server did not become healthy\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${pathname} failed: ${response.status} ${text}`);
  }
  return json;
}

async function expectStatus(pathname, options, status) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  assert(response.status === status, `${pathname} should return ${status}, got ${response.status}`);
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onceExit(process) {
  if (process.exitCode !== null || process.signalCode) return Promise.resolve();
  return new Promise((resolve) => process.once("exit", resolve));
}
