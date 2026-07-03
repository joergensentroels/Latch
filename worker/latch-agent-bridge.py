#!/usr/bin/env python3
"""
Safe Latch bridge for an OpenClaw worker VM.

This script does not execute shell/browser plans directly. It:
- checks optional OpenClaw Gateway health
- reports worker status to Latch
- polls queued work, inbox instructions, and pending approvals
- answers tasks/instructions through Latch's external LLM gateway
- creates approval-backed shell/browser plans for the separate executor service
- records seen IDs locally so it does not spam repeated reports
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import ipaddress
import json
import os
import re
import shlex
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, replace
from pathlib import Path


DEFAULT_STATE_PATH = Path.home() / ".local" / "state" / "latch-agent-bridge" / "state.json"
DEFAULT_SOURCE_CACHE_PATH = Path.home() / ".cache" / "latch-agent-bridge" / "source-notes.json"
DEFAULT_CODE_REPO = "CompassProjects"


def sd_notify(message: str) -> None:
    """Best-effort systemd notification (e.g. "READY=1", "WATCHDOG=1"). No-op unless the
    service runs as Type=notify with WatchdogSec set. Lets a stalled bridge self-recover:
    if the tick loop stops sending WATCHDOG=1, systemd force-restarts the service instead of
    leaving it silently wedged."""
    addr = os.environ.get("NOTIFY_SOCKET")
    if not addr:
        return
    try:
        path = "\0" + addr[1:] if addr.startswith("@") else addr
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
            sock.connect(path)
            sock.sendall(message.encode("utf-8"))
    except OSError:
        pass
SYSTEM_PROMPT = """You are the user's companion inside Compass.
Your visible identity is the companion identity from the shared profile: name, purpose, goals, boundaries, and communication style. If no name is configured, use Compass Companion.
When the user asks who you are, what your goals are, or what your purpose is, answer from the companion profile and anchor only. Do not describe backend architecture, worker processes, routing, approvals, VMs, products, or services as your identity.
Implementation details are silent tools, not personality. Do not mention backend names, bridge/worker labels, VM setup, executor services, routing, or internal channels unless the user explicitly asks about technical implementation or diagnostics.
You may help with planning, explanation, coding advice, and next-step suggestions.
You may use policy-gated shell/browser execution plans, bounded exact-URL research, and trusted-host GitHub actions when the request calls for them. Mention these only as capabilities relevant to a concrete task, never as self-description.
For development tasks, code, files, websites, README, or repository-content updates, assume the target repository is CompassProjects unless the operator explicitly names another repository.
You must not handle private credentials, passwords, API keys, recovery codes, payment tools, purchases, account creation, CAPTCHA/human verification, or personal browser profiles. You may send email only from your own dedicated agent mailbox, and only after the operator approves the outreach; you may never send mail as the operator or from the operator's accounts, and you never hold the mailbox credentials yourself (the trusted host sends on your behalf). If a workflow needs a private login or secret, stop and ask the human to handle that step without revealing the secret to you.
For web/research/execution workflows, prefer token-efficient summaries, explicit source lists, small budgets, exact planned steps, and reusable source notes instead of dumping raw pages.
If you need durable context from the operator before giving a good answer, include one to three lines that start exactly with CONTEXT_QUESTION: followed by a concrete question.
Keep replies concise, practical, and in the companion's voice."""


@dataclass(frozen=True)
class ApprovalNeed:
    type: str
    title: str
    details: str
    expected_response: str
    sensitive: bool
    command: str = ""
    risk_level: str = "medium"
    action_template: str = ""
    action_preview: str = ""
    rendered_commands: tuple[str, ...] = ()
    execution_mode: str = "none"
    execution_plan: dict | None = None
    recipient: str = ""
    subject: str = ""
    contact_purpose: str = ""
    body_preview: str = ""
    attachments: tuple[str, ...] = ()
    send_mode: str = "manual"
    allowed_domains: tuple[str, ...] = ()
    seed_urls: tuple[str, ...] = ()
    max_pages: int = 0
    token_budget: int = 0
    research_question: str = ""
    refresh_research: bool = False
    github_repo_name: str = ""
    github_description: str = ""
    github_visibility: str = "private"
    github_owner: str = ""
    github_auto_init: bool = True
    github_file_path: str = ""
    github_file_content: str = ""
    github_commit_message: str = ""
    planned_recipients: int = 0
    campaign_purpose: str = ""
    email_to: str = ""
    email_subject: str = ""
    email_body: str = ""
    email_compose_brief: str = ""


READ_ONLY_TEMPLATE_LABELS = {
    "bridge.status": "Check Latch bridge service status",
    "bridge.logs": "Read recent Latch bridge logs",
    "openclaw.gateway.health": "Check OpenClaw Gateway health",
    "docker.status": "Check OpenClaw Docker container status",
    "tailscale.status": "Check Tailscale status",
    "repo.status": "Check read-only Latch repo status",
}


RISK_RULES = [
    (
        "purchase",
        ("buy", "purchase", "order", "checkout", "payment", "pay ", "invoice", "subscribe", "subscription"),
        "Purchase approval needed",
        "The request appears to involve payment, purchase, checkout, subscription, or spending.",
        "Approve only after reviewing cost, vendor, and exact action. Purchases remain human-boundary steps and are not delegated to the executor.",
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
        ("run command", "execute", "powershell", "terminal", "shell", "sudo", "docker", "systemctl", "ssh ", "scp ", "install ", "download", "firefox", "chromium", "playwright", "browser"),
        "Command approval needed",
        "The request appears to require executing a command or changing a system.",
        "Review the exact shell/browser plan. If approved and non-sensitive, the separate executor service may run it and report an audit record.",
        False,
    ),
]


def main() -> int:
    parser = argparse.ArgumentParser(description="Safe Latch planning bridge for OpenClaw workers.")
    parser.add_argument("--base-url", default=os.getenv("LATCH_BASE_URL", "").rstrip("/"))
    parser.add_argument("--agent-key", default=os.getenv("LATCH_AGENT_KEY", ""))
    parser.add_argument("--worker-name", default=os.getenv("LATCH_WORKER_NAME", socket.gethostname()))
    parser.add_argument("--openclaw-health-url", default=os.getenv("OPENCLAW_HEALTH_URL", ""))
    parser.add_argument("--openclaw-compose-dir", default=os.getenv("OPENCLAW_COMPOSE_DIR", str(Path.home() / "openclaw")))
    parser.add_argument("--latch-repo-dir", default=os.getenv("LATCH_REPO_DIR", str(Path.home() / "code" / "latch-readonly")))
    parser.add_argument("--source-cache-path", default=os.getenv("LATCH_SOURCE_CACHE_PATH", str(DEFAULT_SOURCE_CACHE_PATH)))
    parser.add_argument("--interval", type=int, default=int(os.getenv("LATCH_POLL_INTERVAL", "15")))
    parser.add_argument("--state-path", default=os.getenv("LATCH_STATE_PATH", str(DEFAULT_STATE_PATH)))
    parser.add_argument("--max-tasks-per-tick", type=int, default=int(os.getenv("LATCH_MAX_TASKS_PER_TICK", "1")))
    parser.add_argument("--max-messages-per-tick", type=int, default=int(os.getenv("LATCH_MAX_MESSAGES_PER_TICK", "1")))
    parser.add_argument("--process-existing-messages", action="store_true", default=env_bool("LATCH_PROCESS_EXISTING_MESSAGES", False))
    # Agent mailbox monitoring: 0 disables it. When enabled, the bridge polls its own inbox and
    # auto-replies ONLY to senders it has already emailed first (the server enforces this via
    # known-contact gating); mail from anyone else is surfaced to the operator, not answered.
    parser.add_argument("--email-poll-interval", type=int, default=int(os.getenv("LATCH_EMAIL_POLL_INTERVAL", "60")))
    parser.add_argument("--email-reply-channel", default=os.getenv("LATCH_EMAIL_REPLY_CHANNEL", "operations"))
    # Max consecutive auto-replies to one contact before pausing that thread and asking the
    # operator (via an email_thread_continue review) whether to keep going. Bounds bot/auto-reply loops.
    parser.add_argument("--email-reply-cap", type=int, default=int(os.getenv("LATCH_EMAIL_REPLY_CAP", "3")))
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()

    if not args.base_url:
        print("Missing LATCH_BASE_URL or --base-url", file=sys.stderr)
        return 2
    if not args.agent_key:
        print("Missing LATCH_AGENT_KEY or --agent-key", file=sys.stderr)
        return 2

    bridge = Bridge(args)
    bridge.report(f"{args.worker_name} bridge online. Mode: approval-gated bridge with optional VM executor.")
    sd_notify("READY=1")

    while True:
        sd_notify("WATCHDOG=1")
        try:
            bridge.tick()
        except Exception as exc:  # noqa: BLE001 - one bad tick must not kill the bridge; watchdog covers true hangs
            print(f"tick failed: {exc}", file=sys.stderr)
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
        self.heartbeat(gateway)

        payload = self.request_json("GET", "/api/agent/poll")
        if not payload:
            return
        sd_notify("WATCHDOG=1")

        # Operator-adjustable settings delivered via the poll (fall back to CLI/env defaults).
        self.remote_email_reply_cap = (payload.get("agentEmailPolicy") or {}).get("replyCap")

        tasks = payload.get("tasks", [])
        messages = payload.get("messages", [])
        channels = payload.get("channels", [])
        context_items = payload.get("contextItems", [])
        network_context_items = payload.get("networkContextItems", [])
        profile = payload.get("profile", {})
        self.process_approval_decisions(payload.get("approvals", []), tasks, messages, context_items, profile)
        work = payload.get("work", [])
        if work:
            self.process_scoped_work(work, channels, profile)
            self.save_state()
            return
        self.process_tasks(tasks, context_items, network_context_items, profile, channels)
        self.process_messages(messages, context_items, network_context_items, profile, channels)
        self.process_inbound_email(profile)
        self.save_state()

    def heartbeat(self, gateway: str = "") -> None:
        health = "ok" if gateway.startswith("ok ") or not gateway else "warn"
        self.request_json(
            "POST",
            "/api/agent/heartbeat",
            {
                "id": self.args.worker_name.lower().replace(" ", "-") or "openclaw-vm",
                "name": self.args.worker_name,
                "kind": "openclaw",
                "location": "self-hosted",
                "status": "online",
                "health": health,
                "capabilities": {
                    "bridge": True,
                    "diagnostics": True,
                    "executor": False,
                    "browser": False,
                    "shell": False,
                    "downloads": False,
                },
                "lastAuditEvent": gateway,
            },
        )

    def process_scoped_work(self, work: list[dict], channels: list[dict], fallback_profile: dict) -> None:
        for item in work:
            context_items = item.get("contextItems", [])
            profile = item.get("profile") or fallback_profile
            if item.get("kind") == "task" and item.get("task"):
                self.process_tasks([item["task"]], context_items, context_items, profile, channels)
            elif item.get("kind") == "message" and item.get("message"):
                self.process_messages([item["message"]], context_items, context_items, profile, channels)

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

    def process_tasks(self, tasks: list[dict], context_items: list[dict], network_context_items: list[dict], profile: dict, channels: list[dict]) -> None:
        queued = [task for task in tasks if task.get("status") == "queued"]
        for task in queued[: max(0, self.args.max_tasks_per_tick)]:
            task_id = str(task.get("id", ""))
            task_key = task_processing_key(task)
            if not task_id or task_key in set(self.state.setdefault("processed_tasks", [])):
                continue
            title = clean(task.get("title") or "Untitled task", 180)
            details = clean(task.get("details") or "", 6000)
            response_channel = clean_channel_id(task.get("channel") or "") or requested_latch_channel(f"{title}\n{details}", channels) or "compass"
            routing_preference = clean_routing(task.get("routingPreference"))
            allow_network = bool(task.get("allowNetwork")) and routing_preference != "local"
            briefing_items = network_context_items if allow_network else context_items
            briefing_profile = {} if allow_network else profile
            try:
                approval = detect_approval_need(title, details)
                if approval:
                    if approval.type == "command" and approval.execution_mode == "none":
                        approval = self.plan_execution_approval(title, details, approval, routing_preference, allow_network)
                    approval = enrich_status_template(approval, self.args)
                    approval = self.compose_email_if_needed(approval)
                    self.patch_task(task_id, "waiting", "Waiting for operator approval or human help.")
                    created = self.create_approval(approval, task_id=task_id)
                    suffix = f" ({created.get('id')})" if created else ""
                    self.report(f"Approval requested for task: {title}{suffix}", task_id)
                    self.remember("processed_tasks", task_key)
                    continue

                self.patch_task(task_id, "running", f"{self.args.worker_name} is drafting a response.")
                answer = self.ask_llm(
                    [
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "system", "content": context_briefing(briefing_items, briefing_profile)},
                        {"role": "system", "content": channel_briefing(channels, response_channel)},
                        {
                            "role": "user",
                            "content": (
                                "Handle this queued Compass task in the companion voice from the shared profile. "
                                "Do not mention bridge/worker/VM implementation details unless the task asks about them.\n\n"
                                f"Title: {title}\n\n"
                                f"Details:\n{details or '(no details)'}"
                            ),
                        },
                    ],
                    routing_preference=routing_preference,
                    allow_network=allow_network,
                    priority=clean(task.get("priority") or "normal", 20),
                )
                questions = extract_context_questions(answer)
                if questions:
                    created = self.create_context_question(questions, task_id=task_id)
                    suffix = f" ({created.get('id')})" if created else ""
                    self.report(f"Context question requested for task: {title}{suffix}", task_id)
                    self.patch_task(task_id, "waiting", "Waiting for operator context answer.")
                    self.remember("processed_tasks", task_key)
                    continue
                self.report(clean_visible_report_text(answer), task_id, response_channel)
                self.patch_task(task_id, "done", f"Text-only response posted to {response_channel}.")
                self.remember("processed_tasks", task_key)
            except Exception as exc:  # noqa: BLE001 - keep bridge alive and report failure
                self.report(f"Task failed: {title}\n\n{exc}", task_id, response_channel)
                self.patch_task(task_id, "failed", str(exc)[:1800])
                self.remember("processed_tasks", task_key)

    def process_messages(self, messages: list[dict], context_items: list[dict], network_context_items: list[dict], profile: dict, channels: list[dict]) -> None:
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
            response_channel = requested_latch_channel(text, channels) or clean_channel_id(message.get("channel") or "compass")
            routing_preference = clean_routing(message.get("routingPreference"))
            allow_network = bool(message.get("allowNetwork")) and routing_preference != "local"
            briefing_items = network_context_items if allow_network else context_items
            briefing_profile = {} if allow_network else profile
            try:
                if is_self_description_request(text):
                    self.report(companion_self_description(profile), message_id, response_channel)
                    self.remember("processed_messages", message_id)
                    continue

                approval = detect_approval_need("Inbox instruction", text)
                if approval:
                    if approval.type == "command" and approval.execution_mode == "none":
                        approval = self.plan_execution_approval("Inbox instruction", text, approval, routing_preference, allow_network)
                    approval = enrich_status_template(approval, self.args)
                    approval = self.compose_email_if_needed(approval)
                    created = self.create_approval(approval, message_id=message_id)
                    suffix = f" ({created.get('id')})" if created else ""
                    self.report(f"Approval requested for inbox instruction{suffix}.", message_id)
                    self.remember("processed_messages", message_id)
                    continue

                answer = self.ask_llm(
                    [
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "system", "content": context_briefing(briefing_items, briefing_profile)},
                        {"role": "system", "content": channel_briefing(channels, response_channel)},
                        {
                            "role": "user",
                            "content": (
                                "Reply to this Compass inbox instruction in the companion voice from the shared profile. "
                                "Do not mention bridge/worker/VM implementation details unless the instruction asks about them.\n\n"
                                f"Instruction:\n{text}"
                            ),
                        },
                    ],
                    routing_preference=routing_preference,
                    allow_network=allow_network,
                )
                questions = extract_context_questions(answer)
                if questions:
                    created = self.create_context_question(questions, message_id=message_id)
                    suffix = f" ({created.get('id')})" if created else ""
                    self.report(f"Context question requested for inbox instruction{suffix}.", message_id)
                    self.remember("processed_messages", message_id)
                    continue
                self.report(clean_visible_report_text(answer), message_id, response_channel)
                self.remember("processed_messages", message_id)
            except Exception as exc:  # noqa: BLE001 - keep bridge alive and avoid hot loops
                self.report(f"Could not answer inbox instruction yet: {exc}", message_id, response_channel)
                self.remember("processed_messages", message_id)

    def ask_llm(self, messages: list[dict], routing_preference: str = "local", allow_network: bool = False, priority: str = "normal") -> str:
        response = self.request_json(
            "POST",
            "/api/llm/chat",
            {
                "messages": messages,
                "temperature": 0.2,
                "maxTokens": 700,
                "routingPreference": routing_preference,
                "allowNetwork": allow_network,
                "priority": priority,
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

    def plan_execution_approval(
        self,
        title: str,
        details: str,
        approval: ApprovalNeed,
        routing_preference: str,
        allow_network: bool,
    ) -> ApprovalNeed:
        try:
            raw = self.ask_llm(
                [
                    {
                        "role": "system",
                        "content": (
                            "Return JSON only. Create a bounded VM execution plan for a private Ubuntu worker.\n"
                            "Allowed modes: shell or browser. Use shell for installs, files, services, and CLI work. "
                            "Use browser for web pages, screenshots, form steps, and downloads.\n"
                            "Schema: {\"mode\":\"shell|browser\",\"summary\":\"...\",\"sensitive\":false,"
                            "\"riskLevel\":\"low|medium|high\",\"timeoutSeconds\":300,"
                            "\"commands\":[\"...\"],\"actions\":[{\"type\":\"open|extract_text|screenshot|click|fill|press|wait|download|search_web\","
                            "\"url\":\"...\",\"selector\":\"...\",\"text\":\"...\",\"key\":\"...\",\"path\":\"...\",\"timeoutMs\":0,\"maxResults\":3}],"
                            "\"expectedResult\":\"...\"}.\n"
                            "Do not include passwords, tokens, payment actions, account creation, CAPTCHA bypass, or external contact."
                        ),
                    },
                    {
                        "role": "user",
                        "content": f"Title: {title}\n\nRequest:\n{details or '(no details)'}",
                    },
                ],
                routing_preference=routing_preference,
                allow_network=allow_network,
            )
            plan = sanitize_execution_plan(json.loads(extract_json_object(raw)))
        except Exception as exc:  # noqa: BLE001 - fall back to a manual approval
            return replace(
                approval,
                details=f"{approval.details}\n\nPlanning failed, so the operator must decide manually: {exc}",
            )

        command_text = "\n".join(plan.get("commands", []))
        action_preview = plan.get("summary") or "Run approved VM execution plan"
        rendered = tuple(plan.get("commands", []))
        return replace(
            approval,
            title="VM execution approval needed",
            details=(
                f"{approval.details}\n\n"
                f"Plan summary: {plan.get('summary') or 'No summary'}\n"
                f"Expected result: {plan.get('expectedResult') or 'Not specified'}"
            ),
            command=command_text,
            expected_response=plan.get("expectedResult") or approval.expected_response,
            sensitive=bool(plan.get("sensitive")) or approval.sensitive,
            risk_level=plan.get("riskLevel") or approval.risk_level,
            action_preview=action_preview,
            rendered_commands=rendered,
            execution_mode=plan.get("mode") or "shell",
            execution_plan=plan,
        )

    def process_inbound_email(self, profile: dict) -> None:
        """Poll the companion's OWN mailbox and auto-reply to senders it has already emailed
        first. The "first-contact" rule is enforced by the server: a reply to a known contact
        sends; any other sender comes back needs_approval and is only surfaced to the operator,
        never auto-answered. Throttled, deduplicated, and loop-guarded (skips self/automated mail)."""
        interval = max(0, int(getattr(self.args, "email_poll_interval", 0) or 0))
        if interval <= 0:
            return
        now = time.time()
        if now - float(self.state.get("lastEmailPollAt", 0) or 0) < interval:
            return
        self.state["lastEmailPollAt"] = now
        resp = self.request_json("POST", "/api/agent/email/poll", {"unseenOnly": True, "limit": 10})
        if not resp or not resp.get("ok"):
            return
        own = str(resp.get("fromAddress") or "").strip().lower()
        seen = set(self.state.setdefault("seen_emails", []))
        threads = self.state.setdefault("email_threads", {})
        remote_cap = getattr(self, "remote_email_reply_cap", None)
        cap = remote_cap if isinstance(remote_cap, int) and remote_cap >= 1 else max(1, int(getattr(self.args, "email_reply_cap", 3) or 3))
        channel = clean(getattr(self.args, "email_reply_channel", "") or "operations", 60)
        for msg in resp.get("messages", []):
            mid = str(msg.get("messageId") or msg.get("uid") or "")
            if not mid or mid in seen:
                continue
            # Mark seen + persist before acting: at-most-once, so a restart never re-replies.
            seen.add(mid)
            self.state["seen_emails"] = sorted(seen)[-500:]
            self.save_state()

            sender = extract_email(msg.get("from", ""))
            subject = clean(msg.get("subject", ""), 200)
            if not sender or is_automated_or_self(sender, own):
                continue
            body = clean(msg.get("body", ""), 4000)
            thread = threads.setdefault(sender, {"count": 0, "paused": False, "log": []})
            thread["log"] = (thread.get("log", []) + [f"From {sender}: {subject} - {body[:300]}"])[-8:]

            # Thread already paused pending your go-ahead: don't reply, don't re-ask (no spam).
            if thread.get("paused"):
                self.save_state()
                continue

            # Hit the per-thread auto-reply cap: pause, summarize, and ask the operator to continue.
            if int(thread.get("count", 0)) >= cap:
                thread["paused"] = True
                self.save_state()
                summary = self.summarize_email_thread(sender, thread, profile)
                self.create_approval(ApprovalNeed(
                    type="email_thread_continue",
                    title=f"Continue email thread with {sender}?",
                    details=(
                        f"The companion has auto-replied {cap} time(s) in its thread with {sender} and paused "
                        "before replying again. Approve to let it keep auto-replying to this contact, or deny "
                        "to keep the thread paused.\n\n"
                        f"Thread summary:\n{summary}"
                    ),
                    expected_response="Approve to resume auto-replies to this contact; deny to keep the thread paused.",
                    sensitive=True,
                    risk_level="medium",
                    email_to=sender,
                ))
                self.report(f"Paused auto-replies to {sender} after {cap} reply(ies). Sent you a 'continue?' review with a summary.", channel=channel)
                continue

            try:
                draft = self.ask_llm(
                    [
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "system", "content": context_briefing([], profile)},
                        {
                            "role": "system",
                            "content": (
                                "You are replying to an email in the companion's own voice. Output ONLY the reply "
                                "body - no 'Subject:' line, no quoted history, no signature block beyond a simple "
                                "sign-off. Keep it concise and professional, answer what the sender actually wrote, "
                                "and do not invent facts or make commitments."
                            ),
                        },
                        {"role": "user", "content": f"Email from {sender}\nSubject: {subject}\n\n{body or '(no readable body)'}"},
                    ]
                )
            except Exception as exc:  # noqa: BLE001 - never let a mailbox hiccup break the tick
                print(f"email reply draft failed for {sender}: {exc}", file=sys.stderr)
                self.report(f"New email from {sender} (re: {subject}) - could not draft a reply automatically.", channel=channel)
                continue
            reply_body = clean(clean_visible_report_text(draft), 8000)
            send = self.request_json(
                "POST",
                "/api/agent/email/send",
                {
                    "to": sender,
                    "subject": reply_subject(subject),
                    "body": reply_body,
                    "inReplyTo": msg.get("messageId", ""),
                    "references": msg.get("messageId", ""),
                },
            )
            if send and send.get("ok"):
                thread["count"] = int(thread.get("count", 0)) + 1
                thread["lastAt"] = now
                thread["log"] = (thread.get("log", []) + [f"Companion reply: {reply_body[:300]}"])[-8:]
                self.save_state()
                self.report(f"Replied to {sender} (re: {subject}) [{thread['count']}/{cap} in this thread]:\n\n{reply_body}", channel=channel)
            elif send and send.get("status") == "needs_approval":
                self.report(
                    f"New email from {sender} (re: {subject}) - I have not emailed them first, so I did not auto-reply. "
                    f"Approve an outreach plan if you want me to respond.\n\nTheir message:\n{body[:1000]}",
                    channel=channel,
                )
            else:
                self.report(f"New email from {sender} (re: {subject}) - reply could not be sent (rate limit or transport error).", channel=channel)

    def summarize_email_thread(self, sender: str, thread: dict, profile: dict) -> str:
        log = "\n".join(thread.get("log", []) or [])
        try:
            return clean(clean_visible_report_text(self.ask_llm(
                [
                    {
                        "role": "system",
                        "content": (
                            "Summarize this email thread in 2-4 sentences for the operator: who the contact is, "
                            "what they want, where the exchange stands, and whether a human should step in. Be "
                            "concise and factual; do not invent details."
                        ),
                    },
                    {"role": "user", "content": f"Thread with {sender}:\n{log or '(no captured history)'}"},
                ]
            )), 2000)
        except Exception as exc:  # noqa: BLE001 - fall back to the raw log rather than failing the pause
            print(f"thread summary failed for {sender}: {exc}", file=sys.stderr)
            return clean(log, 2000)

    def compose_email_if_needed(self, approval: "ApprovalNeed | None") -> "ApprovalNeed | None":
        """For an agent-mailbox send with no operator-dictated body, have the LLM draft the
        email body from the request, and fold it into the approval so the operator reviews the
        real message before approving. No-op for anything else or when a body was given."""
        if not approval or approval.type != "email_campaign":
            return approval
        if approval.email_body or not approval.email_compose_brief:
            return approval
        composed = ""
        try:
            composed = self.ask_llm(
                [
                    {
                        "role": "system",
                        "content": (
                            "You draft short, professional email bodies. Output ONLY the body text - "
                            "no 'Subject:' line, no code fences. Keep it to 3-6 sentences, base it strictly "
                            "on the material provided, and do not invent facts or add placeholders."
                        ),
                    },
                    {
                        "role": "user",
                        "content": (
                            f"Write the body of an email to {approval.email_to}. "
                            f"Base it only on this request and any source text it contains:\n\n{approval.email_compose_brief}"
                        ),
                    },
                ]
            )
        except Exception as exc:  # noqa: BLE001 - fall back to a reviewable draft rather than failing the send
            print(f"email body compose failed: {exc}", file=sys.stderr)
        body = clean((composed or "").strip(), 8000) or clean(approval.email_compose_brief, 8000)
        details = (
            "The companion wants to send an email from its OWN dedicated mailbox "
            "(host-brokered — the worker never holds the mailbox credentials). "
            "The body below was drafted by the companion; review it before approving. "
            "Approving sends this exact message and authorizes 1 new recipient.\n\n"
            f"To: {approval.email_to}\nSubject: {approval.email_subject}\n\n{body}"
        )
        return replace(approval, email_body=body, details=details)

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
                "riskLevel": approval.risk_level,
                "recipient": approval.recipient,
                "subject": approval.subject,
                "contactPurpose": approval.contact_purpose,
                "bodyPreview": approval.body_preview,
                "attachments": list(approval.attachments),
                "sendMode": approval.send_mode,
                "allowedDomains": list(approval.allowed_domains),
                "seedUrls": list(approval.seed_urls),
                "maxPages": approval.max_pages,
                "tokenBudget": approval.token_budget,
                "researchQuestion": approval.research_question,
                "refreshResearch": approval.refresh_research,
                "githubRepoName": approval.github_repo_name,
                "githubDescription": approval.github_description,
                "githubVisibility": approval.github_visibility,
                "githubOwner": approval.github_owner,
                "githubAutoInit": approval.github_auto_init,
                "githubFilePath": approval.github_file_path,
                "githubFileContent": approval.github_file_content,
                "githubCommitMessage": approval.github_commit_message,
                "plannedRecipients": approval.planned_recipients,
                "campaignPurpose": approval.campaign_purpose,
                "emailTo": approval.email_to,
                "emailSubject": approval.email_subject,
                "emailBody": approval.email_body,
                "actionTemplate": approval.action_template,
                "actionPreview": approval.action_preview,
                "renderedCommands": list(approval.rendered_commands),
                "executionMode": approval.execution_mode,
                "executionPlan": approval.execution_plan or {},
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
        profile: dict,
    ) -> None:
        seen = set(self.state.setdefault("seen_approval_decisions", []))
        tasks_by_id = {str(task.get("id", "")): task for task in tasks}
        messages_by_id = {str(message.get("id", "")): message for message in messages}
        for approval in reversed(approvals):
            approval_id = str(approval.get("id", ""))
            status = str(approval.get("status", ""))
            if not approval_id or approval_id in seen or status not in {"approved", "denied"}:
                continue

            # Mark as attempted and PERSIST it before doing any work. If handling then throws
            # or hangs (and the process is later restarted by the watchdog), this approval is
            # not retried forever. This is what turned a single failing approval into the
            # 55x /.cache crash-loop: "seen" used to be recorded only after handling succeeded.
            seen.add(approval_id)
            self.state["seen_approval_decisions"] = sorted(seen)[-500:]
            self.save_state()

            try:
                title = clean(approval.get("title") or approval_id, 180)
                note = clean(approval.get("responseNote") or "", 1000)
                task_id = clean(approval.get("taskId") or approval.get("messageId") or approval_id, 120)
                if approval.get("taskId"):
                    approval_task = tasks_by_id.get(str(approval.get("taskId")))
                    self.remember("processed_tasks", task_processing_key(approval_task or {"id": approval.get("taskId")}))
                if approval.get("messageId"):
                    self.remember("processed_messages", str(approval.get("messageId")))
                if status == "approved":
                    self.handle_approved_decision(approval, title, note, task_id, tasks_by_id, messages_by_id, context_items, profile)
                else:
                    self.report(
                        f"Approval denied: {title}.{f' Operator note: {note}' if note else ''}",
                        task_id,
                    )
                    if approval.get("taskId"):
                        self.patch_task(task_id, "failed", "Approval denied by operator.")
            except Exception as exc:  # noqa: BLE001 - a single approval must never wedge or crash-loop the bridge
                print(f"approval {approval_id} handling failed: {exc}", file=sys.stderr)
                try:
                    self.report(f"Could not finish processing approval {approval_id}: {exc}")
                except Exception:  # noqa: BLE001 - best-effort operator notification
                    pass

    def handle_approved_decision(
        self,
        approval: dict,
        title: str,
        note: str,
        task_id: str,
        tasks_by_id: dict[str, dict],
        messages_by_id: dict[str, dict],
        context_items: list[dict],
        profile: dict,
    ) -> None:
        approval_type = str(approval.get("type", "other"))
        is_sensitive = bool(approval.get("sensitive"))

        if approval_type == "email_thread_continue":
            contact = clean(approval.get("emailTo") or "", 320).strip().lower()
            threads = self.state.setdefault("email_threads", {})
            if contact and contact in threads:
                threads[contact]["count"] = 0
                threads[contact]["paused"] = False
                self.save_state()
            self.report(f"Resuming auto-replies to {contact}." if contact else "Email thread continue approved.", task_id)
            return
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
                    if item != str(approval.get("taskId")) and not item.startswith(f"{approval.get('taskId')}:")
                ]
            return

        if approval_type == "command" and approval.get("executionMode") == "read_only_status":
            result = self.execute_read_only_template(approval)
            self.report_execution(result)
            summary = (
                f"Read-only diagnostic completed: {title}\n\n"
                f"Template: {result['template']}\n"
                f"Exit code: {result['exitCode']}\n\n"
                f"Output:\n{result['stdout'] or '(no stdout)'}"
            )
            if result.get("stderr"):
                summary += f"\n\nErrors:\n{result['stderr']}"
            self.report(clean(summary, 6000), task_id)
            if approval.get("taskId"):
                status = "done" if result["exitCode"] == 0 else "failed"
                self.patch_task(task_id, status, f"Read-only diagnostic {result['template']} exited {result['exitCode']}.")
            return

        if approval_type == "command" and approval.get("executionMode") in {"shell", "browser"}:
            self.report(
                f"Execution approved: {title}\n\nThe root executor service will run the approved {approval.get('executionMode')} plan and report an audit record.",
                task_id,
            )
            if approval.get("taskId"):
                self.patch_task(task_id, "running", "Approved execution is waiting for the VM executor service.")
            return

        if approval_type in {"command", "purchase"}:
            self.report(
                f"Approval recorded: {title}\n\nThe bridge will not execute this category directly. Non-sensitive shell/browser plans require the executor; purchases and secrets remain human-boundary steps."
                f"{f' Operator note: {note}' if note else ''}",
                task_id,
            )
            if approval.get("taskId"):
                self.patch_task(task_id, "paused", "Approval recorded. No executor-compatible plan was available for this request.")
            return

        if approval_type == "external_contact":
            self.report(
                f"External contact reviewed: {title}\n\nLatch has not sent any email or message. Use the operator note as the manual send result, edits, or boundary."
                f"{f' Operator note: {note}' if note else ''}",
                task_id,
            )
            if approval.get("taskId"):
                self.patch_task(task_id, "paused", "External contact draft reviewed. No message was sent by the bridge.")
            return

        if approval_type == "web_research":
            result = perform_read_only_research(approval, self.args)
            self.report_research(result)
            self.report(format_research_report(result), task_id)
            if approval.get("taskId"):
                status = "done" if result["status"] in {"completed", "partial"} else "failed"
                self.patch_task(task_id, status, f"Read-only research {result['status']} with {result['pagesFetched']} fetched page(s).")
            return

        if approval_type == "github_repo":
            repo_url = clean(approval.get("githubRepoUrl") or "", 500)
            full_name = clean(approval.get("githubFullName") or approval.get("githubRepoName") or "", 200)
            self.report(
                f"GitHub repository approved: {title}\n\n"
                f"Repository: {full_name or '(not reported)'}\n"
                f"URL: {repo_url or '(not reported)'}\n\n"
                "The GitHub token stayed on the trusted Latch host; the worker received only this result.",
                task_id,
            )
            if approval.get("taskId"):
                self.patch_task(task_id, "done", f"GitHub repository created: {repo_url or full_name}")
            return

        if approval_type == "github_file":
            file_url = clean(approval.get("githubFileUrl") or "", 500)
            repo = clean(approval.get("githubRepoName") or "", 200)
            file_path = clean(approval.get("githubFilePath") or "", 300)
            self.report(
                f"GitHub file update approved: {title}\n\n"
                f"Repository: {repo or '(not reported)'}\n"
                f"Path: {file_path or '(not reported)'}\n"
                f"URL: {file_url or '(not reported)'}\n\n"
                "The GitHub token stayed on the trusted Latch host; the worker received only this result.",
                task_id,
            )
            if approval.get("taskId"):
                self.patch_task(task_id, "done", f"GitHub file updated: {file_url or file_path}")
            return

        if is_sensitive:
            self.report(
                f"Sensitive approval recorded: {title}\n\n"
                "No account, login, purchase, or verification step was performed by OpenClaw. "
                "Operator notes for sensitive approvals are kept inside Latch and are not forwarded to the LLM. "
                "Complete this step manually if it involves credentials, verification codes, or private account details.",
                task_id,
            )
            if approval.get("taskId"):
                self.patch_task(task_id, "paused", "Sensitive approval recorded. Manual completion is still required.")
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
                {"role": "system", "content": context_briefing(context_items, profile)},
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
        self.report(clean_visible_report_text(answer), task_id)
        if approval.get("taskId"):
            self.patch_task(task_id, "done", "Follow-up response posted after operator approval.")

    def patch_task(self, task_id: str, status: str, note: str = "") -> None:
        self.request_json("PATCH", f"/api/tasks/{task_id}", {"status": status, "note": note})

    def remember(self, bucket: str, item_id: str) -> None:
        seen = set(self.state.setdefault(bucket, []))
        seen.add(item_id)
        self.state[bucket] = sorted(seen)[-500:]

    def report(self, text: str, task_id: str = "", channel: str = "") -> None:
        body = {"text": clean_visible_report_text(text), "taskId": task_id}
        if channel:
            body["channel"] = clean_channel_id(channel)
        self.request_json("POST", "/api/agent/report", body)

    def execute_read_only_template(self, approval: dict) -> dict:
        template_id = clean(approval.get("actionTemplate") or "", 80)
        commands = command_template(template_id, self.args)
        if not commands:
            raise RuntimeError(f"Unknown or unavailable read-only template: {template_id}")
        validate_read_only_commands(commands)

        started_at = utc_now()
        stdout_parts = []
        stderr_parts = []
        exit_code = 0
        rendered = []
        for command in commands:
            rendered.append(render_command(command))
            completed = subprocess.run(
                command["argv"],
                cwd=command.get("cwd") or None,
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )
            if completed.stdout:
                stdout_parts.append(f"$ {render_command(command)}\n{completed.stdout.strip()}")
            if completed.stderr:
                stderr_parts.append(f"$ {render_command(command)}\n{completed.stderr.strip()}")
            if completed.returncode != 0 and exit_code == 0:
                exit_code = completed.returncode
                break

        return {
            "approvalId": clean(approval.get("id") or "", 120),
            "taskId": clean(approval.get("taskId") or "", 120),
            "template": template_id,
            "commands": rendered,
            "exitCode": exit_code,
            "stdout": clean("\n\n".join(stdout_parts), 3000),
            "stderr": clean("\n\n".join(stderr_parts), 3000),
            "startedAt": started_at,
            "finishedAt": utc_now(),
        }

    def report_execution(self, result: dict) -> None:
        self.request_json("POST", "/api/agent/executions", result)

    def report_research(self, result: dict) -> None:
        self.request_json("POST", "/api/agent/research-results", result)

    def request_json(self, method: str, path: str, body: dict | None = None) -> dict | None:
        url = f"{self.args.base_url}{path}"
        data = None
        headers = {"Authorization": f"Bearer {self.args.agent_key}"}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
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


def clean_visible_report_text(value: object) -> str:
    text = str(value or "").replace("\r\n", "\n").strip()
    text = extract_tool_call_message(text)
    previous = ""
    while text and text != previous:
        previous = text
        text = re.sub(r"^Reply to inbox instruction:\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"(?is)^compass\s*<~\s*[^\\n]+\n", "", text)
        text = re.sub(r"^(?:COMPASS|COMPANION|OPERATIONS|RESEARCH|GENERAL|[A-Z0-9_-]+_CHANNEL)\s*:\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"(?i)\b(?:latch|openclaw)\s+bridge\s+worker\b", "Compass Companion", text)
        text = re.sub(r"(?i)\bbridge\s+worker\b", "companion", text)
        text = re.sub(r"(?i)\bprivate\s+openclaw\s+setup\b", "Compass setup", text)
        text = re.sub(r"(?i)\b(?:latch|openclaw)\s+setup\b", "Compass setup", text)
        text = re.sub(r"(?i)\b(?:latch\s+)?agent-executor\s+service\b", "executor", text)
        text = re.sub(r"(?i)\btrusted\s+host\s+connector\b", "trusted connector", text)
        text = re.sub(r"(?i)<\s*latch\s+bridge\s+worker\s*>\s*:?", "", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        text = text.strip()
    return text


def extract_tool_call_message(text: str) -> str:
    if "<|tool_call_argument_begin|>" not in text:
        return text
    match = re.search(r"<\|tool_call_argument_begin\|>\s*(\{.*\})\s*$", text, flags=re.DOTALL)
    if not match:
        return text.replace("<|tool_call_argument_begin|>", "").strip()
    try:
        payload = json.loads(match.group(1))
    except json.JSONDecodeError:
        return text.replace("<|tool_call_argument_begin|>", "").strip()
    message = payload.get("message")
    return str(message).strip() if message else text


def is_self_description_request(text: str) -> bool:
    lowered = text.lower()
    phrases = (
        "describe yourself",
        "who are you",
        "what are you",
        "your goals",
        "your goal",
        "your purpose",
        "what is your purpose",
        "tell me about yourself",
    )
    return any(phrase in lowered for phrase in phrases)


def companion_self_description(profile: dict | None) -> str:
    profile = profile or {}
    name = clean(profile.get("name") or "Compass Companion", 120)
    purpose = clean(profile.get("purpose") or "", 900)
    goals = clean(profile.get("goals") or "", 900)
    style = clean(profile.get("communicationStyle") or "", 500)

    lines = [f"I’m {name}."]
    if purpose:
        lines.append(f"My purpose is to {sentence_fragment(purpose)}")
    else:
        lines.append("My purpose is to help you think clearly, keep continuity over time, and turn good intentions into grounded next actions.")
    if goals:
        lines.append(f"My current goals are to {sentence_fragment(goals)}")
    if style:
        lines.append(f"I try to communicate in a way that is {sentence_fragment(style)}")
    lines.append("The technical machinery behind me is just implementation; it is not my personality or purpose.")
    return "\n\n".join(lines)


def sentence_fragment(text: str) -> str:
    cleaned = re.sub(r"^\s*[-*]\s*", "", text.strip())
    cleaned = re.sub(r"\n+\s*[-*]\s*", "; ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        return ""
    cleaned = cleaned[0].lower() + cleaned[1:] if len(cleaned) > 1 else cleaned.lower()
    return cleaned if cleaned.endswith((".", "!", "?")) else f"{cleaned}."


def detect_approval_need(title: str, details: str) -> ApprovalNeed | None:
    text = f"{title}\n{details}".lower()
    template_id = detect_status_template(text)
    if template_id:
        return ApprovalNeed(
            type="command",
            title="Read-only diagnostic approval needed",
            details=(
                "The request appears to ask for a read-only OpenClaw VM diagnostic.\n\n"
                f"Original request:\n{clean((title + chr(10) + details), 1800)}"
            ),
            expected_response="Approve to run the named read-only diagnostic template, or deny to skip it.",
            sensitive=False,
            risk_level="low",
            action_template=template_id,
            action_preview=READ_ONLY_TEMPLATE_LABELS.get(template_id, template_id),
            execution_mode="read_only_status",
        )

    github_file = detect_github_file_request(title, details)
    if github_file:
        return github_file

    github_repo = detect_github_repo_request(title, details)
    if github_repo:
        return github_repo

    vm_execution = detect_vm_execution(title, details)
    if vm_execution:
        return vm_execution

    email_send = detect_agent_email_send(title, details)
    if email_send:
        return email_send

    contact = detect_external_contact(title, details)
    if contact:
        return contact

    research = detect_web_research(title, details)
    if research:
        return research

    for approval_type, keywords, request_title, reason, expected, sensitive in RISK_RULES:
        matched = [keyword for keyword in keywords if keyword in text]
        if matched:
            if approval_type == "command" and is_capability_policy_note(text):
                continue
            command = extract_command(f"{title}\n{details}") if approval_type == "command" else ""
            if approval_type == "command" and is_generic_command_boundary(matched, command):
                continue
            return ApprovalNeed(
                type=approval_type,
                title=request_title,
                details=f"{reason}\n\nOriginal request:\n{clean((title + chr(10) + details), 1800)}",
                expected_response=expected,
                sensitive=sensitive,
                command=command,
            )
    return None


def detect_github_repo_request(title: str, details: str) -> ApprovalNeed | None:
    raw = clean(f"{title}\n{details}", 2500)
    text = raw.lower()
    phrases = (
        "github repo",
        "github repository",
        "repo on github",
        "repository on github",
        "create a repo",
        "create repo",
        "make a repo",
        "new repo",
        "publish to github",
    )
    if not ("github" in text and ("repo" in text or "repository" in text or "publish" in text)):
        if not any(phrase in text for phrase in phrases):
            return None
    repo_name = extract_github_repo_name(raw)
    return ApprovalNeed(
        type="github_repo",
        title="GitHub repo creation approval needed",
        details=(
            "The request appears to involve creating a GitHub repository through the trusted Latch host connector.\n\n"
            f"Repository: {repo_name}\n"
            "Default visibility: private\n\n"
            f"Original request:\n{raw}"
        ),
        expected_response="Review repository name, visibility, and description. Approval lets Latch create the repo without sharing the GitHub token with the worker.",
        sensitive=False,
        risk_level="medium",
        github_repo_name=repo_name,
        github_description=guess_github_description(raw),
        github_visibility="public" if re.search(r"\bpublic\b", text) else "private",
        github_auto_init=True,
    )


def detect_github_file_request(title: str, details: str) -> ApprovalNeed | None:
    raw = clean(f"{title}\n{details}", 3500)
    text = raw.lower()
    mentions_repo = any(phrase in text for phrase in ("github", "repo", "repository", "compassprojects", "compass projects"))
    mentions_file_update = any(phrase in text for phrase in ("readme", "reader file", "update file", "write file", "edit file", "commit", "push"))
    mentions_static_site = any(phrase in text for phrase in ("website", "web site", "webpage", "web page", "static site", "html", "hello world", "hello work"))
    default_repo_dev_task = is_default_repo_dev_task(text)
    if mentions_repo and mentions_static_site:
        mentions_file_update = True
    if default_repo_dev_task:
        mentions_file_update = True
    if not mentions_file_update:
        return None
    if not mentions_repo and not default_repo_dev_task and "readme" not in text and "reader file" not in text:
        return None
    explicit_repo_name = extract_github_repo_name(raw, allow_guess=False)
    repo_name = explicit_repo_name or DEFAULT_CODE_REPO
    file_path = extract_github_file_path(raw)
    content = draft_github_file_content(raw, file_path)
    return ApprovalNeed(
        type="github_file",
        title="GitHub file update approval needed",
        details=(
            "The request appears to involve updating a file in an existing GitHub repository through the trusted Latch host connector.\n\n"
            f"Repository: {repo_name}{' (default for code/file updates)' if not explicit_repo_name else ''}\n"
            f"Path: {file_path}\n\n"
            f"Original request:\n{raw}"
        ),
        expected_response="Review the repository, file path, and content. Approval lets Latch commit this file without sharing the GitHub token with the worker.",
        sensitive=False,
        risk_level="medium",
        github_repo_name=repo_name,
        github_file_path=file_path,
        github_file_content=content,
        github_commit_message=f"Update {file_path}",
    )


def is_default_repo_dev_task(text: str) -> bool:
    # Non-dev intents that happen to contain a dev verb+noun ("write a summary ... from their
    # website", "email me a description of the app") must NOT be treated as file/commit work.
    if re.search(r"\b(explain|what is|what does|how do i|how should i|why does|review|summariz\w*|summary|describe|email|e-mail)\b", text):
        return False
    action = re.search(r"\b(make|create|build|add|implement|update|write|edit|change|fix|scaffold|commit|push)\b", text)
    artifact = re.search(
        r"\b("
        r"website|web site|webpage|web page|static site|html|css|javascript|js|"
        r"app|application|page|component|code|script|file|readme|feature|bug|ui|"
        r"frontend|front end|landing page"
        r")\b",
        text,
    )
    return bool(action and artifact)


def detect_vm_execution(title: str, details: str) -> ApprovalNeed | None:
    raw = clean(f"{title}\n{details}", 2500)
    text = raw.lower()
    if is_capability_policy_note(text):
        return None
    command_like = re.search(
        r"\b(run|execute)\s+[`$]?[a-z0-9_./:-]+",
        text,
    )
    phrases = (
        " on the openclaw vm",
        " on the vm",
        " in the vm",
        " in the terminal",
        " in shell",
        " shell command",
        " terminal command",
        "take a screenshot",
        "use the browser",
        "open website",
        "open https://",
        "open http://",
    )
    if not command_like and not any(phrase in text for phrase in phrases):
        return None
    return ApprovalNeed(
        type="command",
        title="VM execution approval needed",
        details=(
            "The request appears to require running a VM shell or browser action.\n\n"
            f"Original request:\n{raw}"
        ),
        expected_response="Approve to let the VM executor run the exact planned shell/browser steps.",
        sensitive=False,
        risk_level="medium",
    )


def is_capability_policy_note(text: str) -> bool:
    capability_terms = ("firefox", "playwright", "browser", "shell", "executor", "approval")
    policy_terms = (
        "should be able to",
        "without having to ask",
        "without asking",
        "shouldn't have to ask",
        "do not need approval",
        "doesn't need approval",
        "no approval first",
        "already installed",
        "standard feature",
    )
    install_intent = re.search(r"\b(install|download|set up|setup)\b", text)
    return (
        any(term in text for term in capability_terms)
        and any(term in text for term in policy_terms)
        and not install_intent
    )


def parse_email_message(raw: str) -> tuple[str, str, bool]:
    """Pull an explicit subject/body out of a send request.

    Returns (subject, body, body_is_explicit). If the request gives an explicit "Body:" /
    "saying ..." the body is used verbatim and body_is_explicit is True. Otherwise body is ""
    and the caller should have the LLM compose it from the request (body_is_explicit False)."""
    subject = ""
    body = ""
    subject_match = re.search(
        r"subject\s*[:\-]\s*(.+?)\s*(?:\n|(?:\bbody\b|\bmessage\b|\btext\b)\s*[:\-]|(?:\bsaying\b|\bthat says\b)\s|$)",
        raw,
        re.IGNORECASE,
    )
    if subject_match:
        subject = clean(subject_match.group(1).strip().strip("\"'").rstrip(".,;: "), 300)
    # Marker style first ("body:", "message:", "text:"), then natural phrasing ("saying ...").
    body_match = re.search(r"(?:\bbody\b|\bmessage\b|\btext\b)\s*[:\-]\s*(.+)", raw, re.IGNORECASE | re.DOTALL)
    if not body_match:
        body_match = re.search(r"(?:\bsaying\b|\bthat says\b|\bwhich says\b|\bthat reads\b)\s+(.+)", raw, re.IGNORECASE | re.DOTALL)
    body_is_explicit = bool(body_match)
    if body_match:
        body = clean(body_match.group(1).strip().strip("\"'"), 8000)
    if not subject:
        subject = guess_subject(raw) or "Message from the Compass companion"
    return subject, body, body_is_explicit


def detect_agent_email_send(title: str, details: str) -> ApprovalNeed | None:
    """A request to send mail from the companion's OWN mailbox, addressed to a concrete
    recipient. Routed to the host-brokered agent-email flow (email_campaign approval that,
    once approved, the trusted host actually sends). If no address is present yet (it still
    needs to be scraped/looked up), returns None so a research/browse step can run first."""
    raw = clean(f"{title}\n{details}", 4000)
    text = raw.lower()
    send_phrases = (
        "send email",
        "send an email",
        "send a mail",
        "send an e-mail",
        "send me an email",
        "send this email",
        "send the email",
        "send them an email",
        "send her an email",
        "send him an email",
        "email me at",
    )
    if not any(phrase in text for phrase in send_phrases):
        return None
    # Named-relationship / operator-identity outreach (co-creator, security reviewer, "contact my …")
    # stays on the draft-only external_contact path; the agent mailbox only handles generic sends.
    relationship_markers = (
        "co-creator",
        "cocreator",
        "security specialist",
        "security reviewer",
        "external contact",
        "contact my",
        "contact the",
        "message my",
        "message the",
    )
    if any(marker in text for marker in relationship_markers):
        return None
    recipient = extract_email(raw)
    if not recipient:
        return None
    subject, body, body_is_explicit = parse_email_message(raw)
    # When the operator didn't dictate a literal body, the companion composes one with the LLM
    # (see Bridge.compose_email_if_needed). Detection stays a pure function, so we only stash the
    # brief here; the composed body is filled in and shown for review before the approval is created.
    compose_brief = "" if body_is_explicit else raw
    body_block = body if body_is_explicit else "(the companion will draft the message body from your request — review it below before approving)"
    return ApprovalNeed(
        type="email_campaign",
        title=f"Send email from agent mailbox to {recipient}",
        details=(
            "The companion wants to send an email from its OWN dedicated mailbox "
            "(host-brokered — the worker never holds the mailbox credentials). "
            "Approving sends this exact message and authorizes 1 new recipient.\n\n"
            f"To: {recipient}\nSubject: {subject}\n\n{body_block}\n\n"
            f"Original request:\n{raw}"
        ),
        expected_response="Approve to send this message from the agent mailbox, or deny / return edits.",
        sensitive=True,
        risk_level="medium",
        planned_recipients=1,
        campaign_purpose=clean(raw, 1000),
        email_to=recipient,
        email_subject=subject,
        email_body=body,
        email_compose_brief=compose_brief,
    )


def detect_external_contact(title: str, details: str) -> ApprovalNeed | None:
    raw = clean(f"{title}\n{details}", 2500)
    text = raw.lower()
    phrases = (
        "send email",
        "send an email",
        "write an email",
        "email my",
        "email the",
        "contact my",
        "contact the",
        "message my",
        "message the",
        "co-creator",
        "cocreator",
        "security specialist",
        "security reviewer",
        "external contact",
    )
    if not any(phrase in text for phrase in phrases):
        return None
    return ApprovalNeed(
        type="external_contact",
        title="External contact approval needed",
        details=(
            "The request appears to involve contacting someone outside Latch.\n\n"
            f"Original request:\n{raw}"
        ),
        expected_response="Review the draft/scope. Send manually if appropriate, or return edits/boundaries.",
        sensitive=True,
        risk_level="medium",
        recipient=extract_email(raw),
        subject=guess_subject(raw),
        contact_purpose=raw,
        body_preview=raw,
        send_mode="manual",
    )


def detect_web_research(title: str, details: str) -> ApprovalNeed | None:
    raw = clean(f"{title}\n{details}", 2500)
    text = raw.lower()
    phrases = (
        "browse",
        "web research",
        "internet research",
        "look up",
        "search the web",
        "google",
        "scrape",
        "crawl",
        "read the docs",
        "read website",
        "check website",
    )
    if not any(phrase in text for phrase in phrases):
        return None
    seed_urls = extract_urls(raw)
    allowed_domains = extract_domains(raw)
    if not seed_urls and is_open_web_search_request(text):
        query = search_query_from_request(raw)
        plan = {
            "mode": "browser",
            "summary": f"Search the public web for: {query}",
            "sensitive": False,
            "riskLevel": "medium",
            "timeoutSeconds": 180,
            "commands": [],
            "actions": [
                {
                    "type": "search_web",
                    "text": query,
                    "timeoutMs": 60000,
                    "maxResults": 4,
                }
            ],
            "expectedResult": "Concise public source notes from search results, with URLs, suitable for operator review and saved context when requested.",
        }
        return ApprovalNeed(
            type="command",
            title="Browser web search approval needed",
            details=(
                "The request asks for open-ended public web search. The VM browser executor can run a small approved search, open a few public results, and report concise source notes.\n\n"
                f"Original request:\n{raw}"
            ),
            expected_response="Approve to let the VM browser search the public web and extract concise source notes.",
            sensitive=False,
            risk_level="medium",
            action_preview=plan["summary"],
            rendered_commands=(f"search web: {query}",),
            execution_mode="browser",
            execution_plan=plan,
        )
    return ApprovalNeed(
        type="web_research",
        title="Bounded web research approval needed",
        details=(
            "The request appears to need web access or scraping. Exact-URL research is available after approval; browser execution requires the separate executor.\n\n"
            f"Original request:\n{raw}"
        ),
        expected_response="Approve a narrow source list/page budget, or deny and provide manual sources.",
        sensitive=False,
        risk_level="medium",
        allowed_domains=allowed_domains,
        seed_urls=seed_urls,
        max_pages=5,
        token_budget=3000,
        research_question=raw,
    )


def is_open_web_search_request(text: str) -> bool:
    search_terms = ("google", "search the web", "look up", "scrape the net", "scrape web", "find online")
    return any(term in text for term in search_terms)


def search_query_from_request(raw: str) -> str:
    text = re.sub(r"(?im)^(inbox instruction|task):\s*", " ", raw)
    text = re.sub(r"(?i)\b(can you|please|could you|would you)\b", " ", text)
    text = re.sub(r"(?i)\b(google|search the web for|search the web|look up|scrape the net about|scrape the net|scrape|browse|research)\b", " ", text)
    text = re.sub(r"(?i)\b(and write down in your context what you learn|write down in your context|save .*?context|remember what you learn)\b", " ", text)
    text = collapse_whitespace(text)
    return clean(text or raw, 240)


def detect_status_template(text: str) -> str:
    if any(phrase in text for phrase in ("bridge log", "agent log", "latch-agent-bridge log")):
        return "bridge.logs"
    if any(phrase in text for phrase in ("bridge status", "agent status", "latch-agent-bridge status")):
        return "bridge.status"
    if "gateway health" in text or "openclaw health" in text:
        return "openclaw.gateway.health"
    if "docker status" in text or "docker compose ps" in text or "container status" in text:
        return "docker.status"
    if "tailscale status" in text or "tailscale ip" in text:
        return "tailscale.status"
    if "repo status" in text or "git status" in text or "checkout status" in text:
        return "repo.status"
    return ""


def enrich_status_template(approval: ApprovalNeed, args: argparse.Namespace) -> ApprovalNeed:
    if approval.execution_mode != "read_only_status" or not approval.action_template:
        return approval
    commands = command_template(approval.action_template, args)
    rendered = tuple(render_command(command) for command in commands)
    return ApprovalNeed(
        type=approval.type,
        title=approval.title,
        details=approval.details,
        expected_response=approval.expected_response,
        sensitive=approval.sensitive,
        command="\n".join(rendered),
        risk_level=approval.risk_level,
        action_template=approval.action_template,
        action_preview=approval.action_preview,
        rendered_commands=rendered,
        execution_mode=approval.execution_mode,
        execution_plan=approval.execution_plan,
        recipient=approval.recipient,
        subject=approval.subject,
        contact_purpose=approval.contact_purpose,
        body_preview=approval.body_preview,
        attachments=approval.attachments,
        send_mode=approval.send_mode,
        allowed_domains=approval.allowed_domains,
        seed_urls=approval.seed_urls,
        max_pages=approval.max_pages,
        token_budget=approval.token_budget,
        research_question=approval.research_question,
        refresh_research=approval.refresh_research,
        github_repo_name=approval.github_repo_name,
        github_description=approval.github_description,
        github_visibility=approval.github_visibility,
        github_owner=approval.github_owner,
        github_auto_init=approval.github_auto_init,
        github_file_path=approval.github_file_path,
        github_file_content=approval.github_file_content,
        github_commit_message=approval.github_commit_message,
    )


def is_generic_command_boundary(matched_keywords: list[str], command: str) -> bool:
    if command:
        return False
    generic = {"run command", "execute", "terminal", "shell"}
    return set(matched_keywords).issubset(generic)


def extract_command(text: str) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    command_lines = [
        line for line in lines
        if line.startswith(("`", "$", ">", "sudo ", "docker ", "systemctl ", "ssh ", "scp ", "powershell"))
    ]
    return clean("\n".join(command_lines).replace("`", ""), 4000)


def extract_github_repo_name(text: str, allow_guess: bool = True) -> str:
    if re.search(r"\bcompass\s*proj\w*\b|\bcompassproj\w*\b", text, flags=re.IGNORECASE):
        return DEFAULT_CODE_REPO
    patterns = (
        r"\b(?:repo|repository)\s+(?:named|called)\s+[`\"']?([a-zA-Z0-9._ -]{1,100})",
        r"\b(?:githubRepoName|repoName|repo)\s*[:=]\s*[`\"']?([a-zA-Z0-9._ -]{1,100})",
        r"\bgithub\s+(?:repo|repository)\s+[`\"']?([a-zA-Z0-9._ -]{1,100})",
    )
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            cleaned = clean_github_repo_name(match.group(1))
            if cleaned:
                return cleaned
    lowered = text.lower()
    if not allow_guess:
        return ""
    if "compass" in lowered or "companion" in lowered:
        return "compass-companion"
    words = re.findall(r"[a-zA-Z0-9][a-zA-Z0-9_-]{2,}", text)
    stop = {"github", "repo", "repository", "create", "make", "publish", "please", "next", "want", "able", "code"}
    usable = [word.lower() for word in words if word.lower() not in stop]
    return clean_github_repo_name("-".join(usable[:4]) or "compass-project")


def extract_github_file_path(text: str) -> str:
    match = re.search(r"\b(?:path|file)\s*[:=]\s*[`\"']?([a-zA-Z0-9._ /\-]{1,200})", text, flags=re.IGNORECASE)
    if match:
        return clean_github_file_path(match.group(1))
    if re.search(r"\b(website|web site|webpage|web page|static site|html|hello world|hello work)\b", text, flags=re.IGNORECASE):
        return "index.html"
    if "readme" in text.lower():
        return "README.md"
    return "README.md"


def clean_github_file_path(value: str) -> str:
    parts = []
    for part in clean(value or "README.md", 200).replace("\\", "/").lstrip("/").split("/"):
        if part in {"", ".", ".."}:
            continue
        cleaned = re.sub(r"[^a-zA-Z0-9._ -]", "_", part).strip()
        if cleaned:
            parts.append(cleaned)
    return "/".join(parts)[:200] or "README.md"


def draft_github_file_content(text: str, file_path: str) -> str:
    explicit = re.search(r"(?:content|body)\s*[:=]\s*([\s\S]+)$", text, flags=re.IGNORECASE)
    if explicit:
        return clean(explicit.group(1), 12000)
    if file_path.lower().endswith((".html", ".htm")):
        title = "Compass Hello"
        if re.search(r"hello\s+world|hello\s+work", text, flags=re.IGNORECASE):
            heading = "Hello world"
        else:
            heading = "Hello from Compass"
        return clean(
            "<!doctype html>\n"
            "<html lang=\"en\">\n"
            "<head>\n"
            "  <meta charset=\"utf-8\">\n"
            "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
            f"  <title>{html.escape(title)}</title>\n"
            "  <style>\n"
            "    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #f4f7fa; color: #101828; }\n"
            "    main { width: min(680px, calc(100% - 32px)); padding: 32px; border: 1px solid #d0d7e2; border-radius: 8px; background: white; box-shadow: 0 12px 35px rgba(16, 24, 40, 0.10); }\n"
            "    h1 { margin: 0 0 12px; font-size: clamp(2rem, 8vw, 4rem); }\n"
            "    p { margin: 0; color: #667085; font-size: 1.1rem; line-height: 1.5; }\n"
            "  </style>\n"
            "</head>\n"
            "<body>\n"
            "  <main>\n"
            f"    <h1>{html.escape(heading)}</h1>\n"
            "    <p>A tiny Compass website committed through Latch after operator approval.</p>\n"
            "  </main>\n"
            "</body>\n"
            "</html>\n",
            12000,
        )
    if file_path.lower() == "readme.md":
        repo = extract_github_repo_name(text, allow_guess=False)
        title = (repo or DEFAULT_CODE_REPO).replace("-", " ").replace("_", " ").strip().title() or "Compass Project"
        quoted = re.findall(r"[\"']([^\"']{1,500})[\"']", text)
        extra = f"\n{quoted[-1]}\n" if quoted else ""
        return clean(
            f"# {title}\n\n"
            "A Compass-managed project repository.\n\n"
            "This README was drafted through Latch after operator approval. "
            "Future updates should stay scoped, reviewable, and owned by the operator.\n"
            f"{extra}",
            12000,
        )
    return clean(text, 12000)


def clean_github_repo_name(value: str) -> str:
    name = re.sub(r"\s+", "-", clean(value, 100))
    name = re.sub(r"[^a-zA-Z0-9._-]", "", name)
    name = re.sub(r"\.git$", "", name, flags=re.IGNORECASE).strip(".-")
    return name if re.fullmatch(r"[a-zA-Z0-9._-]{1,100}", name or "") else "compass-project"


def guess_github_description(text: str) -> str:
    first = clean(text.splitlines()[0] if text.splitlines() else text, 240)
    if len(first) > 20:
        return first
    return "Repository created through Compass and Latch."


def extract_email(text: str) -> str:
    match = re.search(r"[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}", text)
    return clean(match.group(0), 300) if match else ""


def reply_subject(subject: str) -> str:
    s = clean(subject or "", 200).strip()
    if not s:
        return "Re: your message"
    return s if re.match(r"(?i)^re:", s) else f"Re: {s}"


def is_automated_or_self(sender: str, own_address: str) -> bool:
    """Guard against mail loops: never auto-reply to our own address or to automated senders."""
    s = (sender or "").strip().lower()
    if not s:
        return True
    if own_address and s == own_address.strip().lower():
        return True
    local = s.split("@")[0]
    return any(marker in local for marker in ("mailer-daemon", "no-reply", "noreply", "donotreply", "do-not-reply", "postmaster", "bounce"))


def extract_domains(text: str) -> tuple[str, ...]:
    matches = re.findall(r"https?://([^/\s)]+)", text)
    domains = []
    for match in matches:
        domain = clean(match.lower().strip(".,;:").split("@")[-1].split(":")[0], 120)
        if domain and domain not in domains:
            domains.append(domain)
    return tuple(domains[:8])


def extract_urls(text: str) -> tuple[str, ...]:
    urls = []
    for match in re.findall(r"https?://[^\s)>\]\"']+", text):
        url = clean(match.rstrip(".,;:"), 500)
        if url and url not in urls:
            urls.append(url)
    return tuple(urls[:12])


def guess_subject(text: str) -> str:
    lowered = text.lower()
    if "security" in lowered and "review" in lowered:
        return "Security review request for Latch"
    if "co-creator" in lowered or "cocreator" in lowered:
        return "Latch co-creator discussion"
    return ""


def perform_read_only_research(approval: dict, args: argparse.Namespace) -> dict:
    started_at = utc_now()
    question = clean(approval.get("researchQuestion") or approval.get("details") or "", 1000)
    seed_urls = ordered_unique(
        list(approval.get("seedUrls") or [])
        + list(extract_urls(approval.get("details") or ""))
        + list(extract_urls(approval.get("researchQuestion") or ""))
        + list(extract_urls(approval.get("responseNote") or ""))
    )[:12]
    allowed_domains = ordered_unique(list(approval.get("allowedDomains") or []) + list(extract_domains(" ".join(seed_urls))))[:12]
    max_pages = clamp_int(approval.get("maxPages"), 1, 5, 3)
    token_budget = clamp_int(approval.get("tokenBudget"), 500, 4000, 3000)
    char_budget = token_budget * 4
    refresh = bool(approval.get("refreshResearch")) or wants_refresh(approval.get("responseNote") or "")
    cache_path = Path(args.source_cache_path).expanduser()
    cache = load_source_cache(cache_path)
    cache_changed = False
    sources = []
    errors = []

    if not seed_urls:
        errors.append("No exact seed URL was approved; no web request was made.")
    if not allowed_domains:
        errors.append("No allowed domain was approved; no web request was made.")

    for url in seed_urls:
        if len(sources) >= max_pages:
            break
        try:
            validate_research_url(url, allowed_domains)
            cache_key = normalized_url_key(url)
            if not refresh and cache_key in cache:
                cached = dict(cache[cache_key])
                cached["cached"] = True
                sources.append(cached)
                continue

            source = fetch_source_note(url, allowed_domains, question, max(500, min(1200, char_budget // max_pages)))
            sources.append(source)
            cache[cache_key] = {**source, "cached": False}
            cache_changed = True
        except Exception as exc:  # noqa: BLE001 - capture per-source failure
            errors.append(f"{url}: {exc}")

    if cache_changed:
        save_source_cache(cache_path, cache)

    combined_summary = summarize_sources(question, sources, char_budget)
    status = "completed" if sources and not errors else "partial" if sources else "failed"
    return {
        "approvalId": clean(approval.get("id") or "", 120),
        "taskId": clean(approval.get("taskId") or "", 120),
        "question": question,
        "allowedDomains": allowed_domains,
        "seedUrls": seed_urls,
        "pagesFetched": len(sources),
        "tokenBudget": token_budget,
        "status": status,
        "summary": combined_summary,
        "sources": sources,
        "errors": errors[:12],
        "startedAt": started_at,
        "finishedAt": utc_now(),
    }


def fetch_source_note(url: str, allowed_domains: list[str], question: str, summary_limit: int) -> dict:
    # SECURITY (pre-public review H3): validate BEFORE the network call, not after. The previous
    # order fetched first and validated the final URL second, so the initial request itself (and,
    # via redirects, any later one) reached the network unchecked. fetch_research_page additionally
    # refuses to follow redirects at all, so this one validated URL is the only address ever
    # contacted for this request.
    validate_research_url(url, allowed_domains)
    page = fetch_research_page(url)
    validate_research_url(page["url"], allowed_domains)
    text = extract_readable_text(page["body"], page["contentType"])
    title = extract_title(page["body"]) or page["url"]
    summary = summarize_text(text, question, summary_limit)
    return {
        "requestedUrl": url,
        "finalUrl": page["url"],
        "url": page["url"],
        "title": title,
        "status": page["status"],
        "summary": summary,
        "excerpt": clean(text, 1000),
        "fetchedAt": utc_now(),
        "cached": False,
    }


def load_source_cache(path: Path) -> dict:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(raw, dict):
        return {}
    result = {}
    for key, source in raw.items():
        if not isinstance(source, dict):
            continue
        cleaned = {
            "requestedUrl": clean(source.get("requestedUrl") or "", 500),
            "finalUrl": clean(source.get("finalUrl") or source.get("url") or "", 500),
            "url": clean(source.get("url") or source.get("finalUrl") or "", 500),
            "title": clean(source.get("title") or "", 240),
            "status": clamp_int(source.get("status"), 0, 599, 0),
            "summary": clean(source.get("summary") or "", 1500),
            "excerpt": clean(source.get("excerpt") or "", 1000),
            "fetchedAt": clean(source.get("fetchedAt") or "", 80),
            "cached": False,
        }
        if key and cleaned["url"]:
            result[clean(key, 500)] = cleaned
    return result


def save_source_cache(path: Path, cache: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    limited = dict(list(cache.items())[-200:])
    path.write_text(json.dumps(limited, indent=2, sort_keys=True), encoding="utf-8")


def normalized_url_key(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    scheme = parsed.scheme.lower()
    host = (parsed.hostname or "").lower()
    port = f":{parsed.port}" if parsed.port else ""
    path = parsed.path or "/"
    query = f"?{parsed.query}" if parsed.query else ""
    return f"{scheme}://{host}{port}{path}{query}"


def wants_refresh(note: str) -> bool:
    lowered = str(note or "").lower()
    return any(phrase in lowered for phrase in ("refresh", "refetch", "ignore cache", "fresh fetch"))


def validate_research_url(url: str, allowed_domains: list[str]) -> None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise RuntimeError("Only http/https URLs are allowed.")
    if parsed.username or parsed.password:
        raise RuntimeError("URLs with embedded credentials are not allowed.")
    host = (parsed.hostname or "").lower()
    if not host:
        raise RuntimeError("URL has no hostname.")
    if host in {"localhost", "127.0.0.1", "::1"} or host.endswith(".local"):
        raise RuntimeError("Private or local hostnames are not allowed.")
    normalized_allowed = [domain.lower().lstrip(".") for domain in allowed_domains if domain]
    if not any(host == domain or host.endswith(f".{domain}") for domain in normalized_allowed):
        raise RuntimeError(f"Host {host} is outside the approved domain list.")
    reject_private_host(host)


def reject_private_host(host: str) -> None:
    try:
        ip = ipaddress.ip_address(host)
        if is_private_ip(ip):
            raise RuntimeError("Private, local, multicast, or reserved IP targets are not allowed.")
        return
    except ValueError:
        pass
    for _family, _type, _proto, _canonname, sockaddr in socket.getaddrinfo(host, None):
        ip = ipaddress.ip_address(sockaddr[0])
        if is_private_ip(ip):
            raise RuntimeError("Approved research URLs must not resolve to private or local IP addresses.")


def is_private_ip(ip: ipaddress._BaseAddress) -> bool:
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    # SECURITY (pre-public review H3): returning None here tells urllib not to follow the
    # redirect. urllib's default behaviour re-requests the Location target with no revalidation,
    # which is exactly the SSRF bypass this closes -- a validated, allow-listed URL could 302 to an
    # internal/metadata address and urllib would fetch it transparently. Research fetch is
    # documented as "exact approved URLs only", so refusing redirects outright (rather than trying
    # to safely re-validate and follow each hop) is both the simplest fix and the correct behavior.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch_research_page(url: str) -> dict:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "LatchReadOnlyResearch/0.1",
            "Accept": "text/html,text/plain,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.2",
            "Range": "bytes=0-500000",
        },
        method="GET",
    )
    opener = urllib.request.build_opener(_NoRedirectHandler)
    try:
        with opener.open(request, timeout=12) as response:
            status = getattr(response, "status", None) or response.getcode()
            if 300 <= status < 400:
                raise RuntimeError(
                    f"Refusing to follow a redirect from {url}. Research fetch only supports "
                    "exact approved URLs, not redirects."
                )
            content_type = response.headers.get("content-type", "")
            if not is_textual_content_type(content_type):
                raise RuntimeError(f"Unsupported content type: {content_type or 'unknown'}")
            body = response.read(500_000)
            charset = response.headers.get_content_charset() or "utf-8"
            return {
                "url": response.geturl(),
                "status": status,
                "contentType": content_type,
                "body": body.decode(charset, errors="replace"),
            }
    except urllib.error.HTTPError as exc:
        # Defensive fallback: on some redirect status codes / Python versions the chain above
        # raises HTTPError instead of returning the raw response. Treat that the same way.
        if 300 <= exc.code < 400:
            raise RuntimeError(
                f"Refusing to follow a redirect from {url}. Research fetch only supports exact "
                "approved URLs, not redirects."
            ) from exc
        raise


def is_textual_content_type(content_type: str) -> bool:
    lowered = content_type.lower()
    return (
        lowered.startswith("text/")
        or "html" in lowered
        or "xml" in lowered
        or "json" in lowered
    )


def extract_title(raw: str) -> str:
    match = re.search(r"<title[^>]*>(.*?)</title>", raw, flags=re.IGNORECASE | re.DOTALL)
    if not match:
        return ""
    return clean(collapse_whitespace(html.unescape(strip_tags(match.group(1)))), 240)


def extract_readable_text(raw: str, content_type: str) -> str:
    if "html" not in content_type.lower() and "<html" not in raw[:1000].lower():
        return clean(collapse_whitespace(raw), 12000)
    text = re.sub(r"(?is)<(script|style|noscript|svg|nav|header|footer|form|aside)[^>]*>.*?</\1>", " ", raw)
    text = re.sub(r"(?is)<!--.*?-->", " ", text)
    text = re.sub(r"(?i)</(p|div|section|article|h[1-6]|li|tr)>", ". ", text)
    text = strip_tags(text)
    text = html.unescape(text)
    return clean(collapse_whitespace(text), 12000)


def strip_tags(value: str) -> str:
    return re.sub(r"(?s)<[^>]+>", " ", value)


def collapse_whitespace(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def summarize_text(text: str, question: str, limit: int) -> str:
    sentences = split_sentences(text)
    if not sentences:
        return clean(text, limit)
    terms = significant_terms(question)
    scored = []
    for index, sentence in enumerate(sentences[:80]):
        lowered = sentence.lower()
        score = sum(1 for term in terms if term in lowered)
        if score:
            scored.append((score, -index, sentence))
    selected = [item[2] for item in sorted(scored, reverse=True)[:6]]
    if not selected:
        selected = sentences[:5]
    return clean(" ".join(selected), limit)


def summarize_sources(question: str, sources: list[dict], char_budget: int) -> str:
    if not sources:
        return "No approved public pages were fetched."
    parts = [f"Question: {question or '(not specified)'}", "", "Source notes:"]
    for source in sources:
        parts.append(f"- {source['title']} ({source['url']}): {source['summary']}")
    return clean("\n".join(parts), min(6000, char_budget))


def split_sentences(text: str) -> list[str]:
    return [clean(part, 500) for part in re.split(r"(?<=[.!?])\s+", text) if clean(part, 500)]


def significant_terms(text: str) -> list[str]:
    stop = {"the", "and", "for", "with", "that", "this", "from", "what", "how", "why", "can", "should", "would", "about", "please", "research", "browse", "summarize"}
    terms = []
    for term in re.findall(r"[a-zA-Z0-9][a-zA-Z0-9_-]{2,}", text.lower()):
        if term not in stop and term not in terms:
            terms.append(term)
    return terms[:20]


def format_research_report(result: dict) -> str:
    lines = [
        "Read-only research completed.",
        "",
        f"Status: {result['status']}",
        f"Pages fetched: {result['pagesFetched']}",
        f"Token budget: {result['tokenBudget']}",
        "",
        result.get("summary") or "(no summary)",
    ]
    if result.get("errors"):
        lines.extend(["", "Errors:", *[f"- {error}" for error in result["errors"]]])
    return clean("\n".join(lines), 6000)


def ordered_unique(values: list[str]) -> list[str]:
    result = []
    for value in values:
        cleaned = clean(value, 500)
        if cleaned and cleaned not in result:
            result.append(cleaned)
    return result


def clamp_int(value: object, minimum: int, maximum: int, fallback: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, number))


def extract_json_object(text: str) -> str:
    stripped = str(text or "").strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?\s*", "", stripped, flags=re.I)
        stripped = re.sub(r"\s*```$", "", stripped)
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start < 0 or end < start:
        raise RuntimeError("Planner did not return a JSON object.")
    return stripped[start : end + 1]


def sanitize_execution_plan(plan: dict) -> dict:
    if not isinstance(plan, dict):
        raise RuntimeError("Planner returned a non-object plan.")
    mode = clean(plan.get("mode") or plan.get("executionMode") or "shell", 20)
    if mode not in {"shell", "browser"}:
        raise RuntimeError(f"Unsupported execution mode: {mode}")
    commands = [clean(command, 1000) for command in list(plan.get("commands") or [])[:20]]
    commands = [command for command in commands if command]
    actions = []
    for action in list(plan.get("actions") or [])[:40]:
        if not isinstance(action, dict):
            continue
        action_type = clean(action.get("type") or "", 40)
        if action_type not in {"open", "extract_text", "screenshot", "click", "fill", "press", "wait", "download"}:
            continue
        actions.append(
            {
                "type": action_type,
                "url": clean(action.get("url") or "", 1000),
                "selector": clean(action.get("selector") or "", 500),
                "text": clean(action.get("text") or "", 2000),
                "key": clean(action.get("key") or "", 80),
                "path": clean(action.get("path") or "", 1000),
                "timeoutMs": clamp_int(action.get("timeoutMs"), 0, 120000, 0),
            }
        )
    if mode == "shell" and not commands:
        raise RuntimeError("Shell execution plans must include at least one command.")
    if mode == "browser" and not actions:
        raise RuntimeError("Browser execution plans must include at least one action.")
    return {
        "mode": mode,
        "summary": clean(plan.get("summary") or "", 1000),
        "sensitive": bool(plan.get("sensitive")),
        "riskLevel": clean(plan.get("riskLevel") or "medium", 20) if clean(plan.get("riskLevel") or "medium", 20) in {"low", "medium", "high"} else "medium",
        "timeoutSeconds": clamp_int(plan.get("timeoutSeconds"), 1, 1800, 300),
        "commands": commands,
        "actions": actions,
        "expectedResult": clean(plan.get("expectedResult") or "", 1000),
    }


def command_template(template_id: str, args: argparse.Namespace) -> list[dict]:
    repo_dir = str(Path(args.latch_repo_dir).expanduser())
    compose_dir = str(Path(args.openclaw_compose_dir).expanduser())
    health_url = clean(args.openclaw_health_url or "http://127.0.0.1:18789/healthz", 300)
    templates = {
        "bridge.status": [
            {"argv": ["systemctl", "is-active", "latch-agent-bridge"]},
            {"argv": ["systemctl", "status", "latch-agent-bridge", "--no-pager"]},
        ],
        "bridge.logs": [
            {"argv": ["journalctl", "-u", "latch-agent-bridge", "--no-pager", "-n", "80"]},
        ],
        "openclaw.gateway.health": [
            {"argv": ["curl", "-fsS", health_url]},
        ],
        "docker.status": [
            {"argv": ["docker", "compose", "ps"], "cwd": compose_dir},
        ],
        "tailscale.status": [
            {"argv": ["tailscale", "status"]},
            {"argv": ["tailscale", "ip", "-4"]},
        ],
        "repo.status": [
            {"argv": ["git", "status", "--short"], "cwd": repo_dir},
            {"argv": ["git", "rev-parse", "--short", "HEAD"], "cwd": repo_dir},
        ],
    }
    return templates.get(template_id, [])


def validate_read_only_commands(commands: list[dict]) -> None:
    banned = {"sudo", "su", "rm", "mv", "cp", "install", "chmod", "chown", "apt", "apt-get", "tee", "sh", "bash", "powershell"}
    for command in commands:
        argv = command.get("argv") or []
        if not argv or any(token in {"|", ">", ">>", "<", "&&", "||", ";"} for token in argv):
            raise RuntimeError("Rejected unsafe diagnostic command shape.")
        if argv[0] in banned:
            raise RuntimeError(f"Rejected unsafe diagnostic command: {argv[0]}")


def render_command(command: dict) -> str:
    prefix = ""
    if command.get("cwd"):
        prefix = f"(cd {shlex.quote(command['cwd'])} && "
    rendered = shlex.join(command["argv"])
    return f"{prefix}{rendered}{')' if prefix else ''}"


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def clean_channel_id(value: object) -> str:
    text = str(value or "").strip().lower()
    text = re.sub(r"[^a-z0-9_-]+", "-", text)
    return text.strip("-")[:48]


def task_processing_key(task: dict) -> str:
    task_id = str(task.get("id") or "")
    version = str(task.get("updatedAt") or task.get("createdAt") or task.get("reopenCount") or "")
    return f"{task_id}:{version}" if version else task_id


def clean_routing(value: object) -> str:
    text = str(value or "auto").strip().lower()
    if text in {"auto", "local", "network"}:
        return text
    return "auto"


def channel_briefing(channels: list[dict], response_channel: str) -> str:
    if not channels:
        return "Latch channels: reply in Compass unless the operator names another Latch channel."
    names = []
    for channel in channels[:20]:
        channel_id = clean_channel_id(channel.get("id") or channel.get("label"))
        label = clean(channel.get("label") or channel_id, 80)
        if channel_id:
            names.append(f"- {label} ({channel_id})")
    target = clean_channel_id(response_channel or "compass")
    return (
        "Latch channel routing:\n"
        "You may post your own Latch reply/status update into these internal channels. "
        "This is allowed and is not external messaging. Do not say you cannot write to Latch channels.\n"
        f"Target channel for this response: {target or 'compass'}\n"
        f"Available channels:\n{chr(10).join(names) if names else '- Compass (compass)'}"
    )


def requested_latch_channel(text: str, channels: list[dict]) -> str:
    lowered = f" {str(text or '').lower()} "
    entries = []
    for channel in channels:
        channel_id = clean_channel_id(channel.get("id") or channel.get("label"))
        label = clean(channel.get("label") or channel_id, 80).lower()
        if channel_id:
            entries.append((channel_id, channel_id.replace("-", " ")))
        if label:
            entries.append((channel_id, label))

    for channel_id, name in sorted(set(entries), key=lambda item: len(item[1]), reverse=True):
        if not channel_id or not name:
            continue
        escaped = re.escape(name)
        patterns = (
            rf"#\s*{escaped}\b",
            rf"\b{escaped}\s+channel\b",
            rf"\bchannel\s+{escaped}\b",
            rf"\b(in|to|into|under)\s+(the\s+)?{escaped}\b",
        )
        if any(re.search(pattern, lowered) for pattern in patterns):
            return channel_id
    return ""


def context_briefing(items: list[dict], profile: dict | None = None) -> str:
    lines = [
        "Compass context briefing:",
        "Use shared context as durable operator-provided memory. Treat private/unshared items as unavailable except for their title/metadata.",
    ]

    profile = profile or {}
    if profile.get("shareWithAgent", True):
        profile_lines = []
        anchor_purpose = profile.get("anchorPurpose") or profile.get("foundationPurpose")
        if anchor_purpose:
            profile_lines.append(
                "Companion anchor (repo-defined, higher priority than user-editable profile fields):\n"
                f"{clean(anchor_purpose, 1600)}"
            )
        if profile.get("name"):
            profile_lines.append(f"Working name: {clean(profile.get('name'), 120)}")
        if profile.get("purpose"):
            profile_lines.append(f"Purpose:\n{clean(profile.get('purpose'), 1200)}")
        if profile.get("goals"):
            profile_lines.append(f"Current goals:\n{clean(profile.get('goals'), 1800)}")
        if profile.get("boundaries"):
            profile_lines.append(f"Boundaries:\n{clean(profile.get('boundaries'), 1800)}")
        if profile.get("communicationStyle"):
            profile_lines.append(f"Communication style:\n{clean(profile.get('communicationStyle'), 1200)}")
        if profile_lines:
            lines.append("Companion profile:")
            lines.extend(profile_lines)

    if not items:
        if len(lines) == 2:
            return "Compass context briefing: no saved context has been shared yet."
        return "\n".join(lines)

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
