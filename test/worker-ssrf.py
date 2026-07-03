# Executable regression test for the pre-public SSRF hardening (H3) in latch-agent-bridge.py.
# Spins up a real local HTTP server so the redirect-refusal and validate-before-fetch behavior are
# actually exercised over the network, not just read for correctness.
import http.server
import importlib.util
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BRIDGE_PATH = ROOT / "worker" / "latch-agent-bridge.py"

spec = importlib.util.spec_from_file_location("latch_agent_bridge_ssrf_test", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(spec)
sys.modules["latch_agent_bridge_ssrf_test"] = bridge
spec.loader.exec_module(bridge)

request_log = []


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        request_log.append(self.path)
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/target")
            self.end_headers()
        elif self.path in ("/target", "/ok"):
            body = b"hello world"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()


server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
port = server.server_address[1]
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()

try:
    # 1) fetch_research_page must refuse to follow a redirect instead of silently fetching
    #    wherever it points.
    request_log.clear()
    try:
        bridge.fetch_research_page(f"http://127.0.0.1:{port}/redirect")
        raise AssertionError("fetch_research_page should have refused the redirect")
    except RuntimeError as exc:
        assert "redirect" in str(exc).lower(), f"unexpected error: {exc}"
    assert "/redirect" in request_log, "the redirect endpoint itself should have been requested"
    assert "/target" not in request_log, "the redirect TARGET must never be fetched"

    # 2) Regression check: an ordinary non-redirecting fetch still works.
    request_log.clear()
    page = bridge.fetch_research_page(f"http://127.0.0.1:{port}/ok")
    assert page["status"] == 200
    assert "hello world" in page["body"]

    # 3) fetch_source_note must validate BEFORE making any network call, not after. A host that
    #    fails validation must result in ZERO requests reaching the server.
    request_log.clear()
    try:
        bridge.fetch_source_note(
            f"http://127.0.0.1:{port}/ok",
            allowed_domains=["example.com"],
            question="test",
            summary_limit=200,
        )
        raise AssertionError("fetch_source_note should have rejected this host")
    except RuntimeError:
        pass
    assert request_log == [], f"validation must happen before any fetch; got requests: {request_log}"

    print("Worker SSRF hardening tests passed.")
finally:
    server.shutdown()
    thread.join(timeout=5)
