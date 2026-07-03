import importlib.util
import shutil
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXECUTOR_PATH = ROOT / "worker" / "latch-agent-executor.py"
BRIDGE_PATH = ROOT / "worker" / "latch-agent-bridge.py"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


executor = load_module("latch_agent_executor", EXECUTOR_PATH)
bridge = load_module("latch_agent_bridge_for_executor_test", BRIDGE_PATH)


shell_plan = executor.sanitize_execution_plan(
    {
        "mode": "shell",
        "summary": "Say hello",
        "sensitive": False,
        "riskLevel": "low",
        "timeoutSeconds": 1,
        "commands": ["echo hello"],
        "expectedResult": "hello",
    }
)
assert shell_plan["mode"] == "shell"
assert shell_plan["commands"] == ["echo hello"]

browser_plan = executor.sanitize_execution_plan(
    {
        "mode": "browser",
        "timeoutSeconds": 60,
        "actions": [
            {"type": "open", "url": "https://example.com"},
            {"type": "extract_text"},
            {"type": "screenshot", "path": "/tmp/example.png"},
            {"type": "search_web", "text": "Jane Doe Example Corp", "maxResults": 4},
            {"type": "unknown"},
        ],
    }
)
assert browser_plan["mode"] == "browser"
assert [action["type"] for action in browser_plan["actions"]] == ["open", "extract_text", "screenshot", "search_web"]
assert browser_plan["actions"][-1]["maxResults"] == 4
assert executor.normalize_search_result_url("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fprofile") == "https://example.com/profile"

for bad_plan in (
    {"mode": "shell", "commands": []},
    {"mode": "browser", "actions": []},
    {"mode": "sudo", "commands": ["whoami"]},
):
    try:
        executor.sanitize_execution_plan(bad_plan)
        raise AssertionError(f"bad plan accepted: {bad_plan}")
    except RuntimeError:
        pass

assert executor.should_execute(
    {"status": "approved", "type": "command", "executionMode": "shell", "sensitive": False}
)
assert not executor.should_execute(
    {"status": "pending", "type": "command", "executionMode": "shell", "sensitive": False}
)
assert not executor.should_execute(
    {"status": "approved", "type": "credential", "executionMode": "shell", "sensitive": True}
)

json_text = bridge.extract_json_object('```json\n{"mode":"shell","commands":["id"]}\n```')
assert json_text == '{"mode":"shell","commands":["id"]}'
parsed = bridge.sanitize_execution_plan({"mode": "shell", "commands": ["id"], "riskLevel": "low"})
assert parsed["commands"] == ["id"]

github_file = bridge.detect_github_file_request(
    "Inbox instruction",
    "Let's have you write hello there somewhere in the readme file",
)
assert github_file is not None
assert github_file.github_repo_name == "CompassProjects"
assert github_file.github_file_path == "README.md"
assert "inbox-instruction" not in github_file.details

explicit_github_file = bridge.detect_github_file_request(
    "Inbox instruction",
    "Update README in repo CompassProjects with hello there",
)
assert explicit_github_file is not None
assert explicit_github_file.github_repo_name == "CompassProjects"

if shutil.which("bash"):
    with tempfile.TemporaryDirectory() as tmp:
        timeout_result = executor.run_shell_plan(
            {"timeoutSeconds": 1, "commands": ["sleep 2"]},
            Path(tmp),
        )
        assert timeout_result["exitCode"] == 124

print("Executor tests passed.")
