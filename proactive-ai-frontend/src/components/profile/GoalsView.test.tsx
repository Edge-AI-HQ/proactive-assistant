import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import GoalsView from "@/components/profile/GoalsView";
import type { ComposioState } from "@/hooks/useComposio";
import type { ReactNode } from "react";

type MockElementProps = { children?: ReactNode } & Record<string, unknown>;

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
      drag,
      dragConstraints,
      dragDirectionLock,
      dragElastic,
      dragControls,
      dragListener,
      onDrag,
      onDragStart,
      onDragEnd,
      custom,
      variants,
      style,
      ...domProps
    } = props;
    void animate;
    void exit;
    void initial;
    void layout;
    void transition;
    void whileHover;
    void whileTap;
    void drag;
    void dragConstraints;
    void dragDirectionLock;
    void dragElastic;
    void dragControls;
    void dragListener;
    void onDrag;
    void onDragStart;
    void onDragEnd;
    void custom;
    void variants;
    void style;
    return React.createElement(tag, domProps, children);
  };

  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => React.createElement(React.Fragment, null, children),
    motion: new Proxy({}, {
      get: (_target, tag) => makeMotionElement(String(tag)),
    }),
    useMotionValue: (value: number) => {
      let current = value;
      return { get: () => current, set: (v: number) => { current = v; } };
    },
    animate: () => ({ stop: () => {} }),
  };
});

vi.mock("@/components/ui/drawer", async () => {
  const React = await import("react");
  const Div = ({ children, ...props }: MockElementProps) => {
    const { open, onOpenChange, overlayClassName, ...domProps } = props;
    void open;
    void onOpenChange;
    void overlayClassName;
    return React.createElement("div", domProps, children);
  };

  return {
    Drawer: Div,
    DrawerContent: Div,
    DrawerDescription: Div,
    DrawerHeader: Div,
    DrawerTitle: Div,
  };
});

vi.mock("@/lib/api", () => ({
  fetchMemories: vi.fn(),
  fetchProfileSnapshot: vi.fn(),
  fetchRawDeviceApps: vi.fn(),
  fetchRawDeviceContacts: vi.fn(),
  fetchRawDeviceHealth: vi.fn(),
  fetchRawGcal: vi.fn(),
  fetchRawGmail: vi.fn(),
  fetchRawTable: vi.fn(),
  fetchSignals: vi.fn(),
  listUserDevices: vi.fn(),
}));

import * as api from "@/lib/api";

const mockFetchMemories = vi.mocked(api.fetchMemories);
const mockFetchProfileSnapshot = vi.mocked(api.fetchProfileSnapshot);
const mockFetchRawDeviceApps = vi.mocked(api.fetchRawDeviceApps);
const mockFetchRawDeviceContacts = vi.mocked(api.fetchRawDeviceContacts);
const mockFetchRawDeviceHealth = vi.mocked(api.fetchRawDeviceHealth);
const mockFetchRawGcal = vi.mocked(api.fetchRawGcal);
const mockFetchRawGmail = vi.mocked(api.fetchRawGmail);
const mockFetchRawTable = vi.mocked(api.fetchRawTable);
const mockFetchSignals = vi.mocked(api.fetchSignals);
const mockListUserDevices = vi.mocked(api.listUserDevices);

function makeComposioState(connections: ComposioState["connections"] = [
  {
    toolkit: "slack",
    status: "ACTIVE",
    connectedAccountId: "slack-account",
    label: null,
    userInfo: null,
  },
]): ComposioState {
  return {
    keyStatus: { configured: true },
    connections,
    statusLoading: false,
    loadingConns: false,
    loadStatus: vi.fn(async () => undefined),
    loadConnections: vi.fn(async () => []),
    loadCatalog: vi.fn(async () => ({ ok: true, page: { items: [], nextCursor: null, totalCount: null } })),
    connectToolkit: vi.fn(async () => ({ ok: true })),
    disconnectAccount: vi.fn(async () => ({ ok: true })),
    waitForToolkit: vi.fn(async () => ({ connected: true })),
    cancelWait: vi.fn(),
    isToolkitConnected: vi.fn((toolkit: string) => toolkit === "slack"),
    reconnectAccount: vi.fn(async () => ({ ok: true })),
    createCustomMcpConnector: vi.fn(async () => ({ ok: true })),
    updateCustomMcpConnector: vi.fn(async () => ({ ok: true })),
    deleteCustomMcpConnector: vi.fn(async () => ({ ok: true })),
  };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("GoalsView", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchProfileSnapshot.mockResolvedValue({
      profile: null,
      goals: [],
      memories: [],
      signals: [],
      interests: [],
    });
    mockFetchMemories.mockResolvedValue({ ok: true, memories: [], total: 0 });
    mockFetchSignals.mockResolvedValue({ ok: true, signals: [], total: 0, next_cursor: null, has_more: false });
    mockFetchRawGmail.mockResolvedValue({ ok: true, messages: [], total: 0 });
    mockFetchRawGcal.mockResolvedValue({ ok: true, events: [], total: 0 });
    mockListUserDevices.mockResolvedValue([]);
    mockFetchRawDeviceApps.mockResolvedValue({ ok: true, apps: [], total: 0 });
    mockFetchRawDeviceContacts.mockResolvedValue({ ok: true, contacts: [], total: 0 });
    mockFetchRawDeviceHealth.mockResolvedValue({ ok: true, observations: [], total: 0 });
    mockFetchRawTable.mockResolvedValue({ ok: true, rows: [], total: 0, table: "slack_messages" });
  });

  test("fetches generic raw counts even when connector state is inactive", async () => {
    render(<GoalsView composio={makeComposioState([])} />);

    await waitFor(() => expect(mockFetchProfileSnapshot).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockFetchRawDeviceHealth).toHaveBeenCalledTimes(1));
    await flushEffects();

    await waitFor(() => {
      expect(mockFetchRawTable).toHaveBeenCalledWith(
        "slack_messages",
        expect.objectContaining({ until: expect.any(String), limit: 1 }),
        expect.any(AbortSignal),
      );
      expect(mockFetchRawTable).toHaveBeenCalledWith(
        "gdocs_documents",
        expect.objectContaining({ until: expect.any(String), limit: 1 }),
        expect.any(AbortSignal),
      );
      expect(mockFetchRawTable).toHaveBeenCalledWith(
        "gsheets_spreadsheets",
        expect.objectContaining({ until: expect.any(String), limit: 1 }),
        expect.any(AbortSignal),
      );
    });
  });

  test("uses identity text when profile summary is empty", async () => {
    mockFetchProfileSnapshot.mockResolvedValueOnce({
      profile: {
        id: "profile-1",
        user_id: "local-user",
        display_name: "Smile",
        locale: "zh-CN",
        timezone: "Asia/Shanghai",
        summary: null,
        facts: { identify: "Builds personal AI products and tests mobile flows." },
        preferences: {},
        constraints: {},
        metadata: {},
      },
      goals: [],
      memories: [],
      signals: [],
      interests: [],
    });

    render(<GoalsView composio={makeComposioState([])} />);

    await waitFor(() => {
      expect(screen.getByText("Builds personal AI products and tests mobile flows.")).toBeTruthy();
    });
    expect(screen.queryByText(/No summary stored yet/i)).toBeNull();
  });

  test("does not use unrelated profile fields as summary text", async () => {
    mockFetchProfileSnapshot.mockResolvedValueOnce({
      profile: {
        id: "profile-1",
        user_id: "local-user",
        display_name: "Smile",
        locale: "zh-CN",
        timezone: "Asia/Shanghai",
        summary: null,
        facts: { role: "founder" },
        preferences: { communication: "direct" },
        constraints: {},
        metadata: {},
      },
      goals: [],
      memories: [],
      signals: [],
      interests: [],
    });

    render(<GoalsView composio={makeComposioState([])} />);

    await waitFor(() => {
      expect(screen.getByText(/No summary stored yet/i)).toBeTruthy();
    });
    expect(screen.queryByText("founder")).toBeNull();
    expect(screen.queryByText("direct")).toBeNull();
  });

});
