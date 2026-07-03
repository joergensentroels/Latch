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

print("Worker read-only template tests passed.")
