import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";

import { setSelectedAmbientSummaryModelId } from "../models-selection";
import { createAmbientTimelineModelBridge } from "./models";
import type { AmbientCandidateWindow } from "./types";

const native = {
  models: {
    list: vi.fn(),
    verifyModel: vi.fn(),
    generateTimelineEvent: vi.fn(),
    generateTimelineBatchDecision: vi.fn(),
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
    native.models.verifyModel.mockReset();
    native.models.generateTimelineEvent.mockReset();
    native.models.generateTimelineBatchDecision.mockReset();
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

  test("preserves native error codes and messages", async () => {
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
      errorMessage: "timed out",
    });
  });


  test("auto-verifies a present selected model before timeline generation", async () => {
    setSelectedAmbientSummaryModelId("qwen3-1_7b-q4");
    native.models.list.mockResolvedValue({
      profiles: [{ id: "qwen3-1_7b-q4", kind: "llm" }],
      statuses: [{ id: "qwen3-1_7b-q4", state: "present" }],
    });
    native.models.verifyModel.mockResolvedValue({ id: "qwen3-1_7b-q4", ok: true, elapsedMs: 12 });
    native.models.generateTimelineEvent.mockResolvedValue({
      eventType: "conversation",
      title: "Verified model",
      summary: "Generated after automatic verification.",
      tags: [],
      confidence: 0.7,
      confidenceLabel: "certain",
      salientFacts: [],
    });
    const bridge = createAmbientTimelineModelBridge();

    const result = await bridge.generateTimelineEvent(windowInput);

    expect(result).toMatchObject({ ok: true, draft: { title: "Verified model" } });
    expect(native.models.verifyModel).toHaveBeenCalledWith({ id: "qwen3-1_7b-q4" });
    expect(native.models.generateTimelineEvent).toHaveBeenCalled();
  });

  test("returns verify_required when automatic verification fails", async () => {
    setSelectedAmbientSummaryModelId("qwen3-1_7b-q4");
    native.models.list.mockResolvedValue({
      profiles: [{ id: "qwen3-1_7b-q4", kind: "llm" }],
      statuses: [{ id: "qwen3-1_7b-q4", state: "present", lastVerifyResult: "fail" }],
    });
    native.models.verifyModel.mockResolvedValue({ id: "qwen3-1_7b-q4", ok: false, elapsedMs: 12 });
    const bridge = createAmbientTimelineModelBridge();

    await expect(bridge.generateTimelineEvent(windowInput)).resolves.toEqual({
      ok: false,
      errorCode: "verify_required",
    });
    expect(native.models.generateTimelineEvent).not.toHaveBeenCalled();
  });


  test("calls native batch generation with compact budgeted input", async () => {
    setSelectedAmbientSummaryModelId("qwen3-1_7b-q4");
    native.models.list.mockResolvedValue({
      profiles: [{ id: "qwen3-1_7b-q4", kind: "llm" }],
      statuses: [{ id: "qwen3-1_7b-q4", state: "present", lastVerifyResult: "ok" }],
    });
    native.models.generateTimelineBatchDecision.mockResolvedValue({
      decisions: [{
        action: "create",
        title: "Product review",
        summary: "Discussed product review follow-ups.",
        importance: "medium",
        occurredAt: "2026-05-15T10:00:00.000Z",
        sourceWindowIds: ["win_1"],
      }],
    });
    const bridge = createAmbientTimelineModelBridge();

    const result = await bridge.generateTimelineBatchDecision?.({ windows: [windowInput] });

    expect(result).toMatchObject({ ok: true, batch: { decisions: [{ action: "create", title: "Product review" }] } });
    expect(native.models.generateTimelineBatchDecision).toHaveBeenCalledWith({
      modelId: "qwen3-1_7b-q4",
      batch: expect.objectContaining({
        schemaVersion: "ambient_timeline_batch.v1",
        windows: [expect.objectContaining({ id: "win_1", compactContext: windowInput.compactContext })],
      }),
    });
    const payload = native.models.generateTimelineBatchDecision.mock.calls[0][0].batch.windows[0];
    expect(payload.rawRefs).toBeUndefined();
  });

  test("truncates batch window context to the on-device prompt budget", async () => {
    setSelectedAmbientSummaryModelId("qwen3-1_7b-q4");
    native.models.list.mockResolvedValue({
      profiles: [{ id: "qwen3-1_7b-q4", kind: "llm" }],
      statuses: [{ id: "qwen3-1_7b-q4", state: "present", lastVerifyResult: "ok" }],
    });
    native.models.generateTimelineBatchDecision.mockResolvedValue({
      decisions: [{
        action: "create",
        title: "Budgeted",
        summary: "Generated from a compact prompt.",
        importance: "medium",
        occurredAt: "2026-05-15T10:00:00.000Z",
        sourceWindowIds: ["win_1"],
      }],
    });
    const bridge = createAmbientTimelineModelBridge();
    const longWindow = { ...windowInput, compactContext: "A".repeat(2_000) };

    await bridge.generateTimelineBatchDecision?.({ windows: [longWindow] });

    const payload = native.models.generateTimelineBatchDecision.mock.calls[0][0].batch.windows[0];
    expect(payload.compactContext.length).toBeLessThanOrEqual(480);
    expect(payload.compactContext.endsWith("…")).toBe(true);
  });

  test("rejects placeholder native batch output copied from the schema", async () => {
    setSelectedAmbientSummaryModelId("qwen3-1_7b-q4");
    native.models.list.mockResolvedValue({
      profiles: [{ id: "qwen3-1_7b-q4", kind: "llm" }],
      statuses: [{ id: "qwen3-1_7b-q4", state: "present", lastVerifyResult: "ok" }],
    });
    native.models.generateTimelineBatchDecision.mockResolvedValue({
      decisions: [{
        action: "create",
        title: "title",
        summary: "summary",
        importance: "medium",
        occurredAt: "iso",
        sourceWindowIds: ["win_1"],
      }],
    });
    const bridge = createAmbientTimelineModelBridge();

    await expect(bridge.generateTimelineBatchDecision?.({ windows: [windowInput] })).resolves.toEqual({
      ok: false,
      errorCode: "invalid_shape",
    });
  });

  test("falls back to window start when batch output has a placeholder occurredAt", async () => {
    setSelectedAmbientSummaryModelId("qwen3-1_7b-q4");
    native.models.list.mockResolvedValue({
      profiles: [{ id: "qwen3-1_7b-q4", kind: "llm" }],
      statuses: [{ id: "qwen3-1_7b-q4", state: "present", lastVerifyResult: "ok" }],
    });
    native.models.generateTimelineBatchDecision.mockResolvedValue({
      decisions: [{
        action: "create",
        title: "Product review",
        summary: "Discussed product review follow-ups.",
        importance: "medium",
        occurredAt: "iso",
        sourceWindowIds: ["win_1"],
      }],
    });
    const bridge = createAmbientTimelineModelBridge();

    const result = await bridge.generateTimelineBatchDecision?.({ windows: [windowInput] });

    expect(result).toMatchObject({
      ok: true,
      batch: {
        decisions: [{
          action: "create",
          occurredAt: "2026-05-15T10:00:00.000Z",
        }],
      },
    });
  });

  test("falls back to single-window native generation when batch facade is unavailable", async () => {
    setSelectedAmbientSummaryModelId("qwen3-1_7b-q4");
    native.models.list.mockResolvedValue({
      profiles: [{ id: "qwen3-1_7b-q4", kind: "llm" }],
      statuses: [{ id: "qwen3-1_7b-q4", state: "present", lastVerifyResult: "ok" }],
    });
    const originalBatch = native.models.generateTimelineBatchDecision;
    delete (native.models as Partial<typeof native.models>).generateTimelineBatchDecision;
    native.models.generateTimelineEvent.mockResolvedValue({
      eventType: "conversation",
      title: "Fallback summary",
      summary: "Generated through the legacy single-window method.",
      tags: [],
      confidence: 0.7,
      confidenceLabel: "certain",
      salientFacts: [],
    });
    const bridge = createAmbientTimelineModelBridge();

    const result = await bridge.generateTimelineBatchDecision?.({ windows: [windowInput] });

    expect(result).toMatchObject({
      ok: true,
      batch: { decisions: [{ action: "create", title: "Fallback summary", sourceWindowIds: ["win_1"] }] },
    });
    expect(native.models.generateTimelineEvent).toHaveBeenCalledWith({
      modelId: "qwen3-1_7b-q4",
      window: expect.objectContaining({ id: "win_1" }),
    });
    native.models.generateTimelineBatchDecision = originalBatch;
  });

  test("rejects placeholder native single-window output copied from the schema", async () => {
    setSelectedAmbientSummaryModelId("qwen3-1_7b-q4");
    native.models.list.mockResolvedValue({
      profiles: [{ id: "qwen3-1_7b-q4", kind: "llm" }],
      statuses: [{ id: "qwen3-1_7b-q4", state: "present", lastVerifyResult: "ok" }],
    });
    native.models.generateTimelineEvent.mockResolvedValue({
      eventType: "conversation",
      title: "short title",
      summary: "one sentence",
      confidence: 0.7,
      confidenceLabel: "certain",
      tags: ["ambient"],
      salientFacts: ["fact"],
    });
    const bridge = createAmbientTimelineModelBridge();

    await expect(bridge.generateTimelineEvent(windowInput)).resolves.toEqual({
      ok: false,
      errorCode: "invalid_shape",
    });
  });


  test("rejects batch decisions that omit selected windows", async () => {
    setSelectedAmbientSummaryModelId("qwen3-1_7b-q4");
    native.models.list.mockResolvedValue({
      profiles: [{ id: "qwen3-1_7b-q4", kind: "llm" }],
      statuses: [{ id: "qwen3-1_7b-q4", state: "present", lastVerifyResult: "ok" }],
    });
    native.models.generateTimelineBatchDecision.mockResolvedValue({ decisions: [] });
    const bridge = createAmbientTimelineModelBridge();

    await expect(bridge.generateTimelineBatchDecision?.({ windows: [windowInput] })).resolves.toEqual({
      ok: false,
      errorCode: "invalid_shape",
    });
  });

  test("rejects batch decisions that echo prompt placeholder values", async () => {
    setSelectedAmbientSummaryModelId("qwen3-1_7b-q4");
    native.models.list.mockResolvedValue({
      profiles: [{ id: "qwen3-1_7b-q4", kind: "llm" }],
      statuses: [{ id: "qwen3-1_7b-q4", state: "present", lastVerifyResult: "ok" }],
    });
    native.models.generateTimelineBatchDecision.mockResolvedValue({
      decisions: [{
        action: "create",
        title: "title",
        summary: "summary",
        importance: "medium",
        occurredAt: "iso",
        sourceWindowIds: ["win_1"],
      }],
    });
    const bridge = createAmbientTimelineModelBridge();

    await expect(bridge.generateTimelineBatchDecision?.({ windows: [windowInput] })).resolves.toEqual({
      ok: false,
      errorCode: "invalid_shape",
    });
  });

  test("falls back to window startedAt when reported occurredAt is the literal placeholder", async () => {
    setSelectedAmbientSummaryModelId("qwen3-1_7b-q4");
    native.models.list.mockResolvedValue({
      profiles: [{ id: "qwen3-1_7b-q4", kind: "llm" }],
      statuses: [{ id: "qwen3-1_7b-q4", state: "present", lastVerifyResult: "ok" }],
    });
    native.models.generateTimelineBatchDecision.mockResolvedValue({
      decisions: [{
        action: "create",
        title: "Product review",
        summary: "Discussed product review follow-ups.",
        importance: "medium",
        occurredAt: "iso",
        sourceWindowIds: ["win_1"],
      }],
    });
    const bridge = createAmbientTimelineModelBridge();

    const result = await bridge.generateTimelineBatchDecision?.({ windows: [windowInput] });

    expect(result).toMatchObject({
      ok: true,
      batch: {
        decisions: [{
          action: "create",
          occurredAt: windowInput.startedAt,
        }],
      },
    });
  });

  test("falls back to window startedAt when reported occurredAt is not a parseable ISO timestamp", async () => {
    setSelectedAmbientSummaryModelId("qwen3-1_7b-q4");
    native.models.list.mockResolvedValue({
      profiles: [{ id: "qwen3-1_7b-q4", kind: "llm" }],
      statuses: [{ id: "qwen3-1_7b-q4", state: "present", lastVerifyResult: "ok" }],
    });
    native.models.generateTimelineBatchDecision.mockResolvedValue({
      decisions: [{
        action: "create",
        title: "Product review",
        summary: "Discussed product review follow-ups.",
        importance: "medium",
        occurredAt: "yesterday morning",
        sourceWindowIds: ["win_1"],
      }],
    });
    const bridge = createAmbientTimelineModelBridge();

    const result = await bridge.generateTimelineBatchDecision?.({ windows: [windowInput] });

    expect(result).toMatchObject({
      ok: true,
      batch: {
        decisions: [{
          action: "create",
          occurredAt: windowInput.startedAt,
        }],
      },
    });
  });

  test("rejects batch decisions that echo angle-bracket placeholders", async () => {
    setSelectedAmbientSummaryModelId("qwen3-1_7b-q4");
    native.models.list.mockResolvedValue({
      profiles: [{ id: "qwen3-1_7b-q4", kind: "llm" }],
      statuses: [{ id: "qwen3-1_7b-q4", state: "present", lastVerifyResult: "ok" }],
    });
    native.models.generateTimelineBatchDecision.mockResolvedValue({
      decisions: [{
        action: "create",
        title: "<TITLE_HERE>",
        summary: "<SUMMARY_HERE>",
        importance: "medium",
        occurredAt: windowInput.startedAt,
        sourceWindowIds: ["win_1"],
      }],
    });
    const bridge = createAmbientTimelineModelBridge();

    await expect(bridge.generateTimelineBatchDecision?.({ windows: [windowInput] })).resolves.toEqual({
      ok: false,
      errorCode: "invalid_shape",
    });
  });

  test("rewrites title containing 'Motion context:' label using compactContext", async () => {
    setSelectedAmbientSummaryModelId("qwen3-1_7b-q4");
    native.models.list.mockResolvedValue({
      profiles: [{ id: "qwen3-1_7b-q4", kind: "llm" }],
      statuses: [{ id: "qwen3-1_7b-q4", state: "present", lastVerifyResult: "ok" }],
    });
    native.models.generateTimelineBatchDecision.mockResolvedValue({
      decisions: [{
        action: "create",
        title: "Motion context: Motion stationary for 36m 55s",
        summary: "讨论了端上 AM 智力不足的可能原因。",
        importance: "medium",
        occurredAt: windowInput.startedAt,
        sourceWindowIds: ["win_1"],
      }],
    });
    const bridge = createAmbientTimelineModelBridge();

    const result = await bridge.generateTimelineBatchDecision?.({ windows: [windowInput] });

    expect(result?.ok).toBe(true);
    if (result?.ok) {
      const [decision] = result.batch.decisions;
      expect(decision.action).toBe("create");
      if (decision.action === "create") {
        expect(decision.title.toLowerCase()).not.toContain("motion context:");
        expect(decision.title.length).toBeLessThanOrEqual(31);
      }
    }
  });

  test("rejects batch decisions that echo example-content phrases (Alice/Bob/APNs)", async () => {
    setSelectedAmbientSummaryModelId("qwen3-1_7b-q4");
    native.models.list.mockResolvedValue({
      profiles: [{ id: "qwen3-1_7b-q4", kind: "llm" }],
      statuses: [{ id: "qwen3-1_7b-q4", state: "present", lastVerifyResult: "ok" }],
    });
    native.models.generateTimelineBatchDecision.mockResolvedValue({
      decisions: [{
        action: "create",
        title: "Standup: roll back APNs entitlement change",
        summary: "Alice flagged a TestFlight 84 push notification regression and Bob owns rolling back the APNs entitlement change today.",
        importance: "high",
        occurredAt: windowInput.startedAt,
        sourceWindowIds: ["win_1"],
      }],
    });
    const bridge = createAmbientTimelineModelBridge();

    await expect(bridge.generateTimelineBatchDecision?.({ windows: [windowInput] })).resolves.toEqual({
      ok: false,
      errorCode: "invalid_shape",
    });
  });

  describe("on-device action candidate (act)", () => {
    function mockBatchWithAct(act: unknown, overrides: Record<string, unknown> = {}): void {
      setSelectedAmbientSummaryModelId("qwen3-1_7b-q4");
      native.models.list.mockResolvedValue({
        profiles: [{ id: "qwen3-1_7b-q4", kind: "llm" }],
        statuses: [{ id: "qwen3-1_7b-q4", state: "present", lastVerifyResult: "ok" }],
      });
      native.models.generateTimelineBatchDecision.mockResolvedValue({
        decisions: [{
          action: "create",
          title: "Product review",
          summary: "Discussed product review follow-ups.",
          importance: "medium",
          occurredAt: windowInput.startedAt,
          sourceWindowIds: ["win_1"],
          act,
          ...overrides,
        }],
      });
    }

    async function batchDecision(): Promise<ReturnType<typeof createAmbientTimelineModelBridge>["generateTimelineBatchDecision"] extends ((...args: never[]) => Promise<infer R>) | undefined ? R : never> {
      const bridge = createAmbientTimelineModelBridge();
      const result = await bridge.generateTimelineBatchDecision?.({ windows: [windowInput] });
      if (!result) throw new Error("expected batch decision result");
      return result;
    }

    test("attaches a valid act as a single actionCandidates entry", async () => {
      mockBatchWithAct({
        l: "Send recap",
        g: "Send a recap of the product review follow-ups to the team.",
        b: "work",
      });
      const result = await batchDecision();
      expect(result.ok).toBe(true);
      if (result.ok) {
        const decision = result.batch.decisions[0];
        expect(decision.action).toBe("create");
        if (decision.action === "create") {
          expect(decision.actionCandidates).toEqual([{
            label: "Send recap",
            goal: "Send a recap of the product review follow-ups to the team.",
            goalBasket: "work",
          }]);
        }
      }
    });

    test("preserves the card and drops act when act is missing entirely", async () => {
      mockBatchWithAct(undefined);
      const result = await batchDecision();
      expect(result.ok).toBe(true);
      if (result.ok) {
        const decision = result.batch.decisions[0];
        expect(decision.action).toBe("create");
        if (decision.action === "create") {
          expect(decision.actionCandidates).toBeUndefined();
        }
      }
    });

    test("drops act with placeholder label without rejecting the card", async () => {
      mockBatchWithAct({ l: "<LABEL_HERE>", g: "Send a recap of the call." });
      const result = await batchDecision();
      expect(result.ok).toBe(true);
      if (result.ok) {
        const decision = result.batch.decisions[0];
        expect(decision.action).toBe("create");
        if (decision.action === "create") {
          expect(decision.actionCandidates).toBeUndefined();
        }
      }
    });

    test("drops act containing evidence label markers", async () => {
      mockBatchWithAct({
        l: "Follow up",
        g: "Motion context: stationary for 36m, plan a recap reply.",
      });
      const result = await batchDecision();
      expect(result.ok).toBe(true);
      if (result.ok) {
        const decision = result.batch.decisions[0];
        if (decision.action === "create") {
          expect(decision.actionCandidates).toBeUndefined();
        }
      }
    });

    test("drops act when label equals goal", async () => {
      mockBatchWithAct({ l: "Send recap", g: "Send recap" });
      const result = await batchDecision();
      expect(result.ok).toBe(true);
      if (result.ok) {
        const decision = result.batch.decisions[0];
        if (decision.action === "create") {
          expect(decision.actionCandidates).toBeUndefined();
        }
      }
    });

    test("drops act when goal duplicates the card summary", async () => {
      mockBatchWithAct({ l: "Send recap", g: "Discussed product review follow-ups." });
      const result = await batchDecision();
      expect(result.ok).toBe(true);
      if (result.ok) {
        const decision = result.batch.decisions[0];
        if (decision.action === "create") {
          expect(decision.actionCandidates).toBeUndefined();
        }
      }
    });

    test("truncates over-long label and goal with ellipsis", async () => {
      mockBatchWithAct({
        l: "Send a longer follow up recap message to the team",
        g: "g".repeat(180),
      });
      const result = await batchDecision();
      expect(result.ok).toBe(true);
      if (result.ok) {
        const decision = result.batch.decisions[0];
        if (decision.action === "create") {
          const [first] = decision.actionCandidates ?? [];
          expect(first?.label.length).toBeLessThanOrEqual(24);
          expect(first?.label.endsWith("…")).toBe(true);
          expect(first?.goal.length).toBeLessThanOrEqual(100);
          expect(first?.goal.endsWith("…")).toBe(true);
        }
      }
    });

    test("drops invalid basket but keeps label and goal", async () => {
      mockBatchWithAct({ l: "Send recap", g: "Send a recap of the call to the team.", b: "nonsense" });
      const result = await batchDecision();
      expect(result.ok).toBe(true);
      if (result.ok) {
        const decision = result.batch.decisions[0];
        if (decision.action === "create") {
          const [first] = decision.actionCandidates ?? [];
          expect(first?.label).toBe("Send recap");
          expect(first?.goalBasket).toBeUndefined();
        }
      }
    });
  });

});
