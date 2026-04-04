#!/usr/bin/env node

/**
 * LLM Model Performance Benchmark
 *
 * Tests direct provider endpoints vs LiteLLM proxy.
 * Metrics: TTFT, TPOT, Output TPS, Total Latency, Output Tokens.
 *
 * Usage:
 *   node scripts/llm-bench.mjs [--rounds 3] [--max-tokens 256] [--models kimi-k2.5,claude-sonnet-4-6]
 */

import { readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

// ── Load .env files ─────────────────────────────────────────────────────────

function loadEnvFile(path) {
  try {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {}
}

// Load litellm .env first (has provider keys), then apis .env
loadEnvFile("ops/litellm/.env");
loadEnvFile("apis/.env");

// ── Config ──────────────────────────────────────────────────────────────────

function env(key, fallback) {
  const v = process.env[key];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  return "";
}

const {
  values: { rounds: roundsStr, "max-tokens": maxTokStr, models: modelsFilter },
} = parseArgs({
  options: {
    rounds: { type: "string", default: "3" },
    "max-tokens": { type: "string", default: "256" },
    models: { type: "string", default: "" },
  },
});

const ROUNDS = Number(roundsStr);
const MAX_TOKENS = Number(maxTokStr);

const PROMPTS = [
  { label: "short", content: "Explain what a closure is in one paragraph." },
  {
    label: "medium",
    content:
      "Compare and contrast TCP and UDP protocols. Cover reliability, ordering, use cases, and performance characteristics. Be concise but thorough.",
  },
];

// ── Provider definitions ────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = env("ANTHROPIC_API_KEY");
const MOONSHOT_API_KEY = env("MOONSHOT_API_KEY");
const MINIMAX_API_KEY = env("MINIMAX_API_KEY");
const LITELLM_LOCAL_URL = "http://127.0.0.1:4000";
const LITELLM_REMOTE_URL = env("LITELLM_REMOTE_URL", "https://litellm-dev.fly.dev");
const LITELLM_API_KEY = env("LITELLM_MASTER_KEY", "");

const MODELS = [
  {
    name: "kimi-k2.5",
    direct: {
      type: "openai",
      baseUrl: "https://api.moonshot.ai/v1",
      apiKey: MOONSHOT_API_KEY,
      model: "kimi-k2.5",
    },
    litellm: { model: "kimi-k2.5" },
  },
  {
    name: "minimax-m2.5",
    direct: {
      type: "openai",
      baseUrl: "https://api.minimax.io/v1",
      apiKey: MINIMAX_API_KEY,
      model: "MiniMax-M2.5",
    },
    litellm: { model: "minimax-m2.5" },
  },
  {
    name: "claude-sonnet-4-6",
    direct: {
      type: "anthropic",
      apiKey: ANTHROPIC_API_KEY,
      model: "claude-sonnet-4-6",
    },
    litellm: { model: "claude-sonnet-4-6" },
  },
  {
    name: "claude-opus-4-6",
    direct: {
      type: "anthropic",
      apiKey: ANTHROPIC_API_KEY,
      model: "claude-opus-4-6",
    },
    litellm: { model: "claude-opus-4-6" },
  },
];

// ── Streaming helpers ───────────────────────────────────────────────────────

/** Stream OpenAI-compatible chat completions and collect timing metrics. */
async function streamOpenAI(baseUrl, apiKey, model, prompt, maxTokens) {
  const t0 = performance.now();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      stream: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  return parseSSE(res, t0);
}

/** Stream Anthropic Messages API and collect timing metrics. */
async function streamAnthropic(apiKey, model, prompt, maxTokens) {
  const t0 = performance.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      stream: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  return parseSSE(res, t0, true);
}

/** Parse SSE stream, measure TTFT, per-token times, total latency. */
async function parseSSE(res, t0, isAnthropic = false) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let ttft = null;
  let tokenCount = 0;
  const tokenTimestamps = [];
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split("\n");
    buf = lines.pop(); // keep incomplete line

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;

      let hasContent = false;
      try {
        const json = JSON.parse(data);
        if (isAnthropic) {
          hasContent =
            json.type === "content_block_delta" &&
            json.delta?.text?.length > 0;
        } else {
          const delta = json.choices?.[0]?.delta;
          // Count content OR reasoning_content (Kimi K2.5 uses reasoning_content for thinking tokens)
          hasContent =
            !!delta?.content || !!delta?.reasoning_content;
        }
      } catch {
        continue;
      }

      if (hasContent) {
        const now = performance.now();
        if (ttft === null) ttft = now - t0;
        tokenTimestamps.push(now);
        tokenCount++;
      }
    }
  }

  const totalLatency = performance.now() - t0;

  // TPOT: average inter-token interval (skip first token)
  let tpot = 0;
  if (tokenTimestamps.length > 1) {
    let sum = 0;
    for (let i = 1; i < tokenTimestamps.length; i++) {
      sum += tokenTimestamps[i] - tokenTimestamps[i - 1];
    }
    tpot = sum / (tokenTimestamps.length - 1);
  }

  const streamDuration = totalLatency - (ttft ?? 0);
  const outputTps =
    streamDuration > 0 ? (tokenCount / streamDuration) * 1000 : 0;

  return {
    ttft: ttft ?? totalLatency,
    tpot,
    outputTps,
    totalLatency,
    tokenCount,
  };
}

// ── Runner ──────────────────────────────────────────────────────────────────

async function runOne(modelDef, endpoint, prompt, maxTokens) {
  if (endpoint === "direct") {
    const d = modelDef.direct;
    if (d.type === "anthropic") {
      return streamAnthropic(d.apiKey, d.model, prompt, maxTokens);
    }
    return streamOpenAI(d.baseUrl, d.apiKey, d.model, prompt, maxTokens);
  }
  const baseUrl =
    endpoint === "litellm-local" ? LITELLM_LOCAL_URL : LITELLM_REMOTE_URL;
  return streamOpenAI(
    baseUrl,
    LITELLM_API_KEY,
    modelDef.litellm.model,
    prompt,
    maxTokens,
  );
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function pad(s, n) {
  return String(s).padEnd(n);
}

// ── Main ────────────────────────────────────────────────────────────────────

const activeModels = modelsFilter
  ? MODELS.filter((m) => modelsFilter.split(",").includes(m.name))
  : MODELS;

if (activeModels.length === 0) {
  console.error(
    "No matching models. Available:",
    MODELS.map((m) => m.name).join(", "),
  );
  process.exit(1);
}

console.log(
  `\n🚀 LLM Bench — ${activeModels.length} models × 3 endpoints × ${PROMPTS.length} prompts × ${ROUNDS} rounds\n`,
);

// Build all tasks: one per (model × endpoint × prompt)
const tasks = [];
for (const modelDef of activeModels) {
  for (const endpoint of ["direct", "litellm-local", "litellm-remote"]) {
    for (const prompt of PROMPTS) {
      tasks.push({ modelDef, endpoint, prompt });
    }
  }
}

// Run a single task: rounds are sequential to avoid RPM limits
async function runTask({ modelDef, endpoint, prompt }) {
  const { label, content } = prompt;
  const tag = `${modelDef.name} | ${endpoint} | ${label}`;
  const logs = [`  ${tag} ...`];

  const runs = [];
  for (let r = 0; r < ROUNDS; r++) {
    try {
      const result = await runOne(modelDef, endpoint, content, MAX_TOKENS);
      runs.push(result);
      logs.push(` ✓`);
    } catch (err) {
      logs.push(` ✗(${err.message.slice(0, 80)})`);
    }
  }

  // Print progress (synchronized via event loop — each task prints when done)
  console.log(logs.join(""));

  if (runs.length === 0) {
    return { model: modelDef.name, endpoint, prompt: label, error: true };
  }

  return {
    model: modelDef.name,
    endpoint,
    prompt: label,
    ttft: median(runs.map((r) => r.ttft)),
    tpot: median(runs.map((r) => r.tpot)),
    outputTps: median(runs.map((r) => r.outputTps)),
    totalLatency: median(runs.map((r) => r.totalLatency)),
    tokenCount: median(runs.map((r) => r.tokenCount)),
  };
}

// Split tasks: direct + litellm-local run concurrently; litellm-remote runs sequentially to avoid RPM/auth issues
const localTasks = tasks.filter((t) => t.endpoint !== "litellm-remote");
const remoteTasks = tasks.filter((t) => t.endpoint === "litellm-remote");

const localResults = await Promise.all(localTasks.map(runTask));

// Run remote tasks one at a time with a small delay to avoid rate limits
const remoteResults = [];
for (const task of remoteTasks) {
  remoteResults.push(await runTask(task));
  await new Promise((r) => setTimeout(r, 500));
}

const allResults = [...localResults, ...remoteResults].sort((a, b) =>
  `${a.model}|${a.endpoint}|${a.prompt}`.localeCompare(
    `${b.model}|${b.endpoint}|${b.prompt}`,
  ),
);

// ── Output ──────────────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(115));
console.log(
  pad("Model", 22),
  pad("Endpoint", 16),
  pad("Prompt", 8),
  pad("TTFT(ms)", 10),
  pad("TPOT(ms)", 10),
  pad("TPS", 8),
  pad("Latency(ms)", 13),
  pad("Tokens", 8),
);
console.log("─".repeat(115));

for (const r of allResults) {
  if (r.error) {
    console.log(
      pad(r.model, 22),
      pad(r.endpoint, 16),
      pad(r.prompt, 8),
      "  ERROR",
    );
    continue;
  }
  console.log(
    pad(r.model, 22),
    pad(r.endpoint, 16),
    pad(r.prompt, 8),
    pad(r.ttft.toFixed(0), 10),
    pad(r.tpot.toFixed(1), 10),
    pad(r.outputTps.toFixed(1), 8),
    pad(r.totalLatency.toFixed(0), 13),
    pad(String(r.tokenCount), 8),
  );
}
console.log("═".repeat(115));

// dump JSON
const outPath = `scripts/llm-bench-results-${Date.now()}.json`;
writeFileSync(outPath, JSON.stringify(allResults, null, 2));
console.log(`\nResults saved to ${outPath}\n`);
