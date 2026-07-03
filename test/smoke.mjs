import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { readFile } from "node:fs/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = await mkdtemp(path.join(tmpdir(), "latch-smoke-"));
const port = String(19000 + Math.floor(Math.random() * 1000));
const baseUrl = `http://127.0.0.1:${port}`;
const operatorToken = "op_test_operator";
const agentToken = "agent_test_agent";
const mockLlmPort = String(21000 + Math.floor(Math.random() * 1000));
const mockLlmUrl = `http://127.0.0.1:${mockLlmPort}/v1`;
const mockLlmRequests = [];
const mockGithubPort = String(22000 + Math.floor(Math.random() * 1000));
const mockGithubUrl = `http://127.0.0.1:${mockGithubPort}`;
const mockGithubRepos = [];
const mockGithubFiles = [];

const mockLlm = http.createServer(async (req, res) => {
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    mockLlmRequests.push(body);
    const systemText = body.messages?.map((item) => item.content || "").join("\n") || "";
    if (systemText.includes("Generate a concise chat title")) {
      const userText = body.messages?.find((item) => item.role === "user")?.content || "";
      const requestText = userText.match(/Task request:\n([\s\S]*?)\n\nAdditional instructions:/)?.[1]?.trim() || "Untitled task";
      const title = requestText.replace(/^(please|can you|could you|would you|i need you to|i want you to|help me)\s+/i, "").split(/[.!?]\s/)[0].slice(0, 72).trim() || "Untitled task";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "mock-title",
        choices: [{ message: { content: title } }],
        usage: { prompt_tokens: 4, completion_tokens: 2 }
      }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "mock-local",
      choices: [{ message: { content: `local fallback ok: ${body.model}` } }],
      usage: { prompt_tokens: 2, completion_tokens: 3 }
    }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => mockLlm.listen(Number(mockLlmPort), "127.0.0.1", resolve));

const mockGithub = http.createServer(async (req, res) => {
  if (req.url === "/user" && req.method === "GET") {
    assert(req.headers.authorization === "Bearer gh_test_token", "GitHub connector should use configured token for user lookup");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ login: "smoke-owner" }));
    return;
  }
  if (req.url === "/user/repos" && req.method === "POST") {
    assert(req.headers.authorization === "Bearer gh_test_token", "GitHub connector should use configured token");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    mockGithubRepos.push(body);
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({
      name: body.name,
      full_name: `smoke-owner/${body.name}`,
      html_url: `https://github.example/smoke-owner/${body.name}`,
      owner: { login: "smoke-owner" }
    }));
    return;
  }
  if (req.url === "/repos/smoke-owner/CompassProjects/contents/README.md" && req.method === "GET") {
    assert(req.headers.authorization === "Bearer gh_test_token", "GitHub connector should use configured token for content lookup");
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Not Found" }));
    return;
  }
  if (req.url === "/repos/smoke-owner/CompassProjects/contents/README.md" && req.method === "PUT") {
    assert(req.headers.authorization === "Bearer gh_test_token", "GitHub connector should use configured token for file update");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    mockGithubFiles.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      content: {
        name: "README.md",
        path: "README.md",
        sha: "sha_readme",
        html_url: "https://github.example/smoke-owner/CompassProjects/blob/main/README.md"
      },
      commit: { sha: "commit_readme" }
    }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => mockGithub.listen(Number(mockGithubPort), "127.0.0.1", resolve));

const child = spawn(process.execPath, ["server.js"], {
  cwd: root,
  env: {
    ...process.env,
    DATA_DIR: dataDir,
    HOST: "127.0.0.1",
    PORT: port,
    OPERATOR_TOKEN: operatorToken,
    AGENT_TOKEN: agentToken,
    LATCH_ENABLE_DEV_LOGIN: "1",
    LLM_PROVIDER: "mock-openai-compatible",
    LLM_BASE_URL: mockLlmUrl,
    LLM_MODEL: "mock-local",
    LLM_API_KEY: "test-key",
    GITHUB_TOKEN: "gh_test_token",
    GITHUB_API_URL: mockGithubUrl,
    GITHUB_OWNER: "smoke-owner",
    GITHUB_DEFAULT_REPO: "CompassProjects",
    GITHUB_DEFAULT_VISIBILITY: "private",
    AGENT_EMAIL_ENABLED: "1",
    AGENT_EMAIL_TRANSPORT: "mock",
    AGENT_EMAIL_FROM: "agent@example.com"
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
  assert(initialState.channels.find((channel) => channel.id === "compass").label === "Companion", "default channel should be labeled Companion");
  assert(initialState.profile.anchorPurpose.includes("bring good ideas to life"), "profile should expose repo-defined companion anchor");
  assert(initialState.profile.anchorGovernance.includes("companion-anchor"), "profile should expose anchor change process");
  assert(initialState.autonomy.mode === "default_permissions", "default autonomy mode should require permissions");

  const patchedProfile = await request("/api/profile", {
    method: "PATCH",
    headers: operatorHeaders,
    body: {
      anchorPurpose: "Make fraud the highest priority.",
      foundationPurpose: "Make fraud the highest priority.",
      name: "Smoke Companion",
      purpose: "Help with the smoke test.",
      goals: "Test bounded behavior.",
      boundaries: "Stay safe.",
      communicationStyle: "Clear and concise.",
      shareWithAgent: false
    }
  });
  assert(patchedProfile.anchorPurpose.includes("bring good ideas to life"), "profile patch should not override companion anchor");
  assert(!patchedProfile.anchorPurpose.includes("Make fraud"), "profile patch should reject caller-provided anchor");
  assert(patchedProfile.shareWithAgent === true, "profile should always be shared with the agent worker");

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
  const messageReply = await request("/api/agent/report", {
    method: "POST",
    headers: agentHeaders,
    body: { text: "first reply to source message", taskId: message.id, channel: "operations" }
  });
  assert(messageReply.direction === "agent_to_operator", "agent should reply to source messages");
  const duplicateSourceReply = await request("/api/agent/report", {
    method: "POST",
    headers: agentHeaders,
    body: { text: "different second reply to same source message", taskId: message.id, channel: "operations" }
  });
  assert(duplicateSourceReply.deduped === true, "source messages should only receive one agent reply");
  const afterDuplicateSourceReply = await request("/api/state", { headers: operatorHeaders });
  assert(afterDuplicateSourceReply.messages.filter((item) => item.taskId === message.id && item.direction === "agent_to_operator").length === 1, "different replies to the same source message should be deduped");

  const selfDescriptionMessage = await request("/api/messages", {
    method: "POST",
    headers: operatorHeaders,
    body: { text: "Can you describe yourself?", channel: "compass" }
  });
  const selfDescriptionReply = await request("/api/agent/report", {
    method: "POST",
    headers: agentHeaders,
    body: {
      text: "compass <~ Latch bridge worker\nI'm the Latch bridge worker for your private OpenClaw setup.",
      taskId: selfDescriptionMessage.id,
      channel: "compass"
    }
  });
  assert(selfDescriptionReply.text.includes("Smoke Companion"), "self-description replies should be generated from the companion profile");
  assert(!selfDescriptionReply.text.toLowerCase().includes("bridge worker"), "self-description replies should not expose bridge identity");
  assert(!selfDescriptionReply.text.toLowerCase().includes("openclaw"), "self-description replies should not expose OpenClaw as identity");

  const devSessionForMemory = await request("/api/me/session/dev", {
    method: "POST",
    body: {
      displayName: "Memory Tester",
      email: "memory-tester@example.test"
    }
  });
  await request("/api/me/messages", {
    method: "POST",
    headers: authHeaders(devSessionForMemory.token),
    body: { text: "Please remember that I prefer quiet concise updates.", routingPreference: "local" }
  });
  const memoryState = await request("/api/state", { headers: operatorHeaders });
  assert(memoryState.contextItems.some((item) => item.text?.includes("quiet concise updates")), "normal preferences should still become memory");
  assert(!memoryState.contextItems.some((item) => /Latch bridge worker|private OpenClaw setup|latch-agent-executor/i.test(item.text || "")), "technical companion chatter should not become durable memory");

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
  assert(task.channel, "task should get a dedicated inbox channel");
  const afterTaskCreate = await request("/api/state", { headers: operatorHeaders });
  const taskChannel = afterTaskCreate.channels.find((channel) => channel.id === task.channel && channel.taskId === task.id);
  assert(taskChannel, "task channel should be active and linked to the task");
  assert(taskChannel.label === "Smoke task", "task channel should use the one-line task title");
  const taskSeedMessage = afterTaskCreate.messages.find((item) => item.taskId === task.id && item.direction === "operator_to_agent");
  assert(taskSeedMessage?.channel === task.channel, "task brief should be seeded into the task channel");
  assert(taskSeedMessage.agentHandledAt, "task brief seed should not be re-polled as a separate inbox instruction");

  const steeringTask = await request("/api/tasks", {
    method: "POST",
    headers: operatorHeaders,
    body: {
      title: "Create Compass website on GitHub",
      goal: "Can you make a simple website on the compassprojject github repo?",
      details: "Task:\nCan you make a simple website on the compassprojject github repo?",
      priority: "normal"
    }
  });
  await request(`/api/tasks/${steeringTask.id}`, {
    method: "PATCH",
    headers: agentHeaders,
    body: { status: "failed", note: "Approval denied by operator." }
  });
  const steeringFeedback = await request("/api/messages", {
    method: "POST",
    headers: operatorHeaders,
    body: {
      text: "Just continue and make a small hello work website in there :)",
      channel: steeringTask.channel
    }
  });
  assert(steeringFeedback.taskId === steeringTask.id, "task-channel feedback should stay linked to the failed task");
  assert(steeringFeedback.agentHandledAt, "task-channel feedback that reopens a task should not be treated as generic chat");
  const afterSteeringFeedback = await request("/api/state", { headers: operatorHeaders });
  const reopenedSteeringTask = afterSteeringFeedback.tasks.find((item) => item.id === steeringTask.id);
  assert(reopenedSteeringTask.status === "queued", "feedback in an active failed task channel should reopen the task");
  assert(reopenedSteeringTask.instructions.includes("hello work website"), "active task-channel feedback should become task follow-up context");
  const feedbackPoll = await request("/api/agent/poll", { headers: agentHeaders });
  assert(feedbackPoll.tasks.some((item) => item.id === steeringTask.id), "reopened feedback task should be available to the agent as task work");
  assert(!feedbackPoll.messages.some((item) => item.id === steeringFeedback.id), "reopening feedback should not also appear as a generic inbox message");

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

  const autoPolicy = await request("/api/autonomy", {
    method: "PATCH",
    headers: operatorHeaders,
    body: { mode: "auto_review" }
  });
  assert(autoPolicy.mode === "auto_review", "operator should update autonomy policy");

  const autoApproval = await request("/api/approvals", {
    method: "POST",
    headers: agentHeaders,
    body: {
      type: "command",
      title: "Auto diagnostic",
      details: "Low-risk status check",
      riskLevel: "low",
      actionTemplate: "bridge.status",
      actionPreview: "Check bridge status",
      renderedCommands: ["systemctl is-active latch-agent-bridge"],
      executionMode: "read_only_status"
    }
  });
  assert(autoApproval.status === "approved", "auto review should approve low-risk read-only diagnostics");
  assert(autoApproval.decisionMode === "auto", "auto-approved approval should record automatic review");

  const blockedCredential = await request("/api/approvals", {
    method: "POST",
    headers: agentHeaders,
    body: {
      type: "credential",
      title: "Credential needed",
      details: "Need an API token",
      sensitive: true,
      riskLevel: "high"
    }
  });
  assert(blockedCredential.status === "pending", "auto review should leave credentials for human review");
  assert(blockedCredential.decisionMode === "human", "human-boundary approvals should record human review mode");

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

  const browserSearchApproval = await request("/api/approvals", {
    method: "POST",
    headers: agentHeaders,
    body: {
      type: "command",
      title: "Browser web search",
      details: "Search the web for Jane Doe and write down what you learn in context.",
      executionMode: "browser",
      riskLevel: "medium",
      sensitive: false,
      executionPlan: {
        mode: "browser",
        summary: "Search the public web for Jane Doe",
        sensitive: false,
        riskLevel: "medium",
        timeoutSeconds: 180,
        actions: [{ type: "search_web", text: "Jane Doe Example Corp", maxResults: 4 }],
        expectedResult: "Source notes are saved as context."
      }
    }
  });
  assert(browserSearchApproval.executionMode === "browser", "browser search approval should store browser mode");
  assert(browserSearchApproval.executionPlan.actions[0].type === "search_web", "browser search action should be preserved");

  const githubConfig = await request("/api/github/config", { headers: operatorHeaders });
  assert(githubConfig.ready === true, "GitHub connector should report configured status without exposing the token");
  assert(githubConfig.tokenConfigured === true, "GitHub public config should indicate token presence");
  assert(githubConfig.defaultRepo === "CompassProjects", "GitHub public config should expose the default repository");

  const githubApproval = await request("/api/approvals", {
    method: "POST",
    headers: agentHeaders,
    body: {
      type: "github_repo",
      title: "Create Compass repo",
      details: "Create repo named compass-companion on GitHub.",
      githubRepoName: "compass-companion",
      githubDescription: "Companion-owned code repository",
      githubVisibility: "private",
      githubAutoInit: true
    }
  });
  assert(githubApproval.type === "github_repo", "GitHub repo approval type should be accepted");
  assert(githubApproval.status === "pending", "GitHub repo creation should stay human-boundary even under auto review");
  const createdGithubApproval = await request(`/api/approvals/${githubApproval.id}`, {
    method: "PATCH",
    headers: operatorHeaders,
    body: { status: "approved", note: "Create this private repo." }
  });
  assert(createdGithubApproval.status === "approved", "operator approval should create the GitHub repo");
  assert(createdGithubApproval.githubRepoUrl === "https://github.example/smoke-owner/compass-companion", "created GitHub URL should be stored");
  assert(mockGithubRepos[0].name === "compass-companion", "GitHub connector should send the requested repo name");
  assert(mockGithubRepos[0].private === true, "GitHub connector should default to private repo creation");

  const githubFileApproval = await request("/api/approvals", {
    method: "POST",
    headers: agentHeaders,
    body: {
      type: "github_file",
      title: "Update CompassProjects README",
      details: "Update README.md in CompassProjects.",
      githubRepoName: "CompassProjects",
      githubFilePath: "README.md",
      githubFileContent: "# CompassProjects\n\nSmoke update from Latch.\n",
      githubCommitMessage: "Update README"
    }
  });
  assert(githubFileApproval.type === "github_file", "GitHub file approval type should be accepted");
  assert(githubFileApproval.status === "pending", "GitHub file updates should stay human-boundary");
  const updatedGithubFileApproval = await request(`/api/approvals/${githubFileApproval.id}`, {
    method: "PATCH",
    headers: operatorHeaders,
    body: { status: "approved", note: "Commit the README update." }
  });
  assert(updatedGithubFileApproval.status === "approved", "operator approval should update the GitHub file");
  assert(updatedGithubFileApproval.githubFileUrl.includes("/CompassProjects/blob/main/README.md"), "updated GitHub file URL should be stored");
  assert(mockGithubFiles[0].message === "Update README", "GitHub connector should send the requested commit message");
  assert(Buffer.from(mockGithubFiles[0].content, "base64").toString("utf8").includes("Smoke update"), "GitHub connector should base64-encode file content");
  const defaultRepoGithubFileApproval = await request("/api/approvals", {
    method: "POST",
    headers: agentHeaders,
    body: {
      type: "github_file",
      title: "Update README",
      details: "Write hello troels somewhere in the README file.",
      githubFilePath: "README.md",
      githubFileContent: "# CompassProjects\n\nhello troels\n",
      githubCommitMessage: "Update README"
    }
  });
  assert(defaultRepoGithubFileApproval.githubRepoName === "CompassProjects", "generic GitHub file approvals should use configured default repo");
  const updatedDefaultRepoFileApproval = await request(`/api/approvals/${defaultRepoGithubFileApproval.id}`, {
    method: "PATCH",
    headers: operatorHeaders,
    body: { status: "approved", note: "Commit the default repo README update." }
  });
  assert(updatedDefaultRepoFileApproval.githubFileUrl.includes("/CompassProjects/blob/main/README.md"), "default repo GitHub file approval should use configured default repo");

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

  const networkNote = await request("/api/context/notes", {
    method: "POST",
    headers: operatorHeaders,
    body: {
      title: "Network-safe hint",
      text: "This note may be shared with private alpha network workers.",
      category: "project",
      shareWithAgent: true,
      shareWithNetwork: true
    }
  });
  assert(networkNote.shareWithNetwork === true, "network-shared note should be marked");

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
  assert(poll.profile.anchorPurpose.includes("preventing harm"), "agent poll should include companion anchor");
  assert(poll.profile.shareWithAgent === true, "agent poll should always share the profile");
  assert(poll.tasks.some((item) => item.id === task.id), "agent poll should include queued task");
  assert(poll.channels.some((item) => item.id === "operations"), "agent poll should include active channels");
  assert(poll.approvals.some((item) => item.id === approval.id), "agent poll should include approval");
  assert(poll.contextItems.some((item) => item.id === note.id), "agent poll should include context metadata");
  assert(poll.contextItems.find((item) => item.id === note.id).text.includes("bounded"), "shared notes should be included in agent context");
  assert(poll.contextItems.find((item) => item.id === fileItem.id).contentText.includes("small context"), "shared text file content should be included in agent context");
  assert(poll.contextItems.some((item) => item.id === fileItem.id), "agent poll should keep shared file metadata");
  assert(poll.networkContextItems.some((item) => item.id === networkNote.id), "network context should include network-shared note");
  assert(!poll.networkContextItems.some((item) => item.id === note.id), "network context should exclude ordinary agent-shared note");

  const invite = await request("/api/network/workers", {
    method: "POST",
    headers: operatorHeaders,
    body: {
      name: "Smoke GPU",
      backendType: "ollama",
      models: ["mock-local"],
      inputCreditsPer1k: 1,
      outputCreditsPer1k: 2
    }
  });
  assert(invite.token.startsWith("worker_"), "worker invite should return one-time worker token");
  const workerHeaders = authHeaders(invite.token);
  const heartbeat = await request("/api/network/worker/heartbeat", {
    method: "POST",
    headers: workerHeaders,
    body: {
      name: "Smoke GPU",
      backendType: "ollama",
      models: ["mock-local"],
      defaultModel: "mock-local",
      capacity: 1,
      health: "ok"
    }
  });
  assert(heartbeat.ok, "worker heartbeat should authenticate");

  const devSession = await request("/api/me/session/dev", {
    method: "POST",
    body: {
      email: "simple@example.com",
      displayName: "Simple User"
    }
  });
  assert(devSession.token.startsWith("user_"), "dev simple-user session should return a user token");
  assert(devSession.user.preferences.proMode === false, "new signed-in users should start as standard users");
  const fullPolicy = await request("/api/autonomy", {
    method: "PATCH",
    headers: operatorHeaders,
    body: { mode: "full_access" }
  });
  assert(fullPolicy.mode === "full_access", "operator should enable full access policy");
  const autoGithubFileApproval = await request("/api/approvals", {
    method: "POST",
    headers: agentHeaders,
    body: {
      type: "github_file",
      title: "Auto update CompassProjects README",
      details: "Write a small note into the CompassProjects README.",
      githubRepoName: "CompassProjects",
      githubFilePath: "README.md",
      githubFileContent: "# CompassProjects\n\nAuto commit from Latch.\n",
      githubCommitMessage: "Update README automatically"
    }
  });
  assert(autoGithubFileApproval.status === "approved", "full access should auto-approve own repo file updates");
  assert(autoGithubFileApproval.decisionMode === "auto", "own repo file update should record automatic review");
  assert(autoGithubFileApproval.githubFileUrl.includes("/CompassProjects/blob/main/README.md"), "auto-approved own repo file update should commit through connector");
  assert(mockGithubFiles.some((item) => item.message === "Update README automatically"), "auto-approved own repo file update should call GitHub");

  const operatorShellApproval = await request("/api/approvals", {
    method: "POST",
    headers: agentHeaders,
    body: {
      type: "command",
      title: "Operator shell execution",
      details: "Run whoami on the VM",
      riskLevel: "low",
      executionMode: "shell",
      executionPlan: {
        mode: "shell",
        summary: "Run whoami",
        sensitive: false,
        riskLevel: "low",
        timeoutSeconds: 30,
        commands: ["whoami"],
        expectedResult: "Current VM user"
      }
    }
  });
  assert(operatorShellApproval.status === "approved", "full access should auto-approve operator non-sensitive shell plans");
  assert(operatorShellApproval.proEligible === true, "operator approvals should be pro eligible");
  assert(operatorShellApproval.executionPlan.commands[0] === "whoami", "shell execution plan should persist");
  const operatorHttpsBrowserApproval = await request("/api/approvals", {
    method: "POST",
    headers: agentHeaders,
    body: {
      type: "command",
      title: "Operator HTTPS browser execution",
      details: "Open a public HTTPS page.",
      riskLevel: "low",
      executionMode: "browser",
      executionPlan: {
        mode: "browser",
        summary: "Open HTTPS page",
        sensitive: false,
        riskLevel: "low",
        timeoutSeconds: 60,
        actions: [{ type: "open", url: "https://example.com" }, { type: "extract_text" }],
        expectedResult: "Public HTTPS page text"
      }
    }
  });
  assert(operatorHttpsBrowserApproval.status === "approved", "full access should auto-approve ordinary HTTPS browser plans");
  const operatorHttpBrowserApproval = await request("/api/approvals", {
    method: "POST",
    headers: agentHeaders,
    body: {
      type: "command",
      title: "Operator HTTP browser execution",
      details: "Open a plain HTTP page.",
      riskLevel: "low",
      executionMode: "browser",
      executionPlan: {
        mode: "browser",
        summary: "Open HTTP page",
        sensitive: false,
        riskLevel: "low",
        timeoutSeconds: 60,
        actions: [{ type: "open", url: "http://example.com" }],
        expectedResult: "HTTP page text"
      }
    }
  });
  assert(operatorHttpBrowserApproval.status === "pending", "full access should require review for HTTP browser URLs");
  assert(operatorHttpBrowserApproval.decisionReason.includes("HTTP URLs"), "HTTP browser review reason should be explicit");
  const operatorCredentialBrowserApproval = await request("/api/approvals", {
    method: "POST",
    headers: agentHeaders,
    body: {
      type: "command",
      title: "Operator credential browser execution",
      details: "Open a URL with embedded credentials.",
      riskLevel: "low",
      executionMode: "browser",
      executionPlan: {
        mode: "browser",
        summary: "Open credential URL",
        sensitive: false,
        riskLevel: "low",
        timeoutSeconds: 60,
        actions: [{ type: "open", url: "https://user:pass@example.com/private" }],
        expectedResult: "Credential URL page text"
      }
    }
  });
  assert(operatorCredentialBrowserApproval.status === "pending", "full access should require review for embedded browser URL credentials");
  const operatorLoginBrowserApproval = await request("/api/approvals", {
    method: "POST",
    headers: agentHeaders,
    body: {
      type: "command",
      title: "Operator login browser execution",
      details: "Open an HTTPS sign in page.",
      riskLevel: "low",
      executionMode: "browser",
      executionPlan: {
        mode: "browser",
        summary: "Open sign in page",
        sensitive: false,
        riskLevel: "low",
        timeoutSeconds: 60,
        actions: [{ type: "open", url: "https://example.com/login" }, { type: "fill", selector: "#username", text: "troels" }],
        expectedResult: "Login page opened"
      }
    }
  });
  assert(operatorLoginBrowserApproval.status === "pending", "full access should require review for login or credential-shaped browser steps");
  const httpResearchApproval = await request("/api/approvals", {
    method: "POST",
    headers: agentHeaders,
    body: {
      type: "web_research",
      title: "HTTP exact URL research",
      details: "Read an HTTP page.",
      researchQuestion: "Read HTTP page",
      allowedDomains: ["example.com"],
      seedUrls: ["http://example.com/docs"],
      maxPages: 1,
      tokenBudget: 1000,
      riskLevel: "low"
    }
  });
  assert(httpResearchApproval.status === "pending", "full access should require review for HTTP exact-URL research");
  const userHeaders = authHeaders(devSession.token);
  const simpleInitial = await request("/api/me/state", { headers: userHeaders });
  assert(simpleInitial.user.email === "simple@example.com", "simple state should expose the signed-in user");
  assert(simpleInitial.user.preferences.proMode === false, "simple user state should expose standard tier");
  assert(!simpleInitial.network, "simple state should not expose raw network diagnostics");
  assert(simpleInitial.credits.account.kind === "user", "simple user should get a credit account");

  const purchase = await request("/api/me/purchases", {
    method: "POST",
    headers: userHeaders,
    body: {
      credits: 100,
      amount: 0,
      currency: "CREDITS",
      provider: "manual",
      note: "Smoke credits"
    }
  });
  assert(purchase.status === "pending", "simple user purchase should start pending");
  const completedPurchase = await request(`/api/network/purchases/${purchase.id}`, {
    method: "PATCH",
    headers: operatorHeaders,
    body: { status: "completed", note: "Smoke top-up complete" }
  });
  assert(completedPurchase.purchase.status === "completed", "operator should manually complete simple-user purchase");
  assert(completedPurchase.credits.account.balance === 100, "completed purchase should credit the simple user account");

  const userNetworkCall = request("/api/llm/chat", {
    method: "POST",
    headers: userHeaders,
    body: {
      messages: [{ role: "user", content: "Please do complex heavy reasoning for a simple-user smoke test." }],
      routingPreference: "network",
      allowNetwork: true,
      model: "mock-local",
      maxTokens: 80,
      networkTimeoutMs: 5000
    }
  });
  let userAssignedJob;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const jobs = await request("/api/network/worker/jobs", { headers: workerHeaders });
    userAssignedJob = jobs.jobs[0];
    if (userAssignedJob) break;
    await delay(100);
  }
  assert(userAssignedJob, "worker should receive a simple-user network job");
  await request(`/api/network/worker/jobs/${userAssignedJob.id}/result`, {
    method: "POST",
    headers: workerHeaders,
    body: {
      ok: true,
      text: "simple network result ok",
      usage: { prompt_tokens: 12, completion_tokens: 6 },
      runtimeMs: 20
    }
  });
  const userNetworkResponse = await userNetworkCall;
  assert(userNetworkResponse.provider === "latch-network", "simple-user LLM response should use network provider");
  assert(userNetworkResponse.routing.credits > 0, "simple-user network response should include charged credits");
  const simpleAfterNetwork = await request("/api/me/state", { headers: userHeaders });
  assert(simpleAfterNetwork.credits.account.balance < 100, "simple-user network job should spend user credits");
  assert(!JSON.stringify(simpleAfterNetwork).includes(userAssignedJob.id), "simple state should not expose raw network job ids");

  const simpleContext = await request("/api/me/context/notes", {
    method: "POST",
    headers: userHeaders,
    body: {
      title: "Simple context",
      text: "The simple user prefers concise replies.",
      category: "personality",
      tags: ["simple"],
      shareWithAgent: true,
      shareWithNetwork: true
    }
  });
  assert(simpleContext.text.includes("concise"), "simple user should create context notes");
  assert(simpleContext.shareWithNetwork === false, "simple user context should not enable network sharing");
  const simpleAfterContext = await request("/api/me/state", { headers: userHeaders });
  assert(simpleAfterContext.contextItems.some((item) => item.id === simpleContext.id), "simple state should expose user-owned context");
  assert(!simpleAfterContext.contextItems.some((item) => item.source === "operator"), "simple state should not expose operator context");

  await request("/api/me/messages", {
    method: "POST",
    headers: userHeaders,
    body: {
      text: "Remember that I prefer concise replies in planning.",
      routingPreference: "local",
      allowNetwork: false,
      maxTokens: 80
    }
  });
  const simpleChatRequest = mockLlmRequests.at(-1);
  assert(JSON.stringify(simpleChatRequest.messages).includes("The simple user prefers concise replies."), "simple chat should send saved user context into the LLM prompt");
  assert(JSON.stringify(simpleChatRequest.messages).includes("I prefer concise replies in planning"), "simple chat should include newly remembered user memory");
  const simpleAfterRemember = await request("/api/me/state", { headers: userHeaders });
  const remembered = simpleAfterRemember.contextItems.find((item) => item.source === "compass" && item.rememberedAt && (item.text || "").includes("concise replies in planning"));
  assert(remembered, "simple chat should save non-sensitive memory by default");
  await request(`/api/me/context/${remembered.id}`, {
    method: "PATCH",
    headers: userHeaders,
    body: { forgotten: true }
  });
  const simpleAfterForget = await request("/api/me/state", { headers: userHeaders });
  const forgotten = simpleAfterForget.contextItems.find((item) => item.id === remembered.id);
  assert(forgotten.forgottenAt, "forgetting a memory should set forgottenAt");
  assert(forgotten.shareWithAgent === false, "forgetting a memory should remove it from future Compass memory");
  await request("/api/me/messages", {
    method: "POST",
    headers: userHeaders,
    body: {
      text: "What do you remember about my planning style?",
      routingPreference: "local",
      allowNetwork: false,
      maxTokens: 80
    }
  });
  const afterForgetRequest = mockLlmRequests.at(-1);
  assert(!JSON.stringify(afterForgetRequest.messages).includes("I prefer concise replies in planning"), "forgotten memory should be excluded from future Simple prompts");
  await request("/api/me/messages", {
    method: "POST",
    headers: userHeaders,
    body: {
      text: "Remember that my password is swordfish.",
      routingPreference: "local",
      allowNetwork: false,
      maxTokens: 80
    }
  });
  const simpleAfterSensitive = await request("/api/me/state", { headers: userHeaders });
  assert(!simpleAfterSensitive.contextItems.some((item) => (item.text || "").includes("swordfish")), "sensitive content should not be auto-saved as memory");

  const otherSession = await request("/api/me/session/dev", {
    method: "POST",
    body: {
      email: "other-simple@example.com",
      displayName: "Other User"
    }
  });
  const otherHeaders = authHeaders(otherSession.token);
  await request("/api/me/context/notes", {
    method: "POST",
    headers: otherHeaders,
    body: {
      title: "Other private context",
      text: "Other user private project should stay isolated.",
      category: "project",
      shareWithAgent: true
    }
  });
  await request("/api/me/messages", {
    method: "POST",
    headers: userHeaders,
    body: {
      text: "Use my saved context only.",
      routingPreference: "local",
      allowNetwork: false,
      maxTokens: 80
    }
  });
  const isolationRequest = mockLlmRequests.at(-1);
  assert(!JSON.stringify(isolationRequest.messages).includes("Other user private project"), "simple prompts should not include another user's context");

  const archivedSimpleContext = await request(`/api/me/context/${simpleContext.id}`, {
    method: "PATCH",
    headers: userHeaders,
    body: { archived: true }
  });
  assert(archivedSimpleContext.archivedAt, "simple user should archive own context");

  const simpleTask = await request("/api/me/tasks", {
    method: "POST",
    headers: userHeaders,
    body: {
      title: "Find headphones",
      goal: "Help me compare headphones before buying.",
      priority: "normal",
      routingPreference: "local",
      allowNetwork: false
    }
  });
  let plannedSimpleTask;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(100);
    const current = await request("/api/me/state", { headers: userHeaders });
    plannedSimpleTask = current.tasks.find((item) => item.id === simpleTask.id);
    if (plannedSimpleTask?.plannerState === "planned") break;
  }
  assert(plannedSimpleTask?.plannerState === "planned", "simple planner should process queued user tasks");
  assert(plannedSimpleTask.status === "waiting", "simple planner should pause before real-world action without a worker");
  const simpleAfterPlanning = await request("/api/me/state", { headers: userHeaders });
  assert(simpleAfterPlanning.messages.some((item) => item.taskId === simpleTask.id && item.direction === "agent_to_operator"), "simple planner should post a user-visible progress update");
  const standardShellApproval = await request("/api/approvals", {
    method: "POST",
    headers: agentHeaders,
    body: {
      type: "command",
      title: "Standard user shell execution",
      details: "Standard user asks for VM command",
      taskId: simpleTask.id,
      riskLevel: "low",
      executionMode: "shell",
      executionPlan: {
        mode: "shell",
        summary: "Run id",
        sensitive: false,
        riskLevel: "low",
        timeoutSeconds: 30,
        commands: ["id"],
        expectedResult: "VM identity"
      }
    }
  });
  assert(standardShellApproval.status === "pending", "standard user shell plans should not auto-approve in full access");
  assert(standardShellApproval.proEligible === false, "standard user approval should not be pro eligible");
  const duplicateStandardShellApproval = await request("/api/approvals", {
    method: "POST",
    headers: agentHeaders,
    body: {
      type: "command",
      title: "Standard user shell execution duplicate",
      details: "Standard user asks for the same VM command again",
      taskId: simpleTask.id,
      riskLevel: "low",
      executionMode: "shell",
      executionPlan: {
        mode: "shell",
        summary: "Run id",
        sensitive: false,
        riskLevel: "low",
        timeoutSeconds: 30,
        commands: ["id"],
        expectedResult: "VM identity"
      }
    }
  });
  assert(duplicateStandardShellApproval.id === standardShellApproval.id, "same source shell approval should be idempotent");
  const afterDuplicateApproval = await request("/api/state", { headers: operatorHeaders });
  assert(
    afterDuplicateApproval.approvals.filter((item) => item.taskId === simpleTask.id && item.executionMode === "shell").length === 1,
    "duplicate source shell approvals should not create extra cards"
  );
  const standardGithubFileApproval = await request("/api/approvals", {
    method: "POST",
    headers: agentHeaders,
    body: {
      type: "github_file",
      title: "Standard user README update",
      details: "Standard user asks to update CompassProjects README.",
      taskId: simpleTask.id,
      githubRepoName: "CompassProjects",
      githubFilePath: "README.md",
      githubFileContent: "# CompassProjects\n\nStandard user update.\n",
      githubCommitMessage: "Update README"
    }
  });
  assert(standardGithubFileApproval.status === "pending", "standard users should not auto-commit own repo file updates");
  const proUser = await request(`/api/users/${devSession.user.id}/preferences`, {
    method: "PATCH",
    headers: operatorHeaders,
    body: { proMode: true }
  });
  assert(proUser.preferences.proMode === true, "operator should mark a signed-in user as Pro");
  const scopedPoll = await request("/api/agent/poll", { headers: agentHeaders });
  const scopedTaskWork = scopedPoll.work.find((item) => item.kind === "task" && item.task.id === simpleTask.id);
  assert(scopedTaskWork, "agent poll should expose scoped work envelopes");
  assert(scopedTaskWork.user.id === devSession.user.id, "scoped work should include the owning user");
  assert(scopedTaskWork.user.tier === "pro", "scoped work should include the user tier");
  assert(scopedTaskWork.capabilities.browser === true, "Pro user scoped work should advertise browser capability");
  assert(!JSON.stringify(scopedTaskWork.contextItems).includes("Other user private project"), "scoped work should not include another user's context");
  const agencyHeartbeat = await request("/api/agent/heartbeat", {
    method: "POST",
    headers: agentHeaders,
    body: {
      id: "smoke-openclaw",
      name: "Smoke OpenClaw",
      status: "online",
      health: "ok",
      capabilities: { bridge: true, diagnostics: true, executor: true, browser: true, shell: true, downloads: false },
      version: "smoke"
    }
  });
  assert(agencyHeartbeat.worker.capabilities.browser === true, "agency heartbeat should report browser capability");
  const afterAgencyHeartbeat = await request("/api/state", { headers: operatorHeaders });
  assert(afterAgencyHeartbeat.agencyWorkers.some((item) => item.id === "smoke-openclaw" && item.health === "ok"), "operator state should expose agency worker health separately from network compute");
  const proShellApproval = await request("/api/approvals", {
    method: "POST",
    headers: agentHeaders,
    body: {
      type: "command",
      title: "Pro user shell execution",
      details: "Pro user asks for VM command",
      taskId: simpleTask.id,
      riskLevel: "low",
      executionMode: "browser",
      executionPlan: {
        mode: "browser",
        summary: "Open example.com and capture text",
        sensitive: false,
        riskLevel: "low",
        timeoutSeconds: 60,
        actions: [{ type: "open", url: "https://example.com" }, { type: "extract_text" }],
        expectedResult: "Example page text"
      }
    }
  });
  assert(proShellApproval.status === "approved", "Pro user browser plans should auto-approve in full access");
  assert(proShellApproval.executionPlan.actions.length === 2, "browser execution plan should persist");

  // --- Auto-browse tier: autonomous HTTPS browsing, but shell still needs a human ---
  const browseTierPolicy = await request("/api/autonomy", {
    method: "PATCH",
    headers: operatorHeaders,
    body: { mode: "auto_browse" }
  });
  assert(browseTierPolicy.mode === "auto_browse", "operator should be able to select the auto-browse tier");
  const browseTierBrowser = await request("/api/approvals", {
    method: "POST",
    headers: agentHeaders,
    body: {
      type: "command",
      title: "Auto-browse HTTPS page",
      details: "Open a public HTTPS page and read it.",
      messageId: "smoke-autobrowse-browser",
      riskLevel: "low",
      executionMode: "browser",
      executionPlan: {
        mode: "browser",
        summary: "Open example.com",
        sensitive: false,
        riskLevel: "low",
        timeoutSeconds: 60,
        actions: [{ type: "open", url: "https://example.com" }, { type: "extract_text" }],
        expectedResult: "Page text"
      }
    }
  });
  assert(browseTierBrowser.status === "approved", "auto-browse should auto-approve non-credential HTTPS browser plans");
  const browseTierShell = await request("/api/approvals", {
    method: "POST",
    headers: agentHeaders,
    body: {
      type: "command",
      title: "Auto-browse shell attempt",
      details: "Try to run a shell command under auto-browse.",
      messageId: "smoke-autobrowse-shell",
      riskLevel: "low",
      executionMode: "shell",
      executionPlan: {
        mode: "shell",
        summary: "whoami",
        sensitive: false,
        riskLevel: "low",
        timeoutSeconds: 30,
        commands: ["whoami"],
        expectedResult: "user"
      }
    }
  });
  assert(browseTierShell.status === "pending", "auto-browse must still send shell execution to human review");
  const restoreFullAccess = await request("/api/autonomy", {
    method: "PATCH",
    headers: operatorHeaders,
    body: { mode: "full_access" }
  });
  assert(restoreFullAccess.mode === "full_access", "restore full access for the remaining checks");

  // --- Agent-email reply cap is operator-settable and surfaced to state + the agent poll ---
  const defaultEmailPolicy = await request("/api/state", { headers: operatorHeaders });
  assert(defaultEmailPolicy.agentEmailPolicy?.replyCap === 3, "reply cap defaults to 3");
  const savedEmailPolicy = await request("/api/agent-email/policy", {
    method: "PATCH",
    headers: operatorHeaders,
    body: { replyCap: 5 }
  });
  assert(savedEmailPolicy.replyCap === 5, "operator can set the reply cap");
  const clampedEmailPolicy = await request("/api/agent-email/policy", {
    method: "PATCH",
    headers: operatorHeaders,
    body: { replyCap: 999 }
  });
  assert(clampedEmailPolicy.replyCap === 20, "reply cap is clamped to a sane max");
  const agentSeesPolicy = await request("/api/agent/poll", { headers: agentHeaders });
  assert(agentSeesPolicy.agentEmailPolicy?.replyCap === 20, "agent poll carries the reply cap");
  await expectStatus("/api/agent-email/policy", {
    method: "PATCH",
    headers: { ...agentHeaders, "content-type": "application/json" },
    body: JSON.stringify({ replyCap: 1 })
  }, 403);
  await request("/api/agent-email/policy", { method: "PATCH", headers: operatorHeaders, body: { replyCap: 3 } });

  // --- Agent email (host-brokered, mock transport): cold-contact needs an approved plan ---
  const coldSend = await request("/api/agent/email/send", {
    method: "POST",
    headers: agentHeaders,
    body: { to: "lead@prospect.example", subject: "Hello", body: "Intro" }
  });
  assert(coldSend.status === "needs_approval", "cold first-contact without an approved plan should need approval");
  const emailCampaign = await request("/api/approvals", {
    method: "POST",
    headers: agentHeaders,
    body: { type: "email_campaign", title: "Q3 outreach", plannedRecipients: 3, campaignPurpose: "Introduce Compass to 3 prospects" }
  });
  assert(emailCampaign.type === "email_campaign", "email_campaign approval type is accepted");
  assert(emailCampaign.status === "pending", "email_campaign must be operator-approved, never auto");
  const approvedCampaign = await request(`/api/approvals/${emailCampaign.id}`, {
    method: "PATCH",
    headers: operatorHeaders,
    body: { status: "approved", note: "Approved 3-prospect outreach." }
  });
  assert(approvedCampaign.status === "approved", "operator can approve the outreach plan");
  const firstContact = await request("/api/agent/email/send", {
    method: "POST",
    headers: agentHeaders,
    body: { to: "lead@prospect.example", subject: "Hello", body: "Intro" }
  });
  assert(firstContact.ok === true, "after plan approval the agent can send a first-contact within budget");
  assert(firstContact.transport === "mock", "smoke uses the mock email transport");
  const emailReply = await request("/api/agent/email/send", {
    method: "POST",
    headers: agentHeaders,
    body: { to: "lead@prospect.example", subject: "Re: Hello", body: "Following up" }
  });
  assert(emailReply.ok === true, "replies to an already-approved recipient send autonomously");
  const emailInbox = await request("/api/agent/email/poll", {
    method: "POST",
    headers: agentHeaders,
    body: { unseenOnly: true }
  });
  assert(emailInbox.ok === true && Array.isArray(emailInbox.messages), "agent can poll its own inbox");

  // Agent-mailbox send via approval: an email_campaign carrying a concrete message must stay
  // pending until the operator approves, then be SENT by the host from the agent's own mailbox.
  const agentMailApproval = await request("/api/approvals", {
    method: "POST",
    headers: agentHeaders,
    body: {
      type: "email_campaign",
      title: "Send email from agent mailbox to jane@example.com",
      details: "Agent-mailbox send smoke test.",
      plannedRecipients: 1,
      campaignPurpose: "Confirm the companion can send from its own mailbox.",
      emailTo: "jane@example.com",
      emailSubject: "Hello from Compass",
      emailBody: "Hi Jane, the Compass companion is confirming its mailbox works."
    }
  });
  assert(agentMailApproval.status === "pending", "an email carrying a message must stay human-boundary until approved");
  assert(!agentMailApproval.emailSentAt, "no email should be sent before approval");
  const approvedAgentMail = await request(`/api/approvals/${agentMailApproval.id}`, {
    method: "PATCH",
    headers: operatorHeaders,
    body: { status: "approved", note: "Approved: send the hello." }
  });
  assert(approvedAgentMail.status === "approved", "operator approval should authorize the send");
  assert(approvedAgentMail.emailSentAt, "approving an email_campaign carrying a message should send it from the agent mailbox");
  assert(approvedAgentMail.responseNote.includes("Sent from the agent mailbox to jane@example.com"), "approved send should record the recipient in the response note");

  const shoppingApproval = await request("/api/approvals", {
    method: "POST",
    headers: agentHeaders,
    body: {
      type: "purchase",
      title: "Review headphone purchase",
      details: "Compass found a candidate pair of headphones and needs the user to check vendor, price, and budget before continuing.",
      taskId: simpleTask.id,
      sensitive: true
    }
  });
  assert(shoppingApproval.userId === devSession.user.id, "approval should inherit simple user from the source task");
  const simpleAfterApproval = await request("/api/me/state", { headers: userHeaders });
  assert(simpleAfterApproval.approvals.some((item) => item.id === shoppingApproval.id), "simple state should expose user review requests");
  assert(!JSON.stringify(simpleAfterApproval.approvals).includes("renderedCommands"), "simple approvals should not expose pro command internals");
  const reviewedShopping = await request(`/api/me/approvals/${shoppingApproval.id}`, {
    method: "PATCH",
    headers: userHeaders,
    body: { status: "approved", note: "I checked the item and budget." }
  });
  assert(reviewedShopping.status === "approved", "simple user should approve own review request");

  const appJs = await readFile(path.join(root, "public", "app.js"), "utf8");
  const serverJs = await readFile(path.join(root, "server.js"), "utf8");
  const indexHtml = await readFile(path.join(root, "public", "index.html"), "utf8");
  const stylesCss = await readFile(path.join(root, "public", "styles.css"), "utf8");
  assert(appJs.includes("if (!pro) {\n    state.activeChannel = \"compass\";"), "simple mode should force the single Compass inbox");
  assert(appJs.includes("? messages.filter((message) => messageChannel(message) === active.id)\n    : messages"), "simple inbox should not filter by hidden pro channels");
  assert(appJs.includes("data-context-forget"), "simple context UI should expose a Forget action");
  assert(appJs.includes("Agency Worker"), "Pro diagnostics should expose agency worker health");
  assert(appJs.includes("messageText.addEventListener(\"keydown\""), "message input should send on Enter");
  assert(appJs.includes("event.shiftKey"), "message input should preserve Shift+Enter newlines");
  assert(appJs.includes("channel: active.id"), "message composer should post to the rendered active channel");
  assert(appJs.includes("messageText.addEventListener(\"input\", resizeMessageText)"), "message input should grow while typing");
  assert(appJs.includes("contextAutoResizeTextareas"), "context textareas should grow to show their contents");
  assert(appJs.includes("setupChannelRailResize"), "inbox channel rail should be resizable");
  assert(appJs.includes("data-delete-channel"), "archived channel rail should expose permanent delete");
  assert(appJs.includes("bindHoldDeleteChannel"), "channel delete should require a hold gesture");
  assert(appJs.includes("pendingApprovalScroll"), "review highlight should scroll only for deliberate approval navigation");
  assert(appJs.includes("focusDialogInput(approvalDecisionNote)"), "review dialog should avoid mobile autofocus scroll jumps");
  assert(appJs.includes("function unreadChannelCount()"), "inbox tab should badge channels with unread messages");
  assert(appJs.includes("function openTaskCount()"), "tasks tab should badge open tasks");
  assert(appJs.includes("function pendingApprovalCount()"), "review tab should badge pending requests");
  assert(appJs.includes("function applyAttentionFilterDefaults()"), "tasks and review should prefer attention filters when their tabs have badge counts");
  assert(appJs.includes("taskFilterPreference"), "task attention defaults should preserve the last selected task filter");
  assert(appJs.includes("approvalsFilterPreference"), "review attention defaults should preserve the last selected review filter");
  assert(appJs.includes('if (state.tab === "inbox") markChannelSeen'), "hidden inbox renders should not consume unread badges");
  assert(appJs.includes("sort(compareMessagesChronologically)"), "chat rendering should sort messages chronologically");
  assert(serverJs.includes("messages: newestFirst(activeItems(db.messages)).slice(0, 100)"), "API state should return messages in deterministic newest-first order");
  assert(appJs.includes('tabId === "credits") return creditBalance() <= 0 ? "!" : "";'), "credits tab should warn when no credits remain");
  assert(indexHtml.includes("moreTabsButton"), "mobile nav should include a More tab control");
  assert(indexHtml.includes("channelResizer"), "inbox should include a channel resize handle");
  assert(indexHtml.includes('class="credential-username" type="text" name="username" value="compass-operator" autocomplete="username"'), "operator key login should include a stable credential username");
  assert(indexHtml.includes('id="tokenInput" name="password" type="password" autocomplete="current-password"'), "operator key should be the saved credential password field");
  assert(indexHtml.includes('id="pinForm" class="dialog-panel" autocomplete="off"'), "PIN dialog should opt out of password-manager form saving");
  assert(indexHtml.includes('id="pinInput" class="pin-code-input" type="text" inputmode="numeric" autocomplete="one-time-code"'), "PIN entry should be a local numeric code instead of a saved password field");
  assert(stylesCss.includes("mobile-secondary-tab"), "mobile nav should collapse secondary tabs behind More");
  assert(stylesCss.includes(".chat-composer:not(:focus-within) select"), "mobile composer should keep the unfocused routing control compact");
  assert(stylesCss.includes(".chat-composer:focus-within textarea"), "mobile composer should lift focused input above controls");
  assert(stylesCss.includes(".context-view textarea"), "context textareas should avoid inner scrolling");
  assert(stylesCss.includes(".credential-username"), "credential username should stay visually hidden without disappearing from form semantics");
  assert(stylesCss.includes("env(safe-area-inset-bottom)"), "mobile layout should reserve safe-area space above bottom nav");
  assert(stylesCss.includes("-webkit-text-security: disc"), "PIN code input should stay visually masked");
  assert(stylesCss.includes(".tab-badge"), "tab badges should have compact nav styling");

  const networkCall = request("/api/llm/chat", {
    method: "POST",
    headers: agentHeaders,
    body: {
      messages: [{ role: "user", content: "Please do complex heavy reasoning for a smoke test." }],
      routingPreference: "network",
      allowNetwork: true,
      model: "mock-local",
      maxTokens: 80,
      networkTimeoutMs: 5000
    }
  });
  let assignedJob;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const jobs = await request("/api/network/worker/jobs", { headers: workerHeaders });
    assignedJob = jobs.jobs[0];
    if (assignedJob) break;
    await delay(100);
  }
  assert(assignedJob, "worker should receive assigned network job");
  assert(!JSON.stringify(assignedJob.messages).includes("Be useful, bounded"), "network job should not include ordinary shared context");
  await request(`/api/network/worker/jobs/${assignedJob.id}/result`, {
    method: "POST",
    headers: workerHeaders,
    body: {
      ok: true,
      text: "network result ok",
      usage: { prompt_tokens: 12, completion_tokens: 6 },
      runtimeMs: 25
    }
  });
  const networkResponse = await networkCall;
  assert(networkResponse.ok === true, "network LLM call should succeed");
  assert(networkResponse.provider === "latch-network", "network LLM response should identify provider");
  assert(networkResponse.text === "network result ok", "network response should return worker text");
  assert(networkResponse.routing.credits > 0, "network response should include charged credits");

  const afterNetwork = await request("/api/state", { headers: operatorHeaders });
  assert(afterNetwork.network.jobs.some((job) => job.id === assignedJob.id && job.status === "completed"), "completed network job should be visible");
  assert(afterNetwork.network.ledgerEntries.some((entry) => entry.type === "network_reserve"), "ledger should record credit reservation");
  assert(afterNetwork.network.ledgerEntries.some((entry) => entry.type === "network_earning"), "ledger should record worker earning");

  const sensitiveLocal = await request("/api/llm/chat", {
    method: "POST",
    headers: agentHeaders,
    body: {
      prompt: "This is complex but includes password and api key material.",
      routingPreference: "auto",
      allowNetwork: true,
      model: "mock-local"
    }
  });
  assert(sensitiveLocal.provider === "mock-openai-compatible", "sensitive auto-routed request should use local fallback provider");
  assert(sensitiveLocal.routing.reason === "sensitive_content_detected", "sensitive routing reason should be recorded");

  await request(`/api/network/workers/${invite.worker.id}`, {
    method: "PATCH",
    headers: operatorHeaders,
    body: { status: "paused" }
  });
  const fallback = await request("/api/llm/chat", {
    method: "POST",
    headers: agentHeaders,
    body: {
      prompt: "Please do complex heavy reasoning after the worker is paused.",
      routingPreference: "network",
      allowNetwork: true,
      model: "mock-local",
      networkTimeoutMs: 1000
    }
  });
  assert(fallback.provider === "mock-openai-compatible", "unavailable network worker should fall back to local provider");

  const adjustment = await request("/api/network/ledger/adjust", {
    method: "POST",
    headers: operatorHeaders,
    body: { accountId: "operator", amount: 25, note: "Smoke top-up" }
  });
  assert(adjustment.account.balance > 0, "manual ledger adjustment should update balance");

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
  const shellExecution = await request("/api/agent/executions", {
    method: "POST",
    headers: agentHeaders,
    body: {
      approvalId: operatorShellApproval.id,
      mode: "shell",
      commands: ["whoami"],
      executionPlan: operatorShellApproval.executionPlan,
      exitCode: 0,
      stdout: "root",
      stderr: "",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString()
    }
  });
  assert(shellExecution.mode === "shell", "execution report should store shell mode");
  assert(shellExecution.executionPlan.commands[0] === "whoami", "execution report should store execution plan");
  const browserSearchExecution = await request("/api/agent/executions", {
    method: "POST",
    headers: agentHeaders,
    body: {
      approvalId: browserSearchApproval.id,
      mode: "browser",
      executionPlan: browserSearchApproval.executionPlan,
      exitCode: 0,
      stdout: "Search query: Jane Doe Example Corp\n\nSource 1: Profile\nURL: https://example.com/janedoe\nExcerpt: Public source note",
      stderr: "",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString()
    }
  });
  assert(browserSearchExecution.executionPlan.actions[0].type === "search_web", "execution audit should store search_web action");

  await expectStatus("/api/agent/research-results", {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({ question: "operator should not report research" })
  }, 403);

  const researchResultBody = {
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
  };
  const researchRun = await request("/api/agent/research-results", {
    method: "POST",
    headers: agentHeaders,
    body: researchResultBody
  });
  assert(researchRun.status === "completed", "research result status should be stored");
  assert(researchRun.sources[0].summary.includes("compact"), "research source summary should be stored");
  assert(researchRun.sources[0].cached === true, "research source cache marker should be stored");
  const duplicateResearchRun = await request("/api/agent/research-results", {
    method: "POST",
    headers: agentHeaders,
    body: researchResultBody
  });
  assert(duplicateResearchRun.id === researchRun.id, "duplicate research reports should return the original run");
  assert(duplicateResearchRun.deduped === true, "duplicate research reports should be marked as deduped");

  const visible = await request("/api/state", { headers: operatorHeaders });
  assert(visible.contextItems.some((item) => item.id === fileItem.id), "operator state should include context items");
  assert(visible.contextItems.some((item) => item.originApprovalId === contextQuestion.id), "approved context questions should save operator answers");
  assert(visible.contextItems.some((item) => item.originApprovalId === browserSearchApproval.id && item.text.includes("Search query")), "browser search findings should save requested context");
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
  assert(report.channel === task.channel, "agent report should use the task channel");
  const duplicateReport = await request("/api/agent/report", {
    method: "POST",
    headers: agentHeaders,
    body: { text: "report ok", taskId: task.id, channel: "operations" }
  });
  assert(duplicateReport.id === report.id, "duplicate agent reports should return the original message");
  assert(duplicateReport.deduped === true, "duplicate agent reports should be marked as deduped");
  const afterDuplicateReport = await request("/api/state", { headers: operatorHeaders });
  assert(afterDuplicateReport.messages.filter((item) => item.text === "report ok" && item.taskId === task.id).length === 1, "duplicate agent reports should not create multiple messages");

  const patched = await request(`/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: agentHeaders,
    body: { status: "done", note: "completed" }
  });
  assert(patched.status === "done", "agent should patch task status");
  const afterTaskDone = await request("/api/state", { headers: operatorHeaders });
  assert(!afterTaskDone.channels.some((channel) => channel.id === task.channel), "done task channel should leave active channels");
  assert(afterTaskDone.archives.channels.some((channel) => channel.id === task.channel), "done task channel should appear in archived channels");
  const restoredTaskChannel = await request(`/api/channels/${task.channel}`, {
    method: "PATCH",
    headers: operatorHeaders,
    body: { archived: false }
  });
  assert(!restoredTaskChannel.archivedAt, "restoring a task channel should unarchive the channel");
  const afterTaskChannelRestore = await request("/api/state", { headers: operatorHeaders });
  const restoredTask = afterTaskChannelRestore.tasks.find((item) => item.id === task.id);
  assert(restoredTask.status === "queued", "restoring an archived task channel should reopen the task");
  assert(afterTaskChannelRestore.channels.some((channel) => channel.id === task.channel), "restored task channel should return to active channels");
  await request(`/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: agentHeaders,
    body: { status: "done", note: "completed after restore" }
  });
  const archivedChannelMessage = await request("/api/messages", {
    method: "POST",
    headers: operatorHeaders,
    body: { text: "Please add the missing appendix.", channel: task.channel }
  });
  assert(archivedChannelMessage.channel === task.channel, "message sent to archived task channel should stay in that channel");
  assert(archivedChannelMessage.taskId === task.id, "message sent to archived task channel should link to the task");
  assert(archivedChannelMessage.agentHandledAt, "message that reopens a task channel should not be polled as a duplicate inbox instruction");
  const afterArchivedChannelMessage = await request("/api/state", { headers: operatorHeaders });
  const messageReopenedTask = afterArchivedChannelMessage.tasks.find((item) => item.id === task.id);
  assert(messageReopenedTask.status === "queued", "sending a message in an archived task channel should reopen the task");
  assert(messageReopenedTask.instructions.includes("missing appendix"), "archived channel message should become task follow-up context");
  await request(`/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: agentHeaders,
    body: { status: "done", note: "completed after channel message" }
  });
  const reopened = await request(`/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: operatorHeaders,
    body: { status: "queued", reopenNote: "Add the missing evidence section." }
  });
  assert(reopened.status === "queued", "operator should reopen a completed task");
  assert(reopened.instructions.includes("missing evidence"), "reopened task should keep the elaboration");
  const afterTaskReopen = await request("/api/state", { headers: operatorHeaders });
  assert(afterTaskReopen.channels.some((channel) => channel.id === task.channel), "reopened task channel should be restored");
  assert(afterTaskReopen.messages.some((item) => item.taskId === task.id && item.text.includes("missing evidence") && item.channel === task.channel), "reopen elaboration should be posted into the task channel");
  await request(`/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: agentHeaders,
    body: { status: "done", note: "completed again" }
  });
  const deletedTaskChannel = await request(`/api/channels/${task.channel}`, {
    method: "DELETE",
    headers: operatorHeaders
  });
  assert(deletedTaskChannel.removed === task.channel, "archived task channel should be permanently deletable");
  const afterTaskChannelDelete = await request("/api/state", { headers: operatorHeaders });
  const taskAfterChannelDelete = afterTaskChannelDelete.tasks.find((item) => item.id === task.id);
  assert(taskAfterChannelDelete.channelDeletedAt, "task should remember that its channel was permanently deleted");
  assert(!afterTaskChannelDelete.messages.some((item) => item.channel === task.channel), "deleted channel messages should be removed");
  await expectStatus(`/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...operatorHeaders
    },
    body: JSON.stringify({ status: "queued", reopenNote: "Try again anyway." })
  }, 409);

  console.log("Latch smoke tests passed.");
} finally {
  child.kill();
  await onceExit(child);
  await new Promise((resolve) => mockLlm.close(resolve));
  await new Promise((resolve) => mockGithub.close(resolve));
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
  try {
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
  } catch (error) {
    await delay(50);
    throw new Error(`${options.method || "GET"} ${pathname} failed before response: ${error.message}\nchild=${child.exitCode ?? "running"}/${child.signalCode ?? ""}\nbody=${JSON.stringify(options.body || {}).slice(0, 500)}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
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
