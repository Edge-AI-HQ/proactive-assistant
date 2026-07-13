import { describe, expect, test } from "vitest";

import { SIGNAL_KINDS } from "../signals";
import { rawEventFromSignal } from "./normalize";

describe("rawEventFromSignal", () => {
  test("normalizes PIN hardware final transcripts as transcript source events", () => {
    const raw = rawEventFromSignal({
      kind: SIGNAL_KINDS.pinHardwareTranscript,
      title: "PIN hardware transcript",
      summary: "今天白天一直开着实时转播",
      occurred_at: "2026-07-04T09:30:00.000Z",
      payload: {
        schema_version: "pin_hardware_transcript.v1",
        provider: "tencent",
        device_name: "PIN MR20",
        speaker_segments: [
          { speaker: "说话人 1", text: "今天白天一直开着实时转播" },
        ],
      },
    });

    expect(raw.sourceType).toBe("transcript");
    expect(raw.eventType).toBe("transcript.ready");
    expect(raw.sensitivity).toBe("private");
    expect(raw.compactText).toBe("说话人 1: \"今天白天一直开着实时转播\"");
  });
});
