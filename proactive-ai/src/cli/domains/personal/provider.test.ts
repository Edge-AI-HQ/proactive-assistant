import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { createPersonalProvider } from "./provider.js";
import { _resetSettingsCache } from "../../../core/domains/personal/platform_settings.js";

const sse = (payload: unknown): Response =>
  new Response(`data: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

test("createPersonalProvider uses Composio MCP session and meta tools", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  _resetSettingsCache();

  try {
    const requests: Array<{ url: string; method: string; headers: Headers; body: Record<string, unknown> | null }> = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
      requests.push({ url, method, headers, body });

      if (url.endsWith("/api/v3/tool_router/session")) {
        return new Response(JSON.stringify({
          mcp: { url: "https://connect.composio.dev/mcp/session_test" },
        }), { status: 200 });
      }

      if (url.startsWith("https://connect.composio.dev/mcp/session_test")) {
        assert.equal(headers.get("x-api-key"), "ak_test_platform");
        assert.equal(body?.method, "tools/call");
        assert.deepEqual(body?.params, {
          name: "COMPOSIO_MANAGE_CONNECTIONS",
          arguments: { toolkits: ["gmail"] },
        });
        return sse({
          result: {
            content: [{
              type: "text",
              text: JSON.stringify({
                data: {
                  results: {
                    gmail: {
                      status: "ACTIVE",
                      connected_account_id: "ca_123",
                      current_user_info: { email: "test@example.com" },
                    },
                  },
                },
              }),
            }],
          },
        });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    const provider = createPersonalProvider({
      env: {
        COMPOSIO_API_KEY: "ak_test_platform",
        COMPOSIO_USER_ID: "user_123",
        COMPOSIO_API_BASE: "https://backend.composio.dev/api/v3",
      },
      homeDir: "/Users/test",
    });

    const [connection] = await provider.checkConnections(["gmail"]);

    assert.equal(connection?.toolkit, "gmail");
    assert.equal(connection?.status, "ACTIVE");
    assert.equal(connection?.connectedAccountId, "ca_123");
    assert.deepEqual(connection?.userInfo, { email: "test@example.com" });

    const sessionRequest = requests.find((request) =>
      request.url.endsWith("/api/v3/tool_router/session") && request.method === "POST",
    );
    assert.deepEqual(sessionRequest?.body, { user_id: "user_123" });
    assert.equal(sessionRequest?.headers.get("x-api-key"), "ak_test_platform");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createPersonalProvider falls back to proactive-ai local settings for MCP mode", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  _resetSettingsCache();
  const homeDir = "/tmp/pin-cli-personal-mcp-fallback";
  const profileDir = join(homeDir, ".openclaw-proactive-ai");
  const settingsPath = join(profileDir, "local-settings.json");

  rmSync(homeDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({
    composio: {
      apiKey: "ak_test_platform_local",
      userId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    },
  }) + "\n");

  try {
    const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
      requests.push({ url, method, body });

      if (url.endsWith("/api/v3/tool_router/session")) {
        return new Response(JSON.stringify({
          mcp: { url: "https://connect.composio.dev/mcp/session_local" },
        }), { status: 200 });
      }

      if (url.startsWith("https://connect.composio.dev/mcp/session_local")) {
        return sse({
          result: {
            content: [{
              type: "text",
              text: JSON.stringify({
                data: {
                  results: {
                    notion: {
                      status: "PENDING",
                      connected_account_id: "ca_local",
                      redirect_url: "https://platform.example/connect-local",
                    },
                  },
                },
              }),
            }],
          },
        });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    const provider = createPersonalProvider({
      env: {},
      homeDir,
    });

    const connection = await provider.connectApp("notion");

    assert.equal(connection.toolkit, "notion");
    assert.equal(connection.status, "PENDING");
    assert.equal(connection.connectedAccountId, "ca_local");
    assert.equal(connection.redirectUrl, "https://platform.example/connect-local");

    const sessionRequest = requests.find((request) =>
      request.url.endsWith("/api/v3/tool_router/session") && request.method === "POST",
    );
    assert.deepEqual(sessionRequest?.body, { user_id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d" });
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(homeDir, { recursive: true, force: true });
  }
});
