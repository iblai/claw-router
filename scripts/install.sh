#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROUTER_DIR="$HOME/.openclaw/workspace/skills/router"
SERVICE_NAME="openclaw-router"
PORT=8402

echo "⚡ Installing openclaw-router..."

# 1. Copy router files
mkdir -p "$ROUTER_DIR"
cp "$SKILL_DIR/server.js" "$ROUTER_DIR/server.js"

if [ ! -f "$ROUTER_DIR/config.json" ]; then
  cp "$SKILL_DIR/config.json" "$ROUTER_DIR/config.json"
  echo "  ✓ Copied default config.json"
else
  echo "  ✓ config.json already exists — preserved"
fi
echo "  ✓ Copied server.js to $ROUTER_DIR"

# 2. Detect OpenAI key (best-effort, for the OpenAI HEAVY tier default).
#    Local providers (Ollama/llama.cpp) need no key. Other keys are pass-through.
API_KEY=""
AUTH_FILE="$HOME/.openclaw/agents/main/agent/auth-profiles.json"
if [ -f "$AUTH_FILE" ]; then
  API_KEY=$(grep -o '"key": "[^"]*"' "$AUTH_FILE" 2>/dev/null | head -1 | cut -d'"' -f4 || true)
fi

if [ -z "$API_KEY" ]; then
  echo ""
  echo "  ℹ No API key auto-detected. openclaw-router will work for local-only"
  echo "    tiers (Ollama/llama.cpp). Set OPENAI_API_KEY in the systemd service"
  echo "    if you want to route to cloud HEAVY tier."
  API_KEY=""
fi

# 3. Capture any provider keys / host overrides set in the installer
#    environment. We use python3 to safely escape values for systemd
#    Environment= directives (a value with a newline or quote would
#    otherwise inject extra directives or break the unit file).
EXTRA_ENV_FILE="$(mktemp)"
python3 - "$EXTRA_ENV_FILE" << 'PYEOF'
import os, sys
out_path = sys.argv[1]
provider_envs = [
    "OPENAI_API_KEY", "OPENROUTER_API_KEY", "ZAI_API_KEY", "MOONSHOT_API_KEY",
    "OLLAMA_HOST", "LLAMACPP_HOST", "OLLAMA_API_KEY", "LLAMACPP_API_KEY",
]
with open(out_path, "w") as f:
    for v in provider_envs:
        val = os.environ.get(v)
        if val is None or val == "":
            continue
        # Escape backslashes and double quotes for systemd syntax.
        esc = val.replace("\\", "\\\\").replace("\"", "\\\"")
        # Reject any value containing a newline / carriage return — never
        # inject those into a systemd unit (would smuggle directives).
        if "\n" in esc or "\r" in esc:
            print(f"  ⚠ Refusing to write {v}: value contains newline/CR", file=sys.stderr)
            continue
        f.write(f'Environment={v}="{esc}"\n')
PYEOF
EXTRA_ENV="$(cat "$EXTRA_ENV_FILE" 2>/dev/null || true)"
rm -f "$EXTRA_ENV_FILE"
if [ -n "$EXTRA_ENV" ]; then
  echo "$EXTRA_ENV" | while IFS= read -r line; do
    var_name="${line%%=*}"
    echo "  ✓ Passing through ${var_name#Environment=}"
  done
fi

# 4. Create systemd service.
# We build the unit file by composition:
#   1. A static header herestrung with `printf` (substitute real paths now)
#   2. An env-file written by a python heredoc that filters newline/CR
#   3. The unit references the env-file via `EnvironmentFile=`
# Net: the unit file body has zero unquoted shell interpolation in it.
NODE_BIN=$(which node)
ENV_FILE="/etc/openclaw-router.env"
TMP_ENV="$(mktemp)"
: > "$TMP_ENV"
for VAR in OPENAI_API_KEY OPENROUTER_API_KEY ZAI_API_KEY MOONSHOT_API_KEY \
           OLLAMA_HOST LLAMACPP_HOST OLLAMA_API_KEY LLAMACPP_API_KEY; do
  if [ -n "${!VAR:-}" ]; then
    SAFE_VAL=$(printf "%q" "${!VAR}")
    echo "$VAR=$SAFE_VAL" >> "$TMP_ENV"
  fi
done
cat >> "$TMP_ENV" <<STATIC
ROUTER_CONFIG=$ROUTER_DIR/config.json
ROUTER_PORT=$PORT
ROUTER_LOG=1
STATIC
sudo install -m 0600 "$TMP_ENV" "$ENV_FILE"
rm -f "$TMP_ENV"

# Build the unit file via printf — values that *need* expansion ($NODE_BIN,
# $ENV_FILE, $ROUTER_DIR) are passed as printf arguments. There is no
# unquoted heredoc that could swallow a malicious env value.
UNIT_FILE="$(mktemp)"
sudo python3 - "$UNIT_FILE" "$NODE_BIN" "$ENV_FILE" "$ROUTER_DIR" << 'PYEOF'
import sys, os
out, node_bin, env_file, router_dir = sys.argv[1:5]
content = f"""[Unit]
Description=openclaw-router - Cost-optimizing model routing (OpenAI Chat Completions)
After=network.target

[Service]
Type=simple
ExecStart={node_bin} {router_dir}/server.js
EnvironmentFile={env_file}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
"""
with open(out, "w") as f:
    f.write(content)
print(f"  ✓ Env file written with {os.path.getsize(env_file) if os.path.exists(env_file) else 0} bytes", file=sys.stderr)
PYEOF
sudo install -m 0644 "$UNIT_FILE" /etc/systemd/system/$SERVICE_NAME.service
rm -f "$UNIT_FILE"
echo "  ✓ Created systemd service (env file: $ENV_FILE)"

# 5. Start the service
sudo systemctl daemon-reload
sudo systemctl enable --now "$SERVICE_NAME"
echo "  ✓ Service started on port $PORT"

# 6. Wait for it to be ready
sleep 1
if curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
  echo "  ✓ Health check passed"
else
  echo "  ⚠ Service started but health check failed — check: journalctl -u $SERVICE_NAME -f"
fi

# 7. Register with OpenClaw config
OPENCLAW_JSON="$HOME/.openclaw/openclaw.json"
if [ -f "$OPENCLAW_JSON" ] && command -v python3 &> /dev/null; then
  python3 - "$OPENCLAW_JSON" "$PORT" << 'PYEOF'
import json, sys

config_path, port = sys.argv[1], sys.argv[2]
with open(config_path) as f:
    cfg = json.load(f)

# Add model provider.
# Note: api is "openai-chat-completions" — OpenClaw calls it with the OpenAI
# body shape, router picks tier + proxies. Streaming works via SSE passthrough.
providers = cfg.setdefault("models", {}).setdefault("providers", {})
if "openclaw-router" not in providers:
    providers["openclaw-router"] = {
        "baseUrl": f"http://127.0.0.1:{port}",
        "apiKey": "passthrough",
        "api": "openai-chat-completions",
        "models": [{
            "id": "auto",
            "name": "openclaw-router (auto)",
            "reasoning": True,
            "input": ["text"],
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
            "contextWindow": 128000,
            "maxTokens": 8192
        }]
    }
    print("  ✓ Registered model provider in openclaw.json")
else:
    print("  ✓ Model provider already registered")

# Add to model allowlist (agents.defaults.models) if it exists
models_allowlist = cfg.get("agents", {}).get("defaults", {}).get("models")
if models_allowlist is not None and "openclaw-router/auto" not in models_allowlist:
    models_allowlist["openclaw-router/auto"] = {}
    print("  ✓ Added openclaw-router/auto to model allowlist")

with open(config_path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
PYEOF
  echo ""
  echo "  ⚠ Restart OpenClaw to pick up the new model provider:"
  echo "    openclaw gateway restart"
  echo "    # or: /config reload (from chat)"
  echo "    # or: kill -USR1 \$(pgrep -f 'openclaw.*gateway')"
else
  echo ""
  echo "  Now register the model in your OpenClaw session:"
  echo ""
  echo '  /config set models.providers.openclaw-router.baseUrl http://127.0.0.1:'"$PORT"
  echo '  /config set models.providers.openclaw-router.api openai-chat-completions'
  echo '  /config set models.providers.openclaw-router.apiKey passthrough'
  echo '  /config set models.providers.openclaw-router.models [{"id":"auto","name":"openclaw-router (auto)","reasoning":true,"input":["text"],"contextWindow":128000,"maxTokens":8192}]'
fi
echo ""
echo "  Then use: /model openclaw-router/auto"
echo ""
echo "  By default, LIGHT/MEDIUM tier route to local Ollama (127.0.0.1:11434)."
echo "  Make sure Ollama (or your chosen provider) is running."
echo ""
echo "⚡ Done! Check stats: curl http://127.0.0.1:$PORT/stats"
