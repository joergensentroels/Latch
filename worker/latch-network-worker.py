#!/usr/bin/env python3
"""
Latch Network private-alpha compute worker.

Runs on a trusted lending machine. It polls Latch for assigned chat jobs and
forwards them to either an Ollama native endpoint or an OpenAI-compatible
chat-completions endpoint. It never receives the operator key, agent key, or
provider API keys from Latch.
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


def main() -> int:
    parser = argparse.ArgumentParser(description="Latch Network compute worker.")
    parser.add_argument("--base-url", default=os.getenv("LATCH_BASE_URL", "").rstrip("/"))
    parser.add_argument("--worker-token", default=os.getenv("LATCH_WORKER_TOKEN", ""))
    parser.add_argument("--worker-name", default=os.getenv("LATCH_WORKER_NAME", socket.gethostname()))
    parser.add_argument("--backend", choices=("ollama", "openai-compatible"), default=os.getenv("LATCH_WORKER_BACKEND", "ollama"))
    parser.add_argument("--backend-url", default=os.getenv("LATCH_WORKER_BACKEND_URL", "http://127.0.0.1:11434"))
    parser.add_argument("--backend-config", default=os.getenv("LATCH_WORKER_BACKEND_CONFIG", ""))
    parser.add_argument("--backend-api-key", default=os.getenv("LATCH_WORKER_BACKEND_API_KEY", ""))
    parser.add_argument("--models", default=os.getenv("LATCH_WORKER_MODELS", ""))
    parser.add_argument("--default-model", default=os.getenv("LATCH_WORKER_DEFAULT_MODEL", ""))
    parser.add_argument("--capacity", type=int, default=int(os.getenv("LATCH_WORKER_CAPACITY", "1")))
    parser.add_argument("--input-credits-per-1k", type=int, default=int(os.getenv("LATCH_INPUT_CREDITS_PER_1K", "1")))
    parser.add_argument("--output-credits-per-1k", type=int, default=int(os.getenv("LATCH_OUTPUT_CREDITS_PER_1K", "2")))
    parser.add_argument("--interval", type=int, default=int(os.getenv("LATCH_WORKER_POLL_INTERVAL", "5")))
    parser.add_argument("--quiet", action="store_true", default=env_bool("LATCH_WORKER_QUIET", False))
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    apply_backend_config(args)

    if not args.base_url:
        print("Missing LATCH_BASE_URL or --base-url", file=sys.stderr)
        return 2
    if not args.worker_token:
        print("Missing LATCH_WORKER_TOKEN or --worker-token", file=sys.stderr)
        return 2
    if args.worker_token in {"worker_replace_me", "worker_paste_invite_token_here"}:
        print("Replace the placeholder worker token with the real worker_... invite token from Timeline > Latch Network.", file=sys.stderr)
        return 2

    worker = NetworkWorker(args)
    try:
        while True:
            worker.tick()
            if args.once:
                return 0
            time.sleep(max(2, args.interval))
    except KeyboardInterrupt:
        print("\n[stop] Latch Network worker stopped.", flush=True)
        return 0


class NetworkWorker:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args

    def tick(self) -> None:
        self.heartbeat()
        payload = self.request_json("GET", "/api/network/worker/jobs")
        jobs = payload.get("jobs", [])
        if not jobs and not self.args.quiet:
            print(f"[poll] no jobs; worker {self.args.worker_name} is online", flush=True)
        for job in jobs:
            self.run_job(job)

    def heartbeat(self) -> None:
        self.request_json(
            "POST",
            "/api/network/worker/heartbeat",
            {
                "name": self.args.worker_name,
                "backendType": self.args.backend,
                "models": split_models(self.args.models),
                "defaultModel": self.args.default_model,
                "capacity": self.args.capacity,
                "inputCreditsPer1k": self.args.input_credits_per_1k,
                "outputCreditsPer1k": self.args.output_credits_per_1k,
                "health": "ok",
            },
        )
        if not self.args.quiet:
            print(
                f"[heartbeat] {self.args.worker_name} online via {self.args.backend} "
                f"({self.args.default_model or self.args.models or 'model unset'})",
                flush=True,
            )

    def run_job(self, job: dict) -> None:
        started = time.monotonic()
        if not self.args.quiet:
            print(f"[job] running {job.get('id')} model={job.get('model') or self.args.default_model}", flush=True)
        try:
            if self.args.backend == "ollama":
                result = self.call_ollama(job)
            else:
                result = self.call_openai_compatible(job)
            result["runtimeMs"] = int((time.monotonic() - started) * 1000)
        except Exception as exc:  # noqa: BLE001 - report failure and keep polling
            result = {
                "ok": False,
                "error": str(exc)[:1000],
                "runtimeMs": int((time.monotonic() - started) * 1000),
            }
        self.request_json("POST", f"/api/network/worker/jobs/{job['id']}/result", result)
        if not self.args.quiet:
            status = "ok" if result.get("ok") else f"failed: {result.get('error')}"
            print(f"[job] reported {job.get('id')} {status}", flush=True)

    def call_ollama(self, job: dict) -> dict:
        model = job.get("model") or self.args.default_model
        response = request_json(
            "POST",
            f"{self.args.backend_url.rstrip('/')}/api/chat",
            {
                "model": model,
                "messages": job.get("messages", []),
                "stream": False,
                "options": {
                    "temperature": job.get("temperature", 0.2),
                    "num_predict": job.get("maxTokens", 1024),
                },
            },
            timeout=180,
        )
        text = str(response.get("message", {}).get("content") or response.get("response") or "")
        return {
            "ok": True,
            "text": text,
            "usage": {
                "prompt_tokens": estimate_tokens(json.dumps(job.get("messages", []))),
                "completion_tokens": estimate_tokens(text),
            },
        }

    def call_openai_compatible(self, job: dict) -> dict:
        headers = {}
        if self.args.backend_api_key:
            headers["authorization"] = f"Bearer {self.args.backend_api_key}"
        response = request_json(
            "POST",
            openai_chat_completions_url(self.args.backend_url),
            {
                "model": job.get("model") or self.args.default_model,
                "messages": job.get("messages", []),
                "temperature": job.get("temperature", 0.2),
                "max_tokens": job.get("maxTokens", 1024),
            },
            headers=headers,
            timeout=180,
        )
        text = str(response.get("choices", [{}])[0].get("message", {}).get("content") or "")
        return {
            "ok": True,
            "text": text,
            "usage": response.get("usage") or {
                "prompt_tokens": estimate_tokens(json.dumps(job.get("messages", []))),
                "completion_tokens": estimate_tokens(text),
            },
        }

    def request_json(self, method: str, path: str, body: dict | None = None) -> dict:
        return request_json(
            method,
            f"{self.args.base_url}{path}",
            body,
            headers={"authorization": f"Bearer {self.args.worker_token}"},
            timeout=60,
        )


def request_json(method: str, url: str, body: dict | None = None, headers: dict | None = None, timeout: int = 60) -> dict:
    data = None
    request_headers = {"content-type": "application/json", **(headers or {})}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method, headers=request_headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            text = response.read().decode("utf-8")
            return json.loads(text) if text else {}
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        if exc.code == 401:
            raise RuntimeError(
                f"{method} {url} failed: 401 unauthorized. "
                "Create a fresh worker invite in Timeline > Latch Network and use the exact worker_... token shown there. "
                "Also check that the worker is not paused."
            ) from exc
        raise RuntimeError(f"{method} {url} failed: {exc.code} {text}") from exc


def apply_backend_config(args: argparse.Namespace) -> None:
    if not args.backend_config:
        return
    path = os.path.abspath(args.backend_config)
    with open(path, "r", encoding="utf-8") as handle:
        config = json.load(handle)
    args.backend_url = str(config.get("baseUrl") or args.backend_url).rstrip("/")
    args.default_model = str(config.get("model") or args.default_model)
    if not args.models and args.default_model:
        args.models = args.default_model
    args.backend_api_key = str(config.get("apiKey") or args.backend_api_key)


def openai_chat_completions_url(base_url: str) -> str:
    cleaned = str(base_url or "").rstrip("/")
    if cleaned.endswith("/chat/completions"):
        return cleaned
    if cleaned.endswith("/v1"):
        return f"{cleaned}/chat/completions"
    return f"{cleaned}/v1/chat/completions"


def split_models(value: str) -> list[str]:
    return [item.strip() for item in str(value or "").split(",") if item.strip()][:20]


def estimate_tokens(text: str) -> int:
    return max(1, (len(str(text or "")) + 3) // 4)


def env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


if __name__ == "__main__":
    raise SystemExit(main())
