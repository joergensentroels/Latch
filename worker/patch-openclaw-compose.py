"""Bind OpenClaw's published ports to the worker's Tailscale IP instead of 0.0.0.0.

This does exact-string edits on OpenClaw's docker-compose.yml. OpenClaw is an
upstream project, so its compose format can change between releases. A silent
no-op here would leave the gateway published on every interface (0.0.0.0) --
a real exposure -- so this script VERIFIES the critical binding was actually
scoped and fails loudly if it can't recognise the format.
"""
from pathlib import Path
import os
import re

project_dir = Path(os.environ.get("OPENCLAW_PROJECT_DIR", "/home/user/apps/openclaw"))
compose_path = project_dir / "docker-compose.yml"
env_path = project_dir / ".env"
tailscale_ip = os.environ.get("OPENCLAW_GATEWAY_HOST", "")

if not tailscale_ip:
    raise SystemExit("Set OPENCLAW_GATEWAY_HOST to the VM Tailscale IP before running this patch.")
if not compose_path.exists():
    raise SystemExit(f"No docker-compose.yml at {compose_path}. Set OPENCLAW_PROJECT_DIR to the OpenClaw project dir.")

GATEWAY_PORT = 18789  # critical: the gateway must never be published on 0.0.0.0
BRIDGE_PORT = 18790   # best-effort: not published by every OpenClaw version


def unscoped_publishes(text: str, container_port: int) -> list[str]:
    """Return ports entries that publish container_port WITHOUT a host IP scope.

    A scoped entry looks like `<host>:<hostport>:<containerport>` where <host> is
    the Tailscale IP or the ${OPENCLAW_GATEWAY_HOST} var. An unscoped entry
    (`<hostport>:<containerport>`) binds every interface and is what we must fix.
    """
    offenders = []
    for line in text.splitlines():
        stripped = line.strip()
        match = re.match(r'-\s*"?(?P<left>[^"#]+):%d"?\s*$' % container_port, stripped)
        if not match:
            continue
        left = match.group("left")
        scoped = "OPENCLAW_GATEWAY_HOST" in left or re.search(r"\d+\.\d+\.\d+\.\d+", left)
        if not scoped:
            offenders.append(stripped)
    return offenders


text = compose_path.read_text()

# Exact-string scoping for the known OpenClaw compose format.
text = text.replace(
    '      - "${OPENCLAW_GATEWAY_PORT:-18789}:18789"',
    '      - "${OPENCLAW_GATEWAY_HOST}:${OPENCLAW_GATEWAY_PORT:-18789}:18789"',
)
text = text.replace(
    '      - "${OPENCLAW_BRIDGE_PORT:-18790}:18790"',
    '      - "${OPENCLAW_GATEWAY_HOST}:${OPENCLAW_BRIDGE_PORT:-18790}:18790"',
)

needle = '  openclaw-cli:\n    image: ${OPENCLAW_IMAGE:-openclaw:local}\n'
replacement = '  openclaw-cli:\n    image: ${OPENCLAW_IMAGE:-openclaw:local}\n    restart: unless-stopped\n'
if needle in text and '  openclaw-cli:\n    image: ${OPENCLAW_IMAGE:-openclaw:local}\n    restart:' not in text:
    text = text.replace(needle, replacement)

# VERIFY before writing: the gateway port must end up scoped, or we bail with a
# clear message rather than silently leaving it on 0.0.0.0.
gateway_offenders = unscoped_publishes(text, GATEWAY_PORT)
if gateway_offenders:
    raise SystemExit(
        "Refusing to write: the OpenClaw compose format was not recognised, so the "
        f"gateway port {GATEWAY_PORT} would stay published on 0.0.0.0.\n"
        "Offending ports entr" + ("y" if len(gateway_offenders) == 1 else "ies") + ":\n  "
        + "\n  ".join(gateway_offenders)
        + f"\n\nFix manually: prefix the mapping with the Tailscale IP, e.g.\n"
        f'  - "{tailscale_ip}:{GATEWAY_PORT}:{GATEWAY_PORT}"\n'
        "then re-run. (OpenClaw likely changed its docker-compose.yml format.)"
    )

compose_path.write_text(text)

bridge_offenders = unscoped_publishes(text, BRIDGE_PORT)
if bridge_offenders:
    print(
        f"WARNING: bridge port {BRIDGE_PORT} appears published without a host scope:\n  "
        + "\n  ".join(bridge_offenders)
        + f'\n  Consider scoping it too: "{tailscale_ip}:{BRIDGE_PORT}:{BRIDGE_PORT}".'
    )

print(f"OK: gateway port {GATEWAY_PORT} is bound to the Tailscale host scope in {compose_path}.")

if env_path.exists():
    env_text = env_path.read_text()
else:
    env_text = ""
if "OPENCLAW_GATEWAY_HOST=" not in env_text:
    if env_text and not env_text.endswith("\n"):
        env_text += "\n"
    env_text += f"\nOPENCLAW_GATEWAY_HOST={tailscale_ip}\n"
    env_path.write_text(env_text)
    print(f"Set OPENCLAW_GATEWAY_HOST={tailscale_ip} in {env_path}.")
else:
    print(f"OPENCLAW_GATEWAY_HOST already set in {env_path}; left as-is.")
