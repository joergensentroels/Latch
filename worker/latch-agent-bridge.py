#!/usr/bin/env python3
"""
Safe Latch bridge for an OpenClaw worker VM.

This script does not execute tasks. It only:
- checks optional OpenClaw Gateway health
- reports worker status to Latch
- polls queued work, inbox instructions, and pending approvals
- answers tasks/instructions through Latch's external LLM gateway
- records seen IDs locally so it does not spam repeated reports
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path


DEFAULT_STATE_PATH = Path.home() / ".local" / "state" / "latch-agent-bridge" / "state.json"
SYSTEM_PROMPT = """You are the text-only Latch worker for a private OpenClaw setup.
You may help with planning, explanation, coding advice, and next-step suggestions.
You cannot run shell commands, browse, use credentials, create accounts, make purchases, access payment tools, or perform actions outside this chat.
If a request needs a real-world action, credential, purchase, account setup, CAPTCHA, or command execution, say what you would need and ask the operator to approve or perform that step manually.
If you need durable context from the operator before giving a good answer, include one to three lines that start exactly with CONTEXT_QUESTION: followed by a concrete question.
Keep replies concise and practical."""


@dataclass(frozen=True)
class ApprovalNeed:
    type: str
    title: str
    details: str
    expected_response: str
    sensitive: bool
    command: str = ""


RISK_RULES = [
    (
        "purchase",
        ("buy", "purchase", "order", "checkout", "payment", "pay ", "invoice", "subscribe", "subscription"),
        "Purchase approval needed",
        "The request appears to involve payment, purchase, checkout, subscription, or spending.",
        "Approve only after reviewing cost, vendor, and exact action. The text-only bridge will not perform the purchase.",
        True,
    ),
    (
        "credential",
        ("password", "credential", "api key", "token", "secret", "2fa", "mfa", "recovery code", "login", "sign in"),
        "Credential help needed",
        "The request appears to involve credentials, login, tokens, MFA, or sensitive account access.",
        "Provide only the minimum non-secret result needed, or deny if credentials should not be shared.",
        True,
    ),
    (
        "account_setup",
        ("create account", "new account", "register", "sign up", "proton", "email account", "verify email"),
        "Account setup help needed",
        "The request appears to involve creating or verifying an account.",
        "Complete the account step manually if appropriate, then add a short note with the result.",
        True,
    ),
    (
        "human_verification",
        ("captcha", "verification", "verify you are human", "human check", "email code", "sms code"),
        "Human verification needed",
        "The request appears to require a CAPTCHA, verification code, or other human-presence step.",
        "Complete the verification manually, or paste only the short non-sensitive code if one is required.",
        True,
    ),
    (
        "command",
        ("run command", "execute", "powershell", "terminal", "shell", "sudo", "docker", "systemctl", "ssh ", "scp ", "install "),
        "Command approval needed",
        "The request appears to require executing a command or changing a system.",
        "Review the command/action. Approval is recorded, but the text-only bridge will not execute it yet.",
        False,
    ),
]


def main() -> int:
    parser = argparse.ArgumentParser(description="Safe text-only Latch bridge for OpenClaw workers.")
    parser.add_argument("--base-url", default=os.getenv("LATCH_BASE_URL", "").rstrip("/"))
    parser.add_argument("--agent-key", default=os.getenv("LATCH_AGENT_KEY", ""))
    parser.add_argument("--worker-name", default=os.getenv("LATCH_WORKER_NAME", socket.gethostname()))
    parser.add_argument("--openclaw-health-url", default=os.getenv("OPENCLAW_HEALTH_URL", ""))
    parser.add_argument("--interval", type=int, default=int(os.getenv("LATCH_POLL_INTERVAL", "15")))
    parser.add_argument("--state-path", default=os.getenv("LATCH_STATE_PATH", str(DEFAULT_STATE_PATH)))
    parser.add_argument("--max-tasks-per-tick", type=int, default=int(os.getenv("LATCH_MAX_TASKS_PER_TICK", "1")))
    parser.add_argument("--max-messages-per-tick", type=int, default=int(os.getenv("LATCH_MAX_MESSAGES_PER_TICK", "1")))
    parser.add_argument("--process-existing-messages", action="store_true", default=env_bool("LATCH_PROCESS_EXISTING_MESSAGES", False))
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()

    if not args.base_url:
        print("Missing LATCH_BASE_URL or --base-url", file=sys.stderr)
        return 2
    if not args.agent_key:
        print("Missing LATCH_AGENT_KEY or --agent-key", file=sys.stderr)
        return 2

    bridge = Bridge(args)
    bridge.report(f"{args.worker_name} bridge online. Mode: safe text-only assistant.")

    while True:
        bridge.tick()
        if args.once:
            return 0
        time.sleep(max(5, args.interval))


class Bridge:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.state_path = Path(args.state_path)
        self.state = self.load_state()

    def tick(self) -> None:
        gateway = self.check_openclaw_gateway()
        if gateway:
            last = self.state.get("lastGatewayStatus")
            if gateway != last:
                self.report(f"OpenClaw Gateway health changed: {gateway}")
                self.state["lastGatewayStatus"] = gateway

        payload = self.request_json("GET", "/api/agent/poll")
        if not payload:
            return

        tasks = payload.get("tasks", [])
        messages = payload.get("messages", [])
        context_items = payload.get("contextItems", [])
        self.process_approval_decisions(payload.get("approvals", []), tasks, messages, context_items)
        self.process_tasks(tasks, context_items)
        self.process_messages(messages, context_items)
        self.save_state()

    def check_openclaw_gateway(self) -> str:
        url = self.args.openclaw_health_url
        if not url:
            return ""
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                return f"ok {response.status} at {url}"
        except Exception as exc:  # noqa: BLE001 - status text is enough for this bridge
            return f"unreachable at {url}: {exc}"

    def report_new_items(self, bucket: str, items: list[dict], prefix: str) -> None:
        seen = set(self.state.setdefault(f"seen_{bucket}", []))
        changed = False
        for item in items:
            item_id = str(item.get("id", ""))
            if not item_id or item_id in seen:
                continue
            if bucket == "approvals" and item.get("status") != "pending":
                continue
            title = str(item.get("title") or item.get("text") or item_id)[:180]
            status = str(item.get("status", ""))
            self.report(f"{prefix}: {title} {f'[{status}]' if status else ''}".strip(), item_id)
            seen.add(item_id)
            changed = True
        if changed:
            self.state[f"seen_{bucket}"] = sorted(seen)[-500:]

    def process_tasks(self, tasks: list[dict], context_items: list[dict]) -> None:
        queued = [task for task in tasks if task.get("status") == "queued"]
        for task in queued[: max(0, self.args.max_tasks_per_tick)]:
            task_id = str(task.get("id", ""))
            if not task_id or task_id in set(self.state.setdefault("processed_tasks", [])):
                continue
            title = clean(task.get("title") or "Untitled task", 180)
            details = clean(task.get("details") or "", 6000)
            try:
                approval = detect_approval_need(title, details)
                if approval:
                    self.patch_task(task_id, "waiting", "Waiting for operator approval or human help.")
                    created = self.create_approval(approval, task_id=task_id)
                    suffix = f" ({created.get('id')})" if created else ""
                    self.report(f"Approval requested for task: {title}{suffix}", task_id)
                    self.remember("processed_tasks", task_id)
                    continue

                self.patch_task(task_id, "running", f"{self.args.worker_name} is drafting a text-only response.")
                answer = self.ask_llm(
                    [
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "system", "content": context_briefing(context_items)},
                        {
                            "role": "user",
                            "content": (
                                "Handle this queued Latch task as a text-only assistant.\n\n"
                                f"Title: {title}\n\n"
                                f"Details:\n{details or '(no details)'}"
                            ),
                        },
                    ]
                )
                questions = extract_context_questions(answer)
                if questions:
                    created = self.create_context_question(questions, task_id=task_id)
                    suffix = f" ({created.get('id')})" if created else ""
                    self.report(f"Context question requested for task: {title}{suffix}", task_id)
                    self.patch_task(task_id, "waiting", "Waiting for operator context answer.")
                    self.remember("processed_tasks", task_id)
                    continue
                self.report(f"Task completed: {title}\n\n{answer}", task_id)
                self.patch_task(task_id, "done", "Text-only response posted to inbox.")
                self.remember("processed_tasks", task_id)
            except Exception as exc:  # noqa: BLE001 - keep bridge alive and report failure
                self.report(f"Task failed: {title}\n\n{exc}", task_id)
                self.patch_task(task_id, "failed", str(exc)[:1800])
                self.remember("processed_tasks", task_id)

    def process_messages(self, messages: list[dict], context_items: list[dict]) -> None:
        operator_messages = [
            message for message in messages
            if message.get("direction") == "operator_to_agent" and message.get("text")
        ]
        seen = set(self.state.setdefault("processed_messages", []))

        if not self.state.get("messageBaselineReady") and not self.args.process_existing_messages:
            for message in operator_messages:
                message_id = str(message.get("id", ""))
                if message_id:
                    seen.add(message_id)
            self.state["processed_messages"] = sorted(seen)[-500:]
            self.state["messageBaselineReady"] = True
            return

        self.state["messageBaselineReady"] = True
        new_messages = [
            message for message in reversed(operator_messages)
            if str(message.get("id", "")) and str(message.get("id", "")) not in seen
        ]
        for message in new_messages[: max(0, self.args.max_messages_per_tick)]:
            message_id = str(message.get("id", ""))
            text = clean(message.get("text") or "", 6000)
            try:
                approval = detect_approval_need("Inbox instruction", text)
                if approval:
                    created = self.create_approval(approval, message_id=message_id)
                    suffix = f" ({created.get('id')})" if created else ""
                    self.report(f"Approval requested for inbox instruction{suffix}.", message_id)
                    self.remember("processed_messages", message_id)
                    continue

                answer = self.ask_llm(
                    [
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "system", "content": context_briefing(context_items)},
                        {
                            "role": "user",
                            "content": (
                                "Reply to this Latch inbox instruction as a text-only assistant.\n\n"
                                f"Instruction:\n{text}"
                            ),
                        },
                    ]
                )
                questions = extract_context_questions(answer)
                if questions:
                    created = self.create_context_question(questions, message_id=message_id)
                    suffix = f" ({created.get('id')})" if created else ""
                    self.report(f"Context question requested for inbox instruction{suffix}.", message_id)
                    self.remember("processed_messages", message_id)
                    continue
                self.report(f"Reply to inbox instruction:\n\n{answer}", message_id)
                self.remember("processed_messages", message_id)
            except Exception as exc:  # noqa: BLE001 - keep bridge alive and avoid hot loops
                self.report(f"Could not answer inbox instruction yet: {exc}", message_id)
                self.remember("processed_messages", message_id)

    def ask_llm(self, messages: list[dict]) -> str:
        response = self.request_json(
            "POST",
            "/api/llm/chat",
            {
                "messages": messages,
                "temperature": 0.2,
                "maxTokens": 700,
            },
        )
        if not response:
            raise RuntimeError("Latch LLM gateway did not return a response.")
        if not response.get("ok"):
            detail = response.get("error") or response.get("status") or "unknown_error"
            raise RuntimeError(f"Latch LLM gateway returned {detail}.")
        text = clean(response.get("text") or "", 6000)
        if not text:
            raise RuntimeError("Latch LLM gateway returned an empty response.")
        return text

    def create_approval(self, approval: ApprovalNeed, task_id: str = "", message_id: str = "") -> dict:
        response = self.request_json(
            "POST",
            "/api/approvals",
            {
                "type": approval.type,
                "title": approval.title,
                "details": approval.details,
                "command": approval.command,
                "expectedResponse": approval.expected_response,
                "sensitive": approval.sensitive,
                "taskId": task_id,
                "messageId": message_id,
            },
        )
        if not response:
            raise RuntimeError("Latch did not create the approval request.")
        return response

    def create_context_question(self, questions: list[str], task_id: str = "", message_id: str = "") -> dict:
        question_text = "\n".join(f"- {question}" for question in questions[:3])
        response = self.request_json(
            "POST",
            "/api/approvals",
            {
                "type": "context_question",
                "title": "Context question",
                "details": question_text,
                "expectedResponse": "Answer this if you want it saved as worker context. Keep secrets out of the answer.",
                "contextCategory": "memory",
                "contextTags": ["operator-answer"],
                "sensitive": False,
                "taskId": task_id,
                "messageId": message_id,
            },
        )
        if not response:
            raise RuntimeError("Latch did not create the context question.")
        return response

    def process_approval_decisions(
        self,
        approvals: list[dict],
        tasks: list[dict],
        messages: list[dict],
        context_items: list[dict],
    ) -> None:
        seen = set(self.state.setdefault("seen_approval_decisions", []))
        tasks_by_id = {str(task.get("id", "")): task for task in tasks}
        messages_by_id = {str(message.get("id", "")): message for message in messages}
        for approval in reversed(approvals):
            approval_id = str(approval.get("id", ""))
            status = str(approval.get("status", ""))
            if not approval_id or approval_id in seen or status not in {"approved", "denied"}:
                continue

            title = clean(approval.get("title") or approval_id, 180)
            note = clean(approval.get("responseNote") or "", 1000)
            task_id = clean(approval.get("taskId") or approval.get("messageId") or approval_id, 120)
            if approval.get("taskId"):
                self.remember("processed_tasks", str(approval.get("taskId")))
            if approval.get("messageId"):
                self.remember("processed_messages", str(approval.get("messageId")))
            if status == "approved":
                self.handle_approved_decision(approval, title, note, task_id, tasks_by_id, messages_by_id, context_items)
            else:
                self.report(
                    f"Approval denied: {title}.{f' Operator note: {note}' if note else ''}",
                    task_id,
                )
                if approval.get("taskId"):
                    self.patch_task(task_id, "failed", "Approval denied by operator.")
            seen.add(approval_id)
            self.state["seen_approval_decisions"] = sorted(seen)[-500:]

    def handle_approved_decision(
        self,
        approval: dict,
        title: str,
        note: str,
        task_id: str,
        tasks_by_id: dict[str, dict],
        messages_by_id: dict[str, dict],
        context_items: list[dict],
    ) -> None:
        approval_type = str(approval.get("type", "other"))
        is_sensitive = bool(approval.get("sensitive"))
        task = tasks_by_id.get(str(approval.get("taskId", "")))
        message = messages_by_id.get(str(approval.get("messageId", "")))

        if approval_type == "context_question":
            self.report(
                f"Context answer recorded: {title}\n\nThe answer was saved into Latch Context for future worker responses.",
                task_id,
            )
            if approval.get("taskId"):
                self.patch_task(task_id, "queued", "Operator context answer saved. Task can be reconsidered.")
                self.state.setdefault("processed_tasks", [])
                self.state["processed_tasks"] = [
                    item for item in self.state["processed_tasks"]
                    if item != str(approval.get("taskId"))
                ]
            return

        if approval_type in {"command", "purchase"}:
            self.report(
                f"Approval recorded: {title}\n\nThe text-only bridge will not execute commands, make purchases, or handle secrets yet."
                f"{f' Operator note: {note}' if note else ''}",
                task_id,
            )
            if approval.get("taskId"):
                self.patch_task(task_id, "paused", "Approval recorded. Execution is not enabled in text-only mode.")
            return

        if is_sensitive:
            self.report(
                f"Sensitive approval recorded: {title}\n\nOperator note was not forwarded to the external LLM. Continue manually if the note contains credentials, verification codes, or private account details.",
                task_id,
            )
            if approval.get("taskId"):
                self.patch_task(task_id, "paused", "Sensitive approval recorded. Note was not forwarded to the LLM.")
            return

        if not note:
            self.report(
                f"Approval recorded: {title}\n\nNo operator note was provided, so there is nothing further to process.",
                task_id,
            )
            if approval.get("taskId"):
                self.patch_task(task_id, "paused", "Approval recorded without an operator note.")
            return

        original = original_request_text(task, message, approval)
        answer = self.ask_llm(
            [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "system", "content": context_briefing(context_items)},
                {
                    "role": "user",
                    "content": (
                        "Continue after this approved human/operator step. "
                        "Use the operator note as context, but do not claim to have executed actions.\n\n"
                        f"Approval type: {approval_type}\n"
                        f"Approval title: {title}\n\n"
                        f"Original request:\n{original}\n\n"
                        f"Operator note:\n{note}"
                    ),
                },
            ]
        )
        self.report(f"Follow-up after approval: {title}\n\n{answer}", task_id)
        if approval.get("taskId"):
            self.patch_task(task_id, "done", "Follow-up response posted after operator approval.")

    def patch_task(self, task_id: str, status: str, note: str = "") -> None:
        self.request_json("PATCH", f"/api/tasks/{task_id}", {"status": status, "note": note})

    def remember(self, bucket: str, item_id: str) -> None:
        seen = set(self.state.setdefault(bucket, []))
        seen.add(item_id)
        self.state[bucket] = sorted(seen)[-500:]

    def report(self, text: str, task_id: str = "") -> None:
        self.request_json("POST", "/api/agent/report", {"text": text, "taskId": task_id})

    def request_json(self, method: str, path: str, body: dict | None = None) -> dict | None:
        url = f"{self.args.base_url}{path}"
        data = None
        headers = {"Authorization": f"Bearer {self.args.agent_key}"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            print(f"{method} {path} failed: HTTP {exc.code}", file=sys.stderr)
        except Exception as exc:  # noqa: BLE001 - bridge should keep running
            print(f"{method} {path} failed: {exc}", file=sys.stderr)
        return None

    def load_state(self) -> dict:
        try:
            return json.loads(self.state_path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def save_state(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(json.dumps(self.state, indent=2), encoding="utf-8")


def clean(value: object, limit: int) -> str:
    return str(value or "").strip()[:limit]


def detect_approval_need(title: str, details: str) -> ApprovalNeed | None:
    text = f"{title}\n{details}".lower()
    for approval_type, keywords, request_title, reason, expected, sensitive in RISK_RULES:
        if any(keyword in text for keyword in keywords):
            return ApprovalNeed(
                type=approval_type,
                title=request_title,
                details=f"{reason}\n\nOriginal request:\n{clean((title + chr(10) + details), 1800)}",
                expected_response=expected,
                sensitive=sensitive,
                command=extract_command(details if approval_type == "command" else ""),
            )
    return None


def extract_command(text: str) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    command_lines = [
        line for line in lines
        if line.startswith(("`", "$", ">", "sudo ", "docker ", "systemctl ", "ssh ", "scp ", "powershell"))
    ]
    return clean("\n".join(command_lines).replace("`", ""), 4000)


def context_briefing(items: list[dict]) -> str:
    if not items:
        return "Latch context briefing: no saved context has been shared yet."

    lines = [
        "Latch context briefing:",
        "Use shared context as durable operator-provided memory. Treat private/unshared items as unavailable except for their title/metadata.",
    ]
    for item in items[:12]:
        title = clean(item.get("title") or item.get("name") or "Context", 120)
        category = clean(item.get("category") or "memory", 40)
        tags = ", ".join(clean(tag, 30) for tag in item.get("tags", [])[:5])
        shared = bool(item.get("shareWithAgent"))
        label = f"- [{category}] {title}"
        if tags:
            label += f" ({tags})"
        if not shared:
            lines.append(f"{label}: private metadata only.")
            continue
        if item.get("text"):
            lines.append(f"{label}:\n{clean(item.get('text'), 1600)}")
        elif item.get("contentText"):
            name = clean(item.get("name") or title, 120)
            lines.append(f"{label} file {name}:\n{clean(item.get('contentText'), 1800)}")
        else:
            lines.append(f"{label}: shared, but no text content is available.")
    return "\n".join(lines)


def extract_context_questions(answer: str) -> list[str]:
    questions = []
    for line in str(answer or "").splitlines():
        stripped = line.strip()
        if stripped.startswith("CONTEXT_QUESTION:"):
            question = clean(stripped.split("CONTEXT_QUESTION:", 1)[1], 500)
            if question:
                questions.append(question)
    return questions[:3]


def original_request_text(task: dict | None, message: dict | None, approval: dict) -> str:
    if task:
        return clean(
            f"Task: {task.get('title', '')}\n\nDetails:\n{task.get('details') or task.get('note') or ''}",
            3000,
        )
    if message:
        return clean(f"Message:\n{message.get('text', '')}", 3000)
    return clean(str(approval.get("details", "")), 3000)


def env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


if __name__ == "__main__":
    raise SystemExit(main())
