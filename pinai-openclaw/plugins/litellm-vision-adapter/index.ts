// OpenClaw Plugin: LiteLLM Vision Adapter
// Intercepts LiteLLM chat/completions requests that contain images and have
// streaming enabled.  Disables streaming on the outbound request, then wraps
// the non-stream JSON response back into SSE so the caller still sees a
// streaming response.  This works around LiteLLM providers that break when
// streaming + vision are combined.

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

const FETCH_PATCH_KEY = "__pinaiLiteLLMVisionAdapterPatched__";
const ADAPTER_HEADER = "x-pinai-litellm-stream-adapter";

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLiteLLMChatCompletions(url: URL): boolean {
  return /\/(v1\/)?chat\/completions$/.test(url.pathname);
}

function hasImageMessages(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isRecord(part)) continue;
      const type = String(part.type || "").toLowerCase();
      if (type === "image_url" || type === "input_image" || type === "image") return true;
      if (isRecord(part.image_url) || typeof part.image === "string") return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Request-path: disable stream for vision requests
// ---------------------------------------------------------------------------

async function patchVisionStreamOff(
  input: RequestInfo | URL,
  init?: RequestInit,
  api?: OpenClawPluginApi,
): Promise<RequestInit | null> {
  const rawUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input instanceof Request
          ? input.url
          : "";
  if (!rawUrl) return null;

  let targetUrl: URL;
  try { targetUrl = new URL(rawUrl); } catch { return null; }
  if (!isLiteLLMChatCompletions(targetUrl)) return null;

  const method = (
    init?.method || (input instanceof Request ? input.method : "GET")
  ).trim().toUpperCase();
  if (method !== "POST") return null;

  const headers = new Headers(
    init?.headers || (input instanceof Request ? input.headers : {}),
  );
  const contentType = headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.includes("application/json")) return null;

  let bodyText = "";
  const rawBody = init?.body;
  if (typeof rawBody === "string") {
    bodyText = rawBody;
  } else if (rawBody instanceof Uint8Array) {
    bodyText = new TextDecoder().decode(rawBody);
  } else if (input instanceof Request) {
    try { bodyText = await input.clone().text(); } catch { bodyText = ""; }
  }
  if (!bodyText) return null;

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(bodyText) as Record<string, unknown>; } catch { return null; }
  if (parsed.stream !== true || !hasImageMessages(parsed.messages)) return null;

  parsed.stream = false;
  headers.set(ADAPTER_HEADER, "1");
  api?.logger.info("[litellm-vision] disable stream for vision request");
  return {
    ...(input instanceof Request
      ? { method: input.method, redirect: input.redirect, credentials: input.credentials }
      : {}),
    ...init,
    headers,
    body: JSON.stringify(parsed),
  };
}

// ---------------------------------------------------------------------------
// Response-path: adapt non-stream JSON → SSE
// ---------------------------------------------------------------------------

function consumeAdapterMarker(
  input: RequestInfo | URL,
  init?: RequestInit,
): { nextInit: RequestInit | undefined; shouldAdapt: boolean } {
  const headers = new Headers(
    init?.headers || (input instanceof Request ? input.headers : {}),
  );
  const marker = headers.get(ADAPTER_HEADER) === "1";
  if (!marker) return { nextInit: init, shouldAdapt: false };
  headers.delete(ADAPTER_HEADER);
  return {
    nextInit: {
      ...(input instanceof Request
        ? { method: input.method, body: input.body, redirect: input.redirect }
        : {}),
      ...init,
      headers,
    },
    shouldAdapt: true,
  };
}

function extractMessageText(payload: Record<string, unknown>): string {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  if (!choices.length || !isRecord(choices[0])) return "";
  const message = isRecord(choices[0].message) ? choices[0].message : null;
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (typeof part.text === "string" && part.text) parts.push(part.text);
  }
  return parts.join("");
}

async function adaptToSse(
  response: Response,
  api?: OpenClawPluginApi,
): Promise<Response> {
  if (!response.ok) return response;
  const ct = response.headers.get("content-type")?.toLowerCase() || "";
  if (ct.includes("text/event-stream")) return response;

  const raw = await response.text();
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch {
    return new Response(raw, { status: response.status, headers: response.headers });
  }
  const content = extractMessageText(parsed);
  if (!content) {
    return new Response(raw, { status: response.status, headers: response.headers });
  }

  const created = Math.floor(Date.now() / 1000);
  const id = typeof parsed.id === "string" && parsed.id.trim()
    ? parsed.id.trim()
    : `chatcmpl_${Date.now()}`;
  const model = typeof parsed.model === "string" ? parsed.model : "";

  const firstChunk = {
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
  const lastChunk = {
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  const sse =
    `data: ${JSON.stringify(firstChunk)}\n\n` +
    `data: ${JSON.stringify(lastChunk)}\n\n` +
    "data: [DONE]\n\n";

  api?.logger.info("[litellm-vision] adapted non-stream completion to SSE");
  return new Response(sse, {
    status: response.status,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}

// ---------------------------------------------------------------------------
// Fetch proxy installation
// ---------------------------------------------------------------------------

function installFetchProxy(api: OpenClawPluginApi) {
  const g = globalThis as typeof globalThis & { [FETCH_PATCH_KEY]?: boolean };
  if (g[FETCH_PATCH_KEY]) return;
  if (typeof globalThis.fetch !== "function") {
    api.logger.warn("Global fetch unavailable, skip LiteLLM vision adapter");
    return;
  }

  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // Request path: patch vision+stream requests
    const patchedInit = await patchVisionStreamOff(input, init, api);
    if (patchedInit) init = patchedInit;

    // Consume adapter marker before calling upstream
    const { nextInit, shouldAdapt } = consumeAdapterMarker(input, init);
    const response = await originalFetch(input as RequestInfo, nextInit);

    // Response path: adapt if marked
    if (shouldAdapt) return adaptToSse(response, api);
    return response;
  }) as typeof fetch;

  g[FETCH_PATCH_KEY] = true;
  api.logger.info("LiteLLM vision adapter fetch patch installed");
}

const plugin = {
  id: "litellm-vision-adapter",
  name: "LiteLLM Vision Adapter",
  description: "Adapt streaming vision requests for LiteLLM compatibility",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    api.logger.info("LiteLLM Vision Adapter enabled");
    installFetchProxy(api);
  },
};

export default plugin;
