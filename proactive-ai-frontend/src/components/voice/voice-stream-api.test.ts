import { beforeEach, describe, expect, test, vi } from "vitest";

const { authHeadersMock } = vi.hoisted(() => ({
  authHeadersMock: vi.fn(),
}));

vi.mock("@/lib/transport-bootstrap", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  authHeaders: authHeadersMock,
}));

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  PIN_API_BASE: "https://api.example.test",
}));

describe("voice stream api", () => {
  beforeEach(() => {
    authHeadersMock.mockReset();
  });

  test("keeps the Supabase bearer out of the websocket URL", async () => {
    authHeadersMock.mockResolvedValue({ Authorization: "Bearer token-a" });
    const { buildVoiceStreamUrl } = await import("./voice-stream-api");

    const url = await buildVoiceStreamUrl({ language: "zh" });

    expect(url).toBe(
      "wss://api.example.test/api/voice/transcribe-stream?language=zh",
    );
  });

  test("builds auth frame from bearer without putting it in the URL", async () => {
    authHeadersMock.mockResolvedValue({ Authorization: "Bearer token-a" });
    const { buildVoiceStreamAuthMessage } = await import("./voice-stream-api");

    await expect(buildVoiceStreamAuthMessage()).resolves.toEqual({
      type: "auth",
      token: "token-a",
    });
  });

  test("builds auth frame from local dev auth", async () => {
    authHeadersMock.mockResolvedValue({ "X-Dev-Auth": "pinai-local-dev-user" });
    const { buildVoiceStreamAuthMessage } = await import("./voice-stream-api");

    await expect(buildVoiceStreamAuthMessage()).resolves.toEqual({
      type: "auth",
      dev_auth: "pinai-local-dev-user",
    });
  });
});
