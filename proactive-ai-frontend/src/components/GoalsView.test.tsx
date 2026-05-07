import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import GoalsView from "./GoalsView";
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
      ...domProps
    } = props;
    void animate;
    void exit;
    void initial;
    void layout;
    void transition;
    void whileHover;
    void whileTap;
    return React.createElement(tag, domProps, children);
  };

  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => React.createElement(React.Fragment, null, children),
    motion: new Proxy({}, {
      get: (_target, tag) => makeMotionElement(String(tag)),
    }),
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
    connectToolkit: vi.fn(async () => ({ ok: true })),
    disconnectAccount: vi.fn(async () => ({ ok: true })),
    waitForToolkit: vi.fn(async () => ({ connected: true })),
    cancelWait: vi.fn(),
    isToolkitConnected: vi.fn((toolkit: string) => toolkit === "slack"),
    reconnectAccount: vi.fn(async () => ({ ok: true })),
  };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("GoalsView", () => {
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

  test("does not fetch generic raw counts when no generic connector is active", async () => {
    render(<GoalsView composio={makeComposioState([])} />);

    await waitFor(() => expect(mockFetchProfileSnapshot).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockFetchRawDeviceHealth).toHaveBeenCalledTimes(1));
    await flushEffects();

    expect(mockFetchRawTable).not.toHaveBeenCalled();
  });

  test("counts populated top-level profile fields in the profile metric", async () => {
    mockFetchProfileSnapshot.mockResolvedValueOnce({
      profile: {
        id: "profile-1",
        user_id: "local-user",
        display_name: "Smile",
        locale: "zh-CN",
        timezone: "Asia/Shanghai",
        summary: "Builds proactive AI products.",
        facts: {},
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
      const hasProfileCount = screen.getAllByRole("button").some((button) => (
        /Profile\s*4\s*fields/i.test(button.textContent ?? "")
      ));
      expect(hasProfileCount).toBe(true);
    });
  });

  test("includes active generic connector raw counts in the profile raw total", async () => {
    mockFetchRawGmail.mockResolvedValueOnce({ ok: true, messages: [], total: 200 });
    mockFetchRawGcal.mockResolvedValueOnce({ ok: true, events: [], total: 100 });
    mockFetchRawTable.mockResolvedValueOnce({ ok: true, rows: [], total: 17, table: "slack_messages" });

    render(<GoalsView composio={makeComposioState()} />);

    await waitFor(() => {
      expect(mockFetchRawTable).toHaveBeenCalledWith("slack_messages", { limit: 1 }, expect.any(AbortSignal));
    });
    await waitFor(() => {
      expect(screen.getAllByText("317").length).toBeGreaterThan(0);
    });
  });

  test("fetches generic raw table after the raw panel opens", async () => {
    render(<GoalsView composio={makeComposioState()} />);

    await waitFor(() => expect(mockFetchProfileSnapshot).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockFetchRawDeviceHealth).toHaveBeenCalledTimes(1));
    await flushEffects();
    await waitFor(() => {
      expect(mockFetchRawTable).toHaveBeenCalledWith("slack_messages", { limit: 1 }, expect.any(AbortSignal));
    });

    const rawButtons = screen.getAllByRole("button", { name: /Raw/i });
    fireEvent.click(rawButtons[rawButtons.length - 1]);

    await waitFor(() => {
      expect(mockFetchRawTable).toHaveBeenCalledWith("slack_messages", { limit: 12 });
    });
  });
});
