#!/usr/bin/env python3
"""
Root-capable Latch executor for approved OpenClaw VM plans.

This service is intentionally separate from the text bridge. It only runs
approved command approvals with executionMode shell/browser and records audits.
"""

from __future__ import annotations

import argparse
import datetime as dt
import ipaddress
import json
import os
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


DEFAULT_STATE_PATH = Path("/var/lib/latch-agent-executor/state.json")
DEFAULT_WORK_DIR = Path("/var/lib/latch-agent-executor/work")
DEFAULT_BROWSER_DIR = Path("/var/lib/latch-agent-executor/browser")
DEFAULT_DOWNLOAD_DIR = Path("/var/lib/latch-agent-executor/downloads")
MAX_TIMEOUT_SECONDS = 1800


def main() -> int:
    parser = argparse.ArgumentParser(description="Execute approved Latch VM plans.")
    parser.add_argument("--base-url", default=os.getenv("LATCH_BASE_URL", "").rstrip("/"))
    parser.add_argument("--agent-key", default=os.getenv("LATCH_AGENT_KEY", ""))
    parser.add_argument("--interval", type=int, default=int(os.getenv("LATCH_EXECUTOR_POLL_INTERVAL", "10")))
    parser.add_argument("--state-path", default=os.getenv("LATCH_EXECUTOR_STATE_PATH", str(DEFAULT_STATE_PATH)))
    parser.add_argument("--work-dir", default=os.getenv("LATCH_EXECUTOR_WORK_DIR", str(DEFAULT_WORK_DIR)))
    parser.add_argument("--browser-dir", default=os.getenv("LATCH_EXECUTOR_BROWSER_DIR", str(DEFAULT_BROWSER_DIR)))
    parser.add_argument("--download-dir", default=os.getenv("LATCH_EXECUTOR_DOWNLOAD_DIR", str(DEFAULT_DOWNLOAD_DIR)))
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()

    if not args.base_url:
        print("Missing LATCH_BASE_URL or --base-url")
        return 2
    if not args.agent_key:
        print("Missing LATCH_AGENT_KEY or --agent-key")
        return 2

    executor = Executor(args)
    executor.ensure_dirs()
    executor.safe_report("Latch executor online. Mode: approved shell/browser execution.")
    while True:
        try:
            executor.tick()
        except Exception as exc:  # noqa: BLE001 - Latch may be temporarily unreachable
            print(f"Executor tick failed: {exc}", flush=True)
        if args.once:
            return 0
        time.sleep(max(5, args.interval))


class Executor:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.state_path = Path(args.state_path)
        self.state = self.load_state()

    def ensure_dirs(self) -> None:
        for directory in (
            self.state_path.parent,
            Path(self.args.work_dir),
            Path(self.args.browser_dir),
            Path(self.args.download_dir),
        ):
            directory.mkdir(parents=True, exist_ok=True)

    def tick(self) -> None:
        payload = self.request_json("GET", "/api/agent/poll")
        approvals = payload.get("approvals", []) if payload else []
        messages_by_id = {str(message.get("id") or ""): message for message in (payload.get("messages", []) if payload else [])}
        executed = set(self.state.setdefault("executed_approvals", []))
        for approval in reversed(approvals):
            approval_id = str(approval.get("id") or "")
            if not should_execute(approval) or approval_id in executed:
                continue
            result = self.execute_approval(approval)
            self.request_json("POST", "/api/agent/executions", result)
            source_message = messages_by_id.get(str(approval.get("messageId") or ""))
            report_channel = str(source_message.get("channel") or "operations") if source_message else "operations"
            self.report(format_execution_report(result), result.get("taskId") or "", report_channel)
            if result.get("taskId"):
                status = "done" if result["exitCode"] == 0 else "failed"
                note = f"{result['mode']} execution exited {result['exitCode']}."
                self.request_json("PATCH", f"/api/tasks/{result['taskId']}", {"status": status, "note": note})
            executed.add(approval_id)
            self.state["executed_approvals"] = sorted(executed)[-1000:]
            self.save_state()

    def execute_approval(self, approval: dict) -> dict:
        started = utc_now()
        plan = sanitize_execution_plan(approval.get("executionPlan") or {})
        mode = plan["mode"]
        try:
            if mode == "shell":
                result = run_shell_plan(plan, Path(self.args.work_dir))
            elif mode == "browser":
                result = run_browser_plan(
                    plan,
                    Path(self.args.browser_dir),
                    default_download_dir=Path(self.args.download_dir) / str(approval.get("id") or "approval"),
                )
            else:
                raise RuntimeError(f"Unsupported execution mode: {mode}")
        except Exception as exc:  # noqa: BLE001 - audit failures too
            result = {"exitCode": 1, "stdout": "", "stderr": str(exc), "commands": plan.get("commands", [])}
        return {
            "approvalId": str(approval.get("id") or ""),
            "taskId": str(approval.get("taskId") or ""),
            "messageId": str(approval.get("messageId") or ""),
            "template": str(approval.get("actionTemplate") or ""),
            "mode": mode,
            "commands": result.get("commands", plan.get("commands", [])),
            "executionPlan": plan,
            "exitCode": int(result.get("exitCode", 1)),
            "stdout": str(result.get("stdout", ""))[:3000],
            "stderr": str(result.get("stderr", ""))[:3000],
            "startedAt": started,
            "finishedAt": utc_now(),
        }

    def report(self, text: str, task_id: str = "", channel: str = "operations") -> None:
        body = {"text": text, "channel": channel or "operations"}
        if task_id:
            body["taskId"] = task_id
        self.request_json("POST", "/api/agent/report", body)

    def safe_report(self, text: str, task_id: str = "", channel: str = "operations") -> None:
        try:
            self.report(text, task_id, channel)
        except Exception as exc:  # noqa: BLE001 - service should keep retrying
            print(f"Executor report failed: {exc}", flush=True)

    def request_json(self, method: str, path: str, body: dict | None = None) -> dict | None:
        data = None
        headers = {"Authorization": f"Bearer {self.args.agent_key}"}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(f"{self.args.base_url}{path}", data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"{method} {path} failed: {exc.code} {raw}") from exc
        return json.loads(raw) if raw else {}

    def load_state(self) -> dict:
        try:
            return json.loads(self.state_path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 - missing/corrupt state should not brick service
            return {}

    def save_state(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(json.dumps(self.state, indent=2, sort_keys=True), encoding="utf-8")


def should_execute(approval: dict) -> bool:
    return (
        approval.get("status") == "approved"
        and approval.get("type") == "command"
        and approval.get("executionMode") in {"shell", "browser"}
        and not approval.get("sensitive")
    )


def sanitize_execution_plan(plan: dict) -> dict:
    if not isinstance(plan, dict):
        raise RuntimeError("Execution plan must be an object.")
    mode = str(plan.get("mode") or plan.get("executionMode") or "").strip()
    if mode not in {"shell", "browser"}:
        raise RuntimeError("Execution plan mode must be shell or browser.")
    timeout = clamp_int(plan.get("timeoutSeconds"), 1, MAX_TIMEOUT_SECONDS, 300)
    commands = [str(command).strip() for command in list(plan.get("commands") or [])[:20] if str(command).strip()]
    actions = []
    for action in list(plan.get("actions") or [])[:40]:
        if not isinstance(action, dict):
            continue
        action_type = str(action.get("type") or "").strip()
        if action_type not in {"open", "extract_text", "screenshot", "click", "fill", "press", "wait", "download", "search_web"}:
            continue
        actions.append(
            {
                "type": action_type,
                "url": str(action.get("url") or "").strip(),
                "selector": str(action.get("selector") or "").strip(),
                "text": str(action.get("text") or ""),
                "key": str(action.get("key") or "").strip(),
                "path": str(action.get("path") or "").strip(),
                "timeoutMs": clamp_int(action.get("timeoutMs"), 0, 120000, 0),
                "maxResults": clamp_int(action.get("maxResults"), 1, 5, 3),
            }
        )
    if mode == "shell" and not commands:
        raise RuntimeError("Shell plans require at least one command.")
    if mode == "browser" and not actions:
        raise RuntimeError("Browser plans require at least one action.")
    return {
        "mode": mode,
        "summary": str(plan.get("summary") or "")[:1000],
        "sensitive": bool(plan.get("sensitive")),
        "riskLevel": str(plan.get("riskLevel") or "medium")[:20],
        "timeoutSeconds": timeout,
        "commands": commands,
        "actions": actions,
        "expectedResult": str(plan.get("expectedResult") or "")[:1000],
    }


def run_shell_plan(plan: dict, work_dir: Path) -> dict:
    stdout_parts = []
    stderr_parts = []
    exit_code = 0
    deadline = time.monotonic() + int(plan["timeoutSeconds"])
    work_dir.mkdir(parents=True, exist_ok=True)
    for command in plan["commands"]:
        remaining = max(1, int(deadline - time.monotonic()))
        try:
            completed = subprocess.run(
                ["bash", "-lc", command],
                cwd=str(work_dir),
                text=True,
                capture_output=True,
                timeout=remaining,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return {
                "exitCode": 124,
                "stdout": "\n".join(stdout_parts),
                "stderr": "\n".join(stderr_parts + [f"$ {command}\nTimed out."]),
                "commands": plan["commands"],
            }
        stdout_parts.append(f"$ {command}\n{completed.stdout.strip()}")
        if completed.stderr.strip():
            stderr_parts.append(f"$ {command}\n{completed.stderr.strip()}")
        exit_code = completed.returncode
        if completed.returncode != 0:
            break
    return {
        "exitCode": exit_code,
        "stdout": "\n".join(part for part in stdout_parts if part.strip()),
        "stderr": "\n".join(part for part in stderr_parts if part.strip()),
        "commands": plan["commands"],
    }


def run_browser_plan(plan: dict, browser_dir: Path, default_download_dir: Path) -> dict:
    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:  # noqa: BLE001 - installer provides this dependency
        raise RuntimeError(f"Playwright is not available: {exc}") from exc

    browser_dir.mkdir(parents=True, exist_ok=True)
    default_download_dir.mkdir(parents=True, exist_ok=True)
    notes = []
    with sync_playwright() as playwright:
        context = playwright.firefox.launch_persistent_context(
            user_data_dir=str(browser_dir),
            headless=True,
            accept_downloads=True,
        )
        page = context.pages[0] if context.pages else context.new_page()
        try:
            for action in plan["actions"]:
                action_type = action["type"]
                if action_type == "open":
                    # SECURITY (pre-public review H3): only search_web checked for private/local
                    # targets before; "open" let an approved plan's URL reach the internal network
                    # unchecked. Approval still gates the plan itself -- this stops a plan whose URL
                    # was rewritten or misjudged from reaching an internal/metadata address.
                    reject_private_url(action["url"])
                    page.goto(action["url"], wait_until="domcontentloaded", timeout=action["timeoutMs"] or 30000)
                    notes.append(f"Opened {page.url}")
                elif action_type == "extract_text":
                    title = page.title()
                    text = page.locator("body").inner_text(timeout=action["timeoutMs"] or 10000)
                    notes.append(f"Title: {title}\n{text[:2500]}")
                elif action_type == "screenshot":
                    target = confine_path(action["path"], default_download_dir, "screenshot.png")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    page.screenshot(path=str(target), full_page=True)
                    notes.append(f"Screenshot: {target}")
                elif action_type == "click":
                    page.locator(action["selector"]).click(timeout=action["timeoutMs"] or 10000)
                    notes.append(f"Clicked {action['selector']}")
                elif action_type == "fill":
                    page.locator(action["selector"]).fill(action["text"], timeout=action["timeoutMs"] or 10000)
                    notes.append(f"Filled {action['selector']}")
                elif action_type == "press":
                    page.keyboard.press(action["key"])
                    notes.append(f"Pressed {action['key']}")
                elif action_type == "wait":
                    page.wait_for_timeout(action["timeoutMs"] or 1000)
                    notes.append("Waited")
                elif action_type == "download":
                    target = confine_path(action["path"], default_download_dir, "download")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    if action["url"]:
                        reject_private_url(action["url"])
                        page.goto(action["url"], wait_until="domcontentloaded", timeout=action["timeoutMs"] or 30000)
                    with page.expect_download(timeout=action["timeoutMs"] or 30000) as download_info:
                        if action["selector"]:
                            page.locator(action["selector"]).click()
                    download = download_info.value
                    final_target = target if target.suffix else target / download.suggested_filename
                    final_target.parent.mkdir(parents=True, exist_ok=True)
                    download.save_as(str(final_target))
                    notes.append(f"Downloaded: {final_target}")
                elif action_type == "search_web":
                    notes.extend(run_search_web_action(page, action))
        finally:
            context.close()
    return {"exitCode": 0, "stdout": "\n\n".join(notes), "stderr": "", "commands": []}


def run_search_web_action(page, action: dict) -> list[str]:
    query = str(action.get("text") or "").strip()
    if not query:
        raise RuntimeError("search_web requires a query in action.text.")
    max_results = clamp_int(action.get("maxResults"), 1, 5, 3)
    timeout = action.get("timeoutMs") or 60000
    search_url = f"https://duckduckgo.com/html/?q={urllib.parse.quote_plus(query)}"
    page.goto(search_url, wait_until="domcontentloaded", timeout=timeout)
    page.wait_for_timeout(1000)
    links = page.eval_on_selector_all(
        "a",
        """
        (anchors) => anchors.map((anchor) => ({
          text: (anchor.innerText || anchor.textContent || '').trim(),
          href: anchor.href || ''
        })).filter((item) => item.href && item.text)
        """,
    )
    results = []
    seen = set()
    for item in links:
        url = normalize_search_result_url(str(item.get("href") or ""))
        title = " ".join(str(item.get("text") or "").split())[:180]
        if not url or url in seen or not title:
            continue
        try:
            reject_private_url(url)
        except RuntimeError:
            continue
        seen.add(url)
        results.append({"title": title, "url": url})
        if len(results) >= max_results:
            break

    notes = [f"Search query: {query}", f"Search URL: {search_url}", f"Results selected: {len(results)}"]
    for index, result in enumerate(results, start=1):
        try:
            page.goto(result["url"], wait_until="domcontentloaded", timeout=timeout)
            title = page.title() or result["title"]
            text = page.locator("body").inner_text(timeout=10000)
            excerpt = " ".join(text.split())[:1800]
            notes.append(f"Source {index}: {title}\nURL: {page.url}\nExcerpt: {excerpt}")
        except Exception as exc:  # noqa: BLE001 - continue with other results
            notes.append(f"Source {index}: {result['title']}\nURL: {result['url']}\nError: {exc}")
    if not results:
        notes.append("No public search results were opened.")
    return notes


def normalize_search_result_url(url: str) -> str:
    if url.startswith("//"):
        url = f"https:{url}"
    parsed = urllib.parse.urlparse(url)
    if parsed.netloc.endswith("duckduckgo.com") and parsed.path.startswith("/l/"):
        query = urllib.parse.parse_qs(parsed.query)
        redirected = query.get("uddg", [""])[0]
        if redirected:
            url = redirected
            parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, parsed.path or "/", "", parsed.query, ""))


def reject_private_url(url: str) -> None:
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower()
    if not host or host in {"localhost", "127.0.0.1", "::1"} or host.endswith(".local"):
        raise RuntimeError("Private or local search result URL is not allowed.")
    try:
        ip = ipaddress.ip_address(host)
        if is_private_ip(ip):
            raise RuntimeError("Private or local search result URL is not allowed.")
        return
    except ValueError:
        pass
    for _family, _type, _proto, _canonname, sockaddr in socket.getaddrinfo(host, None):
        ip = ipaddress.ip_address(sockaddr[0])
        if is_private_ip(ip):
            raise RuntimeError("Search result resolved to a private or local IP address.")


def is_private_ip(ip: ipaddress._BaseAddress) -> bool:
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def format_execution_report(result: dict) -> str:
    text = [
        "VM execution completed.",
        f"Mode: {result.get('mode')}",
        f"Exit code: {result.get('exitCode')}",
    ]
    if result.get("stdout"):
        text.append(f"Output:\n{result['stdout']}")
    if result.get("stderr"):
        text.append(f"Errors:\n{result['stderr']}")
    return "\n\n".join(text)[:6000]


def confine_path(requested: str, base_dir: Path, default_name: str) -> Path:
    """Constrain a plan-supplied write path to base_dir.

    SECURITY (pre-public review F3): screenshot/download actions carried a free-form `path`. The
    executor runs as root, so an approved plan whose path was rewritten or misjudged could write
    anywhere on the worker (e.g. /etc). Resolve the request relative to base_dir and reject any
    result that escapes it; fall back to a safe name inside base_dir.
    """
    base = base_dir.resolve()
    candidate = (base / (requested or default_name)).resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        candidate = base / default_name
    return candidate


def clamp_int(value: object, minimum: int, maximum: int, fallback: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, number))


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


if __name__ == "__main__":
    raise SystemExit(main())
