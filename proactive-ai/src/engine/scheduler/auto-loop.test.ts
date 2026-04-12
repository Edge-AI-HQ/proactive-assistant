import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  pinCliData,
  loadAutoLoopState,
  getAutoGenerate,
  getAutoDreaming,
  buildDefaultCtx,
  getDefaultProfile,
  listDreamRuns,
  startDreaming,
  resolveDreamingTimezone,
  isDreamingDue,
  syncCardChatFeedback,
} = vi.hoisted(() => ({
  pinCliData: vi.fn(),
  loadAutoLoopState: vi.fn(() => ({ lastFinishedAt: null })),
  getAutoGenerate: vi.fn(() => false),
  getAutoDreaming: vi.fn(() => false),
  buildDefaultCtx: vi.fn(() => ({ env: {}, homeDir: "/tmp" })),
  getDefaultProfile: vi.fn(),
  listDreamRuns: vi.fn(() => []),
  startDreaming: vi.fn(),
  resolveDreamingTimezone: vi.fn(() => "UTC"),
  isDreamingDue: vi.fn(() => false),
  syncCardChatFeedback: vi.fn(),
}));

vi.mock("../pipeline/pin-cli.js", () => ({
  pinCliData,
}));

vi.mock("../pending-store.js", () => ({
  loadAutoLoopState,
}));

vi.mock("../server/local-settings.js", () => ({
  getAutoGenerate,
  getAutoDreaming,
}));

vi.mock("../pipeline/data-access.js", () => ({
  buildDefaultCtx,
  getDefaultProfile,
}));

vi.mock("../dreaming/service.js", () => ({
  listDreamRuns,
  startDreaming,
}));

vi.mock("../dreaming/schedule.js", () => ({
  resolveDreamingTimezone,
  isDreamingDue,
}));

vi.mock("../chat-feedback/service.js", () => ({
  syncCardChatFeedback,
}));

import { DEFAULT_CONFIG } from "../config.js";
import { startAutoLoop } from "./auto-loop.js";
import { autoPollState, gatewayOriginState, pipelineState } from "../state.js";

describe("startAutoLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    autoPollState.started = false;
    autoPollState.ingestInFlight = false;
    autoPollState.loopInFlight = false;
    autoPollState.dreamInFlight = false;
    autoPollState.ingestTimer = null;
    autoPollState.detectTimer = null;
    gatewayOriginState.gatewayOrigin = null;
    pipelineState.running = false;
    pipelineState.phase = null;
    pipelineState.iteration = null;
    pinCliData.mockResolvedValue({
      inserted: { world: 0, personal: 0, total: 0 },
      pending: 0,
    });
    syncCardChatFeedback.mockResolvedValue({
      scannedCards: 0,
      qualifiedCards: 0,
      summarizedCards: 0,
      writtenFeedback: 0,
      skippedBelowThreshold: 0,
      skippedUnchanged: 0,
    });
  });

  afterEach(() => {
    if (autoPollState.ingestTimer) clearInterval(autoPollState.ingestTimer);
    if (autoPollState.detectTimer) clearInterval(autoPollState.detectTimer);
    autoPollState.started = false;
    vi.useRealTimers();
  });

  it("runs background card-chat feedback sync on the detect loop even when auto-generate is off", async () => {
    const api = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      config: {},
    };

    startAutoLoop(api as never, {
      ...DEFAULT_CONFIG,
      auto_ingest_interval_ms: 60_000,
      auto_detect_interval_ms: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(syncCardChatFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        api,
        trigger: "auto",
      }),
    );
  });
});
