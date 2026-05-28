import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CaptureReadyEvent } from "@pin/capacitor-ambient-ai";

const ambientAiMock = vi.hoisted(() => ({
  audio: {
    readCapture: vi.fn(),
  },
}));
const voiceApiMock = vi.hoisted(() => ({
  fetchVoiceIdentity: vi.fn(),
  transcribeVoiceAudioDiarized: vi.fn(),
}));
const transcriptionApiMock = vi.hoisted(() => ({
  transcribeVoiceAudio: vi.fn(),
}));

vi.mock("@pin/capacitor-ambient-ai", () => ({
  AmbientAi: ambientAiMock,
}));
vi.mock("@/services/voiceIdentityApi", () => voiceApiMock);
vi.mock("@/components/voice/transcriptionApi", () => transcriptionApiMock);

const event: CaptureReadyEvent = {
  platform: "ios",
  wavId: "wav-1",
  burstId: "burst-1",
  captureSessionId: "capture-1",
  capturedAt: "2026-05-27T00:00:00.000Z",
  durationMs: 4000,
  byteSize: 1000,
};

describe("transcribeAmbientCapture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ambientAiMock.audio.readCapture.mockResolvedValue({
      base64: btoa("wav-bytes"),
      contentType: "audio/wav",
    });
  });

  test("uses diarized transcription when voice identity is enabled", async () => {
    voiceApiMock.fetchVoiceIdentity.mockResolvedValue({
      enabled: true,
      speakerName: "self",
      enrolledAt: "2026-05-27T00:00:00Z",
      updatedAt: "2026-05-27T00:00:00Z",
      referenceDurationMs: 5000,
      referenceByteLen: 1000,
    });
    voiceApiMock.transcribeVoiceAudioDiarized.mockResolvedValue({
      text: "Self said hello. Speaker replied.",
      selfText: "Self said hello.",
      speakerLabels: ["self", "speaker_1"],
      segments: [
        { speaker: "self", text: "Self said hello.", startMs: 0, endMs: 1200 },
        { speaker: "speaker_1", text: "Speaker replied.", startMs: 1300, endMs: 2500 },
      ],
      provider: "cloud_diarize",
      diarizationStatus: "matched_reference",
      diarizationModel: "gpt-4o-transcribe-diarize",
    });

    const { transcribeAmbientCapture } = await import("./capture-transcription");
    const result = await transcribeAmbientCapture(event, "en");

    expect(voiceApiMock.transcribeVoiceAudioDiarized).toHaveBeenCalledWith(
      expect.any(Blob),
      { language: "en" },
    );
    expect(transcriptionApiMock.transcribeVoiceAudio).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      text: "Self said hello. Speaker replied.",
      selfText: "Self said hello.",
      speakerLabels: ["self", "speaker_1"],
      provider: "cloud_diarize",
      diarizationStatus: "matched_reference",
    });
  });

  test("falls back to plain transcription when identity is not enrolled", async () => {
    voiceApiMock.fetchVoiceIdentity.mockResolvedValue(null);
    transcriptionApiMock.transcribeVoiceAudio.mockResolvedValue("Plain transcript");

    const { transcribeAmbientCapture } = await import("./capture-transcription");
    const result = await transcribeAmbientCapture(event, "zh");

    expect(voiceApiMock.transcribeVoiceAudioDiarized).not.toHaveBeenCalled();
    expect(transcriptionApiMock.transcribeVoiceAudio).toHaveBeenCalledWith(
      expect.any(Blob),
      { language: "zh" },
    );
    expect(result).toMatchObject({
      text: "Plain transcript",
      selfText: "",
      speakerLabels: [],
      segments: [],
      provider: "cloud_whisper",
      diarizationStatus: "not_enrolled",
    });
  });

  test("falls back to plain transcription when diarization fails", async () => {
    voiceApiMock.fetchVoiceIdentity.mockResolvedValue({
      enabled: true,
      speakerName: "self",
      enrolledAt: "2026-05-27T00:00:00Z",
      updatedAt: "2026-05-27T00:00:00Z",
      referenceDurationMs: 5000,
      referenceByteLen: 1000,
    });
    voiceApiMock.transcribeVoiceAudioDiarized.mockRejectedValue(new Error("diarize failed"));
    transcriptionApiMock.transcribeVoiceAudio.mockResolvedValue("Fallback transcript");

    const { transcribeAmbientCapture } = await import("./capture-transcription");
    const result = await transcribeAmbientCapture(event, "en");

    expect(result).toMatchObject({
      text: "Fallback transcript",
      provider: "cloud_whisper",
      diarizationStatus: "fallback_plain_text",
    });
  });
});
