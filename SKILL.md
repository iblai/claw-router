---
name: openclaw-router
description: Cost-optimizing model router for OpenClaw. Proxies OpenAI Chat Completions requests to the cheapest capable model (LIGHT/MEDIUM/HEAVY tiers) using weighted scoring. Outbound is always OpenAI Chat Completions — works with any compatible upstream (OpenAI, OpenRouter, Ollama, llama.cpp, z.ai, Moonshot). Defaults to local Ollama for LIGHT/MEDIUM and OpenAI for HEAVY. Use when setting up smart model routing, reducing API costs, or routing between local LLMs and hosted providers.
---

# openclaw-router

A zero-dependency proxy that sits between OpenClaw and any OpenAI Chat Completions–compatible upstream, routing each request to the cheapest capable model using a 14-dimension weighted scorer (<1ms overhead).

## Install

```bash
bash "$(dirname "$0")/scripts/install.sh"
```

This will:
1. Copy `server.js` and `config.json` to `~/.openclaw/workspace/skills/router/`
2. Create and start a systemd service (`openclaw-router`) on port 8402
3. Register `openclaw-router/auto` as an OpenClaw model provider with `api: openai-chat-completions`

After install, `openclaw-router/auto` is available anywhere OpenClaw accepts a model ID.

## Defaults out of the box

| Tier | Provider | Model | Cost |
|---|---|---|---|
| LIGHT | Ollama (local) | `llama3.1:8b` | free |
| MEDIUM | Ollama (local) | `qwen2.5-coder:32b` | free |
| HEAVY | OpenAI | `gpt-5.1` | paid |

Works fully offline for LIGHT/MEDIUM once Ollama is running. HEAVY tier needs `OPENAI_API_KEY` set in the service environment.

## Verify

```bash
curl -s http://127.0.0.1:8402/health | jq .
curl -s http://127.0.0.1:8402/stats | jq .
```

## Use

Set `openclaw-router/auto` as the model for any scope:

| Scope | How |
|---|---|
| Cron job | Set `model` to `openclaw-router/auto` in job config |
| Subagents | `agents.defaults.subagents.model = "openclaw-router/auto"` |
| Per-session | `/model openclaw-router/auto` |
| All sessions | `agents.defaults.model.primary = "openclaw-router/auto"` |

**Tip:** Keep the main interactive session on a fixed model (e.g. Opus if you have Anthropic configured directly). Use the router for cron jobs, subagents, and background tasks where cost savings compound.

## Customize

All config lives in `~/.openclaw/workspace/skills/router/config.json` and hot-reloads on save — no restart needed.

### Switch tiers to other upstreams

Each tier can be a bare model id (uses default provider) or `{ "provider": "...", "model": "..." }`. All providers speak OpenAI Chat Completions:

```json
{
  "defaultProvider": "ollama",
  "providers": {
    "ollama":    { "baseUrl": "http://127.0.0.1:11434",        "auth": "none" },
    "llamacpp":  { "baseUrl": "http://127.0.0.1:8080",          "auth": "none" },
    "openai":    { "baseUrl": "https://api.openai.com/v1",     "apiKeyEnv": "OPENAI_API_KEY",    "auth": "bearer" },
    "openrouter":{ "baseUrl": "https://openrouter.ai/api/v1",  "apiKeyEnv": "OPENROUTER_API_KEY", "auth": "bearer" }
  },
  "models": {
    "LIGHT":  { "provider": "ollama",    "model": "llama3.1:8b" },
    "MEDIUM": { "provider": "openrouter","model": "deepseek/deepseek-v3.2" },
    "HEAVY":  { "provider": "openai",    "model": "gpt-5.1" }
  }
}
```

### Local-only mode (no cloud at all)

Set all three tiers to `ollama` or `llamacpp`:

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

All three are auth: "none" — no `OPENAI_API_KEY` required, the service won't fail if missing.

### Scoring

Keyword lists control which tier handles a request:

- `simpleKeywords`, `relayKeywords` → push toward **LIGHT** (cheap)
- `imperativeVerbs`, `codeKeywords`, `agenticKeywords` → push toward **MEDIUM**
- `technicalKeywords`, `reasoningKeywords`, `domainKeywords` → push toward **HEAVY** (capable)

Tune boundaries and weights in `config.json` to match your workload.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ROUTER_CONFIG` | `./config.json` | Path to scoring config |
| `ROUTER_PORT` | `8402` | Port to listen on |
| `ROUTER_LOG` | `1` | Set to `0` to disable per-request logging |
| `OPENAI_API_KEY` | — | Required only if HEAVY/any tier uses OpenAI |
| `OPENROUTER_API_KEY` | — | Required only if any tier uses OpenRouter |
| `ZAI_API_KEY` / `MOONSHOT_API_KEY` | — | For z.ai / Moonshot tiers |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Override Ollama baseUrl (read at startup if you wire it) |
| `LLAMACPP_HOST` | `http://127.0.0.1:8080` | Override llama.cpp server baseUrl |

The install script passes through any of these if set in its environment.

## Uninstall

```bash
bash "$(dirname "$0")/scripts/uninstall.sh"
```

Stops the service, removes the systemd unit, deletes router files. Switch any workloads using `openclaw-router/auto` back to a direct model first.
