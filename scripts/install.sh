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

# 3. Pass through any provider keys set in the installer environment.
#    Local endpoints (Ollama, llama.cpp) typically don't need keys, but you
#    can override the host with OLLAMA_HOST / LLAMACPP_HOST if non-default.
EXTRA_ENV=""
for VAR in OPENAI_API_KEY OPENROUTER_API_KEY ZAI_API_KEY MOONSHOT_API_KEY \
            OLLAMA_HOST LLAMACPP_HOST OLLAMA_API_KEY LLAMACPP_API_KEY; do
  if [ -n "${!VAR:-}" ]; then
    EXTRA_ENV="${EXTRA_ENV}Environment=${VAR}=${!VAR}"$'\n'
    case "$VAR" in
      *_HOST) echo "  ✓ Passing through $VAR (upstream host override)" ;;
      *_API_KEY) echo "  ✓ Passing through $VAR" ;;
      *) echo "  ✓ Passing through $VAR" ;;
    esac
  fi
done

# 4. Create systemd service
NODE_BIN=$(which node)
sudo tee /etc/systemd/system/$SERVICE_NAME.service > /dev/null << EOF
[Unit]
Description=openclaw-router - Cost-optimizing model routing (OpenAI Chat Completions)
After=network.target

[Service]
Type=simple
ExecStart=$NODE_BIN $ROUTER_DIR/server.js
${EXTRA_ENV}Environment=ROUTER_CONFIG=$ROUTER_DIR/config.json
Environment=ROUTER_PORT=$PORT
Environment=ROUTER_LOG=1
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
echo "  ✓ Created systemd service"

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
