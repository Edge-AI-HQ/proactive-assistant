import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { useAmbientTimeline } from "./useAmbientTimeline";

const { storeMock, runtimeMock, getExistingAmbientRuntimeMock } = vi.hoisted(() => ({
  storeMock: {
    init: vi.fn(),
    status: vi.fn(() => ({ mode: "sqlite", ready: true, lastError: null })),
    listTimelineEvents: vi.fn(),
    listCandidateWindows: vi.fn(),
    listRawEvents: vi.fn(),
    dismissTimelineEvent: vi.fn(),
  },
  runtimeMock: {
    refreshTimeline: vi.fn(),
  },
  getExistingAmbientRuntimeMock: vi.fn(),
}));

vi.mock("@/lib/platform", () => ({ isNative: true }));
vi.mock("@/services/ambient/timeline", () => ({
  getAmbientTimelineStore: () => storeMock,
  AMBIENT_TIMELINE_KIND: "ambient_timeline",
  AMBIENT_CANDIDATE_WINDOW_KIND: "ambient_candidate_window",
  todayLocalDate: () => "2026-05-15",
  buildAmbientNarrativeSummary: () => null,
  groupAmbientTimelineEvents: () => [],
}));
vi.mock("@/services/ambient", () => ({
  getExistingAmbientRuntime: getExistingAmbientRuntimeMock,
}));

function AmbientTimelineProbe({ children }: { children?: ReactNode }) {
  const timeline = useAmbientTimeline();
  return (
    <div>
      <span>{timeline.loading ? "loading" : "ready"}</span>
      {timeline.events.map((event) => (
        <article key={event.id}>
          <h2>{event.title}</h2>
          <p>{event.summary}</p>
        </article>
      ))}
      {timeline.latestRawEvents.map((event) => (
        <article key={event.id}>
          <h2>{event.compactText}</h2>
        </article>
      ))}
      {children}
    </div>
  );
}

describe("useAmbientTimeline", () => {
  beforeEach(() => {
    getExistingAmbientRuntimeMock.mockReturnValue(runtimeMock);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("loads a snapshot before processing pending windows and does not replay the full day", async () => {
    storeMock.init.mockResolvedValue(undefined);
    storeMock.listTimelineEvents.mockResolvedValue([]);
    storeMock.listCandidateWindows.mockResolvedValue([]);
    storeMock.listRawEvents.mockResolvedValue([]);
    runtimeMock.refreshTimeline.mockResolvedValue([]);

    render(<AmbientTimelineProbe />);

    await waitFor(() => {
      expect(screen.getByText("ready")).toBeTruthy();
    });
    await waitFor(() => {
      expect(runtimeMock.refreshTimeline).toHaveBeenCalledWith("2026-05-15");
    });
    expect(storeMock.listTimelineEvents).toHaveBeenCalledWith("2026-05-15", {
      visibleOnly: true,
      limit: 100,
    });
  });

  test("hides old LLM placeholder summary events while keeping raw transcript text", async () => {
    storeMock.init.mockResolvedValue(undefined);
    storeMock.listTimelineEvents.mockResolvedValue([{
      id: "evt-placeholder",
      occurredAt: "2026-05-15T10:00:00.000Z",
      generationSource: "llm_summary",
      generationMethod: "local_llm",
      sourceTypes: ["transcript"],
      title: "specific title from context",
      summary: "specific summary from context",
    }]);
    storeMock.listCandidateWindows.mockResolvedValue([]);
    storeMock.listRawEvents.mockImplementation(async ({ sourceType }: { sourceType: string }) =>
      sourceType === "transcript"
        ? [{
            id: "raw-transcript",
            sourceType: "transcript",
            compactText: "Transcript segment: 这是真实转录文字。",
            occurredAt: "2026-05-15T10:00:00.000Z",
          }]
        : [],
    );
    runtimeMock.refreshTimeline.mockResolvedValue([]);

    render(<AmbientTimelineProbe />);

    expect(await screen.findByText("ready")).toBeTruthy();
    expect(await screen.findByText("Transcript segment: 这是真实转录文字。")).toBeTruthy();
    expect(screen.queryByText("specific title from context")).toBeNull();
    expect(screen.queryByText("specific summary from context")).toBeNull();
  });

  test("does not return latest raw transcript when a pending window already represents it", async () => {
    storeMock.init.mockResolvedValue(undefined);
    storeMock.listTimelineEvents.mockResolvedValue([]);
    storeMock.listCandidateWindows.mockResolvedValue([{
      id: "win-transcript",
      rawRefs: [{ sourceType: "transcript", id: "raw-transcript" }],
    }]);
    storeMock.listRawEvents.mockImplementation(async ({ sourceType }: { sourceType: string }) =>
      sourceType === "transcript"
        ? [{
            id: "raw-transcript",
            sourceType: "transcript",
            compactText: "这段已经在 pending window 里。",
            occurredAt: "2026-05-15T10:00:00.000Z",
          }]
        : [],
    );
    runtimeMock.refreshTimeline.mockResolvedValue([]);

    render(<AmbientTimelineProbe />);

    expect(await screen.findByText("ready")).toBeTruthy();
    expect(screen.queryByText("这段已经在 pending window 里。")).toBeNull();
  });

  test("does not create or run timeline generation when native ambient runtime is off", async () => {
    getExistingAmbientRuntimeMock.mockReturnValue(null);
    storeMock.init.mockResolvedValue(undefined);
    storeMock.listTimelineEvents.mockResolvedValue([]);
    storeMock.listCandidateWindows.mockResolvedValue([]);
    storeMock.listRawEvents.mockResolvedValue([]);

    render(<AmbientTimelineProbe />);

    expect(await screen.findByText("ready")).toBeTruthy();
    expect(runtimeMock.refreshTimeline).not.toHaveBeenCalled();
  });
});
