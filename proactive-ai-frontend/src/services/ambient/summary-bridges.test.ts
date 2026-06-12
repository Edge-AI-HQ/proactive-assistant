import { beforeEach, describe, expect, test, vi } from "vitest";

const summarizeAmbientWithCloudMock = vi.hoisted(() => vi.fn());
const localGenerateMock = vi.hoisted(() => vi.fn());

vi.mock("@pin-ai/core", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  summarizeAmbientWithCloud: summarizeAmbientWithCloudMock,
}));

vi.mock("./timeline/models", () => ({
  ambientTimelineModels: {
    generateAmbientSummaryEvent: localGenerateMock,
  },
}));

import { createCloudFirstAmbientSummaryBridge } from "./summary-bridges";
import type { AmbientSummaryContext } from "./timeline/summary-context";

const context: AmbientSummaryContext = {
  schemaVersion: "ambient_summary.v1",
  localDate: "2026-05-19",
  generatedAt: "2026-05-19T10:15:00.000Z",
  rawEvents: [],
  recentSummaries: [],
};

describe("createCloudFirstAmbientSummaryBridge", () => {
  beforeEach(() => {
    summarizeAmbientWithCloudMock.mockReset();
    localGenerateMock.mockReset();
    localGenerateMock.mockResolvedValue({
      ok: true,
      draft: {
        title: "Local",
        summary: "Local summary",
        tags: [],
        confidence: 0.5,
        confidenceLabel: "uncertain",
      },
      modelId: "local-model",
    });
  });

  test("falls back to local without calling cloud when the privacy gate closes before request", async () => {
    const bridge = createCloudFirstAmbientSummaryBridge({ shouldUseCloud: () => false });

    const result = await bridge.generateAmbientSummaryEvent(context);

    expect(summarizeAmbientWithCloudMock).not.toHaveBeenCalled();
    expect(localGenerateMock).toHaveBeenCalledWith(context);
    expect(result).toMatchObject({
      ok: true,
      generationMethod: "local_llm",
      primarySourceLabel: "On-device summary",
    });
  });
});
