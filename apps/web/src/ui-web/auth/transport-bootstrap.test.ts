// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { getSessionMock, refreshSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  refreshSessionMock: vi.fn(),
}));

vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      getSession: getSessionMock,
      refreshSession: refreshSessionMock,
    },
  },
}));

vi.mock("./platform", () => ({
  PIN_API_BASE: "",
  pinApiRequestHeaders: (headers: Record<string, string> = {}) => headers,
}));

describe("authHeaders", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_PIN_LOCAL_DEV_AUTH", "");
    getSessionMock.mockReset();
    refreshSessionMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("returns the local dev auth header when explicitly enabled", async () => {
    vi.stubEnv("VITE_PIN_LOCAL_DEV_AUTH", "1");
    const { authHeaders } = await import("./transport-bootstrap");

    await expect(authHeaders()).resolves.toEqual({
      "X-Dev-Auth": "pinai-local-dev-user",
    });
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  test("falls back to the Supabase access token when local dev auth is off", async () => {
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: "token-a" } },
    });
    const { authHeaders } = await import("./transport-bootstrap");

    await expect(authHeaders()).resolves.toEqual({
      Authorization: "Bearer token-a",
    });
  });
});

describe("profileClientHintHeaders", () => {
  test("sends the platform hint so the server can tier timezone trust", async () => {
    const { profileClientHintHeaders } = await import("./transport-bootstrap");
    const headers = profileClientHintHeaders();
    // Under vitest/jsdom Capacitor resolves to its web implementation — the
    // same value an Electron/browser client sends. The server lets "web"
    // seed an unset timezone but never override the phone's.
    expect(headers["X-Pin-Client-Platform"]).toBe("web");
    expect(headers["X-Pin-Client-Timezone"]).toBeTruthy();
  });
});
