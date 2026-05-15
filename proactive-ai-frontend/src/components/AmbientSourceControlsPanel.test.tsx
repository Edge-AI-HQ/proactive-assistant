import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import AmbientSourceControlsPanel from "./AmbientSourceControlsPanel";

const { patchMock, runtimeMock } = vi.hoisted(() => ({
  patchMock: vi.fn(),
  runtimeMock: {
    status: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    reconcileEnabledSources: vi.fn(),
    flush: vi.fn(),
  },
}));

vi.mock("@/lib/platform", () => ({ isNative: true }));
vi.mock("@/hooks/useUserSettings", () => ({
  useUserSettings: () => ({
    settings: {
      ambientSources: {
        sound_classifier: { enabled: true },
        health: { enabled: false },
      },
    },
    loading: false,
    saving: false,
    error: null,
    patch: patchMock,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/services/ambient/runtime-client", () => ({
  loadAmbientRuntime: () => Promise.resolve(runtimeMock),
}));

function makeStatus() {
  return {
    sources: [
      {
        key: "sound_classifier",
        label: "Sound Classifier",
        enabled: true,
        lastEvent: { ts: 1_700_000_000_000, summary: "speech" },
        ingestedCount: 3,
        lastError: null,
      },
      {
        key: "health",
        label: "HealthKit",
        enabled: false,
        lastEvent: null,
        ingestedCount: 0,
        lastError: null,
      },
    ],
    bufferSize: 0,
    outboxMode: "memory",
    outboxPendingCount: 0,
    totalIngested: 3,
    totalIngestErrors: 0,
    lastFlushTs: null,
    lastDrainTs: null,
    lastSuccessfulDrainTs: null,
    lastIngestError: null,
    uploadsLocked: false,
  };
}

describe("AmbientSourceControlsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMock.status.mockReturnValue(makeStatus());
    patchMock.mockResolvedValue({
      ambientSources: {
        sound_classifier: { enabled: true },
        health: { enabled: true },
      },
    });
  });

  test("renders permissions and reconciles the full enabled source set after a toggle", async () => {
    render(<AmbientSourceControlsPanel />);

    expect(screen.getByText("Permissions & sources")).toBeTruthy();
    expect(screen.getByText("Sound Classifier")).toBeTruthy();
    expect(screen.getByText("HealthKit")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Enable HealthKit" }));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith({
        ambientSources: { health: { enabled: true } },
      });
      expect(runtimeMock.reconcileEnabledSources).toHaveBeenCalledWith([
        "sound_classifier",
        "health",
      ]);
    });
  });
});
