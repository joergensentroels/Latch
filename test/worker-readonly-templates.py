import argparse
import importlib.util
import sys
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

research = bridge.detect_approval_need(
    "Research docs",
    "Please browse https://example.com/docs and summarize the install path without scraping too much.",
)
assert research.type == "web_research"
assert research.allowed_domains == ("example.com",)
assert research.max_pages == 5
assert research.token_budget == 3000

print("Worker read-only template tests passed.")
