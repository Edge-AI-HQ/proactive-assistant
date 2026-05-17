import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";

import { setSelectedAmbientSummaryModelId } from "../models-selection";
import { createAmbientTimelineModelBridge } from "./models";
import type { AmbientCandidateWindow } from "./types";

const native = {
  models: {
    list: vi.fn(),
    generateTimelineEvent: vi.fn(),
  },
};

vi.mock("@pin/capacitor-ambient-ai", () => ({
  AmbientAi: native,
}));

const windowInput: AmbientCandidateWindow = {
  id: "win_1",
  localUserId: "local",
  localDate: "2026-05-15",
  windowType: "transcript_session",
  startedAt: "2026-05-15T10:00:00.000Z",
  endedAt: "2026-05-15T10:02:00.000Z",
  timezone: "UTC",
  sourceTypes: ["transcript"],
  deviceLabels: ["Microphone"],
  rawRefs: [{ sourceType: "transcript", id: "raw_1" }],
  observationIds: [],
  compactContext: "Transcript segment: discussed the product review follow-up.",
  privacyHint: "private",
  confidenceHint: 0.55,
  salienceHint: 0.5,
  generationPolicy: "llm_allowed",
  llmInputHash: "hash",
  status: "pending",
  lastAttemptAt: null,
  attemptCount: 0,
  lastErrorCode: null,
  expiresAt: null,
  createdAt: "2026-05-15T10:00:00.000Z",
  updatedAt: "2026-05-15T10:00:00.000Z",
};

describe("Ambient timeline model bridge", () => {
  beforeEach(() => {
    localStorage.clear();
    native.models.list.mockReset();
    native.models.generateTimelineEvent.mockReset();
  });

  afterEach(() => {
    localStorage.clear();
  });

  test("does not call native generation without an explicit selected model", async () => {
    const bridge = createAmbientTimelineModelBridge();

    await expect(bridge.generateTimelineEvent(windowInput)).resolves.toEqual({ ok: false, errorCode: "no_selected_model" });

    expect(native.models.generateTimelineEvent).not.toHaveBeenCalled();
  });

  test("calls native generation with compact window input for a verified selected model", async () => {
    setSelectedAmbientSummaryModelId("qwen3-1_7b-q4");
    native.models.list.mockResolvedValue({
      profiles: [{ id: "qwen3-1_7b-q4", kind: "llm" }],
      statuses: [{ id: "qwen3-1_7b-q4", state: "present", lastVerifyResult: "ok" }],
    });
    native.models.generateTimelineEvent.mockResolvedValue({
      eventType: "conversation",
      title: "Product review",
      summary: "Discussed product review follow-ups.",
      tags: ["conversation", "work"],
      confidence: 0.7,
      confidenceLabel: "certain",
      salientFacts: ["Product review follow-ups"],
      actionCandidates: [{ label: "Do not sync" }],
    });
    const bridge = createAmbientTimelineModelBridge();

    const result = await bridge.generateTimelineEvent(windowInput);

    expect(result).toMatchObject({ ok: true, draft: { title: "Product review", eventType: "conversation" } });
    expect(native.models.generateTimelineEvent).toHaveBeenCalledWith({
      modelId: "qwen3-1_7b-q4",
      window: expect.objectContaining({
        id: "win_1",
        compactContext: windowInput.compactContext,
      }),
    });
    const payload = native.models.generateTimelineEvent.mock.calls[0][0].window;
    expect(payload.rawRefs).toBeUndefined();
    expect(payload.compactContext).toBe(windowInput.compactContext);
    expect(result.ok ? result.draft.actionCandidates : undefined).toBeUndefined();
  });
  test("returns typed errors and falls back unknown event types to other", async () => {
    setSelectedAmbientSummaryModelId("qwen3-1_7b-q4");
    native.models.list.mockResolvedValue({
      profiles: [{ id: "qwen3-1_7b-q4", kind: "llm" }],
      statuses: [{ id: "qwen3-1_7b-q4", state: "present", lastVerifyResult: "ok" }],
    });
    native.models.generateTimelineEvent.mockResolvedValue({
      eventType: "planning",
      title: "Planning chat",
      summary: "Discussed planning follow-ups.",
      confidence: 0.6,
      confidenceLabel: "uncertain",
    });
    const bridge = createAmbientTimelineModelBridge();

    const result = await bridge.generateTimelineEvent(windowInput);

    expect(result).toMatchObject({
      ok: true,
      draft: { eventType: "other", title: "Planning chat" },
    });
  });

  test("preserves native error codes", async () => {
    setSelectedAmbientSummaryModelId("qwen3-1_7b-q4");
    native.models.list.mockResolvedValue({
      profiles: [{ id: "qwen3-1_7b-q4", kind: "llm" }],
      statuses: [{ id: "qwen3-1_7b-q4", state: "present", lastVerifyResult: "ok" }],
    });
    const err = new Error("timed out");
    Object.assign(err, { code: "generation_timeout" });
    native.models.generateTimelineEvent.mockRejectedValue(err);
    const bridge = createAmbientTimelineModelBridge();

    await expect(bridge.generateTimelineEvent(windowInput)).resolves.toEqual({
      ok: false,
      errorCode: "generation_timeout",
    });
  });

});
