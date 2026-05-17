import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { useAmbientTimeline } from "./useAmbientTimeline";

const { storeMock, pipelineMock } = vi.hoisted(() => ({
  storeMock: {
    init: vi.fn(),
    status: vi.fn(() => ({ mode: "sqlite", ready: true, lastError: null })),
    listTimelineEvents: vi.fn(),
    listCandidateWindows: vi.fn(),
    listRawEvents: vi.fn(),
    dismissTimelineEvent: vi.fn(),
  },
  pipelineMock: {
    regenerateDay: vi.fn(),
    processPendingWindows: vi.fn(),
  },
}));

vi.mock("@/lib/platform", () => ({ isNative: true }));
vi.mock("@/services/ambient/timeline", () => ({
  getAmbientTimelineStore: () => storeMock,
  getAmbientTimelinePipeline: () => pipelineMock,
  todayLocalDate: () => "2026-05-15",
  buildAmbientNarrativeSummary: () => null,
  groupAmbientTimelineEvents: () => [],
}));

function AmbientTimelineProbe({ children }: { children?: ReactNode }) {
  const timeline = useAmbientTimeline();
  return (
    <div>
      <span>{timeline.loading ? "loading" : "ready"}</span>
      {children}
    </div>
  );
}

describe("useAmbientTimeline", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("loads a snapshot before processing pending windows and does not replay the full day", async () => {
    storeMock.init.mockResolvedValue(undefined);
    storeMock.listTimelineEvents.mockResolvedValue([]);
    storeMock.listCandidateWindows.mockResolvedValue([]);
    storeMock.listRawEvents.mockResolvedValue([]);
    pipelineMock.processPendingWindows.mockResolvedValue([]);

    render(<AmbientTimelineProbe />);

    await waitFor(() => {
      expect(screen.getByText("ready")).toBeTruthy();
    });
    await waitFor(() => {
      expect(pipelineMock.processPendingWindows).toHaveBeenCalledWith("2026-05-15");
    });

    expect(pipelineMock.regenerateDay).not.toHaveBeenCalled();
    expect(storeMock.listTimelineEvents).toHaveBeenCalledWith("2026-05-15", {
      visibleOnly: true,
      limit: 100,
    });
  });
});
