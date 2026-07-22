#!/usr/bin/env node
/**
 * openclaw-router — Local cost-optimizing proxy for OpenAI Chat Completions API.
 *
 * Sits between OpenClaw and any OpenAI-compatible upstream (OpenAI, OpenRouter,
 * Ollama, llama.cpp server, z.ai, Moonshot, etc.), automatically routing each
 * request to the cheapest capable model using weighted scoring.
 *
 * Proxy contract:
 *   - Inbound:  OpenAI Chat Completions (`/v1/chat/completions`)
 *   - Outbound: OpenAI Chat Completions (same shape; only `model` changes)
 *   - Streaming: SSE passthrough (`data: {...}\n\n`)
 *
 * All scoring config lives in config.json (or ROUTER_CONFIG env path).
 * Zero dependencies — just Node.js standard library.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node server.js
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

// ─── Load Config ───

const CONFIG_PATH = process.env.ROUTER_CONFIG || path.join(__dirname, "config.json");

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const cfg = JSON.parse(raw);

  if (cfg.scoring.multiStepPatterns) {
    cfg.scoring.multiStepPatterns = cfg.scoring.multiStepPatterns.map(p =>
      p instanceof RegExp ? p : new RegExp(p, "i")
    );
  }

  // ─── Providers ───
  // Each provider = { baseUrl, apiKeyEnv|apiKey, auth: "bearer"|"none", stripThinking? }
  // Outbound is always OpenAI Chat Completions format.
  // Upstreams that don't natively speak OpenAI (e.g. an Anthropic-native gateway
  // someone wants to keep) can be added later behind a translator — not in scope.
  cfg.defaultProvider = cfg.defaultProvider || "openai";
  cfg.providers = cfg.providers || {};
  for (const [name, p] of Object.entries(cfg.providers)) {
    p.auth = p.auth || "bearer";
    if (!p.baseUrl) {
      throw new Error(`Provider "${name}" missing baseUrl`);
    }
  }
  if (!cfg.providers[cfg.defaultProvider]) {
    throw new Error(`Default provider "${cfg.defaultProvider}" not defined in providers map`);
  }

  // ─── Tiers ───
  // Same shape as before: a tier value is either a bare string (model id on default
  // provider) or { provider, model, stripThinking? }.
  cfg.tiers = {};
  for (const tier of ["LIGHT", "MEDIUM", "HEAVY"]) {
    const v = cfg.models[tier];
    const spec = typeof v === "string"
      ? { provider: cfg.defaultProvider, model: v }
      : { provider: v.provider || cfg.defaultProvider, model: v.model, stripThinking: v.stripThinking };
    if (spec.stripThinking === undefined) spec.stripThinking = tier === "LIGHT";
    if (!cfg.providers[spec.provider]) {
      throw new Error(`Tier ${tier} references unknown provider "${spec.provider}"`);
    }
    cfg.tiers[tier] = spec;
  }

  return cfg;
}

let config = loadConfig();

fs.watchFile(CONFIG_PATH, { interval: 2000 }, () => {
  try {
    config = loadConfig();
    console.log("[router] Config reloaded from", CONFIG_PATH);
  } catch (e) {
    console.error("[router] Config reload failed:", e.message);
  }
});

// ─── Environment ───

const PORT = parseInt(process.env.ROUTER_PORT || "8402", 10);
const LOG_ROUTING = process.env.ROUTER_LOG !== "0";

// ─── Dimension Scorers ───

function scoreTokenCount(tokens, thresholds) {
  if (tokens < thresholds.simple) return { score: -0.8, signal: `short(${tokens}t)` };
  if (tokens > thresholds.complex) return { score: 0.8, signal: `long(${tokens}t)` };
  return { score: 0, signal: null };
}

function scoreKeywords(text, keywords, threshLow, threshHigh, scoreLow, scoreHigh) {
  const matches = keywords.filter(kw => text.includes(kw.toLowerCase()));
  if (matches.length >= threshHigh) return { score: scoreHigh, signal: matches.slice(0, 3).join(",") };
  if (matches.length >= threshLow) return { score: scoreLow, signal: matches.slice(0, 2).join(",") };
  return { score: 0, signal: null };
}

function scorePatterns(text, patterns) {
  const hits = patterns.filter(p => p.test(text));
  if (hits.length > 0) return { score: 0.5, signal: "multi-step" };
  return { score: 0, signal: null };
}

function scoreQuestions(text) {
  const count = (text.match(/\?/g) || []).length;
  if (count > 3) return { score: 0.5, signal: `${count}q` };
  return { score: 0, signal: null };
}

// ─── Main Classifier ───

function classify(text, estimatedTokens) {
  const s = config.scoring;
  const lower = text.toLowerCase();

  const dims = {
    tokenCount:       scoreTokenCount(estimatedTokens, s.tokenThresholds),
    codePresence:     scoreKeywords(lower, s.codeKeywords, 1, 3, 0.5, 1.0),
    reasoningMarkers: scoreKeywords(lower, s.reasoningKeywords, 1, 2, 0.6, 1.0),
    technicalTerms:   scoreKeywords(lower, s.technicalKeywords, 2, 4, 0.5, 1.0),
    creativeMarkers:  scoreKeywords(lower, s.creativeKeywords, 1, 2, 0.4, 0.7),
    simpleIndicators: scoreKeywords(lower, s.simpleKeywords, 1, 2, -0.8, -1.0),
    multiStep:        scorePatterns(lower, s.multiStepPatterns),
    questionCount:    scoreQuestions(text),
    imperativeVerbs:  scoreKeywords(lower, s.imperativeVerbs, 1, 2, 0.3, 0.5),
    constraints:      scoreKeywords(lower, s.constraintKeywords, 1, 3, 0.3, 0.7),
    outputFormat:     scoreKeywords(lower, s.formatKeywords, 1, 2, 0.4, 0.7),
    domainSpecific:   scoreKeywords(lower, s.domainKeywords, 1, 2, 0.5, 0.8),
    agenticTask:      scoreKeywords(lower, s.agenticKeywords, 2, 4, 0.4, 0.8),
    relayIndicators:  scoreKeywords(lower, s.relayKeywords, 1, 2, -0.9, -1.0),
  };

  let score = 0;
  const signals = [];
  for (const [name, dim] of Object.entries(dims)) {
    const w = s.weights[name] || 0;
    score += dim.score * w;
    if (dim.signal) signals.push(`${name}:${dim.signal}`);
  }

  const overrides = s.overrides || {};

  const decide = (tier, extra) => {
    const spec = config.tiers[tier];
    return { model: spec.model, provider: spec.provider, stripThinking: spec.stripThinking, tier, score, signals, ...extra };
  };

  const reasoningMin = overrides.reasoningKeywordMin || 2;
  const reasoningHits = s.reasoningKeywords.filter(kw => lower.includes(kw.toLowerCase()));
  if (reasoningHits.length >= reasoningMin) {
    return decide("HEAVY", { confidence: 0.95, reasoning: "reasoning-override" });
  }

  const largeCtx = overrides.largeContextTokens || 50000;
  if (estimatedTokens > largeCtx) {
    return decide("HEAVY", { confidence: 0.95, reasoning: "large-context" });
  }

  const { lightMedium, mediumHeavy } = s.boundaries;
  let tier, distFromBoundary;

  if (score < lightMedium) {
    tier = "LIGHT";
    distFromBoundary = lightMedium - score;
  } else if (score < mediumHeavy) {
    tier = "MEDIUM";
    distFromBoundary = Math.min(score - lightMedium, mediumHeavy - score);
  } else {
    tier = "HEAVY";
    distFromBoundary = score - mediumHeavy;
  }

  const confidence = 1 / (1 + Math.exp(-s.confidenceSteepness * distFromBoundary));

  if (confidence < s.confidenceThreshold) {
    return decide("MEDIUM", { confidence, reasoning: "ambiguous→medium" });
  }

  return decide(tier, { confidence, reasoning: "scored" });
}

// ─── Extract scoring text from OpenAI Chat Completions messages format ───

// OpenAI shape: messages: [{role, content}] where content is string OR
// content parts array (`[{type:"text", text:...}]`). For vision it's also
// `{type:"image_url", image_url:{url}}` — we skip those for scoring.
// We skip messages with role "system" (the system prompt) and the first
// few "assistant" turns — same exclusion rule as before: only score what
// the user is asking about right now.
function extractText(body) {
  let text = "";
  if (Array.isArray(body.messages)) {
    const recent = body.messages.slice(-3);
    for (const msg of recent) {
      if (msg.role && msg.role !== "user") continue;
      const c = msg.content;
      if (typeof c === "string") {
        text += c + " ";
      } else if (Array.isArray(c)) {
        for (const part of c) {
          if (part.type === "text" && typeof part.text === "string") {
            text += part.text + " ";
          }
        }
      }
    }
  }
  return text;
}

// ─── Proxy upstream ───

// Resolve the API key for a provider: prefer env var if apiKeyEnv is set;
// else fall back to literal apiKey in config (useful for local Ollama/llama.cpp
// where there's no key). When both are missing, the request goes out without
// Authorization — which is correct for local-only servers.
function providerKey(provider) {
  if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) {
    return process.env[provider.apiKeyEnv];
  }
  return provider.apiKey || null;
}

// stripThinking: for Ollama/llama.cpp the `reasoning_effort`-style controls are
// rarely supported; the simplest portable behavior is to drop any `reasoning_*`
// or `thinking` fields the caller may have set, so local upstreams don't 400.
function stripThinking(body) {
  for (const k of Object.keys(body)) {
    if (k === "thinking" || k.startsWith("reasoning_")) {
      delete body[k];
    }
  }
}

function proxyUpstream(req, res, body, decision) {
  body.model = decision.model;

  const provider = config.providers[decision.provider] || config.providers[config.defaultProvider];

  // OpenAI Chat Completions path; append /v1/chat/completions
  const path_ = (provider.baseUrl.replace(/\/$/, "")) + "/v1/chat/completions";

  if (decision.stripThinking) stripThinking(body);

  const payload = JSON.stringify(body);
  const parsed = new URL(provider.baseUrl);

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
    path: path_,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      // Pass through accept so streamed clients get the right content-type
      "Accept": req.headers["accept"] || "application/json",
    },
  };

  const key = providerKey(provider);
  if (key && provider.auth !== "none") {
    options.headers["Authorization"] = `Bearer ${key}`;
  }

  const transport = parsed.protocol === "https:" ? https : http;
  const upstreamReq = transport.request(options, (upstreamRes) => {
    // Relay status + headers (filtered to safe ones)
    const safeHeaders = {};
    const passthrough = ["content-type", "cache-control", "x-request-id"];
    for (const h of passthrough) {
      if (upstreamRes.headers[h]) safeHeaders[h] = upstreamRes.headers[h];
    }
    res.writeHead(upstreamRes.statusCode, safeHeaders);
    upstreamRes.pipe(res);
  });

  upstreamReq.on("error", (err) => {
    console.error("[router] upstream error:", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "proxy_error", message: err.message } }));
    }
  });

  upstreamReq.write(payload);
  upstreamReq.end();
}

// ─── Stats ───

const stats = {
  total: 0,
  byTier: {},
  estimatedCost: 0,
  baselineCost: 0,
  startedAt: new Date().toISOString(),
};

// ─── HTTP Server ───

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", models: config.models, tiers: config.tiers, port: PORT }));
    return;
  }

  if (req.method === "GET" && req.url === "/stats") {
    const savings = stats.baselineCost > 0
      ? ((1 - stats.estimatedCost / stats.baselineCost) * 100).toFixed(1) + "%"
      : "n/a";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...stats, savings }));
    return;
  }

  // Accept the OpenAI Chat Completions route from OpenClaw; keep /v1/messages
  // as a legacy alias for any already-deployed clients.
  const isChatCompletions = req.method === "POST" && (
    req.url === "/v1/chat/completions" || req.url.startsWith("/v1/chat/completions?")
  );
  const isLegacyAnthropic = req.method === "POST" && (
    req.url.startsWith("/v1/messages") || req.url.startsWith("/v1/messages?")
  );
  if (!isChatCompletions && !isLegacyAnthropic) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found. Use POST /v1/chat/completions" }));
    return;
  }

  let chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    // Auto-rewrite inbound "auto" to whatever the scorer decides, mirroring the
    // upstream OpenClaw provider behavior for the model id.
    if (body.model === "auto" || body.model === "openclaw-router/auto") {
      const text = extractText(body);
      const estimatedTokens = Math.ceil(text.length / 4);
      const decision = classify(text, estimatedTokens);

      stats.total++;
      stats.byTier[decision.tier] = (stats.byTier[decision.tier] || 0) + 1;
      const cost = config.costs[decision.model] || { input: 0 };
      stats.estimatedCost += (estimatedTokens / 1_000_000) * cost.input;
      const heavyCost = (estimatedTokens / 1_000_000) * (config.costs[config.models.HEAVY]?.input || 5);
      stats.baselineCost += heavyCost;

      if (LOG_ROUTING) {
        const savings = heavyCost > 0
          ? ((heavyCost - (estimatedTokens / 1_000_000) * cost.input) / heavyCost * 100).toFixed(0)
          : 0;
        console.log(
          `[router] ${decision.tier.padEnd(6)} → ${decision.model} ` +
          `| score=${decision.score.toFixed(3)} conf=${decision.confidence.toFixed(2)} ` +
          `| ${decision.reasoning} | -${savings}% | ${text.slice(0, 80).replace(/\n/g, " ")}...`
        );
      }

      proxyUpstream(req, res, body, decision);
    } else {
      // Specific model requested → just route to the default provider verbatim.
      const decision = {
        model: body.model,
        provider: config.defaultProvider,
        stripThinking: false,
        tier: "BYPASS",
        score: 0,
        signals: [],
        confidence: 1,
        reasoning: "explicit-model",
      };
      proxyUpstream(req, res, body, decision);
    }
  });
});

// ─── Start ───

const defaultProviderCfg = config.providers[config.defaultProvider];
if (defaultProviderCfg.auth !== "none" && !providerKey(defaultProviderCfg)) {
  const envName = defaultProviderCfg.apiKeyEnv || "API_KEY";
  console.error(`[router] No API key for default provider "${config.defaultProvider}" (set ${envName}). Exiting.`);
  process.exit(1);
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[router] openclaw-router listening on http://127.0.0.1:${PORT}`);
  console.log(`[router] Config: ${CONFIG_PATH}`);
  console.log(`[router] Format: OpenAI Chat Completions (outbound to all providers)`);
  const fmt = t => `${config.tiers[t].provider}/${config.tiers[t].model}`;
  console.log(`[router] Tiers: LIGHT=${fmt("LIGHT")} MEDIUM=${fmt("MEDIUM")} HEAVY=${fmt("HEAVY")}`);
});
