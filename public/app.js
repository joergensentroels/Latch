const initialTab = new URLSearchParams(location.search).get("tab");

const state = {
  token: localStorage.getItem("latchOperatorToken") || localStorage.getItem("commandCenterToken") || "",
  tab: ["inbox", "tasks", "approvals", "timeline"].includes(initialTab) ? initialTab : "inbox",
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
const messageForm = document.querySelector("#messageForm");
const messageText = document.querySelector("#messageText");
const taskForm = document.querySelector("#taskForm");
const taskTitle = document.querySelector("#taskTitle");
const taskDetails = document.querySelector("#taskDetails");
const taskPriority = document.querySelector("#taskPriority");
const refreshButton = document.querySelector("#refreshButton");
const lockButton = document.querySelector("#lockButton");
const installButton = document.querySelector("#installButton");
const notifyButton = document.querySelector("#notifyButton");
const installHint = document.querySelector("#installHint");
const dismissInstallHint = document.querySelector("#dismissInstallHint");
const connectionDot = document.querySelector("#connectionDot");
const connectionText = document.querySelector("#connectionText");
const pendingSummary = document.querySelector("#pendingSummary");
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
  events: document.querySelector("#eventsList")
};
const diagnosticsGrid = document.querySelector("#diagnosticsGrid");

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  state.token = tokenInput.value.trim();
  localStorage.setItem("latchOperatorToken", state.token);
  localStorage.removeItem("commandCenterToken");
  await boot();
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

refreshButton.addEventListener("click", refresh);
notifyButton.addEventListener("click", enableNotifications);
installButton.addEventListener("click", async () => {
  if (!state.deferredInstallPrompt) return;
  state.deferredInstallPrompt.prompt();
  await state.deferredInstallPrompt.userChoice;
  state.deferredInstallPrompt = null;
  installButton.classList.add("hidden");
});

dismissInstallHint.addEventListener("click", () => {
  localStorage.setItem("latchInstallHintDismissed", "1");
  localStorage.removeItem("commandCenterInstallHintDismissed");
  installHint.classList.add("hidden");
});

approvalDialogClose.addEventListener("click", closeApprovalDialog);
approvalDecisionCancel.addEventListener("click", closeApprovalDialog);
approvalDialog.addEventListener("click", (event) => {
  if (event.target === approvalDialog) closeApprovalDialog();
});
approvalDecisionForm.addEventListener("submit", submitApprovalDecision);

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
}

async function refresh() {
  try {
    const [appState, llmConfig] = await Promise.all([
      api("/api/state"),
      api("/api/llm/config")
    ]);
    state.data = appState;
    state.llmConfig = llmConfig;
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
  renderNotificationButton();
  renderInstallHint();
  maybeNotify();
  renderMessages();
  renderTasks();
  renderApprovals();
  renderDiagnostics();
  renderEvents();
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

function renderInstallHint() {
  const dismissed = localStorage.getItem("latchInstallHintDismissed") === "1" || localStorage.getItem("commandCenterInstallHintDismissed") === "1";
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  installHint.classList.toggle("hidden", dismissed || standalone);
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
        body: item.type === "human_verification" ? "Human help is needed. Open Latch to review." : "Approval requested. Open Latch to review.",
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
    </article>
  `);
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
    </article>
  `);
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
    <article class="item ${approval.type === "human_verification" ? "human-request" : ""}">
      <div class="item-header">
        <h2 class="item-title">${escapeHtml(approval.title)}</h2>
        <span class="badge ${escapeHtml(approval.status)}">${escapeHtml(approval.status)}</span>
      </div>
      <div class="meta-row">
        <span class="type-pill ${escapeHtml(approval.type || "other")}">${formatApprovalType(approval.type)}</span>
        ${approval.sensitive ? `<span class="type-pill sensitive">Sensitive</span>` : ""}
        <span class="item-meta">Requested by ${escapeHtml(approval.requestedBy || "agent")}</span>
      </div>
      <p class="item-body">${escapeHtml(approval.details)}</p>
      ${approval.expectedResponse ? `<p class="help-note"><strong>Return to agent:</strong> ${escapeHtml(approval.expectedResponse)}</p>` : ""}
      ${approval.command ? `<pre class="item-body">${escapeHtml(approval.command)}</pre>` : ""}
      ${approval.responseNote ? `<p class="help-note"><strong>Operator note:</strong> ${escapeHtml(approval.responseNote)}</p>` : ""}
      ${approval.status === "pending" ? `
        <div class="approval-actions">
          <button class="secondary-button" data-approval="${approval.id}" data-status="approved">${approval.type === "human_verification" ? "Mark done" : "Approve"}</button>
          <button class="danger-button" data-approval="${approval.id}" data-status="denied">${approval.type === "human_verification" ? "Cannot help" : "Deny"}</button>
        </div>
      ` : ""}
    </article>
  `);

  lists.approvals.querySelectorAll("[data-approval]").forEach((button) => {
    button.addEventListener("click", async () => {
      openApprovalDialog(button.dataset.approval, button.dataset.status);
    });
  });
}

function openApprovalDialog(approvalId, status) {
  const approval = (state.data?.approvals || []).find((item) => item.id === approvalId);
  if (!approval) return;

  state.approvalDecision = { approval, status };
  const isApproved = status === "approved";
  approvalDialogEyebrow.textContent = formatApprovalType(approval.type);
  approvalDialogTitle.textContent = isApproved
    ? (approval.type === "human_verification" ? "Mark Done" : "Approve Request")
    : (approval.type === "human_verification" ? "Cannot Help" : "Deny Request");
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
  if (approval.type === "human_verification") return "Verification completed, or short result";
  if (approval.type === "credential") return "Minimum non-secret result, never a password";
  if (approval.type === "command") return "Reviewed scope or manual result";
  if (approval.type === "purchase") return "Budget/vendor check or manual purchase result";
  return "Decision note";
}

function formatApprovalType(value) {
  const labels = {
    command: "Command",
    human_verification: "Human verification",
    account_setup: "Account setup",
    purchase: "Purchase",
    credential: "Credential",
    other: "Other"
  };
  return labels[value] || "Other";
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
  const latestAgentMessage = messages.find((message) => message.direction === "agent_to_operator");
  const openTasks = tasks.filter((item) => ["queued", "running", "waiting"].includes(item.status)).length;
  const pendingApprovals = approvals.filter((item) => item.status === "pending").length;
  const llmReady = Boolean(state.llmConfig?.enabled);

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

function renderList(target, items, template) {
  if (!items.length) {
    target.innerHTML = document.querySelector("#emptyTemplate").innerHTML;
    return;
  }
  target.innerHTML = items.map(template).join("");
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

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
