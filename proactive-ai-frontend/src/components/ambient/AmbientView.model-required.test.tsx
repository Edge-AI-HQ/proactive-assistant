import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import AmbientView from "@/components/ambient/AmbientView";

vi.mock("@/lib/platform", () => ({ isNative: true }));
vi.mock("@pin-ai/state", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useUserSettings: () => ({ settings: null, patch: vi.fn() }),
  useUserDevices: () => ({ devices: [], loading: false, error: null }),
}));
vi.mock("@/hooks/useAmbientLiveSession", () => ({
  useAmbientLiveSession: () => ({ session: null, previewVisibleCount: 0, dismiss: vi.fn() }),
}));
vi.mock("@/components/ambient/AmbientSourceControlsPanel", () => ({ default: () => <div /> }));
vi.mock("./LiveSessionCard", () => ({ default: () => <div /> }));
vi.mock("@/hooks/useAmbientTimeline", () => ({
  useAmbientTimeline: () => ({
    events: [],
    latestRawEvents: [],
    pendingTranscriptWindows: [],
    pendingTranscriptCount: 2,
    narrativeSummary: null,
    loading: false,
    error: null,
    localDate: "2026-05-19",
    storeStatus: null,
    dismiss: vi.fn(),
  }),
}));
vi.mock("@/services/ambient/enabled-state", () => ({
  getPersistedAmbientEnabled: () => true,
  setPersistedAmbientEnabled: vi.fn(),
}));
vi.mock("@/services/ambient", () => ({
  getAmbientRuntime: () => ({
    status: () => ({
      sources: [],
      bufferSize: 0,
      outboxMode: "memory",
      outboxPendingCount: 0,
      totalIngested: 0,
      totalIngestErrors: 0,
      lastFlushTs: null,
      lastDrainTs: null,
      lastSuccessfulDrainTs: null,
      lastIngestError: null,
      uploadsLocked: false,
    }),
    subscribe: () => () => {},
  }),
  getExistingAmbientRuntime: () => null,
}));
vi.mock("@/services/ambient/models-recommendation", () => ({
  RECOMMENDED_AMBIENT_LLM_LABEL: "Gemma 2B",
  RECOMMENDED_AMBIENT_LLM_MODEL_ID: "gemma-2-2b-q4",
}));
vi.mock("@/components/onboarding/AmbientModelSetupStep", () => ({
  default: () => <div>Gemma setup drawer</div>,
}));

describe("AmbientView model setup CTA", () => {
  test("opens the Gemma setup drawer from the missing-model CTA", () => {
    render(<AmbientView />);

    fireEvent.click(screen.getByRole("button", { name: /download gemma 2b/i }));

    expect(screen.getByText(/Gemma setup drawer/i)).toBeTruthy();
  });
});
