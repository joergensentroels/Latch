const initialTab = new URLSearchParams(location.search).get("tab");
const tabs = ["inbox", "tasks", "approvals", "context", "timeline"];
const maxContextUploadBytes = 2_000_000;

const state = {
  token: localStorage.getItem("latchOperatorToken") || localStorage.getItem("commandCenterToken") || "",
  tab: tabs.includes(initialTab) ? initialTab : "inbox",
  data: null,
  taskFilter: localStorage.getItem("latchTaskFilter") || "open",
  approvalsFilter: localStorage.getItem("latchApprovalsFilter") || "pending",
  seenNotificationIds: new Set(JSON.parse(localStorage.getItem("latchSeenNotificationIds") || "[]")),
  notificationBaselineReady: false,
  deferredInstallPrompt: null,
  approvalDecision: null
};

const loginView = document.querySelector("#loginView");
const mainView = document.querySelector("#mainView");
const loginForm = document.querySelector("#loginForm");
const tokenInput = document.querySelector("#tokenInput");
const toggleTokenVisibility = document.querySelector("#toggleTokenVisibility");
const messageForm = document.querySelector("#messageForm");
const messageText = document.querySelector("#messageText");
const taskForm = document.querySelector("#taskForm");
const taskTitle = document.querySelector("#taskTitle");
const taskDetails = document.querySelector("#taskDetails");
const taskPriority = document.querySelector("#taskPriority");
const profileForm = document.querySelector("#profileForm");
const profileName = document.querySelector("#profileName");
const profilePurpose = document.querySelector("#profilePurpose");
const profileGoals = document.querySelector("#profileGoals");
const profileBoundaries = document.querySelector("#profileBoundaries");
const profileCommunicationStyle = document.querySelector("#profileCommunicationStyle");
const profileShare = document.querySelector("#profileShare");
const profileStatus = document.querySelector("#profileStatus");
const contextNoteForm = document.querySelector("#contextNoteForm");
const contextTitle = document.querySelector("#contextTitle");
const contextCategory = document.querySelector("#contextCategory");
const contextTags = document.querySelector("#contextTags");
const contextText = document.querySelector("#contextText");
const contextShare = document.querySelector("#contextShare");
const contextNoteStatus = document.querySelector("#contextNoteStatus");
const contextFileForm = document.querySelector("#contextFileForm");
const contextFileInput = document.querySelector("#contextFileInput");
const contextFileCategory = document.querySelector("#contextFileCategory");
const contextFileTags = document.querySelector("#contextFileTags");
const contextFileShare = document.querySelector("#contextFileShare");
const contextFileStatus = document.querySelector("#contextFileStatus");
const refreshButton = document.querySelector("#refreshButton");
const lockButton = document.querySelector("#lockButton");
const appLockButton = document.querySelector("#appLockButton");
const installButton = document.querySelector("#installButton");
const notifyButton = document.querySelector("#notifyButton");
const backupButton = document.querySelector("#backupButton");
const exportContextButton = document.querySelector("#exportContextButton");
const backupStatus = document.querySelector("#backupStatus");
const connectionDot = document.querySelector("#connectionDot");
const connectionText = document.querySelector("#connectionText");
const pendingSummary = document.querySelector("#pendingSummary");
const routeWarning = document.querySelector("#routeWarning");
const pinDialog = document.querySelector("#pinDialog");
const pinForm = document.querySelector("#pinForm");
const pinDialogEyebrow = document.querySelector("#pinDialogEyebrow");
const pinDialogTitle = document.querySelector("#pinDialogTitle");
const pinHelp = document.querySelector("#pinHelp");
const pinInput = document.querySelector("#pinInput");
const pinConfirmLabel = document.querySelector("#pinConfirmLabel");
const pinConfirmInput = document.querySelector("#pinConfirmInput");
const pinStatus = document.querySelector("#pinStatus");
const passkeyButton = document.querySelector("#passkeyButton");
const pinCancelButton = document.querySelector("#pinCancelButton");
const pinSubmitButton = document.querySelector("#pinSubmitButton");
const approvalDialog = document.querySelector("#approvalDialog");
const approvalDecisionForm = document.querySelector("#approvalDecisionForm");
const approvalDialogEyebrow = document.querySelector("#approvalDialogEyebrow");
const approvalDialogTitle = document.querySelector("#approvalDialogTitle");
const approvalDialogSummary = document.querySelector("#approvalDialogSummary");
const approvalDecisionNote = document.querySelector("#approvalDecisionNote");
const approvalDecisionSubmit = document.querySelector("#approvalDecisionSubmit");
const approvalDialogClose = document.querySelector("#approvalDialogClose");
const approvalDecisionCancel = document.querySelector("#approvalDecisionCancel");
const taskFilterButtons = document.querySelectorAll("[data-task-filter]");
const approvalFilterButtons = document.querySelectorAll("[data-approval-filter]");

const lists = {
  messages: document.querySelector("#messagesList"),
  tasks: document.querySelector("#tasksList"),
  approvals: document.querySelector("#approvalsList"),
  context: document.querySelector("#contextList"),
  operations: document.querySelector("#operationsList"),
  archives: document.querySelector("#archivesList"),
  events: document.querySelector("#eventsList")
};
const diagnosticsGrid = document.querySelector("#diagnosticsGrid");
const securityChecklist = document.querySelector("#securityChecklist");
let pinMode = "unlock";

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  state.token = tokenInput.value.trim();
  localStorage.setItem("latchOperatorToken", state.token);
  localStorage.removeItem("commandCenterToken");
  await boot();
});

toggleTokenVisibility.addEventListener("click", () => {
  const shouldShow = tokenInput.type === "password";
  tokenInput.type = shouldShow ? "text" : "password";
  toggleTokenVisibility.classList.toggle("active", shouldShow);
  toggleTokenVisibility.title = shouldShow ? "Hide operator key" : "Show operator key";
  toggleTokenVisibility.setAttribute("aria-label", toggleTokenVisibility.title);
  tokenInput.focus();
});

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = messageText.value.trim();
  if (!text) return;

  await withSubmitLock(messageForm, async () => {
    await api("/api/messages", {
      method: "POST",
      body: JSON.stringify({ text })
    });
    messageText.value = "";
    await refresh();
  });
});

taskForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = taskTitle.value.trim();
  const details = taskDetails.value.trim();
  if (!title && !details) return;

  await withSubmitLock(taskForm, async () => {
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: title || details.slice(0, 80),
        details,
        priority: taskPriority.value
      })
    });
    taskTitle.value = "";
    taskDetails.value = "";
    taskPriority.value = "normal";
    await refresh();
  });
});

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await withSubmitLock(profileForm, async () => {
    await api("/api/profile", {
      method: "PATCH",
      body: JSON.stringify({
        name: profileName.value.trim(),
        purpose: profilePurpose.value.trim(),
        goals: profileGoals.value.trim(),
        boundaries: profileBoundaries.value.trim(),
        communicationStyle: profileCommunicationStyle.value.trim(),
        shareWithAgent: profileShare.checked
      })
    });
    setFormStatus(profileStatus, "Profile saved.", "success");
    await refresh();
  });
});

contextNoteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = contextTitle.value.trim();
  const text = contextText.value.trim();
  if (!text) {
    setFormStatus(contextNoteStatus, "Add a note before saving.", "error");
    contextText.focus();
    return;
  }

  try {
    await withSubmitLock(contextNoteForm, async () => {
      await api("/api/context/notes", {
        method: "POST",
        body: JSON.stringify({
          title,
          text,
          category: contextCategory.value,
          tags: tagsFromInput(contextTags.value),
          shareWithAgent: contextShare.checked
        })
      });
      contextTitle.value = "";
      contextTags.value = "";
      contextText.value = "";
      contextShare.checked = true;
      setFormStatus(contextNoteStatus, "Saved to Context.", "success");
      await refresh();
    });
  } catch (error) {
    setFormStatus(contextNoteStatus, `Could not save: ${error.message}`, "error");
  }
});

contextFileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = contextFileInput.files?.[0];
  if (!file) {
    setFormStatus(contextFileStatus, "Choose a file before uploading.", "error");
    return;
  }
  if (file.size > maxContextUploadBytes) {
    setFormStatus(contextFileStatus, `Files are limited to ${formatBytes(maxContextUploadBytes)} for now.`, "error");
    return;
  }

  try {
    await withSubmitLock(contextFileForm, async () => {
      const contentBase64 = await fileToBase64(file);
      await api("/api/context/files", {
        method: "POST",
        body: JSON.stringify({
          name: file.name,
          type: file.type || "application/octet-stream",
          size: file.size,
          category: contextFileCategory.value,
          tags: tagsFromInput(contextFileTags.value),
          shareWithAgent: contextFileShare.checked,
          contentBase64
        })
      });
      contextFileInput.value = "";
      contextFileTags.value = "";
      contextFileShare.checked = false;
      setFormStatus(contextFileStatus, "Uploaded to Context.", "success");
      await refresh();
    });
  } catch (error) {
    setFormStatus(contextFileStatus, `Could not upload: ${error.message}`, "error");
  }
});

refreshButton.addEventListener("click", refresh);
notifyButton.addEventListener("click", enableNotifications);
backupButton.addEventListener("click", createBackup);
exportContextButton.addEventListener("click", exportContext);
appLockButton.addEventListener("click", () => {
  if (!state.token) return;
  if (!isAppLockConfigured()) {
    openPinDialog("set");
    return;
  }
  state.pinUnlocked = false;
  openPinDialog("unlock");
});
installButton.addEventListener("click", async () => {
  if (!state.deferredInstallPrompt) return;
  state.deferredInstallPrompt.prompt();
  await state.deferredInstallPrompt.userChoice;
  state.deferredInstallPrompt = null;
  installButton.classList.add("hidden");
});

approvalDialogClose.addEventListener("click", closeApprovalDialog);
approvalDecisionCancel.addEventListener("click", closeApprovalDialog);
approvalDialog.addEventListener("click", (event) => {
  if (event.target === approvalDialog) closeApprovalDialog();
});
approvalDecisionForm.addEventListener("submit", submitApprovalDecision);
pinForm.addEventListener("submit", submitPin);
passkeyButton?.addEventListener("click", handlePasskeyButton);
pinCancelButton.addEventListener("click", () => {
  if (pinMode === "unlock") {
    localStorage.removeItem("latchOperatorToken");
    state.token = "";
    closePinDialog();
    showLogin();
    return;
  }
  closePinDialog();
});

lockButton.addEventListener("click", () => {
  localStorage.removeItem("latchOperatorToken");
  localStorage.removeItem("commandCenterToken");
  state.token = "";
  showLogin();
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.deferredInstallPrompt = event;
  installButton.classList.remove("hidden");
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js");
}

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    state.tab = button.dataset.tab;
    history.replaceState(null, "", `?tab=${state.tab}`);
    renderTabs();
  });
});

approvalFilterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.approvalsFilter = button.dataset.approvalFilter;
    localStorage.setItem("latchApprovalsFilter", state.approvalsFilter);
    renderApprovals();
  });
});

taskFilterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.taskFilter = button.dataset.taskFilter;
    localStorage.setItem("latchTaskFilter", state.taskFilter);
    renderTasks();
  });
});

boot();
setInterval(() => {
  if (state.token && !mainView.classList.contains("hidden")) refresh();
}, 8000);

async function boot() {
  if (!state.token) {
    showLogin();
    return;
  }
  if (isAppLockConfigured() && !state.pinUnlocked) {
    showPinLock();
    return;
  }

  try {
    await refresh();
    loginView.classList.add("hidden");
    mainView.classList.remove("hidden");
  } catch {
    markConnection(false);
    showLogin();
  }
}

function showLogin() {
  tokenInput.value = state.token;
  loginView.classList.remove("hidden");
  mainView.classList.add("hidden");
  closePinDialog();
}

function showPinLock() {
  loginView.classList.add("hidden");
  mainView.classList.add("hidden");
  openPinDialog("unlock");
}

async function refresh() {
  try {
    const [appState, llmConfig, about] = await Promise.all([
      api("/api/state"),
      api("/api/llm/config"),
      api("/api/about")
    ]);
    state.data = appState;
    state.llmConfig = llmConfig;
    state.about = about;
    markConnection(true);
    render();
  } catch (error) {
    markConnection(false);
    if (!state.data) throw error;
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${state.token}`,
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

async function withSubmitLock(form, callback) {
  const button = form.querySelector("button[type='submit']");
  button.disabled = true;
  try {
    await callback();
  } finally {
    button.disabled = false;
  }
}

function render() {
  renderTabs();
  renderStatus();
  renderRouteWarning();
  renderNotificationButton();
  maybeNotify();
  renderMessages();
  renderTasks();
  renderApprovals();
  renderProfile();
  renderContext();
  renderDiagnostics();
  renderOperations();
  renderSecurityChecklist();
  renderArchives();
  renderEvents();
}

function renderProfile() {
  const profile = state.data?.profile || {};
  if (profileForm.contains(document.activeElement)) return;

  profileName.value = profile.name || "";
  profilePurpose.value = profile.purpose || "";
  profileGoals.value = profile.goals || "";
  profileBoundaries.value = profile.boundaries || "";
  profileCommunicationStyle.value = profile.communicationStyle || "";
  profileShare.checked = profile.shareWithAgent !== false;
}

function renderRouteWarning() {
  routeWarning.classList.toggle("hidden", isPrivateRoute());
}

async function enableNotifications() {
  if (!("Notification" in window)) return;
  const permission = await Notification.requestPermission();
  renderNotificationButton();
  if (permission === "granted") {
    await showNotification("Latch notifications enabled", {
      body: "You will get alerts while this app can receive updates.",
      tag: "latch-enabled"
    });
  }
}

function renderNotificationButton() {
  if (!("Notification" in window)) {
    notifyButton.classList.add("hidden");
    return;
  }
  const permission = Notification.permission;
  notifyButton.classList.toggle("active", permission === "granted");
  notifyButton.title = permission === "granted" ? "Notifications enabled" : "Enable notifications";
  notifyButton.setAttribute("aria-label", notifyButton.title);
}

function isPrivateRoute() {
  const host = location.hostname.toLowerCase();
  return host === "localhost"
    || host === "127.0.0.1"
    || host === "::1"
    || /^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
    || host.endsWith(".ts.net");
}

function renderStatus() {
  const pendingApprovals = (state.data?.approvals || []).filter((item) => item.status === "pending").length;
  const openTasks = (state.data?.tasks || []).filter((item) => ["queued", "running", "waiting"].includes(item.status)).length;
  const llmStatus = state.llmConfig?.enabled ? `LLM ${state.llmConfig.model}` : "LLM not set";
  pendingSummary.textContent = `${pendingApprovals} approvals - ${openTasks} tasks - ${llmStatus}`;
}

function maybeNotify() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const candidates = [
    ...(state.data?.approvals || [])
      .filter((item) => item.status === "pending")
      .map((item) => ({
        id: item.id,
        title: "Latch needs attention",
        body: item.type === "human_verification" || item.type === "context_question"
          ? "Human input is needed. Open Latch to review."
          : "Approval requested. Open Latch to review.",
        url: "/?tab=approvals"
      })),
    ...(state.data?.messages || [])
      .filter((item) => item.direction === "agent_to_operator")
      .map((item) => ({
        id: item.id,
        title: "Latch agent update",
        body: "Open Latch to read the latest update.",
        url: "/?tab=inbox"
      }))
  ];

  if (!state.notificationBaselineReady) {
    candidates.forEach((item) => state.seenNotificationIds.add(item.id));
    state.notificationBaselineReady = true;
    saveSeenNotificationIds();
    return;
  }

  candidates.forEach((item) => {
    if (state.seenNotificationIds.has(item.id)) return;
    state.seenNotificationIds.add(item.id);
    showNotification(item.title, {
      body: item.body,
      tag: item.id,
      data: { url: item.url }
    });
  });
  saveSeenNotificationIds();
}

async function showNotification(title, options = {}) {
  const registration = await navigator.serviceWorker?.ready.catch(() => null);
  if (registration?.showNotification) {
    await registration.showNotification(title, {
      icon: "/icons/icon.svg",
      badge: "/icons/icon.svg",
      ...options
    });
    return;
  }
  new Notification(title, {
    icon: "/icons/icon.svg",
    ...options
  });
}

function saveSeenNotificationIds() {
  const recent = Array.from(state.seenNotificationIds).slice(-200);
  state.seenNotificationIds = new Set(recent);
  localStorage.setItem("latchSeenNotificationIds", JSON.stringify(recent));
}

function renderTabs() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === state.tab);
  });
  document.querySelectorAll(".panel").forEach((panel) => panel.classList.add("hidden"));
  document.querySelector(`#${state.tab}Panel`).classList.remove("hidden");
}

function renderMessages() {
  const messages = state.data?.messages || [];
  renderList(lists.messages, messages, (message) => `
    <article class="item">
      <div class="item-header">
        <h2 class="item-title">${escapeHtml(message.author)}</h2>
        <span class="item-meta">${formatTime(message.createdAt)}</span>
      </div>
      <p class="item-body">${escapeHtml(message.text)}</p>
      <div class="approval-actions">
        <button class="secondary-button" data-archive-kind="messages" data-archive-id="${escapeHtml(message.id)}" type="button">Archive</button>
      </div>
    </article>
  `);
  bindArchiveButtons(lists.messages);
}

function renderTasks() {
  taskFilterButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.taskFilter === state.taskFilter);
  });

  const allTasks = state.data?.tasks || [];
  const tasks = state.taskFilter === "open"
    ? allTasks.filter((task) => ["queued", "running", "waiting"].includes(task.status))
    : allTasks;
  renderList(lists.tasks, tasks, (task) => `
    <article class="item">
      <div class="item-header">
        <h2 class="item-title">${escapeHtml(task.title)}</h2>
        <span class="badge ${escapeHtml(task.status)}">${escapeHtml(task.status)}</span>
      </div>
      <p class="item-body">${escapeHtml(task.details || task.note || "")}</p>
      <p class="item-meta">${escapeHtml(task.priority)} - ${formatTime(task.updatedAt || task.createdAt)}</p>
      <div class="approval-actions">
        <button class="secondary-button" data-archive-kind="tasks" data-archive-id="${escapeHtml(task.id)}" type="button">Archive</button>
      </div>
    </article>
  `);
  bindArchiveButtons(lists.tasks);
}

function renderApprovals() {
  approvalFilterButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.approvalFilter === state.approvalsFilter);
  });

  const allApprovals = state.data?.approvals || [];
  const approvals = state.approvalsFilter === "pending"
    ? allApprovals.filter((approval) => approval.status === "pending")
    : allApprovals;
  renderList(lists.approvals, approvals, (approval) => `
    <article class="item ${["human_verification", "context_question"].includes(approval.type) ? "human-request" : ""}">
      <div class="item-header">
        <h2 class="item-title">${escapeHtml(approval.title)}</h2>
        <span class="badge ${escapeHtml(approval.status)}">${escapeHtml(approval.status)}</span>
      </div>
      <div class="meta-row">
        <span class="type-pill ${escapeHtml(approval.type || "other")}">${formatApprovalType(approval.type)}</span>
        ${approval.sensitive ? `<span class="type-pill sensitive">Sensitive</span>` : ""}
        ${approval.riskLevel ? `<span class="type-pill risk-${escapeHtml(approval.riskLevel)}">${escapeHtml(approval.riskLevel)} risk</span>` : ""}
        ${approval.executionMode === "read_only_status" ? `<span class="type-pill shared">Read-only</span>` : ""}
        <span class="item-meta">Requested by ${escapeHtml(approval.requestedBy || "agent")}</span>
      </div>
      ${approval.actionPreview || approval.actionTemplate ? `
        <div class="approval-summary">
          <strong>${escapeHtml(approval.actionPreview || commandTemplateLabel(approval.actionTemplate))}</strong>
          <p>${escapeHtml(approvalActionOutcome(approval))}</p>
        </div>
      ` : ""}
      <p class="item-body">${escapeHtml(approval.details)}</p>
      ${approvalAdvice(approval) ? `<p class="approval-advice">${escapeHtml(approvalAdvice(approval))}</p>` : ""}
      ${approval.expectedResponse ? `<p class="help-note"><strong>Return to agent:</strong> ${escapeHtml(approval.expectedResponse)}</p>` : ""}
      ${approval.renderedCommands?.length ? `
        <details class="command-details">
          <summary>Show exact command${approval.renderedCommands.length === 1 ? "" : "s"}</summary>
          <pre class="item-body">${escapeHtml(approval.renderedCommands.join("\n"))}</pre>
        </details>
      ` : approval.command ? `
        <details class="command-details">
          <summary>Show exact command</summary>
          <pre class="item-body">${escapeHtml(approval.command)}</pre>
        </details>
      ` : ""}
      ${approval.responseNote ? `<p class="help-note"><strong>Operator note:</strong> ${escapeHtml(approval.responseNote)}</p>` : ""}
      ${approval.status === "pending" ? `
        <div class="approval-actions">
          <button class="secondary-button" data-approval="${approval.id}" data-status="approved">${approvalActionLabel(approval, "approved")}</button>
          <button class="danger-button" data-approval="${approval.id}" data-status="denied">${approvalActionLabel(approval, "denied")}</button>
          <button class="secondary-button" data-archive-kind="approvals" data-archive-id="${escapeHtml(approval.id)}" type="button">Archive</button>
        </div>
      ` : `
        <div class="approval-actions">
          <button class="secondary-button" data-archive-kind="approvals" data-archive-id="${escapeHtml(approval.id)}" type="button">Archive</button>
        </div>
      `}
    </article>
  `);

  lists.approvals.querySelectorAll("[data-approval]").forEach((button) => {
    button.addEventListener("click", async () => {
      openApprovalDialog(button.dataset.approval, button.dataset.status);
    });
  });
  bindArchiveButtons(lists.approvals);
}

function renderContext() {
  const items = state.data?.contextItems || [];
  renderList(lists.context, items, (item) => `
    <article class="item">
      <div class="item-header">
        <h2 class="item-title">${escapeHtml(item.title || item.name || "Context")}</h2>
        <span class="badge">${escapeHtml(item.kind || "note")}</span>
      </div>
      <div class="meta-row">
        <span class="type-pill">${formatContextCategory(item.category)}</span>
        ${(item.tags || []).map((tag) => `<span class="type-pill neutral">${escapeHtml(tag)}</span>`).join("")}
        ${item.shareWithAgent ? `<span class="type-pill shared">Shared</span>` : `<span class="type-pill neutral">Private</span>`}
        <span class="item-meta">${escapeHtml(item.source || "operator")}</span>
        <span class="item-meta">${formatTime(item.createdAt)}</span>
        ${item.kind === "file" ? `<span class="item-meta">${escapeHtml(formatBytes(item.size || 0))}</span>` : ""}
      </div>
      ${item.kind === "file" ? `
        <p class="item-body">${escapeHtml(item.name || "")}</p>
        ${item.shareStatus ? `<p class="help-note">${escapeHtml(item.shareStatus)}</p>` : ""}
        <div class="approval-actions">
          <button class="secondary-button" data-context-download="${escapeHtml(item.id)}" type="button">Download</button>
          <button class="secondary-button" data-context-share="${escapeHtml(item.id)}" data-context-share-value="${item.shareWithAgent ? "false" : "true"}" type="button">${item.shareWithAgent ? "Keep Private" : "Share"}</button>
          <button class="secondary-button" data-archive-kind="context" data-archive-id="${escapeHtml(item.id)}" type="button">Archive</button>
        </div>
      ` : `
        <p class="item-body">${escapeHtml(item.text || item.preview || "")}</p>
        <div class="approval-actions">
          <button class="secondary-button" data-context-share="${escapeHtml(item.id)}" data-context-share-value="${item.shareWithAgent ? "false" : "true"}" type="button">${item.shareWithAgent ? "Keep Private" : "Share"}</button>
          <button class="secondary-button" data-archive-kind="context" data-archive-id="${escapeHtml(item.id)}" type="button">Archive</button>
        </div>
      `}
    </article>
  `);

  lists.context.querySelectorAll("[data-context-download]").forEach((button) => {
    button.addEventListener("click", () => downloadContextFile(button.dataset.contextDownload));
  });
  lists.context.querySelectorAll("[data-context-share]").forEach((button) => {
    button.addEventListener("click", () => updateContextShare(button.dataset.contextShare, button.dataset.contextShareValue === "true"));
  });
  bindArchiveButtons(lists.context);
}

async function updateContextShare(id, shareWithAgent) {
  await api(`/api/context/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ shareWithAgent })
  });
  await refresh();
}

async function downloadContextFile(id) {
  const response = await fetch(`/api/context/files/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${state.token}` }
  });
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);

  const blob = await response.blob();
  const item = (state.data?.contextItems || []).find((entry) => entry.id === id);
  downloadBlob(blob, item?.name || "context-file");
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function openApprovalDialog(approvalId, status) {
  const approval = (state.data?.approvals || []).find((item) => item.id === approvalId);
  if (!approval) return;

  state.approvalDecision = { approval, status };
  const isApproved = status === "approved";
  approvalDialogEyebrow.textContent = formatApprovalType(approval.type);
  approvalDialogTitle.textContent = isApproved
    ? (approval.type === "context_question" ? "Save Answer" : (approval.type === "human_verification" ? "Mark Done" : "Approve Request"))
    : (approval.type === "context_question" ? "Skip Question" : (approval.type === "human_verification" ? "Cannot Help" : "Deny Request"));
  approvalDialogSummary.textContent = approval.title;
  approvalDecisionNote.value = "";
  approvalDecisionNote.placeholder = approvalPlaceholder(approval, status);
  approvalDecisionSubmit.textContent = isApproved ? "Save Approval" : "Save Denial";
  approvalDecisionSubmit.classList.toggle("danger-button", !isApproved);
  approvalDecisionSubmit.classList.toggle("action-button", isApproved);
  approvalDialog.classList.remove("hidden");
  approvalDecisionNote.focus();
}

function closeApprovalDialog() {
  state.approvalDecision = null;
  approvalDialog.classList.add("hidden");
  approvalDecisionNote.value = "";
}

async function submitApprovalDecision(event) {
  event.preventDefault();
  if (!state.approvalDecision) return;

  const { approval, status } = state.approvalDecision;
  approvalDecisionSubmit.disabled = true;
  try {
    await api(`/api/approvals/${approval.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status,
        note: approvalDecisionNote.value.trim()
      })
    });
    closeApprovalDialog();
    await refresh();
  } finally {
    approvalDecisionSubmit.disabled = false;
  }
}

function approvalPlaceholder(approval, status) {
  if (status === "denied") return "Reason or safer alternative";
  if (approval.type === "context_question") return "Your answer will be saved into Context and shared with the worker";
  if (approval.type === "human_verification") return "Verification completed, or short result";
  if (approval.type === "credential") return "Minimum non-secret result, never a password";
  if (approval.type === "command") return "Reviewed scope or manual result";
  if (approval.type === "purchase") return "Budget/vendor check or manual purchase result";
  return "Decision note";
}

function approvalAdvice(approval) {
  if (approval.type === "command" && approval.executionMode === "read_only_status" && approval.actionTemplate) {
    return "This can only run the named read-only diagnostic template after approval. Raw command text is not executed.";
  }
  if (approval.type === "command" && !approval.command) {
    return "No exact command is attached. Deny this unless you are only recording a boundary or manual result.";
  }
  if (approval.sensitive) {
    return "Sensitive request. Do not paste passwords, recovery codes, payment details, or long-lived tokens back to the agent.";
  }
  if (approval.type === "purchase") {
    return "Purchase request. Approve only after checking cost, vendor, and the exact manual action.";
  }
  return "";
}

function approvalActionOutcome(approval) {
  if (approval.executionMode === "read_only_status") {
    return "If approved, the worker runs this fixed read-only diagnostic and records a trimmed audit result.";
  }
  if (approval.type === "command") {
    return "Approval records your decision; the current bridge will not execute arbitrary commands.";
  }
  if (approval.sensitive) {
    return "Approval records a human step; sensitive notes stay inside Latch.";
  }
  return "Approval records your decision for the worker.";
}

function commandTemplateLabel(value) {
  const labels = {
    "bridge.status": "Check bridge status",
    "bridge.logs": "Read bridge logs",
    "openclaw.gateway.health": "Check OpenClaw Gateway health",
    "docker.status": "Check Docker status",
    "tailscale.status": "Check Tailscale status",
    "repo.status": "Check repo status"
  };
  return labels[value] || value || "Diagnostic";
}

function formatApprovalType(value) {
  const labels = {
    command: "Command",
    human_verification: "Human verification",
    context_question: "Context question",
    account_setup: "Account setup",
    purchase: "Purchase",
    credential: "Credential",
    other: "Other"
  };
  return labels[value] || "Other";
}

function approvalActionLabel(approval, status) {
  if (approval.type === "context_question") return status === "approved" ? "Save answer" : "Skip";
  if (approval.type === "human_verification") return status === "approved" ? "Mark done" : "Cannot help";
  return status === "approved" ? "Approve" : "Deny";
}

function renderEvents() {
  const events = state.data?.events || [];
  renderList(lists.events, events, (item) => `
    <article class="item">
      <div class="item-header">
        <h2 class="item-title">${escapeHtml(item.type)}</h2>
        <span class="item-meta">${formatTime(item.createdAt)}</span>
      </div>
      <p class="item-body">${escapeHtml(item.summary || "")}</p>
    </article>
  `);
}

function renderDiagnostics() {
  const messages = state.data?.messages || [];
  const tasks = state.data?.tasks || [];
  const approvals = state.data?.approvals || [];
  const executions = state.data?.executions || [];
  const latestAgentMessage = messages.find((message) => message.direction === "agent_to_operator");
  const latestExecution = executions[0];
  const openTasks = tasks.filter((item) => ["queued", "running", "waiting"].includes(item.status)).length;
  const pendingApprovals = approvals.filter((item) => item.status === "pending").length;
  const llmReady = Boolean(state.llmConfig?.enabled);
  const about = state.about || {};
  const uptime = about.uptimeSeconds ? `${Math.floor(about.uptimeSeconds / 60)}m ${about.uptimeSeconds % 60}s` : "Unknown";

  const cards = [
    {
      label: "Latch",
      value: connectionText.textContent || "Checking",
      status: connectionDot.classList.contains("online") ? "ok" : "bad"
    },
    {
      label: "LLM",
      value: llmReady ? state.llmConfig.model : "Not configured",
      status: llmReady ? "ok" : "warn"
    },
    {
      label: "Open Work",
      value: `${pendingApprovals} approvals / ${openTasks} tasks`,
      status: pendingApprovals ? "warn" : "ok"
    },
    {
      label: "Worker",
      value: latestAgentMessage ? formatTime(latestAgentMessage.createdAt) : "No update",
      status: latestAgentMessage ? "ok" : "warn",
      note: latestAgentMessage ? latestAgentMessage.text.slice(0, 140) : ""
    },
    {
      label: "Last Diagnostic",
      value: latestExecution ? `${commandTemplateLabel(latestExecution.template)} / ${latestExecution.exitCode}` : "None yet",
      status: !latestExecution ? "warn" : latestExecution.exitCode === 0 ? "ok" : "bad",
      note: latestExecution ? formatTime(latestExecution.finishedAt || latestExecution.createdAt) : "Read-only operations have not run yet"
    },
    {
      label: "Server",
      value: `v${about.version || "dev"} / PID ${about.pid || "?"}`,
      status: "ok",
      note: `Started ${formatTime(about.startedAt)} / uptime ${uptime}`
    },
    {
      label: "Private URL",
      value: about.urls?.privateHttpsUrl || about.urls?.tailscaleHttpUrl || "Not recorded",
      status: about.urls?.privateHttpsUrl ? "ok" : "warn",
      note: about.urls?.privateHttpsUrl ? "Tailscale Serve HTTPS" : "Run Serve-Over-Tailscale.ps1 for private HTTPS"
    },
    {
      label: "Storage",
      value: `${about.counts?.contextItems || 0} context / ${about.counts?.archived || 0} archived`,
      status: about.counts?.archived ? "warn" : "ok",
      note: about.dataDir || ""
    }
  ];

  diagnosticsGrid.innerHTML = cards.map((card) => `
    <article class="status-card ${card.status}">
      <span>${escapeHtml(card.label)}</span>
      <strong>${escapeHtml(card.value)}</strong>
      ${card.note ? `<p>${escapeHtml(card.note)}</p>` : ""}
    </article>
  `).join("");
}

function renderOperations() {
  const executions = state.data?.executions || [];
  renderList(lists.operations, executions.slice(0, 8), (item) => `
    <article class="item">
      <div class="item-header">
        <h2 class="item-title">${escapeHtml(commandTemplateLabel(item.template))}</h2>
        <span class="badge ${item.exitCode === 0 ? "done" : "failed"}">${escapeHtml(String(item.exitCode))}</span>
      </div>
      <div class="meta-row">
        <span class="type-pill shared">Read-only</span>
        <span class="item-meta">${formatTime(item.finishedAt || item.createdAt)}</span>
      </div>
      ${(item.commands || []).length ? `
        <details class="command-details">
          <summary>Show exact command${item.commands.length === 1 ? "" : "s"}</summary>
          <pre class="item-body">${escapeHtml(item.commands.join("\n"))}</pre>
        </details>
      ` : ""}
      ${item.stdout ? `<pre class="item-body">${escapeHtml(item.stdout)}</pre>` : ""}
      ${item.stderr ? `<p class="approval-advice">${escapeHtml(item.stderr)}</p>` : ""}
    </article>
  `);
}

function renderSecurityChecklist() {
  if (!securityChecklist) return;

  const about = state.about || {};
  const checks = [
    {
      label: "Private route",
      ok: isPrivateRoute(),
      warn: false,
      note: isPrivateRoute() ? "This browser is using localhost or a Tailscale address." : "Open Latch through Tailscale before using it away from home."
    },
    {
      label: "Private HTTPS",
      ok: location.protocol === "https:" && location.hostname.toLowerCase().endsWith(".ts.net"),
      warn: Boolean(about.urls?.privateHttpsUrl),
      note: about.urls?.privateHttpsUrl || "Run Serve-Over-Tailscale.ps1 to enable the phone-friendly HTTPS route."
    },
    {
      label: "App lock",
      ok: isAppLockConfigured(),
      warn: false,
      note: isAppLockConfigured() ? appLockLabel() : "Set a local PIN, then add a passkey if the phone supports it."
    },
    {
      label: "Public exposure",
      ok: true,
      warn: false,
      note: "Latch uses Tailscale Serve/private IPs only. Do not enable Tailscale Funnel for this app."
    }
  ];

  securityChecklist.innerHTML = checks.map((check) => {
    const stateName = check.ok ? "ok" : check.warn ? "warn" : "bad";
    const mark = check.ok ? "OK" : check.warn ? "!" : "!";
    return `
      <article class="security-row ${stateName}">
        <span class="security-mark">${mark}</span>
        <div>
          <strong>${escapeHtml(check.label)}</strong>
          <p>${escapeHtml(check.note)}</p>
        </div>
      </article>
    `;
  }).join("");
}

function renderArchives() {
  const archives = state.data?.archives || {};
  const items = [
    ...(archives.messages || []).map((item) => ({ kind: "messages", label: item.author || "Message", title: item.text || item.id, archivedAt: item.archivedAt, id: item.id })),
    ...(archives.tasks || []).map((item) => ({ kind: "tasks", label: "Task", title: item.title || item.id, archivedAt: item.archivedAt, id: item.id })),
    ...(archives.approvals || []).map((item) => ({ kind: "approvals", label: "Approval", title: item.title || item.id, archivedAt: item.archivedAt, id: item.id })),
    ...(archives.contextItems || []).map((item) => ({ kind: "context", label: "Context", title: item.title || item.name || item.id, archivedAt: item.archivedAt, id: item.id }))
  ];

  renderList(lists.archives, items, (item) => `
    <article class="item">
      <div class="item-header">
        <h2 class="item-title">${escapeHtml(item.label)}</h2>
        <span class="item-meta">${formatTime(item.archivedAt)}</span>
      </div>
      <p class="item-body">${escapeHtml(String(item.title || "").slice(0, 280))}</p>
      <div class="approval-actions">
        <button class="secondary-button" data-unarchive-kind="${escapeHtml(item.kind)}" data-unarchive-id="${escapeHtml(item.id)}" type="button">Restore</button>
        <button class="danger-button" data-delete-kind="${escapeHtml(item.kind)}" data-delete-id="${escapeHtml(item.id)}" type="button">Delete</button>
      </div>
    </article>
  `);

  lists.archives.querySelectorAll("[data-unarchive-kind]").forEach((button) => {
    button.addEventListener("click", () => archiveItem(button.dataset.unarchiveKind, button.dataset.unarchiveId, false));
  });
  lists.archives.querySelectorAll("[data-delete-kind]").forEach((button) => {
    button.addEventListener("click", () => deleteItem(button.dataset.deleteKind, button.dataset.deleteId));
  });
}

function renderList(target, items, template) {
  if (!items.length) {
    target.innerHTML = document.querySelector("#emptyTemplate").innerHTML;
    return;
  }
  target.innerHTML = items.map(template).join("");
}

function bindArchiveButtons(target) {
  target.querySelectorAll("[data-archive-kind]").forEach((button) => {
    button.addEventListener("click", () => archiveItem(button.dataset.archiveKind, button.dataset.archiveId, true));
  });
}

async function archiveItem(kind, id, archived) {
  await api(`${collectionPath(kind)}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ archived })
  });
  await refresh();
}

async function deleteItem(kind, id) {
  if (!window.confirm("Delete this archived item permanently?")) return;
  await api(`${collectionPath(kind)}/${encodeURIComponent(id)}`, { method: "DELETE" });
  await refresh();
}

function collectionPath(kind) {
  const paths = {
    messages: "/api/messages",
    tasks: "/api/tasks",
    approvals: "/api/approvals",
    context: "/api/context"
  };
  return paths[kind] || "/api/messages";
}

async function createBackup() {
  try {
    const result = await api("/api/backups", { method: "POST", body: JSON.stringify({}) });
    setFormStatus(backupStatus, `Backup created: ${result.fileName}`, "success");
    await refresh();
  } catch (error) {
    setFormStatus(backupStatus, `Backup failed: ${error.message}`, "error");
  }
}

async function exportContext() {
  try {
    const response = await fetch("/api/context/export", {
      headers: { authorization: `Bearer ${state.token}` }
    });
    if (!response.ok) throw new Error(`Export failed: ${response.status}`);
    const blob = await response.blob();
    downloadBlob(blob, `latch-context-${new Date().toISOString().replaceAll(":", "-")}.json`);
    setFormStatus(backupStatus, "Context export downloaded.", "success");
  } catch (error) {
    setFormStatus(backupStatus, `Export failed: ${error.message}`, "error");
  }
}

function isPinConfigured() {
  return Boolean(localStorage.getItem("latchPinSalt") && localStorage.getItem("latchPinHash"));
}

function isPasskeyConfigured() {
  return Boolean(localStorage.getItem("latchPasskeyCredentialId"));
}

function isAppLockConfigured() {
  return isPinConfigured() || isPasskeyConfigured();
}

function isPasskeySupported() {
  return Boolean(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
}

function appLockLabel() {
  const parts = [];
  if (isPinConfigured()) parts.push("PIN");
  if (isPasskeyConfigured()) parts.push("passkey");
  return `${parts.join(" + ")} configured on this device.`;
}

function openPinDialog(mode) {
  pinMode = mode;
  const isSet = mode === "set";
  const passkeySupported = isPasskeySupported();
  const passkeyConfigured = isPasskeyConfigured();
  pinDialogEyebrow.textContent = isSet ? "Set PIN" : "App Lock";
  pinDialogTitle.textContent = isSet ? "Set App PIN" : "Unlock Latch";
  pinHelp.textContent = isSet
    ? "Set a local PIN for this device. You can add a passkey when Latch is opened over private HTTPS."
    : passkeyConfigured
      ? "Use your passkey or enter your local PIN to unlock this device."
      : "Enter your local PIN to unlock this device.";
  pinSubmitButton.textContent = isSet ? "Save PIN" : "Unlock";
  pinCancelButton.textContent = isSet ? "Cancel" : "Use Operator Key";
  if (passkeyButton) {
    passkeyButton.textContent = passkeyConfigured ? "Use Passkey" : "Add Passkey";
    passkeyButton.classList.toggle("hidden", !passkeySupported || (!passkeyConfigured && !state.token));
  }
  pinConfirmLabel.classList.toggle("hidden", !isSet);
  pinConfirmInput.classList.toggle("hidden", !isSet);
  pinInput.value = "";
  pinConfirmInput.value = "";
  setFormStatus(pinStatus, "", "");
  pinDialog.classList.remove("hidden");
  pinInput.focus();
}

async function handlePasskeyButton() {
  try {
    if (isPasskeyConfigured()) {
      await unlockWithPasskey();
      return;
    }
    await createPasskey();
  } catch (error) {
    setFormStatus(pinStatus, `Passkey failed: ${error.message}`, "error");
  }
}

function closePinDialog() {
  pinDialog.classList.add("hidden");
  pinInput.value = "";
  pinConfirmInput.value = "";
}

async function submitPin(event) {
  event.preventDefault();
  const pin = pinInput.value.trim();
  if (pin.length < 4) {
    setFormStatus(pinStatus, "Use at least 4 digits.", "error");
    return;
  }

  try {
    if (pinMode === "set") {
      const confirmation = pinConfirmInput.value.trim();
      if (pin !== confirmation) {
        setFormStatus(pinStatus, "PINs do not match.", "error");
        return;
      }
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const hash = await hashPin(pin, salt);
      localStorage.setItem("latchPinSalt", bytesToBase64(salt));
      localStorage.setItem("latchPinHash", bytesToBase64(hash));
      localStorage.setItem("latchPinIterations", "150000");
      state.pinUnlocked = true;
      closePinDialog();
      await refresh();
      return;
    }

    if (!isPinConfigured()) {
      setFormStatus(pinStatus, "PIN is not configured on this device.", "error");
      return;
    }
    const salt = base64ToBytes(localStorage.getItem("latchPinSalt") || "");
    const expected = localStorage.getItem("latchPinHash") || "";
    const hash = await hashPin(pin, salt);
    if (bytesToBase64(hash) !== expected) {
      setFormStatus(pinStatus, "Wrong PIN.", "error");
      return;
    }
    state.pinUnlocked = true;
    closePinDialog();
    await boot();
  } catch (error) {
    setFormStatus(pinStatus, `PIN failed: ${error.message}`, "error");
  }
}

async function createPasskey() {
  if (!isPasskeySupported()) {
    throw new Error("Open Latch over private HTTPS to use passkeys.");
  }
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: "Latch" },
      user: {
        id: userId,
        name: "Latch operator",
        displayName: "Latch operator"
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 }
      ],
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required"
      },
      timeout: 60000,
      attestation: "none"
    }
  });

  if (!credential?.rawId) {
    throw new Error("No passkey was created.");
  }
  localStorage.setItem("latchPasskeyCredentialId", bytesToBase64Url(new Uint8Array(credential.rawId)));
  localStorage.setItem("latchPasskeyUserId", bytesToBase64Url(userId));
  state.pinUnlocked = true;
  closePinDialog();
  await refresh();
}

async function unlockWithPasskey() {
  if (!isPasskeySupported()) {
    throw new Error("Open Latch over private HTTPS to use passkeys.");
  }
  const credentialId = base64UrlToBytes(localStorage.getItem("latchPasskeyCredentialId") || "");
  if (!credentialId.length) {
    throw new Error("No passkey is configured.");
  }

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: "public-key", id: credentialId }],
      userVerification: "required",
      timeout: 60000
    }
  });

  if (!assertion?.rawId) {
    throw new Error("Passkey unlock was cancelled.");
  }
  state.pinUnlocked = true;
  closePinDialog();
  await boot();
}

async function hashPin(pin, salt) {
  const iterations = Number(localStorage.getItem("latchPinIterations") || "150000");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

function bytesToBase64(bytes) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlToBytes(value) {
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`
    .replaceAll("-", "+")
    .replaceAll("_", "/");
  return base64ToBytes(padded);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function markConnection(isOnline) {
  connectionDot.classList.toggle("online", isOnline);
  connectionDot.classList.toggle("offline", !isOnline);
  connectionText.textContent = isOnline ? "Online" : "Offline";
}

function formatTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "numeric"
  }).format(new Date(value));
}

function formatBytes(value) {
  const number = Number(value) || 0;
  if (number < 1024) return `${number} B`;
  if (number < 1024 * 1024) return `${Math.round(number / 1024)} KB`;
  return `${(number / 1024 / 1024).toFixed(1)} MB`;
}

function formatContextCategory(value) {
  const labels = {
    goals: "Goals",
    personality: "Personality",
    security: "Security",
    project: "Project",
    memory: "Memory",
    reference: "Reference",
    other: "Other"
  };
  return labels[value] || "Memory";
}

function tagsFromInput(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
}

async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function setFormStatus(target, message, type = "") {
  if (!target) return;
  target.textContent = message;
  target.classList.toggle("success", type === "success");
  target.classList.toggle("error", type === "error");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
