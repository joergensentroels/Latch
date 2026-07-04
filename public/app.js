const tabs = ["inbox", "tasks", "approvals", "context", "timeline", "settings"];
const simpleTabs = ["inbox", "tasks", "approvals", "context", "credits", "settings"];
const proTabs = ["inbox", "tasks", "approvals", "context", "timeline", "settings", "credits"];
const initialParams = new URLSearchParams(location.search);
const initialTab = normalizeTab(initialParams.get("tab"));
const initialApprovalId = cleanRouteId(initialParams.get("approval") || initialParams.get("approvalId") || "");
const savedTaskFilter = normalizeListFilter(localStorage.getItem("latchTaskFilter"), ["open", "all"], "open");
const savedApprovalsFilter = normalizeListFilter(localStorage.getItem("latchApprovalsFilter"), ["pending", "all"], "pending");
const maxContextUploadBytes = 2_000_000;
const fallbackChannels = [
  { id: "compass", label: "Companion", description: "Direct chat with Compass Companion", builtIn: true },
  { id: "general", label: "General", description: "Loose notes", builtIn: true },
  { id: "operations", label: "Operations", description: "Status and diagnostics", builtIn: true },
  { id: "research", label: "Research", description: "Source notes", builtIn: true }
];

const state = {
  token: localStorage.getItem("latchUserToken") || localStorage.getItem("latchOperatorToken") || localStorage.getItem("commandCenterToken") || "",
  authMode: localStorage.getItem("latchAuthMode") || (localStorage.getItem("latchUserToken") ? "user" : "operator"),
  proMode: localStorage.getItem("latchProMode") === "true",
  tab: proTabs.includes(initialTab) ? initialTab : "inbox",
  activeChannel: localStorage.getItem("latchActiveChannel") || "compass",
  channelRailWidth: Number(localStorage.getItem("latchChannelRailWidth") || 260),
  showArchivedChannels: localStorage.getItem("latchShowArchivedChannels") === "true",
  data: null,
  taskFilter: savedTaskFilter,
  taskFilterPreference: savedTaskFilter,
  approvalsFilter: savedApprovalsFilter,
  approvalsFilterPreference: savedApprovalsFilter,
  seenNotificationIds: new Set(JSON.parse(localStorage.getItem("latchSeenNotificationIds") || "[]")),
  disclosureState: JSON.parse(localStorage.getItem("latchDisclosureState") || "{}"),
  notificationBaselineReady: false,
  filterDefaultsInitialized: false,
  deferredInstallPrompt: null,
  approvalDecision: null,
  highlightedApprovalId: initialApprovalId,
  pendingApprovalScroll: Boolean(initialApprovalId),
  contextView: null,
  reopenDrafts: {},
  forceMessageScrollBottom: false,
  doctor: null
};

const loginView = document.querySelector("#loginView");
const mainView = document.querySelector("#mainView");
const loginForm = document.querySelector("#loginForm");
const devUserButton = document.querySelector("#devUserButton");
const tokenInput = document.querySelector("#tokenInput");
const loginStatus = document.querySelector("#loginStatus");
const toggleTokenVisibility = document.querySelector("#toggleTokenVisibility");
const messageForm = document.querySelector("#messageForm");
const messageText = document.querySelector("#messageText");
const messageRouting = document.querySelector("#messageRouting");
const chatShell = document.querySelector(".chat-shell");
const channelList = document.querySelector("#channelList");
const channelResizer = document.querySelector("#channelResizer");
const channelForm = document.querySelector("#channelForm");
const channelName = document.querySelector("#channelName");
const channelDescription = document.querySelector("#channelDescription");
const showArchivedChannels = document.querySelector("#showArchivedChannels");
const chatEyebrow = document.querySelector("#chatEyebrow");
const chatTitle = document.querySelector("#chatTitle");
const chatCount = document.querySelector("#chatCount");
const taskForm = document.querySelector("#taskForm");
const taskBriefEyebrow = document.querySelector("#taskBriefEyebrow");
const taskTitleLabel = document.querySelector("#taskTitleLabel");
const taskTitle = document.querySelector("#taskTitle");
const taskDetails = document.querySelector("#taskDetails");
const taskInstructionDetails = document.querySelector("#taskInstructionDetails");
const taskAutonomyDetails = document.querySelector("#taskAutonomyDetails");
const subGoalRows = document.querySelector("#subGoalRows");
const addSubGoalButton = document.querySelector("#addSubGoalButton");
const taskPriority = document.querySelector("#taskPriority");
const taskRouting = document.querySelector("#taskRouting");
const contactDraftForm = document.querySelector("#contactDraftForm");
const contactRecipient = document.querySelector("#contactRecipient");
const contactSubject = document.querySelector("#contactSubject");
const contactPurpose = document.querySelector("#contactPurpose");
const contactBody = document.querySelector("#contactBody");
const contactAttachments = document.querySelector("#contactAttachments");
const contactDraftStatus = document.querySelector("#contactDraftStatus");
const profileForm = document.querySelector("#profileForm");
const profileName = document.querySelector("#profileName");
const profilePurpose = document.querySelector("#profilePurpose");
const profileGoals = document.querySelector("#profileGoals");
const profileBoundaries = document.querySelector("#profileBoundaries");
const profileCommunicationStyle = document.querySelector("#profileCommunicationStyle");
const profileAnchorPurpose = document.querySelector("#profileAnchorPurpose");
const profileAnchorGovernance = document.querySelector("#profileAnchorGovernance");
const profileStatus = document.querySelector("#profileStatus");
const contextMainSection = document.querySelector("#contextMainSection");
const profileSection = document.querySelector("#profileSection");
const contextViewButtons = document.querySelectorAll("[data-context-view]");
const contextNoteForm = document.querySelector("#contextNoteForm");
const contextTitle = document.querySelector("#contextTitle");
const contextCategory = document.querySelector("#contextCategory");
const contextTags = document.querySelector("#contextTags");
const contextText = document.querySelector("#contextText");
const contextShare = document.querySelector("#contextShare");
const contextNetworkShare = document.querySelector("#contextNetworkShare");
const contextNoteStatus = document.querySelector("#contextNoteStatus");
const contextFileForm = document.querySelector("#contextFileForm");
const contextFileInput = document.querySelector("#contextFileInput");
const contextFileCategory = document.querySelector("#contextFileCategory");
const contextFileTags = document.querySelector("#contextFileTags");
const contextFileShare = document.querySelector("#contextFileShare");
const contextFileNetworkShare = document.querySelector("#contextFileNetworkShare");
const contextFileStatus = document.querySelector("#contextFileStatus");
const networkInviteForm = document.querySelector("#networkInviteForm");
const networkWorkerName = document.querySelector("#networkWorkerName");
const networkWorkerBackend = document.querySelector("#networkWorkerBackend");
const networkWorkerModels = document.querySelector("#networkWorkerModels");
const networkInviteStatus = document.querySelector("#networkInviteStatus");
const autonomyForm = document.querySelector("#autonomyForm");
const autonomyMode = document.querySelector("#autonomyMode");
const autonomySummary = document.querySelector("#autonomySummary");
const autonomyStatus = document.querySelector("#autonomyStatus");
const autonomyStepBudget = document.querySelector("#autonomyStepBudget");
const agentEmailForm = document.querySelector("#agentEmailForm");
const emailReplyCap = document.querySelector("#emailReplyCap");
const emailReplyCapSummary = document.querySelector("#emailReplyCapSummary");
const emailReplyCapStatus = document.querySelector("#emailReplyCapStatus");
const refreshButton = document.querySelector("#refreshButton");
const lockButton = document.querySelector("#lockButton");
const appLockButton = document.querySelector("#appLockButton");
const proModeButton = document.querySelector("#proModeButton");
const installButton = document.querySelector("#installButton");
const notifyButton = document.querySelector("#notifyButton");
const doctorRunButton = document.querySelector("#doctorRunButton");
const doctorStatus = document.querySelector("#doctorStatus");
const backupButton = document.querySelector("#backupButton");
const exportContextButton = document.querySelector("#exportContextButton");
const backupStatus = document.querySelector("#backupStatus");
const connectionDot = document.querySelector("#connectionDot");
const connectionText = document.querySelector("#connectionText");
const pendingSummary = document.querySelector("#pendingSummary");
const creditSummary = document.querySelector("#creditSummary");
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
const approvalGrantScope = document.querySelector("#approvalGrantScope");
const approvalGrantLabel = document.querySelector("#approvalGrantLabel");
const approvalDecisionSubmit = document.querySelector("#approvalDecisionSubmit");
const approvalDialogClose = document.querySelector("#approvalDialogClose");
const approvalDecisionCancel = document.querySelector("#approvalDecisionCancel");
const taskFilterButtons = document.querySelectorAll("[data-task-filter]");
const approvalFilterButtons = document.querySelectorAll("[data-approval-filter]");
const moreTabsButton = document.querySelector("#moreTabsButton");
const tabsMoreMenu = document.querySelector("#tabsMoreMenu");

const lists = {
  messages: document.querySelector("#messagesList"),
  tasks: document.querySelector("#tasksList"),
  approvals: document.querySelector("#approvalsList"),
  context: document.querySelector("#contextList"),
  operations: document.querySelector("#operationsList"),
  doctor: document.querySelector("#doctorGrid"),
  network: document.querySelector("#networkList"),
  archives: document.querySelector("#archivesList"),
  events: document.querySelector("#eventsList")
};
const diagnosticsGrid = document.querySelector("#diagnosticsGrid");
const networkGrid = document.querySelector("#networkGrid");
const mcpServerList = document.querySelector("#mcpServerList");
const mcpRefreshButton = document.querySelector("#mcpRefreshButton");
const mcpStatus = document.querySelector("#mcpStatus");
const scheduleForm = document.querySelector("#scheduleForm");
const scheduleCadenceType = document.querySelector("#scheduleCadenceType");
const scheduleEveryMinutes = document.querySelector("#scheduleEveryMinutes");
const scheduleAtTime = document.querySelector("#scheduleAtTime");
const scheduleDayOfWeek = document.querySelector("#scheduleDayOfWeek");
const scheduleList = document.querySelector("#scheduleList");
const scheduleStatus = document.querySelector("#scheduleStatus");
const grantList = document.querySelector("#grantList");
const capabilityGrid = document.querySelector("#capabilityGrid");
const userTierList = document.querySelector("#userTierList");
const securityChecklist = document.querySelector("#securityChecklist");
const testConsoleStatus = document.querySelector("#testConsoleStatus");
const testActionButtons = document.querySelectorAll("[data-test-action]");
const creditsGrid = document.querySelector("#creditsGrid");
const creditsList = document.querySelector("#creditsList");
const purchaseForm = document.querySelector("#purchaseForm");
const purchaseCredits = document.querySelector("#purchaseCredits");
const purchaseNote = document.querySelector("#purchaseNote");
const purchaseStatus = document.querySelector("#purchaseStatus");
const simpleSettingsSummary = document.querySelector("#simpleSettingsSummary");
let pinMode = "unlock";

const contextAutoResizeTextareas = [
  contextText,
  profilePurpose,
  profileGoals,
  profileBoundaries,
  profileCommunicationStyle
].filter(Boolean);

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  state.token = tokenInput.value.trim();
  state.authMode = "operator";
  setFormStatus(loginStatus, "Unlocking...", "");
  localStorage.setItem("latchOperatorToken", state.token);
  localStorage.setItem("latchAuthMode", "operator");
  localStorage.removeItem("latchUserToken");
  localStorage.removeItem("commandCenterToken");
  try {
    await boot();
    setFormStatus(loginStatus, "", "");
  } catch (error) {
    localStorage.removeItem("latchOperatorToken");
    localStorage.removeItem("commandCenterToken");
    state.token = "";
    tokenInput.value = "";
    showLogin();
    setFormStatus(loginStatus, loginErrorMessage(error), "error");
  }
});

devUserButton?.addEventListener("click", async () => {
  devUserButton.disabled = true;
  setFormStatus(loginStatus, "Starting local user session...", "");
  try {
    const result = await fetchJson("/api/me/session/dev", {
      method: "POST",
      body: JSON.stringify({
        displayName: "Compass user",
        email: "local-user@compass.local"
      })
    });
    state.token = result.token;
    state.authMode = "user";
    state.proMode = false;
    localStorage.setItem("latchUserToken", state.token);
    localStorage.setItem("latchAuthMode", "user");
    localStorage.setItem("latchProMode", "false");
    localStorage.removeItem("latchOperatorToken");
    localStorage.removeItem("commandCenterToken");
    await boot();
    setFormStatus(loginStatus, "", "");
  } catch (error) {
    setFormStatus(loginStatus, `Local user login failed: ${error.message}`, "error");
  } finally {
    devUserButton.disabled = false;
  }
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
    const routingPreference = isProMode() ? (messageRouting.value || "auto") : "auto";
    const active = activeChannel();
    await api(state.authMode === "user" ? "/api/me/messages" : "/api/messages", {
      method: "POST",
      body: JSON.stringify({
        text,
        channel: active.id,
        routingPreference,
        allowNetwork: routingPreference !== "local"
      })
    });
    messageText.value = "";
    resizeMessageText();
    messageRouting.value = "auto";
    state.forceMessageScrollBottom = true;
    await refresh();
  });
});

messageText.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;

  event.preventDefault();
  messageForm.requestSubmit();
});

messageText.addEventListener("input", resizeMessageText);
resizeMessageText();
contextAutoResizeTextareas.forEach((textarea) => {
  textarea.addEventListener("input", () => resizeTextareaToContent(textarea));
});
resizeContextTextareas();

channelForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  // The create-channel form is tucked behind the "+". The first "+" click reveals the inputs
  // and focuses the name; it only creates once the inputs are open and a name is entered.
  if (!channelForm.classList.contains("open")) {
    channelForm.classList.add("open");
    channelName.focus();
    return;
  }
  const label = channelName.value.trim();
  if (!label) return;

  await withSubmitLock(channelForm, async () => {
    const channel = await api("/api/channels", {
      method: "POST",
      body: JSON.stringify({
        label,
        description: channelDescription.value.trim() || "Custom conversation"
      })
    });
    channelName.value = "";
    channelDescription.value = "";
    channelForm.classList.remove("open");
    state.activeChannel = channel.id;
    localStorage.setItem("latchActiveChannel", state.activeChannel);
    await refresh();
  });
});

// Escape collapses the create-channel form back behind the "+".
channelForm.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    channelForm.classList.remove("open");
    channelName.blur();
    channelDescription.blur();
  }
});

showArchivedChannels?.addEventListener("change", () => {
  state.showArchivedChannels = showArchivedChannels.checked;
  localStorage.setItem("latchShowArchivedChannels", String(state.showArchivedChannels));
  renderChannels();
  renderMessages();
});

taskForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const goal = taskTitle.value.trim();
  const instructions = taskDetails.value.trim();
  if (!goal) {
    taskTitle.focus();
    return;
  }

  await withSubmitLock(taskForm, async () => {
    const routingPreference = isProMode() ? (taskRouting.value || "auto") : "auto";
    const subGoals = isProMode() ? collectSubGoals() : [];
    const task = await api(state.authMode === "user" ? "/api/me/tasks" : "/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: titleFromBrief(goal),
        goal,
        instructions,
        details: composeTaskDetails(goal, instructions),
        priority: taskPriority.value,
        routingPreference,
        allowNetwork: routingPreference !== "local",
        subGoals
      })
    });
    taskTitle.value = "";
    taskDetails.value = "";
    taskInstructionDetails.open = false;
    if (subGoalRows) subGoalRows.innerHTML = "";
    if (taskAutonomyDetails) taskAutonomyDetails.open = false;
    taskPriority.value = "normal";
    taskRouting.value = "auto";
    if (task.channel && isProMode()) {
      state.activeChannel = task.channel;
      localStorage.setItem("latchActiveChannel", state.activeChannel);
      state.tab = "inbox";
      updateRoute();
    }
    await refresh();
  });
});

function currentDefaultDepth() {
  return Number(state.data?.autonomy?.defaultStepBudget ?? state.about?.autonomy?.defaultStepBudget ?? 5) || 5;
}

function addSubGoalRow(text = "", depth) {
  if (!subGoalRows) return;
  const value = depth || currentDefaultDepth();
  const row = document.createElement("div");
  row.className = "subgoal-row";
  row.innerHTML = `
    <input type="text" class="subgoal-text" maxlength="500" placeholder="Sub-goal (e.g. Research 3 competitors)">
    <input type="number" class="subgoal-depth" min="1" max="50" step="1" title="Max steps before check-in" aria-label="Depth">
    <button type="button" class="subgoal-remove icon-button compact-icon" title="Remove" aria-label="Remove sub-goal">&times;</button>
  `;
  row.querySelector(".subgoal-text").value = text;
  row.querySelector(".subgoal-depth").value = value;
  subGoalRows.appendChild(row);
}

function collectSubGoals() {
  if (!subGoalRows) return [];
  return [...subGoalRows.querySelectorAll(".subgoal-row")]
    .map((row) => ({
      text: row.querySelector(".subgoal-text")?.value.trim() || "",
      depth: Number(row.querySelector(".subgoal-depth")?.value) || currentDefaultDepth()
    }))
    .filter((item) => item.text);
}

addSubGoalButton?.addEventListener("click", () => addSubGoalRow());
subGoalRows?.addEventListener("click", (event) => {
  const remove = event.target.closest(".subgoal-remove");
  if (remove) remove.closest(".subgoal-row")?.remove();
});
// Seed one row the first time the section is opened, so the default depth is visible.
taskAutonomyDetails?.addEventListener("toggle", () => {
  if (taskAutonomyDetails.open && subGoalRows && !subGoalRows.children.length) addSubGoalRow();
});

contactDraftForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const recipient = contactRecipient.value.trim();
  const subject = contactSubject.value.trim();
  const purpose = contactPurpose.value.trim();
  const body = contactBody.value.trim();
  if (!recipient || !subject || !body) {
    setFormStatus(contactDraftStatus, "Recipient, subject, and draft body are required.", "error");
    return;
  }

  try {
    await withSubmitLock(contactDraftForm, async () => {
      await api("/api/approvals", {
        method: "POST",
        body: JSON.stringify({
          type: "external_contact",
          title: subject,
          details: purpose || "Operator-created contact draft.",
          recipient,
          subject,
          contactPurpose: purpose,
          bodyPreview: body,
          attachments: tagsFromInput(contactAttachments.value),
          sendMode: "manual",
          riskLevel: "medium",
          sensitive: true,
          expectedResponse: "Review the draft, send manually if appropriate, or return edits."
        })
      });
      contactRecipient.value = "";
      contactSubject.value = "";
      contactPurpose.value = "";
      contactBody.value = "";
      contactAttachments.value = "";
      setFormStatus(contactDraftStatus, "Draft approval created.", "success");
      await refresh();
    });
  } catch (error) {
    setFormStatus(contactDraftStatus, `Could not create draft: ${error.message}`, "error");
  }
});

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await withSubmitLock(profileForm, async () => {
    const profilePayload = currentProfilePayload();
    await api("/api/profile", {
      method: "PATCH",
      body: JSON.stringify(profilePayload)
    });
    if (isProfileComplete(profilePayload)) state.contextView = "context";
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
      await api(contextApiPath("/notes"), {
        method: "POST",
        body: JSON.stringify({
          title,
          text,
          category: contextCategory.value,
          tags: tagsFromInput(contextTags.value),
          shareWithAgent: contextShare.checked,
          shareWithNetwork: isProMode() && contextNetworkShare.checked
        })
      });
      contextTitle.value = "";
      contextTags.value = "";
      contextText.value = "";
      resizeTextareaToContent(contextText);
      contextShare.checked = true;
      contextNetworkShare.checked = false;
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
      await api(contextApiPath("/files"), {
        method: "POST",
        body: JSON.stringify({
          name: file.name,
          type: file.type || "application/octet-stream",
          size: file.size,
          category: contextFileCategory.value,
          tags: tagsFromInput(contextFileTags.value),
          shareWithAgent: contextFileShare.checked,
          shareWithNetwork: isProMode() && contextFileNetworkShare.checked,
          contentBase64
        })
      });
      contextFileInput.value = "";
      contextFileTags.value = "";
      contextFileShare.checked = false;
      contextFileNetworkShare.checked = false;
      setFormStatus(contextFileStatus, "Uploaded to Context.", "success");
      await refresh();
    });
  } catch (error) {
    setFormStatus(contextFileStatus, `Could not upload: ${error.message}`, "error");
  }
});

refreshButton.addEventListener("click", refresh);
notifyButton.addEventListener("click", enableNotifications);
doctorRunButton?.addEventListener("click", runDoctor);
proModeButton?.addEventListener("click", () => {
  if (state.authMode !== "operator") return;
  state.proMode = !state.proMode;
  localStorage.setItem("latchProMode", String(state.proMode));
  render();
});
backupButton.addEventListener("click", createBackup);
exportContextButton.addEventListener("click", exportContext);
networkInviteForm?.addEventListener("submit", createNetworkInvite);
purchaseForm?.addEventListener("submit", createPurchaseRequest);
autonomyForm?.addEventListener("submit", (event) => event.preventDefault());
autonomyMode?.addEventListener("change", updateAutonomyPolicy);
autonomyStepBudget?.addEventListener("change", updateAutonomyStepBudget);
agentEmailForm?.addEventListener("submit", (event) => event.preventDefault());
emailReplyCap?.addEventListener("change", updateAgentEmailPolicy);
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
    localStorage.removeItem("latchUserToken");
    localStorage.removeItem("latchAuthMode");
    state.token = "";
    closePinDialog();
    showLogin();
    return;
  }
  closePinDialog();
});

lockButton.addEventListener("click", () => {
  localStorage.removeItem("latchOperatorToken");
  localStorage.removeItem("latchUserToken");
  localStorage.removeItem("commandCenterToken");
  localStorage.removeItem("latchAuthMode");
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
  if (!button.dataset.tab) return;
  button.addEventListener("click", () => {
    if (!visibleTabs().includes(button.dataset.tab)) return;
    openTab(button.dataset.tab);
  });
});

moreTabsButton?.addEventListener("click", () => {
  const open = tabsMoreMenu?.classList.toggle("hidden") === false;
  moreTabsButton.setAttribute("aria-expanded", String(open));
});

document.addEventListener("click", (event) => {
  if (!tabsMoreMenu || tabsMoreMenu.classList.contains("hidden")) return;
  if (tabsMoreMenu.contains(event.target) || moreTabsButton?.contains(event.target)) return;
  closeMoreTabs();
});

contextViewButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.contextView = button.dataset.contextView;
    renderContextView();
  });
});

testActionButtons.forEach((button) => {
  button.addEventListener("click", () => runTestAction(button.dataset.testAction));
});

approvalFilterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const filter = normalizeListFilter(button.dataset.approvalFilter, ["pending", "all"], state.approvalsFilterPreference);
    state.approvalsFilter = filter;
    state.approvalsFilterPreference = filter;
    localStorage.setItem("latchApprovalsFilter", filter);
    renderApprovals();
  });
});

taskFilterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const filter = normalizeListFilter(button.dataset.taskFilter, ["open", "all"], state.taskFilterPreference);
    state.taskFilter = filter;
    state.taskFilterPreference = filter;
    localStorage.setItem("latchTaskFilter", filter);
    renderTasks();
  });
});

setupChannelRailResize();
boot();
setInterval(() => {
  if (state.token && !mainView.classList.contains("hidden") && !isEditingReopenDraft()) refresh();
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
  } catch (error) {
    markConnection(false);
    showLogin();
    throw error;
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

function setupChannelRailResize() {
  if (!chatShell || !channelResizer) return;
  applyChannelRailWidth(state.channelRailWidth);
  let dragStartX = 0;
  let dragStartWidth = 0;
  let dragging = false;

  channelResizer.addEventListener("pointerdown", (event) => {
    if (!isProMode()) return;
    dragging = true;
    dragStartX = event.clientX;
    dragStartWidth = state.channelRailWidth;
    channelResizer.setPointerCapture?.(event.pointerId);
    document.body.classList.add("resizing-channels");
    event.preventDefault();
  });

  channelResizer.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    applyChannelRailWidth(dragStartWidth + event.clientX - dragStartX);
  });

  const finishDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    channelResizer.releasePointerCapture?.(event.pointerId);
    document.body.classList.remove("resizing-channels");
    localStorage.setItem("latchChannelRailWidth", String(state.channelRailWidth));
  };
  channelResizer.addEventListener("pointerup", finishDrag);
  channelResizer.addEventListener("pointercancel", finishDrag);
}

function applyChannelRailWidth(value) {
  if (!chatShell) return;
  const width = Math.round(Math.max(210, Math.min(460, Number(value) || 260)));
  state.channelRailWidth = width;
  chatShell.style.setProperty("--channel-rail-width", `${width}px`);
}

async function refresh() {
  try {
    if (state.authMode === "user") {
      const [appState, me] = await Promise.all([
        api("/api/me/state"),
        api("/api/me")
      ]);
      state.data = appState;
      state.me = me;
      state.llmConfig = { enabled: true, model: "Auto" };
      state.about = {};
    } else {
      const [appState, llmConfig, about] = await Promise.all([
        api("/api/state"),
        api("/api/llm/config"),
        api("/api/about")
      ]);
      state.data = appState;
      state.llmConfig = llmConfig;
      state.about = about;
    }
    if (!state.filterDefaultsInitialized) {
      applyAttentionFilterDefaults();
      state.filterDefaultsInitialized = true;
    }
    markConnection(true);
    render();
  } catch (error) {
    markConnection(false);
    if (!state.data) throw error;
  }
}

async function api(path, options = {}) {
  return fetchJson(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${state.token}`,
      ...(options.headers || {})
    }
  });
}

async function fetchJson(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = body.message || body.error || "";
    } catch {
      detail = await response.text().catch(() => "");
    }
    throw new Error(detail ? `Request failed: ${response.status} ${detail}` : `Request failed: ${response.status}`);
  }
  return response.json();
}

function loginErrorMessage(error) {
  const message = String(error?.message || error || "");
  if (message.includes("401")) return "Operator key was rejected. Check the current key on the trusted host.";
  if (message.includes("Failed to fetch") || message.includes("NetworkError")) return "Compass could not reach Latch. Check that the server is running.";
  return `Unlock failed: ${message || "unknown error"}`;
}

async function withSubmitLock(form, callback) {
  if (form.dataset.submitting === "true") return;
  form.dataset.submitting = "true";
  const button = form.querySelector("button[type='submit']");
  button.disabled = true;
  try {
    await callback();
  } finally {
    delete form.dataset.submitting;
    button.disabled = false;
  }
}

function render() {
  renderExperienceMode();
  renderTabs();
  renderStatus();
  renderRouteWarning();
  renderNotificationButton();
  renderAppLockButton();
  maybeNotify();
  renderChannels();
  renderTaskComposerCopy();
  renderMessages();
  renderTasks();
  renderApprovals();
  renderProfile();
  renderContextView();
    renderContext();
    renderDiagnostics();
    renderDoctor();
    renderAutonomyPolicy();
    renderAgentEmailPolicy();
  renderNetwork();
  renderMcpServers();
  renderSchedules();
  renderGrants();
  renderCredits();
  renderSimpleSettings();
  renderCapabilities();
  renderUserTiers();
  renderOperations();
  renderSecurityChecklist();
  renderArchives();
  renderEvents();
}

function isProMode() {
  return state.authMode === "operator" && state.proMode;
}

function visibleTabs() {
  return isProMode() ? proTabs : simpleTabs;
}

function renderExperienceMode() {
  const pro = isProMode();
  document.body.classList.toggle("pro-mode", pro);
  document.body.classList.toggle("simple-mode", !pro);
  proModeButton?.classList.toggle("hidden", state.authMode !== "operator");
  proModeButton?.classList.toggle("active", pro);
  if (proModeButton) {
    proModeButton.title = pro ? "Switch to Simple Mode" : "Switch to Pro Mode";
    proModeButton.setAttribute("aria-label", proModeButton.title);
    proModeButton.textContent = pro ? "Simple Mode" : "Pro Mode";
  }
  messageRouting?.classList.toggle("hidden", !pro);
  taskRouting?.classList.toggle("hidden", !pro);
  if (!pro) {
    state.activeChannel = "compass";
  }
  if (!visibleTabs().includes(state.tab)) {
    state.tab = "inbox";
    updateRoute();
  }
}

function renderProfile() {
  const profile = state.data?.profile || {};
  if (profileForm.contains(document.activeElement)) return;

  profileName.value = profile.name || "";
  profilePurpose.value = profile.purpose || "";
  profileGoals.value = profile.goals || "";
  profileBoundaries.value = profile.boundaries || "";
  profileCommunicationStyle.value = profile.communicationStyle || "";
  resizeContextTextareas();
  if (profile.anchorPurpose || profile.foundationPurpose) profileAnchorPurpose.textContent = profile.anchorPurpose || profile.foundationPurpose;
  if (profile.anchorGovernance) profileAnchorGovernance.textContent = profile.anchorGovernance;
}

function currentProfilePayload() {
  return {
    name: profileName.value.trim(),
    purpose: profilePurpose.value.trim(),
    goals: profileGoals.value.trim(),
    boundaries: profileBoundaries.value.trim(),
    communicationStyle: profileCommunicationStyle.value.trim(),
    shareWithAgent: true
  };
}

function preferredContextView() {
  if (!isProMode()) return "context";
  return isProfileComplete(state.data?.profile || {}) ? "context" : "profile";
}

function isProfileComplete(profile = {}) {
  return ["name", "purpose", "goals", "boundaries", "communicationStyle"]
    .every((field) => String(profile[field] || "").trim());
}

function renderContextView() {
  const activeView = !isProMode() ? "context" : (state.contextView || preferredContextView());
  state.contextView = activeView;
  contextMainSection.classList.toggle("hidden", activeView !== "context");
  profileSection.classList.toggle("hidden", activeView !== "profile");
  contextViewButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.contextView === activeView);
  });
  requestAnimationFrame(resizeContextTextareas);
}

function renderRouteWarning() {
  routeWarning.classList.toggle("hidden", isPrivateRoute());
}

function openTab(tabId) {
  state.tab = normalizeTab(tabId);
  if (state.tab !== "approvals") state.highlightedApprovalId = "";
  if (state.tab === "context") state.contextView = preferredContextView();
  applyAttentionFilterDefaults();
  updateRoute();
  closeMoreTabs();
  renderTabs();
  renderContextView();
}

function updateRoute(options = {}) {
  const tab = normalizeTab(options.tab || state.tab);
  const approvalId = options.approvalId !== undefined ? cleanRouteId(options.approvalId) : (tab === "approvals" ? state.highlightedApprovalId : "");
  const params = new URLSearchParams();
  params.set("tab", routeTabName(tab));
  if (tab === "approvals" && approvalId) params.set("approval", approvalId);
  history.replaceState(null, "", `?${params.toString()}`);
}

function normalizeTab(tabId) {
  if (tabId === "review") return "approvals";
  return tabs.includes(tabId) || simpleTabs.includes(tabId) || proTabs.includes(tabId) ? tabId : "inbox";
}

function normalizeListFilter(value, choices, fallback = "all") {
  return choices.includes(value) ? value : fallback;
}

function applyAttentionFilterDefaults() {
  if (state.tab === "tasks") {
    state.taskFilter = openTaskCount() > 0 ? "open" : state.taskFilterPreference;
  }
  if (state.tab === "approvals") {
    const highlightedApproval = (state.data?.approvals || []).find((approval) => approval.id === state.highlightedApprovalId);
    state.approvalsFilter = pendingApprovalCount() > 0 && highlightedApproval?.status !== "approved" && highlightedApproval?.status !== "denied"
      ? "pending"
      : state.approvalsFilterPreference;
  }
}

function routeTabName(tabId) {
  return tabId === "approvals" ? "review" : tabId;
}

function cleanRouteId(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9_-]{1,140}$/.test(text) ? text : "";
}

function closeMoreTabs() {
  tabsMoreMenu?.classList.add("hidden");
  moreTabsButton?.setAttribute("aria-expanded", "false");
}

async function enableNotifications() {
  if (!("Notification" in window)) return;
  const permission = await Notification.requestPermission();
  renderNotificationButton();
  if (permission === "granted") {
    await showNotification("Compass notifications enabled", {
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
  notifyButton.textContent = permission === "granted" ? "Notifications On" : "Notifications";
}

function renderAppLockButton() {
  if (!appLockButton) return;
  const configured = isAppLockConfigured();
  appLockButton.classList.toggle("active", configured);
  appLockButton.title = configured ? "Lock this app with PIN or passkey" : "Set App PIN lock";
  appLockButton.setAttribute("aria-label", appLockButton.title);
  appLockButton.textContent = configured ? "App Lock On" : "App Lock";
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
  if (isProMode()) {
    pendingSummary.innerHTML = `
      <span class="status-chip${pendingApprovals > 0 ? " alert" : ""}">${pendingApprovals} approval${pendingApprovals === 1 ? "" : "s"}</span>
      <span class="status-chip">${openTasks} task${openTasks === 1 ? "" : "s"}</span>
      <span class="status-chip subtle">${escapeHtml(llmStatus)}</span>
    `;
  } else {
    pendingSummary.innerHTML = `
      <span class="status-chip${openTasks > 0 ? " alert" : ""}">${openTasks} open task${openTasks === 1 ? "" : "s"}</span>
      <span class="status-chip subtle">${escapeHtml(friendlyComputeSummary())}</span>
    `;
  }
  const balance = creditBalance();
  creditSummary.textContent = `${balance} credits`;
}

function creditBalance() {
  if (state.authMode === "user") return state.data?.credits?.account?.balance ?? 0;
  const operator = (state.data?.network?.ledgerAccounts || []).find((account) => account.id === "operator");
  return operator?.balance ?? 0;
}

function friendlyComputeSummary() {
  return state.data?.compute?.status || "Handled locally";
}

function maybeNotify() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const candidates = [
    ...(state.data?.approvals || [])
      .filter((item) => item.status === "pending")
      .map((item) => ({
        id: item.id,
        title: "Compass needs attention",
        body: item.type === "human_verification" || item.type === "context_question"
          ? "Human input is needed. Open Compass to review."
          : "Approval requested. Open Compass to review.",
        url: reviewApprovalUrl(item.id)
      })),
    ...(state.data?.messages || [])
      .filter((item) => item.direction === "agent_to_operator")
      .map((item) => ({
        id: item.id,
        title: "Compass Companion update",
        body: "Open Compass to read the latest update.",
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
  const allowed = visibleTabs();
  document.querySelectorAll(".tab").forEach((button) => {
    if (!button.dataset.tab) return;
    button.classList.toggle("hidden", !allowed.includes(button.dataset.tab));
    button.classList.toggle("active", button.dataset.tab === state.tab);
  });
  renderMoreTabs(allowed);
  renderTabBadges();
  document.querySelectorAll(".panel").forEach((panel) => panel.classList.add("hidden"));
  const panel = document.querySelector(`#${state.tab}Panel`);
  if (panel) panel.classList.remove("hidden");
}

function renderMoreTabs(allowed) {
  if (!moreTabsButton || !tabsMoreMenu) return;
  const primaryTabs = allowed.slice(0, 3);
  const moreTabs = allowed.slice(3);
  const activeInMore = moreTabs.includes(state.tab);
  moreTabsButton.classList.toggle("hidden", moreTabs.length === 0);
  moreTabsButton.classList.toggle("active", activeInMore);
  moreTabsButton.querySelector("span").textContent = activeInMore ? tabLabel(state.tab) : "More";
  tabsMoreMenu.innerHTML = moreTabs.map((tabId) => `
    <button class="more-tab ${tabId === state.tab ? "active" : ""}" type="button" data-more-tab="${escapeHtml(tabId)}" role="menuitem">
      ${escapeHtml(tabLabel(tabId))}
    </button>
  `).join("");
  tabsMoreMenu.querySelectorAll("[data-more-tab]").forEach((button) => {
    button.addEventListener("click", () => openTab(button.dataset.moreTab));
  });
  document.querySelectorAll(".tab[data-tab]").forEach((button) => {
    button.classList.toggle("mobile-secondary-tab", !primaryTabs.includes(button.dataset.tab));
  });
}

function renderTabBadges() {
  document.querySelectorAll(".tab[data-tab]").forEach((button) => {
    updateTabBadge(button, button.dataset.tab);
  });
  document.querySelectorAll("[data-more-tab]").forEach((button) => {
    updateTabBadge(button, button.dataset.moreTab);
  });
  if (moreTabsButton) {
    const moreTabs = visibleTabs().slice(3);
    const activeInMore = moreTabs.includes(state.tab);
    updateButtonBadge(
      moreTabsButton,
      activeInMore ? tabBadgeValue(state.tab) : aggregateMoreTabBadge(moreTabs),
      moreTabsButton.querySelector("span")?.textContent || "More",
      activeInMore ? state.tab : ""
    );
  }
}

function updateTabBadge(button, tabId) {
  updateButtonBadge(button, tabBadgeValue(tabId), tabLabel(tabId), tabId);
}

function updateButtonBadge(button, value, label, tabId = "") {
  let badge = button.querySelector(".tab-badge");
  if (!value) {
    badge?.remove();
    button.removeAttribute("aria-label");
    return;
  }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "tab-badge";
    button.append(badge);
  }
  badge.textContent = value;
  badge.classList.toggle("credit-alert", value === "!");
  badge.setAttribute("aria-hidden", "true");
  button.setAttribute("aria-label", tabBadgeAriaLabel(label, value, tabId));
}

function tabBadgeValue(tabId) {
  if (tabId === "inbox") return formatTabBadgeValue(unreadChannelCount());
  if (tabId === "tasks") return formatTabBadgeValue(openTaskCount());
  if (tabId === "approvals") return formatTabBadgeValue(pendingApprovalCount());
  if (tabId === "credits") return creditBalance() <= 0 ? "!" : "";
  return "";
}

function aggregateMoreTabBadge(tabIds) {
  const badges = tabIds.map((tabId) => tabBadgeValue(tabId)).filter(Boolean);
  if (badges.includes("!")) return "!";
  const count = badges.reduce((total, value) => total + Number(value.replace("+", "") || 0), 0);
  return formatTabBadgeValue(count);
}

function tabBadgeAriaLabel(label, value, tabId) {
  if (value === "!" && tabId === "credits") return `${label}, no credits left`;
  if (tabId === "inbox") return `${label}, ${value} unread channel${value === "1" ? "" : "s"}`;
  if (tabId === "tasks") return `${label}, ${value} open task${value === "1" ? "" : "s"}`;
  if (tabId === "approvals") return `${label}, ${value} pending request${value === "1" ? "" : "s"}`;
  if (value === "!") return `${label}, attention needed`;
  return `${label}, ${value} items need attention`;
}

function formatTabBadgeValue(count) {
  if (!count) return "";
  return count > 99 ? "99+" : String(count);
}

function unreadChannelCount() {
  const messages = state.data?.messages || [];
  return badgeChannels().filter((channel) => unreadCount(channel.id, messages) > 0).length;
}

function badgeChannels() {
  const channels = Array.isArray(state.data?.channels) && state.data.channels.length
    ? state.data.channels
    : fallbackChannels;
  if (!isProMode()) return channels.filter((channel) => channel.id === "compass").slice(0, 1);
  return channels;
}

function openTaskCount() {
  return (state.data?.tasks || []).filter((item) => ["queued", "running", "waiting"].includes(item.status)).length;
}

function pendingApprovalCount() {
  return (state.data?.approvals || []).filter((item) => item.status === "pending").length;
}

function tabLabel(tabId) {
  const labels = {
    inbox: "Inbox",
    tasks: "Tasks",
    approvals: "Review",
    context: "Context",
    timeline: "Timeline",
    settings: "Settings",
    credits: "Credits"
  };
  return labels[tabId] || tabId;
}

function renderMessages() {
  const messages = state.data?.messages || [];
  const active = activeChannel();
  const channelMessages = (isProMode()
    ? messages.filter((message) => messageChannel(message) === active.id)
    : messages
  ).slice().sort(compareMessagesChronologically);
  const messageList = lists.messages;
  const priorScrollTop = messageList.scrollTop;
  const priorChannel = messageList.dataset.channel || "";
  const channelChanged = priorChannel !== active.id;
  const shouldStickToBottom = state.forceMessageScrollBottom
    || channelChanged
    || messageList.childElementCount === 0
    || isNearScrollBottom(messageList);
  if (state.tab === "inbox") markChannelSeen(active.id, channelMessages);
  chatEyebrow.textContent = isProMode() ? active.label : "Compass";
  chatTitle.textContent = isProMode() ? active.description : "Direct chat with Compass";
  chatCount.textContent = `${channelMessages.length} message${channelMessages.length === 1 ? "" : "s"}`;
  messageText.placeholder = isProMode() ? `Message ${active.label}` : "Message Compass";

  renderList(lists.messages, channelMessages, (message) => `
    <article class="chat-message ${message.direction === "operator_to_agent" ? "from-operator" : "from-agent"}">
      <div class="message-bubble">
        <div class="message-meta">
          <strong>${escapeHtml(message.direction === "operator_to_agent" ? "You" : agentDisplayName())}</strong>
          <span>${formatTime(message.createdAt)}</span>
          ${message.routing ? `<span>${escapeHtml(message.routing.label || routingLabel(message.routingPreference))}</span>` : (isProMode() && message.routingPreference ? `<span>${escapeHtml(routingLabel(message.routingPreference))}</span>` : "")}
          ${message.routing?.credits ? `<span>${escapeHtml(String(message.routing.credits))} credits</span>` : ""}
          ${message.taskId ? `<button class="link-button" data-open-task="${escapeHtml(message.taskId)}" type="button">Task</button>` : ""}
        </div>
        <p>${messageTextMarkup(message)}</p>
        <div class="message-actions ${isProMode() ? "" : "hidden"}">
          <select data-move-message="${escapeHtml(message.id)}" aria-label="Move message to channel">
            ${availableChannels().map((channel) => `<option value="${escapeHtml(channel.id)}" ${messageChannel(message) === channel.id ? "selected" : ""}>${escapeHtml(channel.label)}</option>`).join("")}
          </select>
          <button class="message-archive" data-archive-kind="messages" data-archive-id="${escapeHtml(message.id)}" type="button">Archive</button>
        </div>
      </div>
    </article>
  `);
  messageList.dataset.channel = active.id;
  bindArchiveButtons(lists.messages);
  bindMessageTools(lists.messages);
  state.forceMessageScrollBottom = false;
  if (!shouldStickToBottom) {
    messageList.scrollTop = priorScrollTop;
  }
  requestAnimationFrame(() => {
    if (shouldStickToBottom) {
      messageList.scrollTop = messageList.scrollHeight;
    } else {
      messageList.scrollTop = priorScrollTop;
    }
  });
  renderTabBadges();
}

function compareMessagesChronologically(left, right) {
  const leftTime = Date.parse(left.createdAt || 0);
  const rightTime = Date.parse(right.createdAt || 0);
  if (leftTime !== rightTime) return leftTime - rightTime;
  return String(left.id || "").localeCompare(String(right.id || ""));
}

function isNearScrollBottom(target, threshold = 80) {
  return target.scrollHeight - target.scrollTop - target.clientHeight <= threshold;
}

function resizeMessageText() {
  resizeTextareaToContent(messageText, 220);
}

function resizeContextTextareas() {
  contextAutoResizeTextareas.forEach((textarea) => resizeTextareaToContent(textarea));
}

function resizeTextareaToContent(textarea, maxHeight = Infinity) {
  textarea.style.height = "auto";
  const computed = getComputedStyle(textarea);
  const minHeight = Number.parseFloat(computed.minHeight) || 42;
  const cssMaxHeight = Number.parseFloat(computed.maxHeight);
  const effectiveMaxHeight = Number.isFinite(cssMaxHeight) ? Math.min(maxHeight, cssMaxHeight) : maxHeight;
  const borderHeight = textarea.offsetHeight - textarea.clientHeight;
  const nextHeight = Math.min(effectiveMaxHeight, Math.max(minHeight, textarea.scrollHeight + borderHeight));
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = nextHeight >= effectiveMaxHeight ? "auto" : "hidden";
}

function renderChannels() {
  if (!isProMode()) {
    channelList.innerHTML = "";
    return;
  }
  if (showArchivedChannels) showArchivedChannels.checked = state.showArchivedChannels;
  const messages = state.data?.messages || [];
  const channels = availableChannels();
  if (!channels.some((channel) => channel.id === state.activeChannel)) {
    state.activeChannel = channels[0]?.id || "compass";
    localStorage.setItem("latchActiveChannel", state.activeChannel);
  }
  channelList.innerHTML = channels.map((channel) => {
    const count = messages.filter((message) => messageChannel(message) === channel.id).length;
    const unread = unreadCount(channel.id, messages);
    const latest = messages.find((message) => messageChannel(message) === channel.id);
    return `
      <div class="channel-row ${channel.archivedAt ? "archived" : ""}">
        <button class="channel-button ${channel.id === state.activeChannel ? "active" : ""}" type="button" data-channel="${escapeHtml(channel.id)}">
          <span class="channel-symbol" aria-hidden="true">#</span>
          <span class="channel-copy">
            <strong>${escapeHtml(channel.label)}</strong>
            <small>${escapeHtml(latest ? displayMessageText(latest).slice(0, 48) : channel.description)}</small>
          </span>
          <em class="${unread ? "unread" : ""}">${unread || count}</em>
        </button>
        ${channel.builtIn ? "" : `
          <button class="channel-archive" type="button" data-archive-channel="${escapeHtml(channel.id)}" data-archive-channel-state="${channel.archivedAt ? "false" : "true"}" title="${channel.archivedAt ? "Restore channel" : "Archive channel"}" aria-label="${channel.archivedAt ? "Restore" : "Archive"} ${escapeHtml(channel.label)}">${channel.archivedAt ? "+" : "x"}</button>
          ${channel.archivedAt ? `
            <button class="channel-delete hold-delete" type="button" data-delete-channel="${escapeHtml(channel.id)}" title="Hold 2 seconds to delete channel" aria-label="Hold to delete ${escapeHtml(channel.label)}">
              <span class="hold-delete-progress" aria-hidden="true"></span>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm1 7h2v8h-2v-8Zm4 0h2v8h-2v-8ZM7 8h10l-1 12H8L7 8Z"></path>
              </svg>
            </button>
          ` : ""}
        `}
      </div>
    `;
  }).join("");
  channelList.querySelectorAll("[data-channel]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeChannel = button.dataset.channel;
      localStorage.setItem("latchActiveChannel", state.activeChannel);
      renderChannels();
      renderMessages();
    });
  });
  channelList.querySelectorAll("[data-archive-channel]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/channels/${encodeURIComponent(button.dataset.archiveChannel)}`, {
        method: "PATCH",
        body: JSON.stringify({ archived: button.dataset.archiveChannelState === "true" })
      });
      if (state.activeChannel === button.dataset.archiveChannel) {
        state.activeChannel = "compass";
        localStorage.setItem("latchActiveChannel", state.activeChannel);
      }
      await refresh();
    });
  });
  channelList.querySelectorAll("[data-delete-channel]").forEach((button) => {
    bindHoldDeleteChannel(button);
  });
}

function activeChannel() {
  if (!isProMode()) {
    return availableChannels().find((channel) => channel.id === "compass") || fallbackChannels[0];
  }
  const channels = availableChannels();
  return channels.find((channel) => channel.id === state.activeChannel) || channels[0] || fallbackChannels[0];
}

function messageChannel(message) {
  if (!isProMode()) return "compass";
  if (knownChannels().some((channel) => channel.id === message.channel)) return message.channel;
  if (message.direction === "agent_to_operator") {
    const lowered = String(message.text || "").toLowerCase();
    if (lowered.includes("read-only research") || lowered.includes("source notes")) return "research";
    if (lowered.includes("diagnostic") || lowered.includes("gateway") || lowered.includes("bridge status")) return "operations";
  }
  return "compass";
}

function displayMessageText(message) {
  return cleanDisplayMessageText(message?.text || "");
}

function messageTextMarkup(message) {
  return linkApprovalIds(displayMessageText(message));
}

function linkApprovalIds(value) {
  const text = String(value || "");
  const pattern = /\bapproval_[A-Za-z0-9_]+\b/g;
  let cursor = 0;
  let markup = "";
  for (const match of text.matchAll(pattern)) {
    const id = cleanRouteId(match[0]);
    if (!id) continue;
    markup += escapeHtml(text.slice(cursor, match.index));
    markup += `<a class="approval-link" href="${escapeHtml(reviewApprovalUrl(id))}" data-open-approval="${escapeHtml(id)}">${escapeHtml(id)}</a>`;
    cursor = (match.index || 0) + match[0].length;
  }
  markup += escapeHtml(text.slice(cursor));
  return markup;
}

function reviewApprovalUrl(approvalId = "") {
  const id = cleanRouteId(approvalId);
  return `/?tab=review${id ? `&approval=${encodeURIComponent(id)}` : ""}`;
}

function cleanDisplayMessageText(value) {
  let text = String(value || "").replace(/\r\n/g, "\n").trim();
  let previous = "";
  while (text && text !== previous) {
    previous = text;
    text = text
      .replace(/^Reply to inbox instruction:\s*/i, "")
      .replace(/^(?:COMPASS|COMPANION|OPERATIONS|RESEARCH|GENERAL|[A-Z0-9_-]+_CHANNEL)\s*:\s*/g, "")
      .trim();
  }
  return text;
}

function availableChannels() {
  const active = Array.isArray(state.data?.channels) && state.data.channels.length
    ? state.data.channels
    : fallbackChannels;
  const archived = Array.isArray(state.data?.archives?.channels) ? state.data.archives.channels : [];
  const channels = state.showArchivedChannels ? [...active, ...archived] : active;
  if (!isProMode()) return active.filter((channel) => channel.id === "compass");
  return channels;
}

function knownChannels() {
  const active = Array.isArray(state.data?.channels) ? state.data.channels : [];
  const archived = Array.isArray(state.data?.archives?.channels) ? state.data.archives.channels : [];
  const channels = [...active, ...archived];
  return channels.length ? channels : fallbackChannels;
}

function channelLabel(channelId) {
  return knownChannels().find((channel) => channel.id === channelId)?.label || channelId || "Companion";
}

function channelSeenMap() {
  try {
    return JSON.parse(localStorage.getItem("latchChannelSeenAt") || "{}");
  } catch {
    return {};
  }
}

function saveChannelSeenMap(value) {
  localStorage.setItem("latchChannelSeenAt", JSON.stringify(value));
}

function markChannelSeen(channelId, messages) {
  if (!channelId) return;
  const latest = messages
    .map((message) => message.createdAt)
    .filter(Boolean)
    .sort()
    .at(-1) || new Date().toISOString();
  const seen = channelSeenMap();
  if (String(seen[channelId] || "") < latest) {
    seen[channelId] = latest;
    saveChannelSeenMap(seen);
  }
}

function unreadCount(channelId, messages) {
  if (state.tab === "inbox" && channelId === state.activeChannel) return 0;
  const seenAt = channelSeenMap()[channelId] || "";
  return messages.filter((message) =>
    message.direction === "agent_to_operator"
    && messageChannel(message) === channelId
    && String(message.createdAt || "") > seenAt
  ).length;
}

function agentDisplayName() {
  return state.data?.profile?.name || "Compass Companion";
}

function renderTaskComposerCopy() {
  const name = agentDisplayName();
  if (taskBriefEyebrow) taskBriefEyebrow.textContent = `Brief for ${name}`;
  if (taskTitleLabel) taskTitleLabel.textContent = name;
  if (taskTitle) taskTitle.placeholder = `What should ${name} accomplish?`;
}

function titleFromBrief(value) {
  const firstLine = String(value || "").split(/\r?\n/).find((line) => line.trim()) || "Untitled task";
  return firstLine.trim().slice(0, 120);
}

function routingLabel(value) {
  const labels = {
    auto: "Auto routing",
    local: "Local only",
    network: "Network allowed"
  };
  return labels[value] || "Auto routing";
}

function composeTaskDetails(goal, instructions) {
  const parts = [`Task:\n${goal}`];
  if (instructions) parts.push(`Instructions:\n${instructions}`);
  return parts.join("\n\n");
}

function taskBodyMarkup(task) {
  if (task.goal || task.instructions) {
    return `
      <p class="item-body">${escapeHtml(task.goal || task.title || "")}</p>
      ${task.instructions ? `
        <details class="command-details task-instructions" ${detailsAttributes("task:instructions", task.id || task.title || task.instructions)}>
          <summary>Instructions</summary>
          <p class="item-body">${escapeHtml(task.instructions)}</p>
        </details>
      ` : ""}
      ${task.note ? `<p class="item-body">${escapeHtml(task.note)}</p>` : ""}
    `;
  }
  return `<p class="item-body">${escapeHtml(task.details || task.note || "")}</p>`;
}

function taskChannelLabel(channelId) {
  return channelId === "compass" ? agentDisplayName() : channelLabel(channelId);
}

function renderTasks() {
  taskFilterButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.taskFilter === state.taskFilter);
  });

  const allTasks = state.data?.tasks || [];
  const tasks = state.taskFilter === "open"
    ? allTasks.filter((task) => ["queued", "running", "waiting"].includes(task.status))
    : allTasks;
  const messages = state.data?.messages || [];
  renderList(lists.tasks, tasks, (task) => {
    const linkedMessage = messages.find((message) => message.taskId === task.id);
    const taskChannelExists = task.channel && knownChannels().some((channel) => channel.id === task.channel);
    const linkedChannel = taskChannelExists ? task.channel : (linkedMessage ? messageChannel(linkedMessage) : "");
    const canReopen = ["done", "failed", "paused"].includes(task.status) && !task.channelDeletedAt;
    return `
    <article class="item" data-task-card="${escapeHtml(task.id)}">
      <div class="item-header">
        <h2 class="item-title">${escapeHtml(task.title)}</h2>
        <span class="badge ${escapeHtml(task.status)}">${escapeHtml(task.status)}</span>
      </div>
      ${taskBodyMarkup(task)}
      ${linkedChannel ? `
        <div class="linked-message">
          <span class="type-pill shared">${escapeHtml(taskChannelLabel(linkedChannel))}</span>
          ${linkedMessage ? `<p>${escapeHtml(linkedMessage.text.slice(0, 180))}</p>` : `<p>${escapeHtml(channelLabel(linkedChannel))}</p>`}
          <button class="secondary-button" data-open-message-channel="${escapeHtml(linkedChannel)}" type="button">Open Chat</button>
        </div>
      ` : ""}
      <p class="item-meta">${escapeHtml(task.priority)} · ${escapeHtml(routingLabel(task.routingPreference || "auto"))} · ${formatTime(task.updatedAt || task.createdAt)}</p>
      ${canReopen ? `
        <form class="reopen-task-form" data-reopen-task="${escapeHtml(task.id)}">
          <textarea rows="2" maxlength="4000" placeholder="What should Compass add or fix before trying again?">${escapeHtml(state.reopenDrafts[task.id] || "")}</textarea>
          <button class="secondary-button" type="submit">Reopen</button>
        </form>
      ` : ""}
      <div class="approval-actions">
        <button class="secondary-button" data-archive-kind="tasks" data-archive-id="${escapeHtml(task.id)}" type="button">Archive</button>
      </div>
    </article>
  `;
  });
  bindArchiveButtons(lists.tasks);
  bindTaskLinks(lists.tasks);
  bindReopenTaskForms(lists.tasks);
  bindDisclosureState(lists.tasks);
}

function renderApprovals() {
  const allApprovals = state.data?.approvals || [];
  const highlightedApproval = allApprovals.find((approval) => approval.id === state.highlightedApprovalId);
  if (highlightedApproval && highlightedApproval.status !== "pending" && state.approvalsFilter === "pending") {
    state.approvalsFilter = "all";
  }
  approvalFilterButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.approvalFilter === state.approvalsFilter);
  });
  const approvals = state.approvalsFilter === "pending"
    ? allApprovals.filter((approval) => approval.status === "pending")
    : allApprovals;
  if (!isProMode()) {
    renderSimpleApprovals(approvals);
    return;
  }
  renderList(lists.approvals, approvals, (approval) => `
    <article class="item ${approvalHighlightClass(approval.id)} ${["human_verification", "context_question", "external_contact", "web_research", "github_repo", "github_file"].includes(approval.type) ? "human-request" : ""}" data-approval-card="${escapeHtml(approval.id)}">
      <div class="item-header">
        <h2 class="item-title">${escapeHtml(approval.title)}</h2>
        <span class="badge ${escapeHtml(approval.status)}">${escapeHtml(approval.status)}</span>
      </div>
      <div class="meta-row">
        <span class="type-pill ${escapeHtml(approval.type || "other")}">${formatApprovalType(approval.type)}</span>
        ${approval.sensitive ? `<span class="type-pill sensitive">Sensitive</span>` : ""}
        ${approval.riskLevel ? `<span class="type-pill risk-${escapeHtml(approval.riskLevel)}">${escapeHtml(approval.riskLevel)} risk</span>` : ""}
        ${approval.executionMode === "read_only_status" ? `<span class="type-pill shared">Read-only</span>` : ""}
        ${["shell", "browser"].includes(approval.executionMode) ? `<span class="type-pill shared">${escapeHtml(approval.executionMode)}</span>` : ""}
        ${approval.decisionMode === "auto" ? `<span class="type-pill auto-review">Auto-reviewed</span>` : ""}
        ${approval.proEligible ? `<span class="type-pill auto-review">Pro eligible</span>` : ""}
        <span class="item-meta">Requested by ${escapeHtml(approvalRequesterLabel(approval.requestedBy))}</span>
      </div>
      ${approval.actionPreview || approval.actionTemplate ? `
        <div class="approval-summary">
          <strong>${escapeHtml(approval.actionPreview || commandTemplateLabel(approval.actionTemplate))}</strong>
          <p>${escapeHtml(approvalActionOutcome(approval))}</p>
        </div>
      ` : ""}
      ${approval.type === "external_contact" ? contactApprovalSummary(approval) : ""}
      ${approval.type === "web_research" ? researchApprovalSummary(approval) : ""}
      ${approval.type === "github_repo" ? githubRepoApprovalSummary(approval) : ""}
      ${approval.type === "github_file" ? githubFileApprovalSummary(approval) : ""}
      <p class="item-body">${escapeHtml(approval.details)}</p>
      ${approvalAdvice(approval) ? `<p class="approval-advice">${escapeHtml(approvalAdvice(approval))}</p>` : ""}
      ${approval.expectedResponse ? `<p class="help-note"><strong>Return to agent:</strong> ${escapeHtml(approval.expectedResponse)}</p>` : ""}
      ${executionPlanMarkup(approval)}
      ${approval.renderedCommands?.length ? `
        <details class="command-details" ${detailsAttributes("approval:commands", approval.id || approval.renderedCommands.join("\n"))}>
          <summary>Show exact command${approval.renderedCommands.length === 1 ? "" : "s"}</summary>
          <pre class="item-body">${escapeHtml(approval.renderedCommands.join("\n"))}</pre>
        </details>
      ` : approval.command ? `
        <details class="command-details" ${detailsAttributes("approval:commands", approval.id || approval.command)}>
          <summary>Show exact command</summary>
          <pre class="item-body">${escapeHtml(approval.command)}</pre>
        </details>
      ` : ""}
      ${approval.responseNote ? `<p class="help-note"><strong>${approval.decisionMode === "auto" ? "Policy note" : "Operator note"}:</strong> ${escapeHtml(approval.responseNote)}</p>` : ""}
      ${approval.decisionReason ? `<p class="item-meta">${escapeHtml(approval.decisionReason)}</p>` : ""}
      ${approval.status === "pending" ? `
        <div class="approval-actions">
          <button class="secondary-button" data-approval="${escapeHtml(approval.id)}" data-status="approved">${approvalActionLabel(approval, "approved")}</button>
          <button class="danger-button" data-approval="${escapeHtml(approval.id)}" data-status="denied">${approvalActionLabel(approval, "denied")}</button>
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
  lists.approvals.querySelectorAll("[data-copy-contact]").forEach((button) => {
    button.addEventListener("click", () => copyContactDraft(button.dataset.copyContact));
  });
  bindArchiveButtons(lists.approvals);
  bindDisclosureState(lists.approvals);
  focusHighlightedApproval();
}

function renderSimpleApprovals(approvals) {
  renderList(lists.approvals, approvals, (approval) => `
    <article class="item human-request ${approvalHighlightClass(approval.id)}" data-approval-card="${escapeHtml(approval.id)}">
      <div class="item-header">
        <h2 class="item-title">${escapeHtml(approval.title)}</h2>
        <span class="badge ${escapeHtml(approval.status)}">${escapeHtml(simpleApprovalStatus(approval.status))}</span>
      </div>
      <div class="meta-row">
        <span class="type-pill ${escapeHtml(approval.type || "other")}">${escapeHtml(simpleApprovalType(approval.type))}</span>
        <span class="item-meta">${formatTime(approval.updatedAt || approval.createdAt)}</span>
      </div>
      ${simpleApprovalSummary(approval)}
      <p class="item-body">${escapeHtml(approval.details || "")}</p>
      ${approval.responseNote ? `<p class="help-note"><strong>Your note:</strong> ${escapeHtml(approval.responseNote)}</p>` : ""}
      ${approval.status === "pending" ? `
        <div class="approval-actions">
          <button class="secondary-button" data-approval="${escapeHtml(approval.id)}" data-status="approved">${escapeHtml(simpleApprovalActionLabel(approval, "approved"))}</button>
          <button class="danger-button" data-approval="${escapeHtml(approval.id)}" data-status="denied">${escapeHtml(simpleApprovalActionLabel(approval, "denied"))}</button>
        </div>
      ` : ""}
    </article>
  `);
  lists.approvals.querySelectorAll("[data-approval]").forEach((button) => {
    button.addEventListener("click", () => openApprovalDialog(button.dataset.approval, button.dataset.status));
  });
  bindDisclosureState(lists.approvals);
  focusHighlightedApproval();
}

function approvalHighlightClass(approvalId) {
  return approvalId && approvalId === state.highlightedApprovalId ? "route-highlight" : "";
}

function approvalRequesterLabel(value) {
  const labels = {
    compass: "Companion",
    agent: "Worker",
    operator: "Operator",
    user: "You"
  };
  return labels[value] || value || "Worker";
}

function focusHighlightedApproval() {
  if (state.tab !== "approvals" || !state.highlightedApprovalId || !state.pendingApprovalScroll) return;
  state.pendingApprovalScroll = false;
  requestAnimationFrame(() => {
    const card = document.querySelector(`[data-approval-card="${CSS.escape(state.highlightedApprovalId)}"]`);
    card?.scrollIntoView({ block: "center" });
  });
}

function focusDialogInput(input) {
  if (!input || isTouchViewport()) return;
  try {
    input.focus({ preventScroll: true });
  } catch {
    input.focus();
  }
}

function isTouchViewport() {
  return window.matchMedia?.("(pointer: coarse)")?.matches || window.innerWidth < 760;
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
        ${item.shareWithAgent ? `<span class="type-pill shared">${isProMode() ? "Shared" : "Compass"}</span>` : `<span class="type-pill neutral">Private</span>`}
        ${item.rememberedAt ? `<span class="type-pill shared">Remembered</span>` : ""}
        ${item.forgottenAt ? `<span class="type-pill neutral">Forgotten</span>` : ""}
        ${isProMode() && item.shareWithNetwork ? `<span class="type-pill network">Network</span>` : ""}
        ${isProMode() ? `<span class="item-meta">${escapeHtml(item.source || "operator")}</span>` : ""}
        <span class="item-meta">${formatTime(item.createdAt)}</span>
        ${item.kind === "file" ? `<span class="item-meta">${escapeHtml(formatBytes(item.size || 0))}</span>` : ""}
      </div>
      ${item.kind === "file" ? `
        <p class="item-body">${escapeHtml(item.name || "")}</p>
        ${item.shareStatus ? `<p class="help-note">${escapeHtml(item.shareStatus)}</p>` : ""}
        <div class="approval-actions">
          <button class="secondary-button" data-context-download="${escapeHtml(item.id)}" type="button">Download</button>
          <button class="secondary-button" data-context-share="${escapeHtml(item.id)}" data-context-share-value="${item.shareWithAgent ? "false" : "true"}" type="button">${item.shareWithAgent ? "Keep Private" : "Use in Compass"}</button>
          ${!isProMode() && !item.forgottenAt ? `<button class="secondary-button" data-context-forget="${escapeHtml(item.id)}" type="button">Forget</button>` : ""}
          ${isProMode() ? `<button class="secondary-button" data-context-network="${escapeHtml(item.id)}" data-context-network-value="${item.shareWithNetwork ? "false" : "true"}" type="button">${item.shareWithNetwork ? "Remove Network" : "Network Share"}</button>` : ""}
          <button class="secondary-button" data-archive-kind="context" data-archive-id="${escapeHtml(item.id)}" type="button">Archive</button>
        </div>
      ` : `
        <p class="item-body">${escapeHtml(item.text || item.preview || "")}</p>
        <div class="approval-actions">
          <button class="secondary-button" data-context-share="${escapeHtml(item.id)}" data-context-share-value="${item.shareWithAgent ? "false" : "true"}" type="button">${item.shareWithAgent ? "Keep Private" : "Use in Compass"}</button>
          ${!isProMode() && !item.forgottenAt ? `<button class="secondary-button" data-context-forget="${escapeHtml(item.id)}" type="button">Forget</button>` : ""}
          ${isProMode() ? `<button class="secondary-button" data-context-network="${escapeHtml(item.id)}" data-context-network-value="${item.shareWithNetwork ? "false" : "true"}" type="button">${item.shareWithNetwork ? "Remove Network" : "Network Share"}</button>` : ""}
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
  lists.context.querySelectorAll("[data-context-network]").forEach((button) => {
    button.addEventListener("click", () => updateContextNetworkShare(button.dataset.contextNetwork, button.dataset.contextNetworkValue === "true"));
  });
  lists.context.querySelectorAll("[data-context-forget]").forEach((button) => {
    button.addEventListener("click", () => forgetContextMemory(button.dataset.contextForget));
  });
  bindArchiveButtons(lists.context);
}

async function updateContextShare(id, shareWithAgent) {
  await api(contextApiPath(`/${encodeURIComponent(id)}`), {
    method: "PATCH",
    body: JSON.stringify({ shareWithAgent })
  });
  await refresh();
}

async function updateContextNetworkShare(id, shareWithNetwork) {
  if (!isProMode()) return;
  await api(`/api/context/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ shareWithNetwork })
  });
  await refresh();
}

async function forgetContextMemory(id) {
  await api(contextApiPath(`/${encodeURIComponent(id)}`), {
    method: "PATCH",
    body: JSON.stringify({ forgotten: true })
  });
  await refresh();
}

function contextApiPath(suffix = "") {
  const base = state.authMode === "user" ? "/api/me/context" : "/api/context";
  return `${base}${suffix}`;
}

async function downloadContextFile(id) {
  const response = await fetch(contextApiPath(`/files/${encodeURIComponent(id)}`), {
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
  approvalDialogEyebrow.textContent = isProMode() ? formatApprovalType(approval.type) : simpleApprovalType(approval.type);
  approvalDialogTitle.textContent = isProMode()
    ? (isApproved
      ? (approval.type === "context_question" ? "Save Answer" : (approval.type === "human_verification" ? "Mark Done" : "Approve Request"))
      : (approval.type === "context_question" ? "Skip Question" : (approval.type === "human_verification" ? "Cannot Help" : "Deny Request")))
    : (isApproved ? simpleApprovalActionLabel(approval, "approved") : simpleApprovalActionLabel(approval, "denied"));
  approvalDialogSummary.textContent = approval.title;
  approvalDecisionNote.value = "";
  approvalDecisionNote.placeholder = approvalPlaceholder(approval, status);
  approvalDecisionSubmit.textContent = isApproved ? "Save" : "Save";
  approvalDecisionSubmit.classList.toggle("danger-button", !isApproved);
  approvalDecisionSubmit.classList.toggle("action-button", isApproved);
  // Offer "allow this typed operation" only when approving a grantable operation (host says so).
  const grantable = isApproved && isProMode() && Boolean(approval.grantKey);
  if (approvalGrantScope && approvalGrantLabel) {
    approvalGrantScope.value = "once";
    approvalGrantScope.classList.toggle("hidden", !grantable);
    approvalGrantLabel.classList.toggle("hidden", !grantable);
  }
  approvalDialog.classList.remove("hidden");
  focusDialogInput(approvalDecisionNote);
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
    const grantScope = status === "approved" && approvalGrantScope && !approvalGrantScope.classList.contains("hidden")
      ? approvalGrantScope.value
      : "once";
    await api(approvalApiPath(`/${approval.id}`), {
      method: "PATCH",
      body: JSON.stringify({
        status,
        note: approvalDecisionNote.value.trim(),
        ...(grantScope === "session" || grantScope === "always" ? { grant: grantScope } : {})
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
  if (!isProMode()) {
    if (approval.type === "purchase") return "Budget, exact item, or what you checked before continuing";
    if (approval.type === "credential") return "What you did manually. Do not paste passwords or payment details.";
    if (approval.type === "external_contact") return "Edits, confirmation, or why this should wait";
    if (approval.type === "context_question") return "Your answer for Compass to remember";
    return "Optional note";
  }
  if (approval.type === "context_question") return "Your answer will be saved into Context and shared with the worker";
  if (approval.type === "human_verification") return "Verification completed, or short result";
  if (approval.type === "external_contact") return "Manual send result, edits, or reason to hold";
  if (approval.type === "web_research") return "Approved scope, source limits, or safer research route";
  if (approval.type === "github_repo") return "Approved repository details, or why this should wait";
  if (approval.type === "github_file") return "Approved file update details, or why this should wait";
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
  if (approval.type === "external_contact") {
    return "External contact is draft-only. Latch will not send mail or messages in this phase.";
  }
  if (approval.type === "web_research") {
    return "Read-only research can fetch exact approved public URLs only. It will not search, crawl, log in, download files, or touch private network addresses.";
  }
  if (approval.type === "github_repo") {
    return "GitHub repo creation uses the trusted host connector after approval. The worker never receives the GitHub token.";
  }
  if (approval.type === "github_file") {
    return "CompassProjects file updates can auto-commit in Full access for operators and Pro users. The worker never receives the GitHub token.";
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
  if (["shell", "browser"].includes(approval.executionMode)) {
    return "If approved by policy or the operator, the VM executor runs this exact plan and records an audit result.";
  }
  if (approval.type === "command") {
    return "Approval records your decision. Shell/browser work needs an exact executor plan before it can run.";
  }
  if (approval.type === "external_contact") {
    return "Approval records the reviewed draft. The operator still sends manually unless a future connector is enabled.";
  }
  if (approval.type === "web_research") {
    return "If approved, the worker fetches exact approved public URLs, extracts compact source notes, and reports a summary.";
  }
  if (approval.type === "github_repo") {
    return "If approved, Latch creates the repository with the configured GitHub connector and records the resulting URL.";
  }
  if (approval.type === "github_file") {
    return "If approved by the operator or Full access policy, Latch commits this file update through the trusted host connector and records the resulting URL.";
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
    external_contact: "External contact",
    web_research: "Web research",
    github_repo: "GitHub repo",
    github_file: "GitHub file",
    other: "Other"
  };
  return labels[value] || "Other";
}

function approvalActionLabel(approval, status) {
  if (approval.type === "context_question") return status === "approved" ? "Save answer" : "Skip";
  if (approval.type === "human_verification") return status === "approved" ? "Mark done" : "Cannot help";
  if (approval.type === "external_contact") return status === "approved" ? "Mark reviewed" : "Hold";
  if (approval.type === "web_research") return status === "approved" ? "Approve scope" : "Deny scope";
  if (approval.type === "github_repo") return status === "approved" ? "Create repo" : "Hold";
  if (approval.type === "github_file") return status === "approved" ? "Commit file" : "Hold";
  return status === "approved" ? "Approve" : "Deny";
}

function approvalApiPath(suffix = "") {
  const base = state.authMode === "user" ? "/api/me/approvals" : "/api/approvals";
  return `${base}${suffix}`;
}

function simpleApprovalStatus(value) {
  const labels = {
    pending: "needs review",
    approved: "approved",
    denied: "held"
  };
  return labels[value] || value || "review";
}

function simpleApprovalType(value) {
  const labels = {
    command: "Action",
    human_verification: "Confirmation",
    context_question: "Question",
    account_setup: "Account",
    purchase: "Shopping",
    credential: "Private info",
    external_contact: "Message",
    web_research: "Research",
    github_repo: "GitHub repo",
    github_file: "GitHub file",
    other: "Review"
  };
  return labels[value] || "Review";
}

function simpleApprovalActionLabel(approval, status) {
  const approved = status === "approved";
  if (approval.type === "purchase") return approved ? "I checked this" : "Do not continue";
  if (approval.type === "credential") return approved ? "Handled manually" : "Do not share";
  if (approval.type === "external_contact") return approved ? "Looks good" : "Hold this";
  if (approval.type === "context_question") return approved ? "Save answer" : "Skip";
  if (approval.type === "human_verification") return approved ? "Done" : "Cannot help";
  if (approval.type === "web_research") return approved ? "Use these sources" : "Do not research";
  if (approval.type === "github_repo") return approved ? "Looks good" : "Hold this";
  if (approval.type === "github_file") return approved ? "Looks good" : "Hold this";
  return approved ? "Approve" : "Deny";
}

function simpleApprovalSummary(approval) {
  if (approval.type === "purchase") {
    return `<div class="approval-summary"><strong>Shopping check</strong><p>Confirm the exact item, price, vendor, and budget before Compass continues.</p></div>`;
  }
  if (approval.type === "credential") {
    return `<div class="approval-summary"><strong>Private information</strong><p>Handle secrets, payment details, and login steps yourself. Do not paste them into Compass.</p></div>`;
  }
  if (approval.type === "external_contact") return contactApprovalSummary(approval);
  if (approval.type === "web_research") return researchApprovalSummary(approval);
  if (approval.type === "github_repo") return githubRepoApprovalSummary(approval);
  if (approval.type === "github_file") return githubFileApprovalSummary(approval);
  if (approval.type === "context_question") {
    return `<div class="approval-summary"><strong>Memory update</strong><p>Your answer can be saved to Context for future conversations.</p></div>`;
  }
  return "";
}

function contactApprovalSummary(approval) {
  const attachments = approval.attachments || [];
  return `
    <div class="approval-summary contact-summary">
      <strong>Draft contact request</strong>
      <dl class="detail-grid">
        <dt>Recipient</dt><dd>${escapeHtml(approval.recipient || "Not specified")}</dd>
        <dt>Subject</dt><dd>${escapeHtml(approval.subject || "Not specified")}</dd>
        <dt>Purpose</dt><dd>${escapeHtml(approval.contactPurpose || "Not specified")}</dd>
        <dt>Send mode</dt><dd>${escapeHtml(approval.sendMode === "approved_connector" ? "Approved connector" : "Manual")}</dd>
        <dt>Attachments</dt><dd>${attachments.length ? escapeHtml(attachments.join(", ")) : "None"}</dd>
      </dl>
      ${approval.bodyPreview ? `
        <details class="command-details" ${detailsAttributes("approval:draft", approval.id || approval.bodyPreview)}>
          <summary>Show draft preview</summary>
          <pre class="item-body">${escapeHtml(approval.bodyPreview)}</pre>
        </details>
      ` : ""}
      ${approval.bodyPreview ? `<button class="secondary-button" data-copy-contact="${escapeHtml(approval.id)}" type="button">Copy Draft</button>` : ""}
    </div>
  `;
}

function researchApprovalSummary(approval) {
  const domains = approval.allowedDomains || [];
  const seedUrls = approval.seedUrls || [];
  const budget = [
    approval.maxPages ? `${approval.maxPages} pages` : "page budget unset",
    approval.tokenBudget ? `${approval.tokenBudget} tokens` : "token budget unset"
  ].join(" / ");
  return `
    <div class="approval-summary research-summary">
      <strong>Bounded research scope</strong>
      <dl class="detail-grid">
        <dt>Question</dt><dd>${escapeHtml(approval.researchQuestion || "Not specified")}</dd>
        <dt>Seed URLs</dt><dd>${seedUrls.length ? escapeHtml(seedUrls.join(", ")) : "Exact URL required before anything runs"}</dd>
        <dt>Allowed domains</dt><dd>${domains.length ? escapeHtml(domains.join(", ")) : "Not specified"}</dd>
        <dt>Budget</dt><dd>${escapeHtml(budget)}</dd>
      </dl>
    </div>
  `;
}

function githubRepoApprovalSummary(approval) {
  const repoUrl = approval.githubRepoUrl || "";
  return `
    <div class="approval-summary github-summary">
      <strong>GitHub repository</strong>
      <dl class="detail-grid">
        <dt>Name</dt><dd>${escapeHtml(approval.githubRepoName || "Not specified")}</dd>
        <dt>Visibility</dt><dd>${escapeHtml(approval.githubVisibility || "private")}</dd>
        <dt>Owner</dt><dd>${escapeHtml(approval.githubOwner || "Configured account")}</dd>
        <dt>Initialize</dt><dd>${approval.githubAutoInit === false ? "No README" : "README enabled"}</dd>
        <dt>Description</dt><dd>${escapeHtml(approval.githubDescription || "Not specified")}</dd>
        ${repoUrl ? `<dt>Created</dt><dd><a href="${escapeHtml(repoUrl)}" rel="noreferrer">${escapeHtml(approval.githubFullName || repoUrl)}</a></dd>` : ""}
      </dl>
    </div>
  `;
}

function githubFileApprovalSummary(approval) {
  const fileUrl = approval.githubFileUrl || "";
  return `
    <div class="approval-summary github-summary">
      <strong>GitHub file update</strong>
      <dl class="detail-grid">
        <dt>Repository</dt><dd>${escapeHtml(approval.githubRepoName || "Configured repository")}</dd>
        <dt>Owner</dt><dd>${escapeHtml(approval.githubOwner || "Configured account")}</dd>
        <dt>Path</dt><dd>${escapeHtml(approval.githubFilePath || "README.md")}</dd>
        <dt>Commit</dt><dd>${escapeHtml(approval.githubCommitMessage || "Update file")}</dd>
        ${fileUrl ? `<dt>Updated</dt><dd><a href="${escapeHtml(fileUrl)}" rel="noreferrer">${escapeHtml(fileUrl)}</a></dd>` : ""}
      </dl>
      ${approval.githubFileContent ? `
        <details class="command-details" ${detailsAttributes("approval:github-file", approval.id || approval.githubFilePath || approval.githubFileContent)}>
          <summary>Show proposed content</summary>
          <pre class="item-body">${escapeHtml(approval.githubFileContent)}</pre>
        </details>
      ` : ""}
    </div>
  `;
}

function executionPlanMarkup(approval) {
  const plan = approval.executionPlan || {};
  if (!["shell", "browser"].includes(approval.executionMode) || !plan.mode) return "";
  const lines = [
    `Mode: ${plan.mode}`,
    `Timeout: ${plan.timeoutSeconds || 300}s`,
    `Expected: ${plan.expectedResult || "Not specified"}`
  ];
  if (plan.actions?.length) {
    lines.push("Actions:");
    plan.actions.forEach((action, index) => {
      lines.push(`${index + 1}. ${action.type}${action.url ? ` ${action.url}` : ""}${action.selector ? ` ${action.selector}` : ""}${action.path ? ` -> ${action.path}` : ""}`);
    });
  }
  return `
    <details class="command-details" ${detailsAttributes("approval:execution-plan", approval.id || lines.join("\n"))}>
      <summary>Show execution plan</summary>
      <pre class="item-body">${escapeHtml(lines.join("\n"))}</pre>
    </details>
  `;
}

function renderEvents() {
  const events = state.data?.events || [];
  if (!events.length) {
    renderList(lists.events, events, () => "");
    return;
  }

  const groups = groupedEventsByDay(events);
  lists.events.innerHTML = groups.map((group, index) => {
    const key = `timeline:day:${group.key}`;
    return `
    <details class="timeline-group" data-disclosure-key="${escapeHtml(key)}" ${disclosureOpen(key, index === 0) ? "open" : ""}>
      <summary>
        <span>
          <strong>${escapeHtml(group.label)}</strong>
          <small>${escapeHtml(group.bundleCount === group.eventCount ? `${group.eventCount} events` : `${group.eventCount} events in ${group.bundleCount} groups`)}</small>
        </span>
        <span class="badge">${group.eventCount}</span>
      </summary>
      <div class="timeline-group-items">
        ${group.bundles.map(timelineBundleMarkup).join("")}
      </div>
    </details>
  `;
  }).join("");
  bindDisclosureState(lists.events);
}

function timelineBundleMarkup(bundle) {
  if (bundle.items.length === 1) {
    const item = bundle.items[0];
    return `
      <article class="item timeline-event">
        <div class="item-header">
          <h2 class="item-title">${escapeHtml(item.type)}</h2>
          <span class="item-meta">${formatTime(item.createdAt)}</span>
        </div>
        <p class="item-body">${escapeHtml(item.summary || "")}</p>
      </article>
    `;
  }

  const key = stableDisclosureKey("timeline:bundle", bundle.key);
  return `
    <details class="item timeline-event timeline-bundle" data-disclosure-key="${escapeHtml(key)}" ${disclosureOpen(key, false) ? "open" : ""}>
      <summary>
        <span>
          <strong>${escapeHtml(bundle.type)}</strong>
          <small>${escapeHtml(bundle.timeRange)}</small>
        </span>
        <span class="badge">${bundle.items.length}</span>
      </summary>
      <p class="item-body">${escapeHtml(bundle.summary || "")}</p>
      <div class="timeline-bundle-items">
        ${bundle.items.map((item) => `
          <div class="timeline-bundle-row">
            <span class="item-meta">${formatTime(item.createdAt)}</span>
            <span>${escapeHtml(item.summary || "")}</span>
          </div>
        `).join("")}
      </div>
    </details>
  `;
}

function groupedEventsByDay(events) {
  const groups = new Map();
  for (const item of events) {
    const key = eventDayKey(item.createdAt);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        date: eventDayDate(item.createdAt),
        items: []
      });
    }
    groups.get(key).items.push(item);
  }
  return Array.from(groups.values())
    .sort((left, right) => right.date - left.date)
    .map((group) => ({
      ...group,
      label: eventDayLabel(group.date),
      eventCount: group.items.length,
      bundles: collapsedEventBundles(group.items),
      get bundleCount() {
        return this.bundles.length;
      }
    }));
}

function collapsedEventBundles(events) {
  const bundles = new Map();
  for (const item of events) {
    const key = timelineEventBundleKey(item);
    if (!bundles.has(key)) {
      bundles.set(key, {
        key,
        type: item.type || "event",
        summary: item.summary || "",
        items: []
      });
    }
    bundles.get(key).items.push(item);
  }
  return Array.from(bundles.values())
    .map((bundle) => {
      const sorted = bundle.items
        .slice()
        .sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0));
      return {
        ...bundle,
        items: sorted,
        latestAt: sorted[0]?.createdAt || "",
        earliestAt: sorted[sorted.length - 1]?.createdAt || "",
        timeRange: eventBundleTimeRange(sorted)
      };
    })
    .sort((left, right) => Date.parse(right.latestAt || 0) - Date.parse(left.latestAt || 0));
}

function timelineEventBundleKey(item) {
  if (item.type === "research.reported") {
    const run = researchRunById(item.targetId);
    if (run?.approvalId) return `${item.type}\u0000approval:${run.approvalId}\u0000${run.status || ""}\u0000${researchRunResultKey(run)}`;
    if (run?.taskId) return `${item.type}\u0000task:${run.taskId}\u0000${run.status || ""}\u0000${researchRunResultKey(run)}`;
  }
  if (item.type === "execution.reported") {
    const execution = executionById(item.targetId);
    if (execution?.approvalId) return `${item.type}\u0000approval:${execution.approvalId}\u0000${execution.template || ""}\u0000${execution.exitCode ?? ""}`;
  }
  return `${item.type || "event"}\u0000${canonicalBundleText(item.summary || "")}`;
}

function eventBundleTimeRange(items) {
  if (!items.length) return "";
  const latest = items[0]?.createdAt || "";
  const earliest = items[items.length - 1]?.createdAt || latest;
  if (items.length === 1 || latest === earliest) return formatClockTime(latest);
  return `${formatClockTime(earliest)}-${formatClockTime(latest)}`;
}

function eventDayDate(value) {
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) return new Date(0);
  date.setHours(0, 0, 0, 0);
  return date;
}

function eventDayKey(value) {
  return eventDayDate(value).toISOString();
}

function eventDayLabel(date) {
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) return "Today";
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(date);
}

function agencyCapabilitySummary(worker) {
  const caps = worker?.capabilities || {};
  const enabled = [
    caps.bridge ? "bridge" : "",
    caps.diagnostics ? "diagnostics" : "",
    caps.executor ? "executor" : "",
    caps.browser ? "browser" : "",
    caps.shell ? "shell" : "",
    caps.downloads ? "downloads" : ""
  ].filter(Boolean);
  return enabled.length ? enabled.join(", ") : "No capabilities reported yet";
}

function renderDiagnostics() {
  const messages = state.data?.messages || [];
  const tasks = state.data?.tasks || [];
  const approvals = state.data?.approvals || [];
  const executions = state.data?.executions || [];
  const researchRuns = state.data?.researchRuns || [];
  const latestAgentMessage = messages.find((message) => message.direction === "agent_to_operator");
  const latestExecution = executions[0];
  const latestResearch = researchRuns[0];
  const agencyWorkers = state.data?.agencyWorkers || state.about?.agencyWorkers || [];
  const agencyWorker = agencyWorkers[0];
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
      label: "Agency Worker",
      value: agencyWorker ? `${agencyWorker.name} / ${agencyWorker.status}` : "Not paired",
      status: agencyWorker?.health === "ok" ? "ok" : agencyWorker ? "warn" : "warn",
      note: agencyWorker
        ? agencyCapabilitySummary(agencyWorker)
        : "Install and pair Compass Worker before browser, shell, files, downloads, or automation can run."
    },
    {
      label: "Last Worker Update",
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
      label: "Last Research",
      value: latestResearch ? `${latestResearch.status} / ${latestResearch.pagesFetched || 0} pages` : "None yet",
      status: !latestResearch ? "warn" : latestResearch.status === "completed" ? "ok" : latestResearch.status === "partial" ? "warn" : "bad",
      note: latestResearch ? (latestResearch.question || latestResearch.seedUrls?.[0] || "").slice(0, 140) : "Read-only web research has not run yet"
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
    },
    {
      label: "Source",
      value: "github.com/joergensentroels/Latch",
      href: "https://github.com/joergensentroels/Latch",
      status: "ok",
      note: "AGPL-3.0-or-later — source available; view or contribute"
    }
  ];

  diagnosticsGrid.innerHTML = cards.map((card) => `
    <article class="status-card ${card.status}">
      <span>${escapeHtml(card.label)}</span>
      <strong>${card.href
        ? `<a href="${escapeHtml(card.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(card.value)}</a>`
        : escapeHtml(card.value)}</strong>
      ${card.note ? `<p>${escapeHtml(card.note)}</p>` : ""}
    </article>
  `).join("");
}

async function runDoctor() {
  if (!doctorRunButton || state.authMode !== "operator") return;
  doctorRunButton.disabled = true;
  setFormStatus(doctorStatus, "Running doctor checks...", "");
  try {
    state.doctor = await api("/api/doctor");
    const failed = (state.doctor.checks || []).filter((check) => check.status === "bad").length;
    const warnings = (state.doctor.checks || []).filter((check) => check.status === "warn").length;
    setFormStatus(
      doctorStatus,
      failed ? `${failed} check${failed === 1 ? "" : "s"} need attention.` : warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}.` : "All doctor checks passed.",
      failed ? "error" : "success"
    );
    renderDoctor();
  } catch (error) {
    setFormStatus(doctorStatus, `Doctor check failed: ${error.message}`, "error");
  } finally {
    doctorRunButton.disabled = false;
  }
}

function renderDoctor() {
  if (!lists.doctor) return;
  const doctor = state.doctor;
  if (!doctor?.checks?.length) {
    lists.doctor.innerHTML = `
      <article class="status-card warn">
        <span>Doctor</span>
        <strong>Not run yet</strong>
        <p>Run Doctor for host, VM, worker, LLM, and runtime checks.</p>
      </article>
    `;
    return;
  }
  lists.doctor.innerHTML = doctor.checks.map((check) => `
    <article class="status-card ${escapeHtml(check.status || (check.ok ? "ok" : "bad"))}">
      <span>${escapeHtml(check.name)}</span>
      <strong>${escapeHtml(check.ok ? "OK" : check.status === "warn" ? "Warning" : "Needs attention")}</strong>
      <p>${escapeHtml(check.detail || "")}</p>
    </article>
  `).join("") + `
    <article class="status-card ${doctor.ok ? "ok" : "bad"}">
      <span>Last Checked</span>
      <strong>${escapeHtml(formatTime(doctor.checkedAt))}</strong>
      <p>${escapeHtml(doctor.baseUrl || "")}</p>
    </article>
  `;
}

function renderAutonomyPolicy() {
  if (!autonomyForm || !autonomyMode || !autonomySummary) return;
  const policy = state.data?.autonomy || state.about?.autonomy || {};
  const mode = policy.mode || "default_permissions";
  if (!autonomyForm.contains(document.activeElement)) autonomyMode.value = mode;
  if (autonomyStepBudget && document.activeElement !== autonomyStepBudget) {
    autonomyStepBudget.value = policy.defaultStepBudget ?? 5;
  }
  renderAutonomySummary(autonomyMode.value || mode, policy.updatedAt);
}

async function updateAutonomyStepBudget() {
  if (!autonomyStepBudget) return;
  const value = Math.max(1, Math.min(50, Number(autonomyStepBudget.value) || 5));
  autonomyStepBudget.value = value;
  setFormStatus(autonomyStatus, "Saving...", "");
  autonomyStepBudget.disabled = true;
  try {
    const policy = await api("/api/autonomy", {
      method: "PATCH",
      body: JSON.stringify({ defaultStepBudget: value })
    });
    setFormStatus(autonomyStatus, "Default step budget saved.", "success");
    state.data = { ...(state.data || {}), autonomy: policy };
    await refresh();
  } catch (error) {
    setFormStatus(autonomyStatus, `Could not save: ${error.message}`, "error");
    renderAutonomyPolicy();
  } finally {
    autonomyStepBudget.disabled = false;
  }
}

function renderAutonomySummary(mode, updatedAt = "") {
  if (!autonomySummary) return;
  const summary = autonomyModeSummary(mode);
  autonomySummary.innerHTML = `
    <strong>${escapeHtml(autonomyModeLabel(mode))}</strong>
    <p>${escapeHtml(summary)}</p>
    ${updatedAt ? `<p>Updated ${escapeHtml(formatTime(updatedAt))}</p>` : ""}
  `;
}

async function updateAutonomyPolicy() {
  if (!autonomyMode) return;
  const requestedMode = autonomyMode.value;
  renderAutonomySummary(requestedMode, state.data?.autonomy?.updatedAt || state.about?.autonomy?.updatedAt || "");
  setFormStatus(autonomyStatus, "Saving...", "");
  autonomyMode.disabled = true;
  try {
    const policy = await api("/api/autonomy", {
      method: "PATCH",
      body: JSON.stringify({ mode: requestedMode })
    });
    setFormStatus(autonomyStatus, "Autonomy policy saved.", "success");
    state.data = {
      ...(state.data || {}),
      autonomy: policy
    };
    await refresh();
  } catch (error) {
    setFormStatus(autonomyStatus, `Could not save policy: ${error.message}`, "error");
    renderAutonomyPolicy();
  } finally {
    autonomyMode.disabled = false;
  }
}

function renderAgentEmailPolicy() {
  if (!agentEmailForm || !emailReplyCap) return;
  const policy = state.data?.agentEmailPolicy || state.about?.agentEmailPolicy || {};
  const cap = Number(policy.replyCap) || 3;
  if (!agentEmailForm.contains(document.activeElement)) emailReplyCap.value = cap;
  renderEmailReplyCapSummary(Number(emailReplyCap.value) || cap, policy.updatedAt);
}

function renderEmailReplyCapSummary(cap, updatedAt = "") {
  if (!emailReplyCapSummary) return;
  emailReplyCapSummary.innerHTML = `
    <strong>${escapeHtml(String(cap))} repl${cap === 1 ? "y" : "ies"} per thread</strong>
    <p>The companion auto-replies up to ${escapeHtml(String(cap))} time(s) to a contact it emailed first, then pauses that thread and asks you whether to continue.</p>
    ${updatedAt ? `<p>Updated ${escapeHtml(formatTime(updatedAt))}</p>` : ""}
  `;
}

async function updateAgentEmailPolicy() {
  if (!emailReplyCap) return;
  let cap = Math.round(Number(emailReplyCap.value));
  if (!Number.isFinite(cap)) cap = 3;
  cap = Math.min(20, Math.max(1, cap));
  emailReplyCap.value = cap;
  renderEmailReplyCapSummary(cap, state.data?.agentEmailPolicy?.updatedAt || "");
  setFormStatus(emailReplyCapStatus, "Saving...", "");
  emailReplyCap.disabled = true;
  try {
    const policy = await api("/api/agent-email/policy", {
      method: "PATCH",
      body: JSON.stringify({ replyCap: cap })
    });
    setFormStatus(emailReplyCapStatus, "Auto-reply limit saved.", "success");
    state.data = { ...(state.data || {}), agentEmailPolicy: policy };
    await refresh();
  } catch (error) {
    setFormStatus(emailReplyCapStatus, `Could not save: ${error.message}`, "error");
    renderAgentEmailPolicy();
  } finally {
    emailReplyCap.disabled = false;
  }
}

function autonomyModeLabel(value) {
  const labels = {
    default_permissions: "Approve everything",
    auto_review: "Auto read-only",
    auto_browse: "Auto typed tools",
    full_access: "Auto all typed ops"
  };
  return labels[value] || labels.default_permissions;
}

function autonomyModeSummary(value) {
  const summaries = {
    default_permissions: "Nothing runs until you approve it. The agent can plan, draft, and suggest — but every real action waits for you. (Operations you've explicitly allowed still auto-run — see Allowed operations.)",
    auto_review: "Look, don't touch. Only read-only diagnostics and bounded public web research approve themselves. Everything else waits for you.",
    auto_browse: "Auto read-only, plus operator-listed MCP tools. Arbitrary browsing and shell are NOT auto-approved — only typed operations the host can verify.",
    full_access: "Auto-approves typed, host-verifiable operations: read-only diagnostics, bounded research, operator-listed MCP tools, and CompassProjects commits. Arbitrary shell/browser ALWAYS need you — they can't be validated, so they're never auto-run. Credentials, purchases, email, and account/repo creation stay human too."
  };
  return summaries[value] || summaries.default_permissions;
}

function renderMcpServers() {
  if (!mcpServerList) return;
  // Prefer the live catalog (with tools) if it's been fetched; otherwise the redacted list from
  // /api/about (names + allowlist, no tools) so the section renders instantly without a subprocess.
  const source = state.mcp || state.about?.mcp || { enabled: false, servers: [] };
  const servers = source.servers || [];
  if (!source.enabled) {
    mcpServerList.innerHTML = `<p class="empty-state">MCP is off. Add servers to <code>data/mcp.json</code> and set <code>enabled: true</code>.</p>`;
    return;
  }
  if (!servers.length) {
    mcpServerList.innerHTML = `<p class="empty-state">No MCP servers configured.</p>`;
    return;
  }
  mcpServerList.innerHTML = servers.map((server) => {
    const badges = [
      server.transport ? `<span class="type-pill">${escapeHtml(server.transport)}</span>` : "",
      server.ready === false ? `<span class="type-pill risk-high">unreachable</span>` : "",
      (server.allowedTools?.length) ? `<span class="type-pill shared">allowlist: ${server.allowedTools.length}</span>` : "",
      (server.autoApprove?.length) ? `<span class="type-pill auto-review">auto: ${server.autoApprove.length}</span>` : ""
    ].filter(Boolean).join(" ");
    const tools = (server.tools || []).length
      ? `<ul class="mcp-tool-list">${server.tools.map((tool) => `
          <li><strong>${escapeHtml(tool.name)}</strong>${server.autoApprove?.includes(tool.name) ? ` <span class="type-pill auto-review">auto-approve</span>` : ""}${tool.description ? `<span class="item-meta">${escapeHtml(tool.description)}</span>` : ""}</li>
        `).join("")}</ul>`
      : (state.mcp ? `<p class="item-meta">No tools exposed${server.error ? `: ${escapeHtml(server.error)}` : "."}</p>` : `<p class="item-meta">Press Refresh to list tools.</p>`);
    return `
      <article class="item">
        <div class="item-header">
          <h2 class="item-title">${escapeHtml(server.name)}</h2>
          <div class="meta-row">${badges}</div>
        </div>
        ${server.description ? `<p class="item-body">${escapeHtml(server.description)}</p>` : ""}
        ${tools}
      </article>
    `;
  }).join("");
}

async function loadMcpServers() {
  if (state.authMode !== "operator") return;
  if (mcpStatus) setFormStatus(mcpStatus, "Discovering MCP tools...", "");
  try {
    state.mcp = await api("/api/mcp/servers");
    renderMcpServers();
    if (mcpStatus) setFormStatus(mcpStatus, "", "");
  } catch (error) {
    if (mcpStatus) setFormStatus(mcpStatus, `Could not load MCP servers: ${error.message}`, "error");
  }
}

mcpRefreshButton?.addEventListener("click", loadMcpServers);

function updateScheduleCadenceVisibility() {
  if (!scheduleCadenceType) return;
  const type = scheduleCadenceType.value;
  if (scheduleEveryMinutes) scheduleEveryMinutes.hidden = type !== "interval";
  if (scheduleAtTime) scheduleAtTime.hidden = type === "interval";
  if (scheduleDayOfWeek) scheduleDayOfWeek.hidden = type !== "weekly";
}
scheduleCadenceType?.addEventListener("change", updateScheduleCadenceVisibility);

function renderGrants() {
  if (!grantList) return;
  const grants = state.data?.grants || [];
  if (!grants.length) {
    grantList.innerHTML = `<p class="empty-state">No operations allowed yet. Approve a typed operation with "session" or "always" to add one.</p>`;
    return;
  }
  grantList.innerHTML = grants.map((grant) => `
    <article class="item">
      <div class="item-header">
        <h2 class="item-title">${escapeHtml(grant.label || grant.key)}</h2>
        <span class="badge ${grant.sessionScoped ? "" : "approved"}">${grant.sessionScoped ? "session" : "always"}</span>
      </div>
      <div class="meta-row">
        <span class="item-meta"><code>${escapeHtml(grant.key)}</code>${grant.expiresAt ? ` &middot; expires ${escapeHtml(formatTime(grant.expiresAt))}` : ""}</span>
      </div>
      <div class="approval-actions">
        <button class="danger-button" data-grant-revoke="${escapeHtml(grant.id)}" type="button">Revoke</button>
      </div>
    </article>
  `).join("");
}

grantList?.addEventListener("click", async (event) => {
  const id = event.target.closest("[data-grant-revoke]")?.dataset.grantRevoke;
  if (!id) return;
  try {
    await api(`/api/grants/${id}`, { method: "DELETE" });
    await refresh();
  } catch (error) {
    console.error("Could not revoke grant", error);
  }
});

function renderSchedules() {
  if (!scheduleList) return;
  const schedules = state.data?.schedules || [];
  if (!schedules.length) {
    scheduleList.innerHTML = `<p class="empty-state">No schedules yet. Add one above.</p>`;
    return;
  }
  scheduleList.innerHTML = schedules.map((schedule) => {
    const next = schedule.enabled && schedule.nextRunAt ? `Next ${formatTime(schedule.nextRunAt)}` : "Paused";
    const runs = schedule.runCount ? ` &middot; ${schedule.runCount} run${schedule.runCount === 1 ? "" : "s"}` : "";
    return `
      <article class="item">
        <div class="item-header">
          <h2 class="item-title">${escapeHtml(schedule.title)}</h2>
          <span class="badge ${schedule.enabled ? "approved" : ""}">${schedule.enabled ? "on" : "paused"}</span>
        </div>
        <div class="meta-row">
          <span class="type-pill">${escapeHtml(schedule.cadenceLabel || "")}</span>
          <span class="item-meta">${escapeHtml(next)}${runs}</span>
        </div>
        ${schedule.instructions ? `<p class="item-body">${escapeHtml(schedule.instructions)}</p>` : ""}
        <div class="approval-actions">
          <button class="secondary-button" data-schedule-run="${escapeHtml(schedule.id)}" type="button">Run now</button>
          <button class="secondary-button" data-schedule-toggle="${escapeHtml(schedule.id)}" data-enabled="${schedule.enabled ? "1" : "0"}" type="button">${schedule.enabled ? "Pause" : "Resume"}</button>
          <button class="danger-button" data-schedule-delete="${escapeHtml(schedule.id)}" type="button">Delete</button>
        </div>
      </article>
    `;
  }).join("");
}

scheduleForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = document.querySelector("#scheduleTitle")?.value.trim();
  if (!title) return;
  const type = scheduleCadenceType?.value || "daily";
  const body = {
    title,
    instructions: document.querySelector("#scheduleInstructions")?.value.trim() || "",
    cadenceType: type,
    everyMinutes: Number(scheduleEveryMinutes?.value) || 60,
    atTime: scheduleAtTime?.value || "09:00",
    dayOfWeek: Number(scheduleDayOfWeek?.value ?? 1)
  };
  setFormStatus(scheduleStatus, "Adding schedule...", "");
  try {
    await api("/api/schedules", { method: "POST", body: JSON.stringify(body) });
    scheduleForm.reset();
    updateScheduleCadenceVisibility();
    setFormStatus(scheduleStatus, "", "");
    await refresh();
  } catch (error) {
    setFormStatus(scheduleStatus, `Could not add schedule: ${error.message}`, "error");
  }
});

scheduleList?.addEventListener("click", async (event) => {
  const runId = event.target.closest("[data-schedule-run]")?.dataset.scheduleRun;
  const toggleBtn = event.target.closest("[data-schedule-toggle]");
  const deleteId = event.target.closest("[data-schedule-delete]")?.dataset.scheduleDelete;
  try {
    if (runId) {
      setFormStatus(scheduleStatus, "Running now...", "");
      await api(`/api/schedules/${runId}/run`, { method: "POST" });
      setFormStatus(scheduleStatus, "Queued a task.", "success");
    } else if (toggleBtn) {
      const id = toggleBtn.dataset.scheduleToggle;
      const enable = toggleBtn.dataset.enabled !== "1";
      await api(`/api/schedules/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: enable }) });
    } else if (deleteId) {
      if (!confirm("Delete this schedule?")) return;
      await api(`/api/schedules/${deleteId}`, { method: "DELETE" });
    } else {
      return;
    }
    await refresh();
  } catch (error) {
    setFormStatus(scheduleStatus, `Action failed: ${error.message}`, "error");
  }
});

function renderNetwork() {
  if (!networkGrid || !lists.network) return;

  const network = state.data?.network || {};
  const workers = network.workers || [];
  const jobs = network.jobs || [];
  const accounts = network.ledgerAccounts || [];
  const entries = network.ledgerEntries || [];
  const operator = accounts.find((account) => account.id === "operator");
  const onlineWorkers = workers.filter((worker) => worker.status === "active" && ["ok", "warn"].includes(worker.health)).length;
  const activeJobs = jobs.filter((job) => ["queued", "assigned"].includes(job.status)).length;

  const cards = [
    {
      label: "Network Balance",
      value: `${operator?.balance ?? 0} credits`,
      status: (operator?.balance ?? 0) > 0 ? "ok" : "warn",
      note: "Internal private-alpha ledger only"
    },
    {
      label: "Workers",
      value: `${onlineWorkers}/${workers.length} online`,
      status: onlineWorkers ? "ok" : "warn",
      note: "Workers poll Latch; no inbound ports required"
    },
    {
      label: "Jobs",
      value: `${activeJobs} active`,
      status: activeJobs ? "warn" : "ok",
      note: `${jobs.length} recent network jobs`
    },
    {
      label: "Routing",
      value: "Auto / Local / Network",
      status: "ok",
      note: "Sensitive auto-routed prompts stay local"
    }
  ];
  networkGrid.innerHTML = cards.map((card) => `
    <article class="status-card ${card.status}">
      <span>${escapeHtml(card.label)}</span>
      <strong>${escapeHtml(card.value)}</strong>
      <p>${escapeHtml(card.note)}</p>
    </article>
  `).join("");

  const items = [
    ...workers.map((worker) => ({ kind: "worker", sortTime: worker.lastSeenAt || worker.createdAt, worker })),
    ...jobs.slice(0, 8).map((job) => ({ kind: "job", sortTime: job.updatedAt || job.createdAt, job })),
    ...groupedLedgerEntriesByDay(entries).slice(0, 6).map((group) => ({ kind: "ledgerDay", sortTime: group.date.toISOString(), group, open: false }))
  ].sort((left, right) => String(right.sortTime || "").localeCompare(String(left.sortTime || "")));

  renderList(lists.network, items.slice(0, 18), (item) => {
    if (item.kind === "worker") return networkWorkerCard(item.worker);
    if (item.kind === "job") return networkJobCard(item.job);
    return networkLedgerDayCard(item.group, { scope: "network", defaultOpen: item.open });
  });
  bindDisclosureState(lists.network);
  lists.network.querySelectorAll("[data-worker-status]").forEach((button) => {
    button.addEventListener("click", () => updateWorkerStatus(button.dataset.workerStatus, button.dataset.statusValue));
  });
}

function networkWorkerCard(worker) {
  const paused = worker.status === "paused";
  return `
    <article class="item">
      <div class="item-header">
        <h2 class="item-title">${escapeHtml(worker.name)}</h2>
        <span class="badge ${paused ? "paused" : "done"}">${escapeHtml(paused ? "paused" : worker.health || "unknown")}</span>
      </div>
      <div class="meta-row">
        <span class="type-pill network">${escapeHtml(worker.backendType)}</span>
        <span class="item-meta">${escapeHtml((worker.models || []).join(", ") || worker.defaultModel || "model unset")}</span>
        <span class="item-meta">${escapeHtml(String(worker.inputCreditsPer1k))}/${escapeHtml(String(worker.outputCreditsPer1k))} cr / 1k</span>
      </div>
      <p class="item-body">Last seen ${formatTime(worker.lastSeenAt)}.</p>
      <div class="approval-actions">
        <button class="secondary-button" data-worker-status="${escapeHtml(worker.id)}" data-status-value="${paused ? "active" : "paused"}" type="button">${paused ? "Resume" : "Pause"}</button>
      </div>
    </article>
  `;
}

function networkJobCard(job) {
  return `
    <article class="item">
      <div class="item-header">
        <h2 class="item-title">${escapeHtml(job.model || "Network job")}</h2>
        <span class="badge ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span>
      </div>
      <div class="meta-row">
        <span class="type-pill network">${escapeHtml(job.workerName || job.workerId || "worker")}</span>
        <span class="item-meta">${escapeHtml(job.routingReason || "routed")}</span>
        <span class="item-meta">${escapeHtml(String(job.chargedCredits || job.reservedCredits || 0))} credits</span>
      </div>
      ${job.error ? `<p class="approval-advice">${escapeHtml(job.error)}</p>` : `<p class="item-body">${formatTime(job.updatedAt || job.createdAt)}</p>`}
    </article>
  `;
}

function networkLedgerDayCard(group, { scope = "network", defaultOpen = false } = {}) {
  const dayKey = `ledger:${scope}:day:${group.key}`;
  const dayOpen = disclosureOpen(dayKey, defaultOpen);
  return `
    <details class="item ledger-day" data-disclosure-key="${escapeHtml(dayKey)}" ${dayOpen ? "open" : ""}>
      <summary>
        <span>
          <strong>${escapeHtml(group.label)}</strong>
          <small>${group.entries.length} movements</small>
        </span>
        <span class="badge ${group.net >= 0 ? "approved" : "denied"}">${group.net >= 0 ? "+" : ""}${escapeHtml(String(group.net))}</span>
      </summary>
      <div class="ledger-day-summary">
        ${ledgerMovementGroupMarkup("Inbound", group.inbound, group.positive, "approved", `${dayKey}:inbound`)}
        ${ledgerMovementGroupMarkup("Outbound", group.outbound, Math.abs(group.negative), "denied", `${dayKey}:outbound`)}
      </div>
    </details>
  `;
}

function ledgerMovementGroupMarkup(label, entries, amount, badgeClass, key) {
  const signedAmount = amount === 0 ? "0" : (label === "Inbound" ? `+${amount}` : `-${amount}`);
  const hasEntries = entries.length > 0;
  return `
    <details class="ledger-movement" data-disclosure-key="${escapeHtml(key)}" ${disclosureOpen(key, false) ? "open" : ""} ${hasEntries ? "" : "disabled"}>
      <summary>
        <span>
          <strong>${escapeHtml(label)}</strong>
          <small>${entries.length} movement${entries.length === 1 ? "" : "s"}</small>
        </span>
        <span class="badge ${badgeClass}">${escapeHtml(signedAmount)}</span>
      </summary>
      ${hasEntries ? `<div class="ledger-day-items">${entries.map(networkLedgerRow).join("")}</div>` : ""}
    </details>
  `;
}

function networkLedgerRow(entry) {
  return `
    <div class="ledger-row">
      <span class="badge ${entry.amount >= 0 ? "approved" : "denied"}">${entry.amount >= 0 ? "+" : ""}${escapeHtml(String(entry.amount))}</span>
      <div>
        <strong>${escapeHtml(entry.type)}</strong>
        <p>${escapeHtml(entry.note || entry.accountId)}</p>
        <small>${escapeHtml(entry.accountId)} - balance ${escapeHtml(String(entry.balanceAfter))} - ${formatTime(entry.createdAt)}</small>
      </div>
    </div>
  `;
}

function groupedLedgerEntriesByDay(entries) {
  const groups = new Map();
  for (const entry of entries || []) {
    const key = eventDayKey(entry.createdAt);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        date: eventDayDate(entry.createdAt),
        entries: []
      });
    }
    groups.get(key).entries.push(entry);
  }
  return Array.from(groups.values())
    .map((group) => {
      const sorted = group.entries
        .slice()
        .sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0));
      const amounts = sorted.map((entry) => Number(entry.amount) || 0);
      return {
        ...group,
        entries: sorted,
        label: eventDayLabel(group.date),
        net: amounts.reduce((total, amount) => total + amount, 0),
        inbound: sorted.filter((entry) => Number(entry.amount) > 0),
        outbound: sorted.filter((entry) => Number(entry.amount) < 0),
        positive: amounts.filter((amount) => amount > 0).reduce((total, amount) => total + amount, 0),
        negative: amounts.filter((amount) => amount < 0).reduce((total, amount) => total + amount, 0)
      };
    })
    .sort((left, right) => right.date - left.date);
}

function ledgerPeriodTotals(entries) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const yearStart = new Date(now.getFullYear(), 0, 1);
  return {
    month: ledgerTotalsSince(entries, monthStart),
    year: ledgerTotalsSince(entries, yearStart)
  };
}

function ledgerTotalsSince(entries, startDate) {
  const amounts = (entries || [])
    .filter((entry) => Date.parse(entry.createdAt || 0) >= startDate.getTime())
    .map((entry) => Number(entry.amount) || 0);
  return {
    net: amounts.reduce((total, amount) => total + amount, 0),
    positive: amounts.filter((amount) => amount > 0).reduce((total, amount) => total + amount, 0),
    negative: amounts.filter((amount) => amount < 0).reduce((total, amount) => total + amount, 0)
  };
}

function signedCredits(value) {
  const amount = Number(value) || 0;
  return `${amount >= 0 ? "+" : ""}${amount} credits`;
}

async function createNetworkInvite(event) {
  event.preventDefault();
  const name = networkWorkerName.value.trim();
  if (!name) {
    setFormStatus(networkInviteStatus, "Worker name is required.", "error");
    return;
  }
  try {
    await withSubmitLock(networkInviteForm, async () => {
      const result = await api("/api/network/workers", {
        method: "POST",
        body: JSON.stringify({
          name,
          backendType: networkWorkerBackend.value,
          models: tagsFromInput(networkWorkerModels.value)
        })
      });
      networkWorkerName.value = "";
      networkWorkerModels.value = "";
      setFormStatus(networkInviteStatus, `Invite token: ${result.token}`, "success");
      await refresh();
    });
  } catch (error) {
    setFormStatus(networkInviteStatus, `Could not create invite: ${error.message}`, "error");
  }
}

async function updateWorkerStatus(id, status) {
  await api(`/api/network/workers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ status })
  });
  await refresh();
}

function renderCredits() {
  if (!creditsGrid || !creditsList) return;
  const balance = creditBalance();
  const purchases = state.data?.purchases || [];
  const operatorAccountId = state.authMode === "user" ? state.data?.credits?.account?.id : "operator";
  const entries = state.authMode === "user"
    ? (state.data?.credits?.recentEntries || [])
    : (state.data?.network?.ledgerEntries || []).filter((entry) => entry.accountId === operatorAccountId).slice(0, 20);
  const compute = state.data?.compute || {};
  const totals = ledgerPeriodTotals(entries);
  creditsGrid.innerHTML = [
    {
      label: "Balance",
      value: `${balance} credits`,
      status: balance > 0 ? "ok" : "warn",
      note: state.authMode === "user" ? "Used automatically when Compass needs extra compute" : "Operator network ledger"
    },
    {
      label: "Compute",
      value: compute.status || (state.authMode === "user" ? "Handled locally" : "Pro routing"),
      status: compute.status === "Fallback used" ? "warn" : "ok",
      note: compute.lastCredits ? `${compute.lastCredits} credits on the last network job` : "Auto routing uses extra compute only when eligible"
    },
    {
      label: "Top-Ups",
      value: `${purchases.filter((item) => item.status === "pending").length} pending`,
      status: purchases.some((item) => item.status === "pending") ? "warn" : "ok",
      note: "Payment-ready records; manual completion for now"
    },
    {
      label: "This Month",
      value: signedCredits(totals.month.net),
      status: totals.month.net < 0 ? "warn" : "ok",
      note: `In ${totals.month.positive} / out ${Math.abs(totals.month.negative)}`
    },
    {
      label: "This Year",
      value: signedCredits(totals.year.net),
      status: totals.year.net < 0 ? "warn" : "ok",
      note: `In ${totals.year.positive} / out ${Math.abs(totals.year.negative)}`
    }
  ].map((card) => `
    <article class="status-card ${card.status}">
      <span>${escapeHtml(card.label)}</span>
      <strong>${escapeHtml(card.value)}</strong>
      <p>${escapeHtml(card.note)}</p>
    </article>
  `).join("");

  const items = [
    ...purchases.map((purchase) => ({ kind: "purchase", sortTime: purchase.updatedAt || purchase.createdAt, purchase })),
    ...groupedLedgerEntriesByDay(entries).map((group, index) => ({ kind: "ledgerDay", sortTime: group.date.toISOString(), group, open: index === 0 }))
  ].sort((left, right) => String(right.sortTime || "").localeCompare(String(left.sortTime || "")));
  renderList(creditsList, items.slice(0, 30), (item) => item.kind === "purchase" ? purchaseCard(item.purchase) : networkLedgerDayCard(item.group, { scope: "credits", defaultOpen: item.open }));
  bindDisclosureState(creditsList);
}

function purchaseCard(purchase) {
  return `
    <article class="item">
      <div class="item-header">
        <h2 class="item-title">${escapeHtml(String(purchase.credits))} credits</h2>
        <span class="badge ${escapeHtml(purchase.status)}">${escapeHtml(purchase.status)}</span>
      </div>
      <p class="item-body">${escapeHtml(purchase.note || "Credit top-up request")}</p>
      <p class="item-meta">${escapeHtml(purchase.provider)} - ${formatTime(purchase.updatedAt || purchase.createdAt)}</p>
    </article>
  `;
}

function creditEntryCard(entry) {
  return `
    <article class="item">
      <div class="item-header">
        <h2 class="item-title">${escapeHtml(entry.label || entry.type)}</h2>
        <span class="badge">${escapeHtml(String(entry.amount))}</span>
      </div>
      <p class="item-body">Balance ${escapeHtml(String(entry.balanceAfter))}</p>
      <p class="item-meta">${formatTime(entry.createdAt)}</p>
    </article>
  `;
}

async function createPurchaseRequest(event) {
  event.preventDefault();
  const credits = Number(purchaseCredits.value || 0);
  if (!Number.isInteger(credits) || credits <= 0) {
    setFormStatus(purchaseStatus, "Enter a positive credit amount.", "error");
    return;
  }
  if (state.authMode !== "user") {
    setFormStatus(purchaseStatus, "Credit purchase requests are for signed-in Compass users. Operator adjustments stay in Pro Mode.", "error");
    return;
  }
  try {
    await withSubmitLock(purchaseForm, async () => {
      await api("/api/me/purchases", {
        method: "POST",
        body: JSON.stringify({
          credits,
          provider: "manual",
          note: purchaseNote.value.trim() || "Manual top-up request"
        })
      });
      setFormStatus(purchaseStatus, "Credit request recorded.", "success");
      purchaseNote.value = "";
      await refresh();
    });
  } catch (error) {
    setFormStatus(purchaseStatus, `Could not request credits: ${error.message}`, "error");
  }
}

function renderSimpleSettings() {
  if (!simpleSettingsSummary) return;
  const contract = state.data?.productContract || state.about?.productContract || {};
  const cards = [
    {
      label: "Experience",
      value: isProMode() ? "Pro Mode" : "Simple Mode",
      status: "ok",
      note: isProMode() ? "Latch internals are visible." : "Compass hides routing and worker details."
    },
    {
      label: "Account",
      value: state.authMode === "user" ? (state.data?.user?.displayName || "Compass user") : "Operator",
      status: "ok",
      note: state.authMode === "user" ? "External auth-ready local session." : "Self-hosted operator session."
    },
    {
      label: "Credits",
      value: `${creditBalance()} credits`,
      status: creditBalance() > 0 ? "ok" : "warn",
      note: "Extra compute uses credits when routing is eligible."
    },
    {
      label: "Simple",
      value: "Durable companion",
      status: "ok",
      note: contract.simple || "Memory, tasks, approvals, history, and stronger reasoning without direct tools."
    },
    {
      label: "Agency",
      value: isProMode() ? "Worker visible" : "Worker required",
      status: isProMode() ? "ok" : "warn",
      note: isProMode()
        ? (contract.pro || "A paired OpenClaw worker can act under approvals.")
        : "Browser, shell, files, downloads, and external action require Pro with a paired worker."
    }
  ];
  simpleSettingsSummary.innerHTML = cards.map((card) => `
    <article class="status-card ${card.status}">
      <span>${escapeHtml(card.label)}</span>
      <strong>${escapeHtml(card.value)}</strong>
      <p>${escapeHtml(card.note)}</p>
    </article>
  `).join("");
}

function renderCapabilities() {
  if (!capabilityGrid) return;
  const executorSeen = (state.data?.executions || []).some((item) => ["shell", "browser"].includes(item.mode));
  const agencyWorker = (state.data?.agencyWorkers || [])[0];
  const caps = agencyWorker?.capabilities || {};
  const capabilities = [
    ["Compass chat", "Enabled", "Compass Companion can reply into Companion, Operations, Research, and custom channels.", "ok"],
    ["Simple memory", "Enabled", "Simple chat and tasks use saved Context, recent history, goals, and approvals for continuity.", "ok"],
    ["Simple task planner", "Server loop", "Queued Simple tasks get a planning pass and pause before real-world action without a worker.", "ok"],
    ["Channel management", "Operator only", "You can create, archive, and move messages between channels.", "ok"],
    ["Read-only diagnostics", "Approval-gated", "Bridge status, logs, Tailscale, Docker, gateway, and repo status use templates only.", "warn"],
    ["Exact-URL research", "Approval-gated", "Public URLs only, no crawling, no login, cached source notes.", "warn"],
    ["Agent email", "Approval-gated", "The companion sends from its own dedicated mailbox after you approve, and auto-replies only to people it emailed first (limit set above).", "warn"],
    ["External contact", "Draft only", "Contacting someone via your identity stays a draft you send yourself; the agent uses its own mailbox for its own outreach.", "warn"],
    ["Credentials/payments", "Disabled", "Compass Companion should not receive secrets or control purchases/payment tools.", "bad"],
    ["Worker pairing", agencyWorker ? agencyWorker.status : "Not paired", agencyWorker ? agencyCapabilitySummary(agencyWorker) : "Pair OpenClaw before action runtime is available.", agencyWorker?.health === "ok" ? "ok" : "warn"],
    ["Browser automation", caps.browser || executorSeen ? "Policy-gated" : "Executor-ready", "Playwright-managed Firefox runs approved headless browser plans for operators and Pro users.", caps.browser || executorSeen ? "ok" : "warn"],
    ["Write/system commands", caps.shell || executorSeen ? "Policy-gated" : "Executor-ready", "Full access can auto-run non-sensitive approved VM plans for operators and Pro users.", caps.shell || executorSeen ? "ok" : "warn"]
  ];
  capabilityGrid.innerHTML = capabilities.map(([label, value, note, status]) => `
    <article class="capability-card ${status}">
      <div>
        <strong>${escapeHtml(label)}</strong>
        <span>${escapeHtml(value)}</span>
      </div>
      <p>${escapeHtml(note)}</p>
    </article>
  `).join("");
}

function renderUserTiers() {
  if (!userTierList) return;
  const users = state.data?.users || [];
  renderList(userTierList, users, (user) => {
    const pro = Boolean(user.preferences?.proMode);
    return `
      <article class="item">
        <div class="item-header">
          <h2 class="item-title">${escapeHtml(user.displayName || user.email || user.id)}</h2>
          <span class="badge ${pro ? "approved" : "pending"}">${pro ? "pro" : "standard"}</span>
        </div>
        <p class="item-meta">${escapeHtml(user.email || user.id)} - ${escapeHtml(user.preferences?.defaultRoutingPreference || "auto")}</p>
        <div class="approval-actions">
          <button class="secondary-button" data-user-pro="${escapeHtml(user.id)}" data-pro-mode="${pro ? "false" : "true"}" type="button">
            ${pro ? "Set Standard" : "Set Pro"}
          </button>
        </div>
      </article>
    `;
  });
  userTierList.querySelectorAll("[data-user-pro]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api(`/api/users/${encodeURIComponent(button.dataset.userPro)}/preferences`, {
          method: "PATCH",
          body: JSON.stringify({ proMode: button.dataset.proMode === "true" })
        });
        await refresh();
      } finally {
        button.disabled = false;
      }
    });
  });
}

async function runTestAction(action) {
  const active = activeChannel();
  const operations = availableChannels().find((channel) => channel.id === "operations") || active;
  const tests = {
    "channel-route": {
      title: "Test channel routing",
      goal: "Reply in the operations channel with one short sentence confirming channel routing works.",
      instructions: "This is an internal Latch channel test. Do not create an approval."
    },
    "bridge-status": {
      title: "Test bridge status diagnostic",
      goal: "Check bridge.status for the Latch bridge.",
      instructions: "Request the read-only bridge.status diagnostic approval if needed."
    },
    "research-approval": {
      title: "Test exact-URL research approval",
      goal: "Read https://example.com/ as a bounded public exact-URL research test.",
      instructions: "Use exact-URL research only. No search engine, crawling, login, or downloads."
    },
    "plain-task": {
      title: "Test plain task",
      goal: `Reply in ${active.label} with a short summary of what you can currently do in Compass.`,
      instructions: "Keep it concise and do not request external actions."
    }
  };
  const test = tests[action];
  if (!test) return;
  setFormStatus(testConsoleStatus, "Queuing test...", "");
  try {
    const task = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: test.title,
        goal: test.goal,
        instructions: `${test.instructions}\n\nPreferred channel: ${action === "channel-route" ? operations.id : active.id}`,
        details: composeTaskDetails(test.goal, `${test.instructions}\n\nPreferred channel: ${action === "channel-route" ? operations.id : active.id}`),
        priority: "low"
      })
    });
    setFormStatus(testConsoleStatus, `Queued ${task.title}. Watch Tasks and Inbox for the result.`, "success");
    await refresh();
  } catch (error) {
    setFormStatus(testConsoleStatus, `Test failed: ${error.message}`, "error");
  }
}

function renderOperations() {
  const executions = state.data?.executions || [];
  const researchRuns = state.data?.researchRuns || [];
  const operations = [
    ...executions.map((item) => ({ ...item, operationKind: "execution", sortTime: item.finishedAt || item.createdAt })),
    ...researchRuns.map((item) => ({ ...item, operationKind: "research", sortTime: item.finishedAt || item.createdAt }))
  ].sort((left, right) => String(right.sortTime || "").localeCompare(String(left.sortTime || "")));
  const bundles = collapsedOperationBundles(operations);
  renderList(lists.operations, bundles.slice(0, 10), operationBundleCard);
  bindDisclosureState(lists.operations);
}

function operationBundleCard(bundle) {
  if (bundle.items.length === 1) return operationCard(bundle.items[0]);
  const item = bundle.items[0];
  const key = stableDisclosureKey("operation:bundle", bundle.key);
  return `
    <details class="item timeline-event timeline-bundle" data-disclosure-key="${escapeHtml(key)}" ${disclosureOpen(key, false) ? "open" : ""}>
      <summary>
        <span>
          <strong>${escapeHtml(operationTitle(item))}</strong>
          <small>${escapeHtml(operationMetaText(item))}</small>
        </span>
        <span class="badge">${bundle.items.length}</span>
      </summary>
      ${operationDetailMarkup(item)}
      <div class="timeline-bundle-items">
        ${bundle.items.map((row) => `
          <div class="timeline-bundle-row">
            <span class="item-meta">${formatTime(row.finishedAt || row.createdAt)}</span>
            <span>${escapeHtml(operationRowSummary(row))}</span>
          </div>
        `).join("")}
      </div>
    </details>
  `;
}

function operationCard(item) {
  return item.operationKind === "research" ? researchOperationCard(item) : executionOperationCard(item);
}

function executionOperationCard(item) {
  return `
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
        <details class="command-details" ${detailsAttributes("operation:commands", item.id || item.approvalId || item.commands.join("\n"))}>
          <summary>Show exact command${item.commands.length === 1 ? "" : "s"}</summary>
          <pre class="item-body">${escapeHtml(item.commands.join("\n"))}</pre>
        </details>
      ` : ""}
      ${item.stdout ? `<pre class="item-body">${escapeHtml(item.stdout)}</pre>` : ""}
      ${item.stderr ? `<p class="approval-advice">${escapeHtml(item.stderr)}</p>` : ""}
    </article>
  `;
}

function researchOperationCard(item) {
  const sources = item.sources || [];
  return `
    <article class="item">
      <div class="item-header">
        <h2 class="item-title">Read-only research</h2>
        <span class="badge ${item.status === "completed" ? "done" : item.status === "partial" ? "waiting" : "failed"}">${escapeHtml(item.status || "reported")}</span>
      </div>
      <div class="meta-row">
        <span class="type-pill web_research">Web research</span>
        <span class="item-meta">${formatTime(item.finishedAt || item.createdAt)}</span>
        <span class="item-meta">${escapeHtml(String(item.pagesFetched || 0))} pages</span>
      </div>
      <p class="item-body">${escapeHtml(item.question || "Research result")}</p>
      ${item.summary ? `<pre class="item-body">${escapeHtml(item.summary)}</pre>` : ""}
      ${sources.length ? `
        <details class="command-details" ${detailsAttributes("operation:sources", item.id || item.approvalId || item.question)}>
          <summary>Show sources</summary>
          ${sources.map((source) => `
            <div class="source-note">
              <strong>${escapeHtml(source.title || source.url)}</strong>
              <p class="item-meta">${escapeHtml(source.finalUrl || source.url)}${source.requestedUrl && source.requestedUrl !== (source.finalUrl || source.url) ? ` / from ${escapeHtml(source.requestedUrl)}` : ""}${source.status ? ` / ${escapeHtml(String(source.status))}` : ""}${source.cached ? " / cached" : ""}</p>
              <p class="item-body">${escapeHtml(source.summary || source.excerpt || "")}</p>
            </div>
          `).join("")}
        </details>
      ` : ""}
      ${(item.errors || []).length ? `<p class="approval-advice">${escapeHtml(item.errors.join("\\n"))}</p>` : ""}
    </article>
  `;
}

function collapsedOperationBundles(operations) {
  const bundles = new Map();
  for (const item of operations) {
    const key = operationBundleKey(item);
    if (!bundles.has(key)) bundles.set(key, { key, items: [] });
    bundles.get(key).items.push(item);
  }
  return Array.from(bundles.values()).map((bundle) => ({
    ...bundle,
    items: bundle.items.slice().sort((left, right) => String(right.sortTime || "").localeCompare(String(left.sortTime || ""))),
    latestAt: bundle.items[0]?.sortTime || ""
  })).sort((left, right) => String(right.latestAt || "").localeCompare(String(left.latestAt || "")));
}

function operationBundleKey(item) {
  if (item.operationKind === "research") {
    const source = item.approvalId ? `approval:${item.approvalId}` : item.taskId ? `task:${item.taskId}` : canonicalBundleText(item.question || "");
    return `research\u0000${source}\u0000${item.status || ""}\u0000${researchRunResultKey(item)}`;
  }
  if (item.operationKind === "execution") {
    const source = item.approvalId ? `approval:${item.approvalId}` : item.taskId ? `task:${item.taskId}` : canonicalBundleText((item.commands || []).join("\n"));
    return `execution\u0000${source}\u0000${item.template || ""}\u0000${item.exitCode ?? ""}`;
  }
  return `${item.operationKind || "operation"}\u0000${canonicalBundleText(operationRowSummary(item))}`;
}

function operationTitle(item) {
  return item.operationKind === "research" ? "Read-only research" : commandTemplateLabel(item.template);
}

function operationMetaText(item) {
  if (item.operationKind === "research") {
    return `${item.status || "reported"} - ${formatTime(item.finishedAt || item.createdAt)} - ${String(item.pagesFetched || 0)} pages`;
  }
  return `${item.exitCode ?? ""} - ${formatTime(item.finishedAt || item.createdAt)}`;
}

function operationRowSummary(item) {
  if (item.operationKind === "research") return `${item.status || "reported"}: ${item.question || item.seedUrls?.[0] || "research"}`;
  return `${commandTemplateLabel(item.template)}: ${item.exitCode ?? ""}`;
}

function operationDetailMarkup(item) {
  if (item.operationKind === "research") {
    const sources = item.sources || [];
    return `
      <div class="meta-row">
        <span class="type-pill web_research">Web research</span>
        <span class="item-meta">${formatTime(item.finishedAt || item.createdAt)}</span>
        <span class="item-meta">${escapeHtml(String(item.pagesFetched || 0))} pages</span>
      </div>
      <p class="item-body">${escapeHtml(item.question || "Research result")}</p>
      ${item.summary ? `<pre class="item-body">${escapeHtml(item.summary)}</pre>` : ""}
      ${sources.length ? `
        <details class="command-details" ${detailsAttributes("operation:sources", item.id || item.approvalId || item.question)}>
          <summary>Show sources</summary>
          ${sources.map((source) => `
            <div class="source-note">
              <strong>${escapeHtml(source.title || source.url)}</strong>
              <p class="item-meta">${escapeHtml(source.finalUrl || source.url)}${source.requestedUrl && source.requestedUrl !== (source.finalUrl || source.url) ? ` / from ${escapeHtml(source.requestedUrl)}` : ""}${source.status ? ` / ${escapeHtml(String(source.status))}` : ""}${source.cached ? " / cached" : ""}</p>
              <p class="item-body">${escapeHtml(source.summary || source.excerpt || "")}</p>
            </div>
          `).join("")}
        </details>
      ` : ""}
      ${(item.errors || []).length ? `<p class="approval-advice">${escapeHtml(item.errors.join("\\n"))}</p>` : ""}
    `;
  }
  return `
    <div class="meta-row">
      <span class="type-pill shared">Read-only</span>
      <span class="item-meta">${formatTime(item.finishedAt || item.createdAt)}</span>
    </div>
    ${(item.commands || []).length ? `
      <details class="command-details" ${detailsAttributes("operation:commands", item.id || item.approvalId || item.commands.join("\n"))}>
        <summary>Show exact command${item.commands.length === 1 ? "" : "s"}</summary>
        <pre class="item-body">${escapeHtml(item.commands.join("\n"))}</pre>
      </details>
    ` : ""}
    ${item.stdout ? `<pre class="item-body">${escapeHtml(item.stdout)}</pre>` : ""}
    ${item.stderr ? `<p class="approval-advice">${escapeHtml(item.stderr)}</p>` : ""}
  `;
}

function researchRunById(id) {
  return (state.data?.researchRuns || []).find((item) => item.id === id);
}

function executionById(id) {
  return (state.data?.executions || []).find((item) => item.id === id);
}

function researchRunResultKey(run) {
  const errors = (run.errors || []).join("\n");
  const sources = (run.sources || []).map((source) => source.finalUrl || source.url || source.requestedUrl || "").join("\n");
  return [
    run.pagesFetched || 0,
    canonicalBundleText(errors),
    canonicalBundleText(sources),
    canonicalBundleText(run.seedUrls?.join("\n") || "")
  ].join("\u0000");
}

function canonicalBundleText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

async function copyContactDraft(id) {
  const approval = (state.data?.approvals || []).find((item) => item.id === id);
  if (!approval?.bodyPreview) return;
  const draft = [
    `To: ${approval.recipient || ""}`,
    `Subject: ${approval.subject || approval.title || ""}`,
    "",
    approval.bodyPreview
  ].join("\n");
  await navigator.clipboard.writeText(draft);
}

function renderSecurityChecklist() {
  if (!securityChecklist) return;

  const about = state.about || {};
  const checks = [
    {
      label: "Private route",
      ok: isPrivateRoute(),
      warn: false,
      note: isPrivateRoute() ? "This browser is using localhost or a Tailscale address." : "Open Compass through Tailscale before using it away from home."
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
    ...(archives.channels || []).map((item) => ({ kind: "channels", label: "Channel", title: item.label || item.id, archivedAt: item.archivedAt, id: item.id })),
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
        ${item.keep ? "" : `<button class="danger-button" data-delete-kind="${escapeHtml(item.kind)}" data-delete-id="${escapeHtml(item.id)}" type="button">Delete</button>`}
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

function disclosureOpen(key, defaultOpen = false) {
  if (!key) return Boolean(defaultOpen);
  if (Object.prototype.hasOwnProperty.call(state.disclosureState, key)) {
    return Boolean(state.disclosureState[key]);
  }
  return Boolean(defaultOpen);
}

function detailsAttributes(scope, value, defaultOpen = false) {
  const key = stableDisclosureKey(scope, value);
  return `data-disclosure-key="${escapeHtml(key)}" ${disclosureOpen(key, defaultOpen) ? "open" : ""}`;
}

function stableDisclosureKey(scope, value) {
  return `${scope}:${hashDisclosureKey(value)}`;
}

function hashDisclosureKey(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function bindDisclosureState(target) {
  target.querySelectorAll("details[data-disclosure-key]").forEach((details) => {
    details.addEventListener("toggle", () => {
      state.disclosureState[details.dataset.disclosureKey] = details.open;
      saveDisclosureState();
    });
  });
}

function saveDisclosureState() {
  const entries = Object.entries(state.disclosureState).slice(-300);
  state.disclosureState = Object.fromEntries(entries);
  localStorage.setItem("latchDisclosureState", JSON.stringify(state.disclosureState));
}

function bindArchiveButtons(target) {
  target.querySelectorAll("[data-archive-kind]").forEach((button) => {
    button.addEventListener("click", () => archiveItem(button.dataset.archiveKind, button.dataset.archiveId, true));
  });
}

function bindMessageTools(target) {
  target.querySelectorAll("[data-move-message]").forEach((select) => {
    select.addEventListener("change", async () => {
      await api(`/api/messages/${encodeURIComponent(select.dataset.moveMessage)}`, {
        method: "PATCH",
        body: JSON.stringify({ channel: select.value })
      });
      await refresh();
    });
  });
  target.querySelectorAll("[data-open-task]").forEach((button) => {
    button.addEventListener("click", () => openTaskLink(button.dataset.openTask));
  });
  target.querySelectorAll("[data-open-approval]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      openApprovalLink(link.dataset.openApproval);
    });
  });
}

function bindTaskLinks(target) {
  target.querySelectorAll("[data-open-message-channel]").forEach((button) => {
    button.addEventListener("click", () => {
      if (knownChannels().find((channel) => channel.id === button.dataset.openMessageChannel)?.archivedAt) {
        state.showArchivedChannels = true;
        localStorage.setItem("latchShowArchivedChannels", "true");
      }
      state.activeChannel = button.dataset.openMessageChannel;
      localStorage.setItem("latchActiveChannel", state.activeChannel);
      state.tab = "inbox";
      updateRoute();
      render();
    });
  });
}

function bindReopenTaskForms(target) {
  target.querySelectorAll("[data-reopen-task]").forEach((form) => {
    const textarea = form.querySelector("textarea");
    textarea?.addEventListener("input", () => {
      state.reopenDrafts[form.dataset.reopenTask] = textarea.value;
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const note = textarea?.value.trim() || "";
      await api(`${taskCollectionPath()}/${encodeURIComponent(form.dataset.reopenTask)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "queued", reopenNote: note })
      });
      delete state.reopenDrafts[form.dataset.reopenTask];
      await refresh();
    });
  });
}

function isEditingReopenDraft() {
  return Boolean(document.activeElement?.closest?.("[data-reopen-task]"));
}

function openApprovalLink(approvalId) {
  const id = cleanRouteId(approvalId);
  if (!id) return;
  const approval = (state.data?.approvals || []).find((item) => item.id === id);
  if (approval && approval.status !== "pending") {
    state.approvalsFilter = "all";
  }
  state.highlightedApprovalId = id;
  state.pendingApprovalScroll = true;
  state.tab = "approvals";
  updateRoute({ approvalId: id });
  render();
}

function openTaskLink(taskId) {
  state.tab = "tasks";
  state.highlightedApprovalId = "";
  state.taskFilter = "all";
  state.taskFilterPreference = state.taskFilter;
  localStorage.setItem("latchTaskFilter", state.taskFilter);
  updateRoute();
  render();
  requestAnimationFrame(() => {
    document.querySelector(`[data-task-card="${CSS.escape(taskId)}"]`)?.scrollIntoView({ block: "center" });
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

function bindHoldDeleteChannel(button) {
  const holdMs = 2000;
  let startedAt = 0;
  let frame = 0;
  let timer = 0;
  let armed = false;
  let deleting = false;

  const reset = () => {
    armed = false;
    startedAt = 0;
    if (frame) cancelAnimationFrame(frame);
    if (timer) clearTimeout(timer);
    frame = 0;
    timer = 0;
    button.classList.remove("holding");
    button.style.setProperty("--hold-progress", "0");
  };

  const complete = async () => {
    if (!armed || deleting) return;
    const id = button.dataset.deleteChannel;
    deleting = true;
    button.disabled = true;
    reset();
    try {
      await deleteChannel(id);
    } finally {
      deleting = false;
      button.disabled = false;
    }
  };

  const tick = () => {
    if (!armed) return;
    const progress = Math.min(1, (performance.now() - startedAt) / holdMs);
    button.style.setProperty("--hold-progress", progress.toFixed(3));
    if (progress >= 1) return;
    frame = requestAnimationFrame(tick);
  };

  const startHold = (event) => {
    if (button.disabled || deleting || armed) return;
    armed = true;
    startedAt = performance.now();
    button.classList.add("holding");
    if (event.pointerId !== undefined) button.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    timer = window.setTimeout(() => {
      complete().catch((error) => console.error("Could not delete channel", error));
    }, holdMs);
    window.addEventListener("mouseup", stopHold, { once: true });
    window.addEventListener("touchend", stopHold, { once: true });
    window.addEventListener("touchcancel", stopHold, { once: true });
    frame = requestAnimationFrame(tick);
  };

  const stopHold = (event) => {
    if (event?.pointerId !== undefined) button.releasePointerCapture?.(event.pointerId);
    reset();
  };

  button.addEventListener("pointerdown", startHold);
  button.addEventListener("pointerup", stopHold);
  button.addEventListener("pointercancel", stopHold);
  button.addEventListener("mousedown", startHold);
  button.addEventListener("mouseup", stopHold);
  button.addEventListener("touchstart", startHold, { passive: false });
  button.addEventListener("touchend", stopHold);
  button.addEventListener("touchcancel", stopHold);
  button.addEventListener("click", (event) => event.preventDefault());
}

async function deleteChannel(id) {
  await api(`/api/channels/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (state.activeChannel === id) {
    state.activeChannel = "compass";
    localStorage.setItem("latchActiveChannel", state.activeChannel);
  }
  await refresh();
}

function collectionPath(kind) {
  const paths = {
    messages: "/api/messages",
    channels: "/api/channels",
    tasks: taskCollectionPath(),
    approvals: "/api/approvals",
    context: contextApiPath()
  };
  return paths[kind] || "/api/messages";
}

function taskCollectionPath() {
  return state.authMode === "user" ? "/api/me/tasks" : "/api/tasks";
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
  pinDialogTitle.textContent = isSet ? "Set App PIN" : "Unlock Compass";
  pinHelp.textContent = isSet
    ? "Set a local PIN for this device. You can add a passkey when Compass is opened over private HTTPS."
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
    throw new Error("Open Compass over private HTTPS to use passkeys.");
  }
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: "Compass" },
      user: {
        id: userId,
        name: "Compass operator",
        displayName: "Compass operator"
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
    throw new Error("Open Compass over private HTTPS to use passkeys.");
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

function formatClockTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit"
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
