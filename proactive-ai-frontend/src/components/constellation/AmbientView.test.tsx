import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import AmbientView from "./AmbientView";
import { getPersistedAmbientEnabled } from "@/services/ambient/enabled-state";
import { ALL_SOURCE_KEYS } from "@/services/ambient/keys";
import type { UserDevice } from "@/lib/api";

type MockElementProps = { children?: ReactNode } & Record<string, unknown>;

const {
  patchMock,
  runtimeMock,
  startAmbientUploadMock,
  stopAmbientUploadMock,
  liveDismissMock,
  userDevicesMock,
  ambientTimelineMock,
} = vi.hoisted(() => ({
  patchMock: vi.fn(),
  runtimeMock: {
    status: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    setUploadsLocked: vi.fn(),
  },
  startAmbientUploadMock: vi.fn(),
  stopAmbientUploadMock: vi.fn(),
  liveDismissMock: vi.fn(),
  userDevicesMock: {
    devices: [] as UserDevice[],
    loading: false,
    error: null as string | null,
    refresh: vi.fn(),
    registerDevice: vi.fn(),
    revoke: vi.fn(),
  },
  ambientTimelineMock: {
    events: [] as unknown[],
    error: null,
    storeStatus: null,
    narrativeSummary: null,
    groups: [] as unknown[],
    pendingTranscriptCount: 0,
    pendingTranscriptWindows: [] as unknown[],
    latestRawEvents: [] as unknown[],
    dismiss: vi.fn(),
  },
}));

vi.mock("framer-motion", async () => {
  const React = await import("react");
  const makeMotionElement = (tag: string) => ({ children, ...props }: MockElementProps) => {
    const {
      animate,
      exit,
      initial,
      layout,
      transition,
      whileHover,
      whileTap,
      ...rest
    } = props;
    void animate;
    void exit;
    void initial;
    void layout;
    void transition;
    void whileHover;
    void whileTap;
    return React.createElement(tag, rest, children);
  };
  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
    motion: {
      button: makeMotionElement("button"),
      div: makeMotionElement("div"),
      p: makeMotionElement("p"),
      span: makeMotionElement("span"),
    },
  };
});
vi.mock("@/lib/platform", () => ({ isNative: true }));
vi.mock("@/hooks/useUserSettings", () => ({
  useUserSettings: () => ({
    settings: { ambientSources: {}, generationLanguage: "zh-Hans" },
    patch: patchMock,
  }),
}));
vi.mock("@/hooks/useUserDevices", () => ({
  useUserDevices: () => userDevicesMock,
}));
vi.mock("@/hooks/useAmbientLiveSession", () => ({
  useAmbientLiveSession: () => ({
    session: {
      icon: () => <span data-testid="live-icon" />,
      kind: "Voice session",
      title: "Captured transcript",
      location: "On device",
      device: "Microphone",
      startedAt: "10:00",
      signals: ["1 transcript"],
      assists: [{ time: "+00:00", kind: "context", text: "Captured transcript" }],
    },
    previewVisibleCount: 1,
    isRealSession: true,
    dismiss: liveDismissMock,
  }),
}));
vi.mock("@/hooks/useAmbientTimeline", () => ({
  useAmbientTimeline: () => ambientTimelineMock,
}));
vi.mock("@/services/ambient", () => ({
  getAmbientRuntime: () => runtimeMock,
}));
vi.mock("@/services/ambient/lifecycle", () => ({
  startAmbientUpload: startAmbientUploadMock,
  stopAmbientUpload: stopAmbientUploadMock,
}));

function makeStatus() {
  return {
    sources: ALL_SOURCE_KEYS.map((key) => ({
      key,
      label: key,
      enabled: false,
      lastEvent: null,
      ingestedCount: 0,
      lastError: null,
    })),
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

describe("AmbientView ambient toggle", () => {
  afterEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    userDevicesMock.devices = [];
    userDevicesMock.loading = false;
    userDevicesMock.error = null;
    ambientTimelineMock.events = [];
    ambientTimelineMock.latestRawEvents = [];
    ambientTimelineMock.pendingTranscriptWindows = [];
    ambientTimelineMock.pendingTranscriptCount = 0;
    ambientTimelineMock.dismiss.mockClear();
  });

  test("renders device count from the user device registry", () => {
    runtimeMock.status.mockReturnValue(makeStatus());
    userDevicesMock.devices = [
      {
        device_id: "ios-1",
        platform: "ios",
        display_name: "Smile iPhone",
        app_version: null,
        model: "iPhone 15 Pro Max",
        registered_at: "2026-05-17T00:00:00Z",
        last_seen_at: "2026-05-17T01:00:00Z",
        status: "active",
        metadata: {},
      },
      {
        device_id: "watch-1",
        platform: "wearable",
        display_name: "Apple Watch",
        app_version: null,
        model: "Apple Watch Ultra",
        registered_at: "2026-05-17T00:00:00Z",
        last_seen_at: "2026-05-17T01:00:00Z",
        status: "active",
        metadata: {},
      },
      {
        device_id: "web-1",
        platform: "web",
        display_name: "Browser",
        app_version: null,
        model: null,
        registered_at: "2026-05-17T00:00:00Z",
        last_seen_at: "2026-05-17T01:00:00Z",
        status: "active",
        metadata: {},
      },
    ];

    render(<AmbientView />);

    expect(screen.getByText("2 devices")).toBeTruthy();
    expect(screen.queryByText("4 devices")).toBeNull();
  });

  test("persists manual enablement and starts all ambient sources", async () => {
    runtimeMock.status.mockReturnValue(makeStatus());
    patchMock.mockResolvedValue({
      ambientSources: Object.fromEntries(
        ALL_SOURCE_KEYS.map((key) => [key, { enabled: true }]),
      ),
    });

    render(<AmbientView />);
    fireEvent.click(screen.getByRole("button", { name: "Toggle ambient" }));

    await waitFor(() => {
      expect(getPersistedAmbientEnabled()).toBe(true);
      expect(startAmbientUploadMock).toHaveBeenCalledWith({
        enabledSources: ALL_SOURCE_KEYS,
        transcriptionLanguage: "zh-Hans",
      });
    });
  });
  test("renders dismissible ambient live session", async () => {
    runtimeMock.status.mockReturnValue(makeStatus());

    render(<AmbientView />);
    fireEvent.click(screen.getByRole("button", { name: "End session" }));

    await waitFor(() => {
      expect(liveDismissMock).toHaveBeenCalled();
    });
  });

  test("renders latest transcript raw text instead of placeholder timeline text", async () => {
    runtimeMock.status.mockReturnValue(makeStatus());
    ambientTimelineMock.latestRawEvents = [{
      id: "raw-transcript-1",
      sourceType: "transcript",
      eventType: "transcript.ready",
      occurredAt: "2026-05-18T08:07:00.000Z",
      compactText: "Transcript segment: 这是刚刚转录出来的真实文字。",
      sensitivity: "private",
      confidence: 0.75,
    }];

    render(<AmbientView />);

    expect(await screen.findByText("Voice transcript")).toBeTruthy();
    expect(await screen.findByText("这是刚刚转录出来的真实文字。")).toBeTruthy();
    expect(screen.queryByText(/^title$/)).toBeNull();
    expect(screen.queryByText(/^summary$/)).toBeNull();
  });

});
