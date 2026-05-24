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

research = bridge.detect_approval_need(
    "Research docs",
    "Please browse https://example.com/docs and summarize the install path without scraping too much.",
)
assert research.type == "web_research"
assert research.allowed_domains == ("example.com",)
assert research.seed_urls == ("https://example.com/docs",)
assert research.max_pages == 5
assert research.token_budget == 3000

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

print("Worker read-only template tests passed.")
