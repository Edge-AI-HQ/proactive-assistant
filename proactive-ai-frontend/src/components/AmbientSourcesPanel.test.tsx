import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import AmbientSourcesPanel from "./AmbientSourcesPanel";

const { patchMock, runtimeMock, clearMock } = vi.hoisted(() => ({
  patchMock: vi.fn(),
  clearMock: vi.fn(),
  runtimeMock: {
    status: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    start: vi.fn(),
    stop: vi.fn(),
    reconcileEnabledSources: vi.fn(),
    flush: vi.fn(),
  },
}));

vi.mock("@/lib/platform", () => ({ isNative: true }));
vi.mock("./AmbientAudioDebugPanel", () => ({
  default: () => null,
}));
vi.mock("./AmbientModelsPanel", () => ({
  default: () => <div>Ambient models</div>,
}));
vi.mock("@/hooks/useUserSettings", () => ({
  useUserSettings: () => ({
    settings: { ambientSources: { health: { enabled: false } } },
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
vi.mock("@/services/ambient/reset-sqlite", () => ({
  clearAmbientSqliteData: clearMock,
}));

function makeStatus() {
  return {
    sources: [{
      key: "health",
      label: "HealthKit",
      enabled: false,
      lastEvent: null,
      ingestedCount: 0,
      lastError: null,
    }],
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
  };
}

describe("AmbientSourcesPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMock.status.mockReturnValue(makeStatus());
    patchMock.mockResolvedValue({
      ambientSources: { health: { enabled: true } },
    });
    clearMock.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  test("shows HealthKit source and starts it when toggled on", async () => {
    render(<AmbientSourcesPanel />);

    expect(screen.getByText("HealthKit")).toBeTruthy();
    expect(screen.getByText(/steps, sleep, and heart rate/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Enable HealthKit" }));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith({
        ambientSources: { health: { enabled: true } },
      });
      expect(runtimeMock.reconcileEnabledSources).toHaveBeenCalledWith(["health"]);
    });
  });

  test("clears Ambient SQLite data from the debug actions area", async () => {
    render(<AmbientSourcesPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Clear Ambient SQLite data" }));

    await waitFor(() => {
      expect(clearMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText("Ambient SQLite data cleared. Restart the app to reopen fresh local databases.")).toBeTruthy();
  });
});
