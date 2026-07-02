import { beforeEach, describe, expect, test, vi } from "vitest";

// 实现从 ../transport/http 取 proxyFetch（相对导入）→ 这里也 mock 同一相对路径，
// 解析到同一模块，mock 才能拦住（web 旧测 mock @pin-ai/core 不再适用，已随实现搬来 core）。
const { proxyFetchMock } = vi.hoisted(() => ({
  proxyFetchMock: vi.fn(),
}));

vi.mock("../transport/http", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  proxyFetch: proxyFetchMock,
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("voiceIdentityApi", () => {
  beforeEach(() => {
    proxyFetchMock.mockReset();
  });

  test("fetches the current voice identity profile", async () => {
    proxyFetchMock.mockResolvedValue(jsonResponse({
      ok: true,
      profile: {
        enabled: true,
        enrolledAt: "2026-05-27T00:00:00Z",
        updatedAt: "2026-05-27T00:00:00Z",
        speakerName: "self",
        referenceDurationMs: 5000,
        referenceByteLen: 32000,
      },
    }));

    const { fetchVoiceIdentity } = await import("./voice-identity-api");
    const profile = await fetchVoiceIdentity();

    expect(proxyFetchMock).toHaveBeenCalledWith("/voice/identity", undefined);
    expect(profile).toMatchObject({ enabled: true, speakerName: "self" });
  });

  test("uploads a reference blob with duration metadata", async () => {
    proxyFetchMock.mockResolvedValue(jsonResponse({ ok: true, profile: null }));
    const audio = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" });

    const { uploadVoiceIdentityReference } = await import("./voice-identity-api");
    await uploadVoiceIdentityReference(audio, 5000);

    expect(proxyFetchMock).toHaveBeenCalledWith("/voice/identity/reference", {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "X-Audio-Duration-Ms": "5000",
      },
      body: audio,
    });
  });

  test("updates enabled state and deletes reference", async () => {
    proxyFetchMock.mockResolvedValue(jsonResponse({ ok: true, profile: null }));

    const {
      setVoiceIdentityEnabled,
      deleteVoiceIdentityReference,
    } = await import("./voice-identity-api");
    await setVoiceIdentityEnabled(false);
    await deleteVoiceIdentityReference();

    expect(proxyFetchMock).toHaveBeenNthCalledWith(1, "/voice/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(proxyFetchMock).toHaveBeenNthCalledWith(2, "/voice/identity/reference", {
      method: "DELETE",
    });
  });

  test("posts diarized transcription audio without changing the plain voice API", async () => {
    proxyFetchMock.mockResolvedValue(jsonResponse({
      ok: true,
      text: "Self text",
      model: "gpt-4o-transcribe-diarize",
      selfText: "Self text",
      speakerLabels: ["self", "speaker_1"],
      segments: [
        { speaker: "self", text: "Self text", startMs: 0, endMs: 1000 },
      ],
      diarizationModel: "gpt-4o-transcribe-diarize",
      diarizationStatus: "matched_reference",
    }));
    const audio = new Blob([new Uint8Array([1])], { type: "audio/wav" });

    const { transcribeVoiceAudioDiarized } = await import("./voice-identity-api");
    const result = await transcribeVoiceAudioDiarized(audio, { language: "en" });

    expect(result.selfText).toBe("Self text");
    expect(proxyFetchMock).toHaveBeenCalledWith("/voice/transcribe-diarized?language=en", {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "X-Audio-Filename": "voice-input.wav",
      },
      body: audio,
      signal: undefined,
    });
  });
});
