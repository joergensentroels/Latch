from pathlib import Path
import os

project_dir = Path(os.environ.get("OPENCLAW_PROJECT_DIR", "/home/troels/apps/openclaw"))
compose_path = project_dir / "docker-compose.yml"
env_path = project_dir / ".env"
tailscale_ip = os.environ.get("OPENCLAW_GATEWAY_HOST", "")

if not tailscale_ip:
    raise SystemExit("Set OPENCLAW_GATEWAY_HOST to the VM Tailscale IP before running this patch.")

text = compose_path.read_text()
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

compose_path.write_text(text)

env_text = env_path.read_text()
if "OPENCLAW_GATEWAY_HOST=" not in env_text:
    if not env_text.endswith("\n"):
        env_text += "\n"
    env_text += f"\nOPENCLAW_GATEWAY_HOST={tailscale_ip}\n"
    env_path.write_text(env_text)
