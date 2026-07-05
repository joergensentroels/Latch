import argparse
import importlib.util
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BRIDGE_PATH = ROOT / "worker" / "latch-agent-bridge.py"

spec = importlib.util.spec_from_file_location("latch_agent_bridge", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(spec)
sys.modules["latch_agent_bridge"] = bridge
spec.loader.exec_module(bridge)

args = argparse.Namespace(
    openclaw_health_url="http://127.0.0.1:18789/healthz",
    openclaw_compose_dir=str(Path.home() / "openclaw"),
    latch_repo_dir=str(Path.home() / "code" / "latch-readonly"),
    source_cache_path=str(Path(tempfile.gettempdir()) / "latch-test-source-notes.json"),
)

channels = [
    {"id": "compass", "label": "Companion"},
    {"id": "operations", "label": "Operations"},
    {"id": "research", "label": "Research"},
]
assert bridge.requested_latch_channel("Send a message in the operations channel", channels) == "operations"
assert bridge.requested_latch_channel("Please reply to #research", channels) == "research"
assert bridge.requested_latch_channel("Just answer normally", channels) == ""
assert "Do not say you cannot write to Latch channels" in bridge.channel_briefing(channels, "operations")

visible = bridge.clean_visible_report_text(
    "compass <~ Latch bridge worker\nI'm the Latch bridge worker for your private OpenClaw setup and I coordinate with the latch-agent-executor service."
)
assert not visible.lower().startswith("compass:")
assert "<~" not in visible
assert "bridge worker" not in visible.lower()
assert "openclaw" not in visible.lower()
assert "latch-agent-executor" not in visible.lower()

tool_call_visible = bridge.clean_visible_report_text(
    'COMPANION <|tool_call_argument_begin|> {"channel": "compass", "message": "compass:\\nI am a bridge worker."}'
)
assert "<|tool_call" not in tool_call_visible
assert not tool_call_visible.lower().startswith("compass:")
assert "bridge worker" not in tool_call_visible.lower()

self_description = bridge.companion_self_description({
    "name": "Compass the 1st",
    "purpose": "Help the user become more aligned with the person they genuinely want to become.",
    "goals": "- Reduce overwhelm\n- Support sustainable progress",
    "communicationStyle": "Calm, reflective, thoughtful, and concise.",
})
assert "Compass the 1st" in self_description
assert "bridge" not in self_description.lower()
assert "executor" not in self_description.lower()


known = bridge.command_template("bridge.status", args)
assert known, "bridge.status should expand to commands"
assert known[0]["argv"] == ["systemctl", "is-active", "latch-agent-bridge"]
bridge.validate_read_only_commands(known)

assert bridge.command_template("unknown.template", args) == []

for argv in (
    ["sudo", "systemctl", "restart", "latch-agent-bridge"],
    ["rm", "-rf", "/tmp/example"],
    ["install", "a", "b"],
    ["bash", "-lc", "echo bad"],
    ["systemctl", "status", "x", "|", "cat"],
):
    try:
        bridge.validate_read_only_commands([{"argv": argv}])
        raise AssertionError(f"unsafe command was accepted: {argv}")
    except RuntimeError:
        pass

approval = bridge.enrich_status_template(
    bridge.ApprovalNeed(
        type="command",
        title="Read-only diagnostic approval needed",
        details="test",
        expected_response="test",
        sensitive=False,
        action_template="bridge.status",
        action_preview="Check bridge status",
        execution_mode="read_only_status",
    ),
    args,
)
assert approval.rendered_commands
assert approval.command

contact = bridge.detect_approval_need(
    "Contact security reviewer",
    "Please send an email to reviewer@example.com asking for a security review.",
)
assert contact.type == "external_contact"
assert contact.recipient == "reviewer@example.com"
assert contact.send_mode == "manual"
assert "security review" in contact.contact_purpose.lower()

# Generic "send an email to X" routes to the agent's OWN mailbox (host-brokered), not draft-only.
agent_send = bridge.detect_approval_need(
    "Send an email",
    "Send an email to jane@example.com. Subject: Hello from Compass. Body: Hi Jane, the companion is confirming its mailbox works.",
)
assert agent_send.type == "email_campaign"
assert agent_send.email_to == "jane@example.com"
assert agent_send.email_subject == "Hello from Compass"
assert "confirming its mailbox works" in agent_send.email_body
assert agent_send.planned_recipients == 1

# A send with no concrete address yet must NOT become a send (it needs a scrape/lookup step first).
no_address = bridge.detect_approval_need(
    "Find and email",
    "Browse https://example.com/about, find my email address, then send me an email.",
)
assert no_address is None or no_address.type != "email_campaign"

# An email whose body links repo docs (mentions github + README) must still be an email send, not
# get hijacked by the github_file detector - the send detector now runs first.
email_with_repo_links = bridge.detect_approval_need(
    "Email",
    "Send an email to emil@example.com. Subject: A look. Body: Start with the README at https://github.com/acme/proj/blob/main/README.md then read the rest of the repo.",
)
assert email_with_repo_links is not None and email_with_repo_links.type == "email_campaign", f"repo-linking email must stay email_campaign, got {email_with_repo_links and email_with_repo_links.type}"
assert email_with_repo_links.email_to == "emil@example.com"

# A "write a summary ... from their website" request must NOT be mis-detected as a github_file
# commit (regression: dev verb "write" + noun "website" used to trip is_default_repo_dev_task).
summary_req = bridge.detect_approval_need(
    "Summarize",
    "Please write a clean 3-4 sentence summary of what this company does, based only on the raw text I gathered from their website. Return just the summary.",
)
assert summary_req is None or summary_req.type != "github_file", f"summary request must not be github_file, got {summary_req and summary_req.type}"

# But a genuine file/dev task in the default repo still routes to github_file.
dev_task = bridge.detect_approval_need("Update site", "Please update the README file in the repo with a hello world landing page.")
assert dev_task is not None and dev_task.type == "github_file", f"real dev task should be github_file, got {dev_task and dev_task.type}"

research = bridge.detect_approval_need(
    "Research docs",
    "Please browse https://example.com/docs and summarize the install path without scraping too much.",
)
assert research.type == "web_research"
assert research.allowed_domains == ("example.com",)
assert research.seed_urls == ("https://example.com/docs",)
assert research.max_pages == 5
assert research.token_budget == 3000

open_search = bridge.detect_approval_need(
    "Inbox instruction",
    "Can you Google Jane Doe working at Example Corp and write down in your context what you learn about me?",
)
assert open_search.type == "command"
assert open_search.execution_mode == "browser"
assert open_search.execution_plan["actions"][0]["type"] == "search_web"
assert "Jane Doe" in open_search.execution_plan["actions"][0]["text"]

browser_install = bridge.detect_approval_need(
    "Download Firefox",
    "Please download Firefox onto the VM.",
)
assert browser_install.type == "command"

whoami = bridge.detect_approval_need(
    "Run whoami",
    "Run whoami on the OpenClaw VM.",
)
assert whoami.type == "command"
assert whoami.title == "VM execution approval needed"

website_update = bridge.detect_approval_need(
    "Create Compass website on GitHub",
    "Task:\nCan you make a simple website on the compassprojject github repo?\n\nFollow-up:\nJust continue and make a small hello work website in there :)",
)
assert website_update.type == "github_file"
assert website_update.github_repo_name == "CompassProjects"
assert website_update.github_file_path == "index.html"
assert "<!doctype html>" in website_update.github_file_content.lower()
assert "hello world" in website_update.github_file_content.lower()

default_repo_dev_update = bridge.detect_approval_need(
    "Build a tiny app",
    "Please make a small static HTML app that says hello from Compass.",
)
assert default_repo_dev_update.type == "github_file"
assert default_repo_dev_update.github_repo_name == "CompassProjects"
assert default_repo_dev_update.github_file_path == "index.html"

coding_advice = bridge.detect_approval_need(
    "Explain CSS",
    "Can you explain how I should structure the CSS for a small app?",
)
assert coding_advice is None

capability_note = bridge.detect_approval_need(
    "Inbox instruction",
    "You should be able to use firefox and playwright without having to ask for approval first.",
)
assert capability_note is None

bridge.validate_research_url("https://93.184.216.34/docs", ["93.184.216.34"])

for url, domains in (
    ("file:///etc/passwd", ["example.com"]),
    ("https://127.0.0.1/status", ["127.0.0.1"]),
    ("https://example.org/docs", ["example.com"]),
    ("https://user:pass@example.com/docs", ["example.com"]),
):
    try:
        bridge.validate_research_url(url, domains)
        raise AssertionError(f"unsafe research URL was accepted: {url}")
    except RuntimeError:
        pass

summary = bridge.summarize_text(
    "Install Latch with Tailscale. Use a small page budget. Avoid broad scraping.",
    "How should Latch avoid scraping?",
    120,
)
assert "scraping" in summary.lower()

missing_seed = bridge.perform_read_only_research(
    {
        "id": "approval_missing_seed",
        "researchQuestion": "Search the web generally",
        "allowedDomains": ["example.com"],
        "maxPages": 5,
        "tokenBudget": 3000,
    },
    args,
)
assert missing_seed["status"] == "failed"
assert missing_seed["pagesFetched"] == 0
assert any("No exact seed URL" in error for error in missing_seed["errors"])

cache_path = Path(args.source_cache_path)
cache_path.unlink(missing_ok=True)
cache_entry = {
    bridge.normalized_url_key("https://93.184.216.34/docs"): {
        "requestedUrl": "https://93.184.216.34/docs",
        "finalUrl": "https://93.184.216.34/docs",
        "url": "https://93.184.216.34/docs",
        "title": "Cached docs",
        "status": 200,
        "summary": "Cached source note",
        "excerpt": "Cached excerpt",
        "fetchedAt": "2026-05-24T00:00:00Z",
    }
}
bridge.save_source_cache(cache_path, cache_entry)
cached_run = bridge.perform_read_only_research(
    {
        "id": "approval_cached",
        "researchQuestion": "Read cached docs",
        "seedUrls": ["https://93.184.216.34/docs"],
        "allowedDomains": ["93.184.216.34"],
        "maxPages": 1,
        "tokenBudget": 1000,
    },
    args,
)
assert cached_run["status"] == "completed"
assert cached_run["sources"][0]["cached"] is True

# --- Resilience: a failing approval must be marked "seen" (persisted) and never retried.
# Regression for the crash-loop where "seen" was recorded only after handling succeeded, so a
# single failing approval (e.g. the /.cache write error) was retried on every tick forever. ---
import json as _json

_state_file = Path(tempfile.gettempdir()) / "latch-test-bridge-state.json"
if _state_file.exists():
    _state_file.unlink()
_resilience_args = argparse.Namespace(state_path=str(_state_file), worker_name="test-bridge")
_b = bridge.Bridge(_resilience_args)
_b.request_json = lambda *a, **k: {}  # no network for report()/patch_task()
_calls = {"handle": 0}


def _boom(*a, **k):
    _calls["handle"] += 1
    raise RuntimeError("simulated handler failure")


_b.handle_approved_decision = _boom
_approval = {"id": "appr_test_1", "status": "approved", "title": "boom", "type": "web_research"}
_b.process_approval_decisions([_approval], [], [], [], {})
assert _calls["handle"] == 1, "handler should be attempted exactly once"
assert "appr_test_1" in set(_b.state.get("seen_approval_decisions", [])), "failed approval must be marked seen"
# persisted to disk BEFORE handling, so a watchdog restart cannot cause a retry loop
_persisted = _json.loads(_state_file.read_text(encoding="utf-8"))
assert "appr_test_1" in _persisted.get("seen_approval_decisions", []), "seen must be persisted immediately"
# a later poll containing the same approval must not retry it
_b.process_approval_decisions([_approval], [], [], [], {})
assert _calls["handle"] == 1, "an already-seen approval must never be retried (no crash-loop)"
_state_file.unlink()

# sd_notify must be a safe no-op when not running under a systemd watchdog
bridge.sd_notify("WATCHDOG=1")

# --- LLM-composed email body: a send with no explicit "Body:" defers composition to the LLM ---
compose_need = bridge.detect_approval_need("Email", "Send an email to dan@example.com summarizing the latest project news.")
assert compose_need is not None and compose_need.type == "email_campaign", f"expected email_campaign, got {compose_need and compose_need.type}"
assert compose_need.email_to == "dan@example.com"
assert compose_need.email_body == "", "no explicit body should defer to LLM composition"
assert compose_need.email_compose_brief, "a compose brief should be captured for the LLM"

# an explicit "Body:" is used verbatim (no composition)
verbatim_need = bridge.detect_approval_need("Email", "Send an email to dan@example.com. Body: Ship it today.")
assert verbatim_need.email_body == "Ship it today." and verbatim_need.email_compose_brief == "", "explicit body must stay verbatim"

# compose_email_if_needed fills the body via the LLM and surfaces it in the review details
_cb = bridge.Bridge(argparse.Namespace(state_path=str(Path(tempfile.gettempdir()) / "latch-test-compose-state.json"), worker_name="test"))
_cb.ask_llm = lambda messages, **k: "Here is a short, professional summary of the project news."
_composed = _cb.compose_email_if_needed(compose_need)
assert _composed.email_body == "Here is a short, professional summary of the project news.", _composed.email_body
assert _composed.email_body in _composed.details, "composed body should appear in the review details"
# verbatim approvals are left untouched by the composer
assert _cb.compose_email_if_needed(verbatim_need).email_body == "Ship it today.", "verbatim body must not be recomposed"

# --- MCP tool calls: explicit detection + LLM planning against the poll catalog ---
mcp_need = bridge.detect_approval_need("Files", "Use MCP to read the file notes.txt")
assert mcp_need is not None and mcp_need.type == "mcp_tool_call", f"expected mcp_tool_call, got {mcp_need and mcp_need.type}"
assert mcp_need.mcp_tool == "" and mcp_need.mcp_compose_brief, "detector should defer server/tool to the planner"
assert bridge.detect_mcp_tool_call("Summary", "Please write a short summary of this text.") is None, "non-MCP text must not trigger"

_mcp = bridge.Bridge(argparse.Namespace(state_path=str(Path(tempfile.gettempdir()) / "latch-test-mcp-state.json"), worker_name="test"))
_mcp.remote_mcp_catalog = {
    "enabled": True,
    "servers": [
        {"name": "filesystem", "tools": [
            {"name": "read_file", "description": "Read a file", "inputSchema": {"type": "object"}},
            {"name": "list_directory", "description": "List a dir", "inputSchema": {"type": "object"}},
        ]},
    ],
}
_mcp.ask_llm = lambda messages, **k: '{"server":"filesystem","tool":"read_file","args":{"path":"notes.txt"},"summary":"Read notes.txt"}'
_planned = _mcp.plan_mcp_tool_call("Files", "Use MCP to read notes.txt", mcp_need, "local", False)
assert _planned.type == "mcp_tool_call" and _planned.mcp_server == "filesystem" and _planned.mcp_tool == "read_file", _planned
assert _planned.mcp_args == {"path": "notes.txt"}, _planned.mcp_args
assert "filesystem/read_file" in _planned.title

# A model that invents an unlisted tool is rejected -> falls back to a human "other" approval.
_mcp.ask_llm = lambda messages, **k: '{"server":"filesystem","tool":"delete_everything","args":{}}'
_bad = _mcp.plan_mcp_tool_call("Files", "Use MCP to nuke things", mcp_need, "local", False)
assert _bad.type == "other" and not _bad.mcp_tool, "an unlisted tool must not be proposed"

# No catalog available -> operator must decide.
_mcp.remote_mcp_catalog = {"enabled": False, "servers": []}
_none = _mcp.plan_mcp_tool_call("Files", "Use MCP to read notes.txt", mcp_need, "local", False)
assert _none.type == "other", "no MCP tools available should defer to the operator"

# --- Inbound email: auto-reply only to senders the companion emailed first ---
assert bridge.reply_subject("Hello") == "Re: Hello"
assert bridge.reply_subject("Re: Hello") == "Re: Hello"
assert bridge.reply_subject("") == "Re: your message"
assert bridge.is_automated_or_self("companion@example.com", "companion@example.com") is True
assert bridge.is_automated_or_self("no-reply@svc.com", "a@b.com") is True
assert bridge.is_automated_or_self("owner@example.com", "a@b.com") is False

_eb = bridge.Bridge(argparse.Namespace(
    state_path=str(Path(tempfile.gettempdir()) / "latch-test-inbox-state.json"),
    worker_name="test", email_poll_interval=60, email_reply_channel="operations", email_reply_cap=3,
))
if Path(_eb.state_path).exists():
    Path(_eb.state_path).unlink()
_eb.ask_llm = lambda messages, **k: "Thanks - noted, I'll follow up."
_reports = []
_eb.report = lambda text, task_id="", channel="": _reports.append((channel, text))
_sent = []
_approvals = []
_INBOX = {"messages": []}


def _fake_request(method, path, body=None):
    if path == "/api/agent/email/poll":
        return {"ok": True, "fromAddress": "companion@example.com", "messages": _INBOX["messages"]}
    if path == "/api/agent/email/send":
        _sent.append(body)
        # simulate server known-contact gating: only owner@example.com is a known contact
        return {"ok": True, "to": body["to"]} if body["to"] == "owner@example.com" else {"status": "needs_approval"}
    if path == "/api/approvals":
        _approvals.append(body)
        return {"id": "appr_test"}
    return {}


_eb.request_json = _fake_request


def _poll_one(mid, sender, subject="Re: Hello", text="ok"):
    _eb.state["lastEmailPollAt"] = 0
    _INBOX["messages"] = [{"messageId": mid, "from": sender, "subject": subject, "body": text}]
    _eb.process_inbound_email({})


# 1) known sender -> auto-reply sent, threaded, surfaced
_poll_one("<m1>", "Owner <owner@example.com>")
assert len(_sent) == 1 and _sent[0]["to"] == "owner@example.com" and _sent[0]["inReplyTo"] == "<m1>", _sent
assert any("Replied to owner@example.com" in t for _c, t in _reports), _reports

# 2) same message id again -> deduped
_poll_one("<m1>", "owner@example.com")
assert len(_sent) == 1, "an already-seen email must not be answered twice"

# 3) unknown sender -> NOT auto-replied; surfaced for approval
_poll_one("<u1>", "stranger@example.com", subject="Hi", text="cold")
assert any("have not emailed them first" in t for _c, t in _reports), _reports

# 4) self/automated senders -> skipped entirely (no send attempt)
_before = len(_sent)
_eb.state["lastEmailPollAt"] = 0
_INBOX["messages"] = [
    {"messageId": "<self1>", "from": "companion@example.com", "subject": "loop", "body": "x"},
    {"messageId": "<auto1>", "from": "no-reply@svc.com", "subject": "auto", "body": "y"},
]
_eb.process_inbound_email({})
assert len(_sent) == _before, "self/automated senders must be skipped"

# 5) per-thread cap: 3 auto-replies, then pause + file a continue approval, no 4th send
_sent.clear()
_reports.clear()
_approvals.clear()
_eb.state["email_threads"] = {}
_eb.state["seen_emails"] = []
for _i in range(1, 4):
    _poll_one(f"<t{_i}>", "owner@example.com")
assert len(_sent) == 3, f"should auto-reply up to the cap (3), got {len(_sent)}"
_poll_one("<t4>", "owner@example.com")
assert len(_sent) == 3, "must NOT send a 4th auto-reply past the cap"
assert any(a.get("type") == "email_thread_continue" and a.get("emailTo") == "owner@example.com" for a in _approvals), _approvals
assert _eb.state["email_threads"]["owner@example.com"]["paused"] is True

# paused thread: further inbound -> no send, no duplicate continue approval
_appr_before = len(_approvals)
_poll_one("<t5>", "owner@example.com")
assert len(_sent) == 3 and len(_approvals) == _appr_before, "paused thread must not reply or re-ask"

# 6) operator approves the continue -> thread resumes
_eb.handle_approved_decision(
    {"type": "email_thread_continue", "status": "approved", "emailTo": "owner@example.com", "title": "continue"},
    "continue", "", "t", {}, {}, [], {},
)
assert _eb.state["email_threads"]["owner@example.com"]["paused"] is False
assert _eb.state["email_threads"]["owner@example.com"]["count"] == 0
_poll_one("<t6>", "owner@example.com")
assert len(_sent) == 4, "after approving continue, auto-replies resume"

Path(_eb.state_path).unlink()

# --- Multi-step task loop: one sub-goal per step, checkpoint after each, advance on approval ---
_lb = bridge.Bridge(argparse.Namespace(
    state_path=str(Path(tempfile.gettempdir()) / "latch-test-loop-state.json"),
    worker_name="test",
))
if Path(_lb.state_path).exists():
    Path(_lb.state_path).unlink()
_lb.state["task_loops"] = {}
_loop_answers = iter(["Did stage one.", "Did stage two."])
_lb.ask_llm = lambda messages, **k: next(_loop_answers)
_loop_reports = []
_lb.report = lambda text, task_id="", channel="": _loop_reports.append(text)
_loop_approvals = []
_loop_patches = []


def _loop_request(method, path, body=None):
    if path == "/api/approvals":
        _loop_approvals.append(body)
        return {"id": f"appr_{len(_loop_approvals)}"}
    if path.startswith("/api/tasks/"):
        _loop_patches.append((path, body))
        return {"ok": True}
    return {}


_lb.request_json = _loop_request
# Structured sub-goals: explicit {text, depth} objects (count is operator-defined, not inferred).
_loop_subgoals = [{"text": "Research 3 sites", "depth": 4}, {"text": "Email the draft", "depth": 6}]
assert bridge.subgoal_text(_loop_subgoals[0]) == "Research 3 sites"
assert bridge.subgoal_depth(_loop_subgoals[1], 5) == 6
assert bridge.subgoal_text("legacy string") == "legacy string" and bridge.subgoal_depth("legacy string", 5) == 5
_loop_task = {"id": "task_loop_1", "goal": "Compare and email", "channel": "operations", "subGoals": _loop_subgoals, "stepBudget": 12}

# kickoff works sub-goal 1, reports it, files ONE continue checkpoint, does not finish
_lb.start_task_loop(_loop_task, _loop_subgoals, [], {}, "operations", "local", False)
assert _lb.state["task_loops"]["task_loop_1"]["stepCount"] == 1, _lb.state["task_loops"]
assert any("Sub-goal 1/2" in t for t in _loop_reports), _loop_reports
assert len(_loop_approvals) == 1 and _loop_approvals[0]["type"] == "task_continue", _loop_approvals
assert _loop_approvals[0]["taskId"] == "task_loop_1"

# approving the checkpoint advances to the last sub-goal, which finishes the task (no new checkpoint)
_lb.advance_task_loop(_loop_task, [], {})
assert any("Sub-goal 2/2" in t for t in _loop_reports), _loop_reports
assert any("Task complete" in t for t in _loop_reports), _loop_reports
assert len(_loop_approvals) == 1, "the final sub-goal must not file another continue checkpoint"
assert "task_loop_1" not in _lb.state["task_loops"], "a completed loop clears its state"
assert any(p[0] == "/api/tasks/task_loop_1" and p[1].get("status") == "done" for p in _loop_patches), _loop_patches

# denying a checkpoint stops cleanly (paused, not failed) and clears the loop
_lb.state["task_loops"]["task_loop_2"] = {"subGoalIndex": 0, "stepCount": 1, "results": ["x"]}
_lb.stop_task_loop("task_loop_2")
assert "task_loop_2" not in _lb.state["task_loops"]
assert any(p[0] == "/api/tasks/task_loop_2" and p[1].get("status") == "paused" for p in _loop_patches), _loop_patches

Path(_lb.state_path).unlink()

# --- Draft-a-reply (operator send connector): worker drafts, files approved_connector approval ---
_cr = bridge.Bridge(argparse.Namespace(state_path=str(Path(tempfile.gettempdir()) / "latch-test-reply-state.json"), worker_name="test"))
if Path(_cr.state_path).exists():
    Path(_cr.state_path).unlink()
_cr.ask_llm = lambda messages, **k: "Sure, Tuesday works."
_cr.report = lambda text, task_id="", channel="": None
_cr_approvals = []


def _cr_request(method, path, body=None):
    if path == "/api/approvals":
        _cr_approvals.append(body)
        return {"id": "appr_reply"}
    if path.startswith("/api/tasks/"):
        return {"ok": True}
    return {}


_cr.request_json = _cr_request
_cr.draft_connector_reply(
    {"id": "task_reply", "title": "Reply to bob@example.com", "details": "Are you free Tuesday?", "replySubject": "Re: meeting"},
    "bob@example.com", {}, "operations", "local", False,
)
assert len(_cr_approvals) == 1, _cr_approvals
_reply_appr = _cr_approvals[0]
assert _reply_appr["type"] == "external_contact" and _reply_appr["sendMode"] == "approved_connector", _reply_appr
assert _reply_appr["recipient"] == "bob@example.com", _reply_appr
assert "Tuesday" in _reply_appr["contactBody"], _reply_appr
Path(_cr.state_path).unlink(missing_ok=True)

print("Worker read-only template tests passed.")
