import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { createPersonalProvider } from "./provider.js";
import { _resetSettingsCache } from "../../../core/domains/personal/platform_settings.js";

test("createPersonalProvider uses Composio platform mode to create link sessions", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  _resetSettingsCache();

  try {
    const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
      requests.push({ url, method, body });

      if (url.includes("/api/v3/connected_accounts?")) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }

      if (url.includes("/api/v3/auth_configs?")) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }

      if (url.endsWith("/api/v3/auth_configs")) {
        return new Response(JSON.stringify({
          auth_config: {
            id: "authcfg_gmail",
          },
        }), { status: 200 });
      }

      if (url.endsWith("/api/v3/connected_accounts/link")) {
        return new Response(JSON.stringify({
          connected_account_id: "ca_123",
          redirect_url: "https://platform.example/connect",
        }), { status: 200 });
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

    const connection = await provider.connectApp("gmail");

    assert.equal(connection.toolkit, "gmail");
    assert.equal(connection.status, "PENDING");
    assert.equal(connection.connectedAccountId, "ca_123");
    assert.equal(connection.redirectUrl, "https://platform.example/connect");

    const createdAuthConfig = requests.find((request) =>
      request.url.endsWith("/api/v3/auth_configs") && request.method === "POST",
    );
    assert.deepEqual(createdAuthConfig?.body, {
      toolkit: { slug: "gmail" },
    });

    const linkRequest = requests.find((request) =>
      request.url.endsWith("/api/v3/connected_accounts/link") && request.method === "POST",
    );
    assert.deepEqual(linkRequest?.body, {
      auth_config_id: "authcfg_gmail",
      user_id: "user_123",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createPersonalProvider falls back to proactive-ai local settings for platform mode", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  _resetSettingsCache();
  const homeDir = "/tmp/pin-cli-personal-platform-fallback";
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

      if (url.includes("/api/v3/connected_accounts?")) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }

      if (url.includes("/api/v3/auth_configs?")) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }

      if (url.endsWith("/api/v3/auth_configs")) {
        return new Response(JSON.stringify({
          auth_config: { id: "authcfg_notion" },
        }), { status: 200 });
      }

      if (url.endsWith("/api/v3/connected_accounts/link")) {
        return new Response(JSON.stringify({
          connected_account_id: "ca_local",
          redirect_url: "https://platform.example/connect-local",
        }), { status: 200 });
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

    const linkRequest = requests.find((request) =>
      request.url.endsWith("/api/v3/connected_accounts/link") && request.method === "POST",
    );
    assert.deepEqual(linkRequest?.body, {
      auth_config_id: "authcfg_notion",
      user_id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    });
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(homeDir, { recursive: true, force: true });
  }
});
