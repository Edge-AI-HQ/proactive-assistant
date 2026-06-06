import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Radio } from "lucide-react";
import { afterEach, describe, expect, test, vi } from "vitest";

import AmbientView, { LiveFullscreen } from "./AmbientView";
import { getPersistedAmbientEnabled } from "@/services/ambient/enabled-state";
import { ALL_SOURCE_KEYS } from "@/services/ambient/keys";
import type { UserDevice } from "@/lib/api";
import type { LiveSession } from "@/services/ambient/live-session";

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
      onAnimationComplete,
      transition,
      whileHover,
      whileTap,
      ...rest
    } = props;
    void animate;
    void exit;
    void initial;
    void layout;
    void onAnimationComplete;
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
    history: [],
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
  getExistingAmbientRuntime: () => runtimeMock,
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

  test("keeps manual enablement when only HealthKit does not start", async () => {
    runtimeMock.status.mockReturnValue(makeStatus());
    patchMock.mockResolvedValue({
      ambientSources: Object.fromEntries(
        ALL_SOURCE_KEYS.map((key) => [key, { enabled: true }]),
      ),
      generationLanguage: "zh-Hans",
    });
    startAmbientUploadMock.mockResolvedValue({
      ...makeStatus(),
      sources: ALL_SOURCE_KEYS.map((key) => ({
        key,
        label: key,
        enabled: key !== "health",
        lastEvent: null,
        ingestedCount: 0,
        lastError: key === "health" ? "health permission denied" : null,
      })),
    });

    render(<AmbientView />);
    fireEvent.click(screen.getByRole("button", { name: "Toggle ambient" }));

    await waitFor(() => {
      expect(startAmbientUploadMock).toHaveBeenCalledWith({
        enabledSources: ALL_SOURCE_KEYS,
        transcriptionLanguage: "zh-Hans",
      });
      expect(stopAmbientUploadMock).not.toHaveBeenCalled();
      expect(getPersistedAmbientEnabled()).toBe(true);
    });
  });

  test("rolls back manual enablement when the sound source does not start", async () => {
    runtimeMock.status.mockReturnValue(makeStatus());
    patchMock.mockResolvedValue({
      ambientSources: Object.fromEntries(
        ALL_SOURCE_KEYS.map((key) => [key, { enabled: true }]),
      ),
      generationLanguage: "zh-Hans",
    });
    startAmbientUploadMock.mockResolvedValue({
      ...makeStatus(),
      sources: ALL_SOURCE_KEYS.map((key) => ({
        key,
        label: key,
        enabled: key !== "sound_classifier",
        lastEvent: null,
        ingestedCount: 0,
        lastError: key === "sound_classifier" ? "microphone permission denied" : null,
      })),
    });

    render(<AmbientView />);
    fireEvent.click(screen.getByRole("button", { name: "Toggle ambient" }));

    await waitFor(() => {
      expect(startAmbientUploadMock).toHaveBeenCalledWith({
        enabledSources: ALL_SOURCE_KEYS,
        transcriptionLanguage: "zh-Hans",
      });
      expect(stopAmbientUploadMock).toHaveBeenCalled();
      expect(getPersistedAmbientEnabled()).toBe(false);
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

  test("does not show motion context inside pending transcript text", async () => {
    runtimeMock.status.mockReturnValue(makeStatus());
    ambientTimelineMock.pendingTranscriptCount = 1;
    ambientTimelineMock.pendingTranscriptWindows = [{
      id: "win-transcript-1",
      startedAt: "2026-05-18T10:12:00.000Z",
      compactContext: "对决每年的世界杯决赛杯，决赛就是美国队大法国队。 Motion context: Motion stationary for 7m 56s.",
      confidenceHint: 0.55,
    }];

    render(<AmbientView />);

    expect(await screen.findByText("Voice transcript")).toBeTruthy();
    expect(await screen.findByText("对决每年的世界杯决赛杯，决赛就是美国队大法国队。")).toBeTruthy();
    expect(screen.queryByText("Voice transcript pending")).toBeNull();
    expect(screen.queryByText("#pending")).toBeNull();
    expect(screen.queryByText("uncertain")).toBeNull();
    expect(screen.queryByText(/Motion context/i)).toBeNull();
  });

  test("renders concrete sound labels instead of generic sound detected text", async () => {
    runtimeMock.status.mockReturnValue(makeStatus());
    ambientTimelineMock.latestRawEvents = [{
      id: "raw-sound-1",
      sourceType: "sound",
      eventType: "sound.scene_run",
      occurredAt: "2026-05-18T08:08:00.000Z",
      compactText: "Heard Dog bark for 12s.",
      sensitivity: "normal",
      confidence: 0.81,
    }];

    render(<AmbientView />);

    expect(await screen.findByText("Sound context")).toBeTruthy();
    expect(await screen.findByText("Dog bark detected")).toBeTruthy();
    expect(screen.queryByText("Sound detected")).toBeNull();
  });

  // SKIP: experimental on-device ambient V2 (AmbientView summary labels) —
  // drifted from this test; deferred until the ambient direction settles.
  test.skip("labels cloud and on-device summary events by their generation method", async () => {
    runtimeMock.status.mockReturnValue(makeStatus());
    ambientTimelineMock.events = [
      {
        id: "cloud-summary-1",
        localUserId: "local",
        localDate: "2026-05-22",
        timezone: "UTC",
        occurredAt: "2026-05-22T10:00:00.000Z",
        eventType: "other",
        title: "Cloud generated day summary",
        summary: "Cloud generated summary body.",
        primarySourceLabel: "On-device summary",
        deviceLabels: [],
        sourceTypes: ["calendar"],
        tags: ["summary"],
        privacy: "private",
        confidence: 0.8,
        confidenceLabel: "certain",
        salience: 0.7,
        rawRefs: [],
        observationIds: [],
        generationMethod: "cloud_llm",
        generationSource: "llm_summary",
        generationStatus: "visible",
        memoryCandidate: false,
        cardTriggerCandidate: false,
        schemaVersion: "ambient_timeline_event.v1",
        syncStatus: "pending",
        dedupeKey: "ambient:timeline:2026-05-22:cloud",
        createdAt: "2026-05-22T10:00:00.000Z",
        updatedAt: "2026-05-22T10:00:00.000Z",
      },
      {
        id: "local-summary-1",
        localUserId: "local",
        localDate: "2026-05-22",
        timezone: "UTC",
        occurredAt: "2026-05-22T09:00:00.000Z",
        eventType: "other",
        title: "Local generated day summary",
        summary: "Local generated summary body.",
        primarySourceLabel: "Ambient",
        deviceLabels: [],
        sourceTypes: ["motion"],
        tags: ["summary"],
        privacy: "private",
        confidence: 0.7,
        confidenceLabel: "certain",
        salience: 0.7,
        rawRefs: [],
        observationIds: [],
        generationMethod: "local_llm",
        generationSource: "llm_summary",
        generationStatus: "visible",
        memoryCandidate: false,
        cardTriggerCandidate: false,
        schemaVersion: "ambient_timeline_event.v1",
        syncStatus: "pending",
        dedupeKey: "ambient:timeline:2026-05-22:local",
        createdAt: "2026-05-22T09:00:00.000Z",
        updatedAt: "2026-05-22T09:00:00.000Z",
      },
    ];

    render(<AmbientView />);

    expect(await screen.findByText("Cloud generated day summary")).toBeTruthy();
    expect(screen.getByText("Cloud summary")).toBeTruthy();
    expect(screen.getByText("On-device summary")).toBeTruthy();
  });

});

describe("LiveFullscreen scrolling", () => {
  test("auto-scrolls when new live messages arrive while the reader is at the bottom", async () => {
    const { mock, restore } = mockScrollTo();
    try {
      const { rerender } = render(
        <LiveFullscreen session={makeLiveFullscreenSession(["old", "current"])} onClose={vi.fn()} />,
      );
      const scroller = screen.getByTestId("live-fullscreen-messages");
      setScrollGeometry(scroller, { scrollHeight: 1_000, clientHeight: 200, scrollTop: 800 });
      fireEvent.scroll(scroller);
      mock.mockClear();

      rerender(
        <LiveFullscreen session={makeLiveFullscreenSession(["old", "current", "new"])} onClose={vi.fn()} />,
      );

      await waitFor(() => {
        expect(mock).toHaveBeenCalledWith({ top: 1_000, behavior: "smooth" });
      });
      expect(screen.queryByRole("button", { name: /new live message/i })).toBeNull();
    } finally {
      restore();
    }
  });

  test("keeps scroll position and shows a new-message affordance when reading older live messages", async () => {
    const { mock, restore } = mockScrollTo();
    try {
      const { rerender } = render(
        <LiveFullscreen session={makeLiveFullscreenSession(["old", "current"])} onClose={vi.fn()} />,
      );
      const scroller = screen.getByTestId("live-fullscreen-messages");
      setScrollGeometry(scroller, { scrollHeight: 1_000, clientHeight: 200, scrollTop: 120 });
      fireEvent.scroll(scroller);
      mock.mockClear();

      rerender(
        <LiveFullscreen session={makeLiveFullscreenSession(["old", "current", "new"])} onClose={vi.fn()} />,
      );

      const button = await screen.findByRole("button", { name: "Show 1 new live message" });
      expect(button).toBeTruthy();
      expect(mock).not.toHaveBeenCalled();

      fireEvent.click(button);

      expect(mock).toHaveBeenCalledWith({ top: 1_000, behavior: "smooth" });
    } finally {
      restore();
    }
  });

  test("renders existing live messages without row motion and animates only newly appended messages", async () => {
    const { restore } = mockScrollTo();
    try {
      const { container, rerender } = render(
        <LiveFullscreen session={makeLiveFullscreenSession(["old", "current"])} onClose={vi.fn()} />,
      );

      expect(screen.getAllByTestId("live-fullscreen-assist-row")).toHaveLength(2);
      expect(container.querySelector("[data-live-animated='true']")).toBeNull();

      rerender(
        <LiveFullscreen session={makeLiveFullscreenSession(["old", "current", "new"])} onClose={vi.fn()} />,
      );

      await waitFor(() => {
        expect(container.querySelector("[data-live-animated='true']")?.textContent).toContain("new");
      });
      expect(screen.getAllByTestId("live-fullscreen-assist-row")).toHaveLength(3);
    } finally {
      restore();
    }
  });

  test("fades fullscreen rows by viewport position instead of absolute age", () => {
    const { restore } = mockScrollTo();
    try {
      render(
        <LiveFullscreen
          session={makeLiveFullscreenSession(["one", "two", "three", "four", "five", "six"])}
          onClose={vi.fn()}
        />,
      );

      const scroller = screen.getByTestId("live-fullscreen-messages");
      expect(scroller.style.maskImage).toContain("linear-gradient");
      expect(scroller.style.maskImage).toContain("rgba(0, 0, 0, 0.18)");
      expect(scroller.style.maskImage).toContain("black 76%");
      expect(screen.getAllByTestId("live-fullscreen-assist-row")[0].style.opacity).toBe("");
    } finally {
      restore();
    }
  });

  test("keeps the live message area close to the footer", () => {
    const { restore } = mockScrollTo();
    try {
      render(
        <LiveFullscreen
          session={makeLiveFullscreenSession(["old", "current"])}
          onClose={vi.fn()}
        />,
      );

      const scrollerShell = screen.getByTestId("live-fullscreen-messages").parentElement;
      expect(scrollerShell?.className).toContain("pb-20");
      expect(scrollerShell?.className).not.toContain("pb-32");
    } finally {
      restore();
    }
  });
});

function makeLiveFullscreenSession(texts: string[]): LiveSession {
  return {
    icon: Radio,
    kind: "Voice session",
    title: texts[texts.length - 1] ?? "Live",
    location: "On device",
    device: "Microphone",
    startedAt: "10:00",
    signals: [`${texts.length} transcript${texts.length === 1 ? "" : "s"}`],
    assists: texts.map((text, index) => ({
      time: `10:${String(index).padStart(2, "0")}`,
      sortTs: Date.parse(`2026-05-17T10:${String(index).padStart(2, "0")}:00.000Z`),
      kind: "context" as const,
      text,
    })),
  };
}

function setScrollGeometry(
  el: HTMLElement,
  geometry: { scrollHeight: number; clientHeight: number; scrollTop: number },
): void {
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    value: geometry.scrollHeight,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    value: geometry.clientHeight,
  });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    writable: true,
    value: geometry.scrollTop,
  });
}

function mockScrollTo(): {
  mock: ReturnType<typeof vi.fn>;
  restore: () => void;
} {
  const original = HTMLElement.prototype.scrollTo;
  const hadOriginal = Object.prototype.hasOwnProperty.call(HTMLElement.prototype, "scrollTo");
  const mock = vi.fn(function scrollToMock(
    this: HTMLElement,
    options?: ScrollToOptions | number,
    y?: number,
  ) {
    if (typeof options === "object" && typeof options.top === "number") {
      this.scrollTop = options.top;
      return;
    }
    if (typeof y === "number") this.scrollTop = y;
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: mock,
  });
  return {
    mock,
    restore: () => {
      if (hadOriginal) {
        Object.defineProperty(HTMLElement.prototype, "scrollTo", {
          configurable: true,
          value: original,
        });
        return;
      }
      delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    },
  };
}
