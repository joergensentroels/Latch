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

# THE GUARD ASKED A PROXY QUESTION, and so did the first attempt to fix it.
#
# It was `if shutil.which("bash")`. Git Bash is on PATH on the windows-latest runner, so the guard passed,
# the case ran, and `assert exitCode == 124` failed there on the first Windows CI run of this repo.
#
# The first fix was to skip on Windows entirely, on the reasoning that latch-agent-executor is a Linux
# systemd unit (ExecStart=/opt/latch-agent-executor/bin/python, state under /var/lib) so POSIX process
# behaviour is not assertable elsewhere. That reasoning was tidy and WRONG: run directly on the operator's
# own Windows machine, this case returns 124 correctly -- bash runs, `sleep 2` sleeps, the timeout fires and
# the executor sets its own exit code. Skipping on Windows would have deleted coverage that works, on a
# platform story that is not true. Reproducing locally is what caught it; the platform argument alone would
# not have.
#
# So the precondition is neither "is there a bash" nor "is this Linux". It is: CAN THE SHELL THIS EXECUTOR
# WOULD USE ACTUALLY RUN A COMMAND HERE. That is what the timeout assertion depends on, and it is the only
# question whose answer settles whether a failure means the contract is broken or the environment cannot
# host the case. On windows-latest `bash` most likely resolves to the WSL stub in System32, which without a
# distro fails immediately -- so the command never lasts long enough for a timeout to fire, and the exit
# code is whatever that failure produced. That is a guess about the runner and is deliberately not asserted;
# the probe below settles it either way without needing to know.
#
# 124 is the executor's OWN contract, set on subprocess.TimeoutExpired rather than borrowed from the
# timeout(1) coreutil, so the number was never the platform-specific part.
#
# EVERY SKIP IS STATED, and names the exit code it saw. A case that quietly disappears on one leg is
# indistinguishable from one that passed there, which is the failure the two-platform matrix exists to
# remove -- and the original had no `else` at all, so a machine without bash skipped this in silence.
probe = None
if shutil.which("bash"):
    with tempfile.TemporaryDirectory() as tmp:
        probe = executor.run_shell_plan({"timeoutSeconds": 10, "commands": ["exit 0"]}, Path(tmp))

if probe is None:
    print("Executor tests: SKIPPED the shell-timeout case -- no bash on PATH to run it with.")
elif probe.get("exitCode") != 0:
    print("Executor tests: SKIPPED the shell-timeout case -- bash is on PATH but cannot run a trivial "
          "command here (exit %r), so a timeout assertion would measure this environment rather than the "
          "executor." % (probe.get("exitCode"),))
else:
    with tempfile.TemporaryDirectory() as tmp:
        timeout_result = executor.run_shell_plan(
            {"timeoutSeconds": 1, "commands": ["sleep 2"]},
            Path(tmp),
        )
        # The failure message carries the whole result: "assert == 124" alone told CI nothing about what it
        # got instead, which is why the cause took a local reproduction to find.
        assert timeout_result["exitCode"] == 124, (
            "a 1s timeout on `sleep 2` should report the executor's 124, got %r" % (timeout_result,))

print("Executor tests passed.")
