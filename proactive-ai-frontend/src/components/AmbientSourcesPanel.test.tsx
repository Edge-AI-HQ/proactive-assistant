import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import AmbientSourcesPanel from "./AmbientSourcesPanel";

const { patchMock, runtimeMock } = vi.hoisted(() => ({
  patchMock: vi.fn(),
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
vi.mock("@/hooks/useUserSettings", () => ({
  useUserSettings: () => ({ patch: patchMock }),
}));
vi.mock("@/services/ambient", () => ({
  getAmbientRuntime: () => runtimeMock,
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
  };
}

describe("AmbientSourcesPanel health source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMock.status.mockReturnValue(makeStatus());
    patchMock.mockResolvedValue({
      ambientSources: { health: { enabled: true } },
    });
  });

  test("shows HealthKit source and starts it when toggled on", async () => {
    render(<AmbientSourcesPanel />);

    expect(screen.getByText("HealthKit")).toBeTruthy();
    expect(screen.getByText(/steps, sleep, heart rate/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "OFF" }));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith({
        ambientSources: { health: { enabled: true } },
      });
      expect(runtimeMock.reconcileEnabledSources).toHaveBeenCalledWith(["health"]);
    });
  });
});
