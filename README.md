# OpenClaw Router

Route every OpenClaw request to the cheapest capable model — local Ollama by default, or any OpenAI-compatible upstream per tier.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](https://nodejs.com)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-compatible-orange.svg)](#)

---

## Local Cost-Optimizing Model Router for OpenClaw

A zero-dependency Node.js proxy that sits between OpenClaw and any OpenAI Chat Completions–compatible upstream, automatically routing each request to the cheapest capable model. **Local Ollama by default for LIGHT and MEDIUM**, OpenAI for HEAVY — entirely your choice per tier.

**Everything runs locally.** No data leaves your machine unless you explicitly route a tier to a hosted provider. The router is a localhost proxy that forwards directly to your chosen upstream using your own API key (or no key, for local Ollama/llama.cpp).

**Install from your terminal:**

```bash
git clone https://github.com/xdemocle/openclaw-router.git
cd openclaw-router && bash scripts/install.sh
```

That's it — `openclaw-router/auto` is now an OpenAI-compatible model provider OpenClaw can use everywhere.

### Sample savings after 30 days

| Workload | Without router | With router | Saved |
|---|---|---|---|
| Cron jobs (ops alerts, inbox checks) | $121.63 (always-Opus) | $0 (local Ollama) | $121.63 (100%) |
| Subagent tasks (issue triage) | $58.20 (always-Opus) | $0 (local Ollama) | $58.20 (100%) |
| Deep reasoning (strategy, analysis) | $25.00 (always-Opus) | $25.00 (cloud HEAVY) | $0.00 |
| **Total** | **$204.83** | **$25.00** | **$179.83 (88%)** |

Exact numbers depend on your workload. Local-first = near-zero cost on routine traffic.

> The router scores only user messages, not the system prompt — this is critical. OpenClaw sends a large, keyword-rich system prompt with every request, and scoring it inflates every request to the most expensive tier. With system prompt excluded, routine tasks correctly score low and route to cheaper models.

**Check your savings anytime:**

```bash
curl -s http://127.0.0.1:8402/stats | python3 -m json.tool
```

## How It Works

```
OpenClaw  →  localhost:8402  →  Ollama (LIGHT/MEDIUM) / OpenAI (HEAVY)
               │
               ▼
        14-dimension weighted scorer (<1ms)
        Extracts text from last 3 user messages (skips system prompt)
        Scores across: token count, code presence, reasoning markers,
        technical terms, creative markers, simple indicators, multi-step
        patterns, question complexity, imperative verbs, constraints,
        output format, domain specificity, agentic tasks, relay indicators
               │
               ▼
        Maps weighted score to tier via sigmoid confidence
               │
               ├── score < 0.0   → LIGHT  (Ollama llama3.1:8b)              free
               ├── 0.0 – 0.35    → MEDIUM (Ollama qwen2.5-coder:32b)        free
               └── score > 0.35  → HEAVY  (OpenAI gpt-5.1)                   paid
               │
               ▼
        Overrides:
        • 2+ reasoning keywords in user message → HEAVY (0.95 confidence)
        • >50K estimated tokens → HEAVY (large context)
        • Low confidence (ambiguous) → defaults to MEDIUM
               │
               ▼
        Replaces model field in request body → proxies to chosen upstream
```

The proxy speaks native **OpenAI Chat Completions** format on both sides. OpenClaw calls OpenAI's endpoint shape; the router scores it, swaps the model, and forwards. Streaming works transparently (SSE passthrough).

## Quick Start

### Option A: Install script

```bash
cd ~/.openclaw/workspace
git clone https://github.com/xdemocle/openclaw-router.git router
bash router/scripts/install.sh
```

Then restart OpenClaw to pick up the new model provider.

### Option B: Manual edit of `openclaw.json`

```json
{
  "models": {
    "providers": {
      "openclaw-router": {
        "baseUrl": "http://127.0.0.1:8402",
        "api": "openai-chat-completions",
        "apiKey": "passthrough",
        "models": [{
          "id": "auto",
          "name": "openclaw-router (auto)",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 8192
        }]
      }
    }
  }
}
```

Then `systemctl restart openclaw` (or `openclaw gateway restart`).

### Verify the model is available

```bash
curl -s http://127.0.0.1:8402/health | jq .

# Test a request through the router
curl -s http://127.0.0.1:8402/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","max_tokens":50,"messages":[{"role":"user","content":"Say hi"}]}' | jq .
```

In your OpenClaw session: `/model openclaw-router/auto`. To force a cron job to retry immediately after fixing a config error: `/cron run <jobId>`.

## Customizing Tiers and Providers

All scoring config lives in `config.json` (not in server.js). Edit it to match your workload. The server hot-reloads config changes — no restart needed.

Override the config path with: `ROUTER_CONFIG=/path/to/my-config.json`

### Defaults

```json
{
  "defaultProvider": "ollama",
  "providers": {
    "ollama":    { "baseUrl": "http://127.0.0.1:11434", "auth": "none", "format": "openai" },
    "llamacpp":  { "baseUrl": "http://127.0.0.1:8080",   "auth": "none", "format": "openai" },
    "openai":    { "baseUrl": "https://api.openai.com/v1", "apiKeyEnv": "OPENAI_API_KEY", "auth": "bearer" },
    "openrouter":{ "baseUrl": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY", "auth": "bearer" },
    "zai":       { "baseUrl": "https://api.z.ai/v1", "apiKeyEnv": "ZAI_API_KEY", "auth": "bearer" },
    "moonshot":  { "baseUrl": "https://api.moonshot.ai/v1", "apiKeyEnv": "MOONSHOT_API_KEY", "auth": "bearer" }
  },
  "models": {
    "LIGHT":  { "provider": "ollama",    "model": "llama3.1:8b" },
    "MEDIUM": { "provider": "ollama",    "model": "qwen2.5-coder:32b" },
    "HEAVY":  { "provider": "openai",    "model": "gpt-5.1" }
  }
}
```

### Provider field reference

| Field | Required | Notes |
|---|---|---|
| `baseUrl` | yes | Upstream base. Router appends `/v1/chat/completions` |
| `auth` | yes | `"bearer"` (adds `Authorization: Bearer $KEY`) or `"none"` (no auth header — for Ollama/llama.cpp) |
| `apiKeyEnv` | for `auth: bearer` | Env var the key is read from at request time |
| `apiKey` | optional | Literal fallback if `apiKeyEnv` isn't set (rarely needed) |

### Custom tier mixes

Pick whatever combination matches your model inventory:

```json
{
  "models": {
    "LIGHT":  { "provider": "ollama",     "model": "llama3.1:8b" },
    "MEDIUM": { "provider": "openrouter", "model": "deepseek/deepseek-v3.2" },
    "HEAVY":  { "provider": "openai",     "model": "gpt-5.1" }
  }
}
```

Add `OPENROUTER_API_KEY` and `OPENAI_API_KEY` to the systemd service environment if those tiers are active. Restart after env var changes only — `config.json` changes hot-reload.

### Local-only mode (no cloud)

```json
{
  "defaultProvider": "ollama",
  "models": {
    "LIGHT":  "llama3.1:8b",
    "MEDIUM": "qwen2.5-coder:32b",
    "HEAVY":  "qwen3:72b"
  }
}
```

No API keys needed. The service runs entirely on local inference.

## Customizing Scoring

Each dimension has a keyword list that shifts the score. Add words relevant to your domain:

```json
{
  "scoring": {
    "simpleKeywords":  ["order status", "tracking number", ...],
    "relayKeywords":   ["forward to agent", "escalate", "transfer to", ...],
    "reasoningKeywords": ["analyze", "compare", "synthesize", "methodology", ...],
    "domainKeywords":  ["regression", "p-value", "confidence interval", ...]
  }
}
```

Tune boundaries (`lightMedium`, `mediumHeavy`), per-dimension weights, and `confidenceThreshold` to match your workload. See `config.json` defaults for the full structure.

## Verifying Cost Savings

### Real-time: routing logs

```bash
journalctl -u openclaw-router -f
```

```
[router] LIGHT  → ollama/llama3.1:8b     | score=-0.112 conf=0.71 | scored     | -100% | what is 2+2? ...
[router] MEDIUM → ollama/qwen2.5-coder:32b| score=-0.040 conf=0.58 | ambiguous  | -100% | create an issue for the API bug ...
[router] HEAVY  → openai/gpt-5.1         | score=0.116  conf=0.95 | reasoning  |   -0% | prove sqrt(2) is irrational ...
```

### Aggregate: stats endpoint

```bash
curl http://127.0.0.1:8402/stats
```

```json
{
  "total": 847,
  "byTier": { "LIGHT": 412, "MEDIUM": 340, "HEAVY": 95 },
  "estimatedCost": 0.0,
  "baselineCost": 0.0189,
  "startedAt": "..."
}
```

- `estimatedCost`: what you actually spent (free for local tiers)
- `baselineCost`: what the HEAVY-tier model would have cost for the same traffic
- `savings`: `1 - (estimatedCost / baselineCost)`

## Updating

```bash
cd ~/.openclaw/workspace/router   # or wherever you cloned
git pull origin main
bash scripts/install.sh   # or just `sudo systemctl restart openclaw-router`
```

If you've customized `config.json` (added keywords, changed weights, swapped models), `git pull` may conflict. Either:
- Stash your changes first: `git stash && git pull && git stash pop`
- Or keep your config outside the repo: `ROUTER_CONFIG=/path/to/my-config.json`

## Disabling / Uninstalling

Stop without removing:
```bash
sudo systemctl stop openclaw-router
```

Switch workloads back to direct models:
```
/cron update <jobId> model=openai/gpt-5.1
/config set agents.defaults.subagents.model openai/gpt-5.1
/model openai/gpt-5.1
```

Full removal:
```bash
bash ~/.openclaw/workspace/skills/router/scripts/uninstall.sh
/config unset models.providers.openclaw-router
```

## Files

```
├── server.js              # The proxy (~330 lines, zero deps)
├── config.json            # Scoring config + provider/tier map (hot-reload)
├── SKILL.md               # Skill manifest (name + description)
├── README.md              # This file
├── LICENSE                # MIT
└── scripts/
    ├── install.sh         # systemd + openclaw.json registration
    └── uninstall.sh       # Clean teardown
```

## Troubleshooting

### `model not allowed: openclaw-router/auto`

1. **Allowlist** — if `agents.defaults.models` exists in `openclaw.json`, add `"openclaw-router/auto": {}` to it.
2. **Restart required** — OpenClaw caches providers at startup. After editing `openclaw.json`, restart (`openclaw gateway restart`).

### Cron jobs stuck in error backoff

Force an immediate run: `/cron run <jobId>` or hit the cron management API.

### Router is running but requests fail

```bash
curl -s http://127.0.0.1:8402/health         # is the proxy alive?
journalctl -u openclaw-router -n 20         # what did it log?

# Verify the upstream directly
curl -s http://127.0.0.1:11434/api/tags | jq .  # Ollama reachable?
curl -s https://api.openai.com/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY" | jq .  # OpenAI key works?
```

### Config changes not taking effect

`config.json` changes hot-reload — no restart needed. Env var changes (API keys, port) require `sudo systemctl restart openclaw-router`.

### Local Ollama tier not responding

```bash
systemctl status ollama   # is ollama running?
curl -s http://127.0.0.1:11434/api/tags | jq .models[].name | head   # models installed?
ollama pull llama3.1:8b   # pull the model named in config.json
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ROUTER_PORT` | `8402` | Port to listen on |
| `ROUTER_LOG` | `1` | Set to `0` to disable per-request logging |
| `ROUTER_CONFIG` | `./config.json` | Path to scoring config |
| `OPENAI_API_KEY` | — | Required only if any tier uses OpenAI |
| `OPENROUTER_API_KEY` | — | Required only if any tier uses OpenRouter |
| `ZAI_API_KEY` | — | For z.ai GLM tiers |
| `MOONSHOT_API_KEY` | — | For Moonshot Kimi tiers |
| `OLLAMA_HOST` | — | (Optional) Override Ollama host; default in `config.json` |
| `LLAMACPP_HOST` | — | (Optional) Override llama.cpp server host; default in `config.json` |

The install script passes through `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ZAI_API_KEY`, `MOONSHOT_API_KEY`, `OLLAMA_HOST`, `LLAMACPP_HOST` if present in its environment.

---

**Not affiliated with ibl.ai.** This project is a fork of an Anthropic-format upstream; the OpenAI Chat Completions rewrite is the work of `xdemocle`.
