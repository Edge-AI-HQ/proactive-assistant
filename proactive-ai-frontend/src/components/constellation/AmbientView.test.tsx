import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import AmbientView from "./AmbientView";
import { getPersistedAmbientEnabled } from "@/services/ambient/enabled-state";
import { ALL_SOURCE_KEYS } from "@/services/ambient/keys";

type MockElementProps = { children?: ReactNode } & Record<string, unknown>;

const {
  patchMock,
  runtimeMock,
  startAmbientUploadMock,
  stopAmbientUploadMock,
} = vi.hoisted(() => ({
  patchMock: vi.fn(),
  runtimeMock: {
    status: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    setUploadsLocked: vi.fn(),
  },
  startAmbientUploadMock: vi.fn(),
  stopAmbientUploadMock: vi.fn(),
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
    settings: { ambientSources: {} },
    patch: patchMock,
  }),
}));
vi.mock("@/hooks/useAmbientTimeline", () => ({
  useAmbientTimeline: () => ({
    events: [],
    error: null,
    storeStatus: null,
    narrativeSummary: null,
    groups: [],
    pendingTranscriptCount: 0,
    dismiss: vi.fn(),
  }),
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
      });
    });
  });
});
