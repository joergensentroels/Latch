/* "Draft with Latch" Outlook add-in taskpane.
 * Reads the message you're viewing, asks Latch's scoped /api/draft endpoint for a suggested reply,
 * and opens a prefilled reply. Latch never gets your mailbox credentials -- the add-in (running in
 * your authenticated Outlook session) hands over only the message you're looking at, and YOU send. */

const el = (id) => document.getElementById(id);
const KEY_BASE = "latchDraftBaseUrl";
const KEY_TOKEN = "latchDraftKey";

let lastSubject = "";

function setStatus(text, isError) {
  const s = el("status");
  s.textContent = text || "";
  s.classList.toggle("error", Boolean(isError));
}

function loadSettings() {
  el("baseUrl").value = localStorage.getItem(KEY_BASE) || location.origin;
  el("draftKey").value = localStorage.getItem(KEY_TOKEN) || "";
}

function baseUrl() {
  return (localStorage.getItem(KEY_BASE) || el("baseUrl").value || location.origin).replace(/\/+$/, "");
}

function draftKey() {
  return localStorage.getItem(KEY_TOKEN) || el("draftKey").value || "";
}

function getBodyText() {
  return new Promise((resolve, reject) => {
    const item = Office.context.mailbox.item;
    item.body.getAsync(Office.CoercionType.Text, (result) => {
      if (result.status === Office.AsyncResultStatus.Succeeded) resolve(result.value || "");
      else reject(new Error(result.error?.message || "Could not read the message body."));
    });
  });
}

const MODE_LABELS = {
  reply: "Suggested reply — edit before sending",
  summarize: "Summary",
  action_items: "Action items",
  rewrite: "Rewritten text"
};

async function run() {
  const key = draftKey();
  if (!key) {
    setStatus("Add your Latch draft key in Settings first.", true);
    el("settings").open = true;
    return;
  }
  const mode = el("mode").value;
  el("replyBtn").style.display = mode === "reply" ? "" : "none";
  el("draftLabel").textContent = MODE_LABELS[mode] || "Result";
  setStatus("Working…");
  try {
    const item = Office.context.mailbox.item;
    const from = item.from ? `${item.from.displayName || ""} <${item.from.emailAddress || ""}>`.trim() : "";
    const subject = item.subject || "";
    // Rewrite works on what you've typed in the box; the others work on the email you're reading.
    const message = mode === "rewrite" ? el("draft").value.trim() : await getBodyText();
    if (!message) { setStatus(mode === "rewrite" ? "Type something to rewrite first." : "No message content.", true); return; }
    const response = await fetch(`${baseUrl()}/api/assist`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ mode, message, from, subject, guidance: el("guidance").value.trim() })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      setStatus(`Failed: ${data.error || response.status}`, true);
      return;
    }
    el("draft").value = data.output || "";
    lastSubject = data.subject || (subject ? `Re: ${subject}` : "");
    setStatus(mode === "reply" ? "Draft ready — review, then open a reply." : "Done — review or copy.");
  } catch (error) {
    setStatus(`Failed: ${error.message}`, true);
  }
}

function openReply() {
  const body = el("draft").value.trim();
  if (!body) { setStatus("Nothing to reply with yet.", true); return; }
  // Opens a reply in Outlook prefilled with the draft. You review and click Send yourself.
  Office.context.mailbox.item.displayReplyForm(body);
}

async function copyDraft() {
  try {
    await navigator.clipboard.writeText(el("draft").value);
    setStatus("Copied.");
  } catch {
    setStatus("Could not copy.", true);
  }
}

function saveSettings() {
  localStorage.setItem(KEY_BASE, el("baseUrl").value.trim());
  localStorage.setItem(KEY_TOKEN, el("draftKey").value.trim());
  setStatus("Settings saved.");
  el("settings").open = false;
}

function onModeChange() {
  const mode = el("mode").value;
  el("replyBtn").style.display = mode === "reply" ? "" : "none";
  el("draftLabel").textContent = MODE_LABELS[mode] || "Result";
}

Office.onReady(() => {
  loadSettings();
  const item = Office.context.mailbox.item;
  const who = item && item.from ? (item.from.emailAddress || item.from.displayName || "this message") : "this message";
  el("context").textContent = `Message from: ${who}`;
  onModeChange();
  el("mode").addEventListener("change", onModeChange);
  el("runBtn").addEventListener("click", run);
  el("replyBtn").addEventListener("click", openReply);
  el("copyBtn").addEventListener("click", copyDraft);
  el("saveSettings").addEventListener("click", saveSettings);
});
