import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: vi.fn(async (key: string) => values.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        values.delete(key);
      }),
    },
  };
});

vi.mock("@react-native-async-storage/async-storage", () => ({ default: mocks.storage }));

import {
  applyPinHardwareTranscriptEvent,
  clearPinHardwareTranscriptHistory,
  getPinHardwareTranscriptSnapshot,
  setPinHardwareTranscriptOwner,
  subscribePinHardwareTranscripts,
} from "./pin-hardware-transcript-store";

const USER_KEY = "pinai:pin-hardware-transcripts:user-1";

describe("pin hardware transcript store", () => {
  beforeEach(async () => {
    await clearPinHardwareTranscriptHistory();
    mocks.values.clear();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  test("keeps interim text in memory and persists only its final replacement", async () => {
    await setPinHardwareTranscriptOwner("user-1");
    const interim = {
      text: "first words",
      isFinal: false,
      capturedAt: "2026-07-17T10:00:00.000Z",
      provider: "tencent",
      deviceId: "mr20",
      deviceName: "YLF20",
      voiceId: "voice-1",
      sliceIndex: 0,
    };

    applyPinHardwareTranscriptEvent(interim);

    expect(getPinHardwareTranscriptSnapshot()).toMatchObject([
      { text: "first words", pending: true },
    ]);
    expect(mocks.storage.setItem).not.toHaveBeenCalled();

    applyPinHardwareTranscriptEvent({ ...interim, text: "first words finalized", isFinal: true });
    expect(getPinHardwareTranscriptSnapshot()).toMatchObject([
      { text: "first words finalized", pending: false },
    ]);
    applyPinHardwareTranscriptEvent({ ...interim, text: "late interim", isFinal: false });
    expect(getPinHardwareTranscriptSnapshot()[0]?.text).toBe("first words finalized");

    await clearPinHardwareTranscriptHistory();
    const persisted = JSON.parse(mocks.values.get(USER_KEY) ?? "{}") as {
      lines?: Array<{ text: string; pending?: boolean }>;
    };
    expect(persisted.lines).toEqual([
      expect.objectContaining({ text: "first words finalized" }),
    ]);
    expect(persisted.lines?.[0]?.pending).toBeUndefined();
  });

  test("survives subscribers unmounting and keeps prior sessions after restart", async () => {
    await setPinHardwareTranscriptOwner("user-1");
    const listener = vi.fn();
    const unsubscribe = subscribePinHardwareTranscripts(listener);
    applyPinHardwareTranscriptEvent({
      text: "session one",
      isFinal: true,
      capturedAt: "2026-07-17T10:00:00.000Z",
      deviceId: "mr20",
      voiceId: "voice-1",
      sliceIndex: 0,
    });
    unsubscribe();

    applyPinHardwareTranscriptEvent({
      text: "session two",
      isFinal: true,
      capturedAt: "2026-07-17T10:05:00.000Z",
      deviceId: "mr20",
      voiceId: "voice-2",
      sliceIndex: 0,
    });

    expect(listener).toHaveBeenCalledOnce();
    expect(getPinHardwareTranscriptSnapshot().map((line) => line.text)).toEqual([
      "session one",
      "session two",
    ]);
  });

  test("merges Tencent speaker snapshots by sentence id and labels A/B", async () => {
    await setPinHardwareTranscriptOwner("user-1");
    const snapshot = {
      text: "first\nsecond draft",
      isFinal: false,
      capturedAt: "2026-07-17T10:00:00.000Z",
      provider: "tencent_rtasr",
      deviceId: "mr20",
      voiceId: "voice-1",
      segments: [
        { sentenceId: 0, speakerId: "0", text: "first", isFinal: true },
        { sentenceId: 1, speakerId: "-1", text: "second draft", isFinal: false },
      ],
    };

    applyPinHardwareTranscriptEvent(snapshot);
    expect(getPinHardwareTranscriptSnapshot()).toMatchObject([
      { id: "pin:seg:mr20:voice-1:0", speaker: "Speaker A", text: "first", pending: false },
      { id: "pin:seg:mr20:voice-1:1", speaker: "Speaker ?", text: "second draft", pending: true },
    ]);

    applyPinHardwareTranscriptEvent({
      ...snapshot,
      text: "first\nsecond finalized",
      isFinal: true,
      capturedAt: "2026-07-17T10:00:02.000Z",
      segments: [
        { sentenceId: 0, speakerId: "0", text: "first", isFinal: true },
        { sentenceId: 1, speakerId: "1", text: "second finalized", isFinal: true },
      ],
    });

    expect(getPinHardwareTranscriptSnapshot()).toHaveLength(2);
    expect(getPinHardwareTranscriptSnapshot()[1]).toMatchObject({
      id: "pin:seg:mr20:voice-1:1",
      speaker: "Speaker B",
      text: "second finalized",
      pending: false,
      capturedAt: "2026-07-17T10:00:00.000Z",
    });
  });

  test("never uses the hardware name as a speaker fallback", async () => {
    await setPinHardwareTranscriptOwner("user-1");

    applyPinHardwareTranscriptEvent({
      text: "legacy provider result",
      isFinal: true,
      capturedAt: "2026-07-17T10:00:00.000Z",
      provider: "tencent_rtasr",
      deviceId: "mr20",
      deviceName: "YLF20_f009c407",
      voiceId: "voice-1",
      sliceIndex: 0,
    });

    expect(getPinHardwareTranscriptSnapshot()).toMatchObject([
      { speaker: "Speaker A", text: "legacy provider result" },
    ]);
  });

  test("hydrates the current user's final history and enforces the 120 line cap", async () => {
    const now = Date.now();
    mocks.values.set(USER_KEY, JSON.stringify({
      version: 1,
      savedAt: now,
      expiresAt: now + 60_000,
      lines: Array.from({ length: 125 }, (_, index) => ({
        id: `line-${index}`,
        speaker: "PINAI",
        text: `line ${index}`,
        capturedAt: new Date(now).toISOString(),
      })),
    }));

    await setPinHardwareTranscriptOwner("user-1");

    expect(getPinHardwareTranscriptSnapshot()).toHaveLength(120);
    expect(getPinHardwareTranscriptSnapshot()[0]?.text).toBe("line 5");
    expect(getPinHardwareTranscriptSnapshot()[119]?.text).toBe("line 124");
  });

  test("drops expired durable history", async () => {
    const now = new Date("2026-07-17T10:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.values.set(USER_KEY, JSON.stringify({
      version: 1,
      savedAt: now.getTime() - 8 * 24 * 60 * 60 * 1_000,
      expiresAt: now.getTime() - 1,
      lines: [{
        id: "expired",
        speaker: "PINAI",
        text: "expired text",
        capturedAt: "2026-07-09T10:00:00.000Z",
      }],
    }));

    await setPinHardwareTranscriptOwner("user-1");

    expect(getPinHardwareTranscriptSnapshot()).toEqual([]);
    expect(mocks.storage.removeItem).toHaveBeenCalledWith(USER_KEY);
  });
});
