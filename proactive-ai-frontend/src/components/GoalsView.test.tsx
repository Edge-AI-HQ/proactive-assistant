import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import GoalsView from "./GoalsView";
import type { ComposioState } from "@/hooks/useComposio";
import type { PersonalSignal } from "@/lib/api";
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

function getWorkbenchPanelButton(label: string): HTMLElement {
  const pattern = new RegExp(`^${label}(?:Empty|\\d+)$`, "i");
  const button = screen.getAllByRole("button").find((el) => (
    pattern.test((el.textContent ?? "").replace(/\s+/g, "").trim())
  ));
  if (!button) throw new Error(`${label} workbench tab not found`);
  return button;
}

async function openWorkbenchPanel(label: string): Promise<void> {
  await waitFor(() => {
    expect(getWorkbenchPanelButton(label)).toBeTruthy();
  });
  await act(async () => {
    fireEvent.click(getWorkbenchPanelButton(label));
    await Promise.resolve();
  });
}

async function openWorkbenchRawPanel(): Promise<void> {
  await openWorkbenchPanel("Raw");
}

function makeSignal(overrides: Partial<PersonalSignal> & Pick<PersonalSignal, "id" | "title" | "occurred_at">): PersonalSignal {
  return {
    kind: "device.activity",
    summary: "stationary",
    payload: {},
    source: "device",
    device_id: "iphone-1",
    subject: null,
    salience: 0.5,
    confidence: 0.8,
    status: "open",
    dedupe_key: overrides.id,
    available_at: overrides.occurred_at,
    expires_at: null,
    ingested_at: overrides.occurred_at,
    consumed_at: null,
    consumed_by_run_id: null,
    source_raw_table: null,
    source_raw_ids: [],
    referenced_by_runs: [],
    ...overrides,
  };
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
    });
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

  test("includes active generic connector raw counts in the profile raw total", async () => {
    mockFetchRawGmail.mockResolvedValueOnce({ ok: true, messages: [], total: 200 });
    mockFetchRawGcal.mockResolvedValueOnce({ ok: true, events: [], total: 100 });
    mockFetchRawTable.mockImplementation(async (table) => ({
      ok: true,
      rows: [],
      total: table === "slack_messages" ? 17 : 0,
      table: String(table),
    }));

    render(<GoalsView composio={makeComposioState()} />);

    await waitFor(() => {
      expect(mockFetchRawTable).toHaveBeenCalledWith(
        "slack_messages",
        expect.objectContaining({ until: expect.any(String), limit: 1 }),
        expect.any(AbortSignal),
      );
    });
    await waitFor(() => {
      expect(screen.getAllByText("317").length).toBeGreaterThan(0);
    });
  });

  test("hides signals dated after now", async () => {
    mockFetchSignals.mockResolvedValueOnce({
      ok: true,
      signals: [
        makeSignal({
          id: "future-signal",
          title: "Future Motion",
          occurred_at: "2999-01-01T00:00:00Z",
        }),
        makeSignal({
          id: "past-signal",
          title: "Past Motion",
          occurred_at: "2000-01-01T00:00:00Z",
        }),
      ],
      total: 2,
      next_cursor: null,
      has_more: false,
    });

    render(<GoalsView composio={makeComposioState([])} />);

    await openWorkbenchPanel("Signals");

    await waitFor(() => {
      expect(screen.getByText("Past Motion")).toBeTruthy();
    });
    expect(screen.queryByText("Future Motion")).toBeNull();
    expect(mockFetchSignals).toHaveBeenCalledWith(
      expect.objectContaining({ before: expect.any(String), limit: 12, pruneExpired: true }),
      expect.any(AbortSignal),
    );
  });

  test("paginates signals by fetched rows when future rows are hidden", async () => {
    mockFetchSignals
      .mockResolvedValueOnce({
        ok: true,
        signals: [
          makeSignal({
            id: "future-signal",
            title: "Future Motion",
            occurred_at: "2999-01-01T00:00:00Z",
          }),
          makeSignal({
            id: "past-signal",
            title: "Past Motion",
            occurred_at: "2000-01-01T00:00:00Z",
          }),
        ],
        total: 3,
        next_cursor: null,
        has_more: true,
      })
      .mockResolvedValueOnce({
        ok: true,
        signals: [
          makeSignal({
            id: "older-signal",
            title: "Older Motion",
            occurred_at: "1999-01-01T00:00:00Z",
          }),
        ],
        total: 3,
        next_cursor: null,
        has_more: false,
      });

    render(<GoalsView composio={makeComposioState([])} />);

    await openWorkbenchPanel("Signals");

    await waitFor(() => {
      expect(screen.getByText("Past Motion")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Load more signals/i }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText("Older Motion")).toBeTruthy();
    });
    expect(mockFetchSignals).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 2, before: expect.any(String), limit: 12 }),
    );
  });

  test("uses all device snapshot rows for the raw headline count", async () => {
    mockListUserDevices.mockResolvedValueOnce([
      {
        device_id: "iphone-1",
        platform: "ios",
        display_name: "Smile iPhone",
        app_version: null,
        model: null,
        status: "active",
        registered_at: "2026-05-01T00:00:00Z",
        last_seen_at: null,
        metadata: {},
      },
    ]);
    mockFetchRawGmail.mockResolvedValueOnce({ ok: true, messages: [], total: 267 });
    mockFetchRawGcal.mockResolvedValueOnce({ ok: true, events: [], total: 107 });
    mockFetchRawDeviceHealth.mockImplementation(async (filter) => ({
      ok: true,
      observations: [],
      total: filter?.deviceId ? 195 : 195,
    }));
    mockFetchRawDeviceApps.mockResolvedValue({ ok: true, apps: [], total: 0 });
    mockFetchRawDeviceContacts.mockImplementation(async (filter) => ({
      ok: true,
      contacts: [],
      total: filter?.latestSnapshotOnly ? 1024 : 2048,
    }));
    mockFetchRawTable.mockResolvedValue({ ok: true, rows: [], total: 0, table: "slack_messages" });

    render(<GoalsView composio={makeComposioState([])} />);

    await waitFor(() => {
      expect(screen.getAllByText("2617").length).toBeGreaterThan(0);
    });
  });

  test("hides raw rows dated after today", async () => {
    mockFetchRawGcal.mockResolvedValueOnce({
      ok: true,
      events: [
        {
          id: "future-calendar-row",
          calendar_id: "primary",
          event_id: "future-calendar-row",
          title: "Future Calendar Event",
          description: null,
          location: null,
          start_at: "2999-07-30T00:00:00Z",
          end_at: "2999-07-30T01:00:00Z",
          attendees: [],
          status: "confirmed",
          occurred_at: "2999-07-30T00:00:00Z",
          ingested_at: "2999-01-01T00:00:00Z",
          dedupe_key: "future-calendar-row",
          reference_count: 0,
          last_referenced_at: null,
          referenced_by_runs: [],
        },
        {
          id: "past-calendar-row",
          calendar_id: "primary",
          event_id: "past-calendar-row",
          title: "Past Calendar Event",
          description: null,
          location: null,
          start_at: "2000-01-01T00:00:00Z",
          end_at: "2000-01-01T01:00:00Z",
          attendees: [],
          status: "confirmed",
          occurred_at: "2000-01-01T00:00:00Z",
          ingested_at: "2000-01-01T00:00:00Z",
          dedupe_key: "past-calendar-row",
          reference_count: 0,
          last_referenced_at: null,
          referenced_by_runs: [],
        },
      ],
      total: 2,
    });

    render(<GoalsView composio={makeComposioState([{
      toolkit: "googlecalendar",
      status: "ACTIVE",
      connectedAccountId: "gcal-account",
      label: null,
      userInfo: null,
    }])} />);

    await openWorkbenchRawPanel();

    await waitFor(() => {
      expect(screen.getByText("Past Calendar Event")).toBeTruthy();
    });
    expect(screen.queryByText("Future Calendar Event")).toBeNull();
    expect(mockFetchRawGcal).toHaveBeenCalledWith(
      expect.objectContaining({ until: expect.any(String), limit: 12 }),
      expect.any(AbortSignal),
    );
  });

  test("opens the freshest device raw source and keeps health rows visible by occurred time", async () => {
    mockListUserDevices.mockResolvedValueOnce([
      {
        device_id: "iphone-1",
        platform: "ios",
        display_name: "Smile iPhone",
        app_version: null,
        model: null,
        status: "active",
        registered_at: "2026-05-01T00:00:00Z",
        last_seen_at: null,
        metadata: {},
      },
    ]);
    mockFetchRawGmail.mockResolvedValueOnce({
      ok: true,
      messages: [{
        id: "old-gmail-row",
        message_id: "old-gmail-row",
        thread_id: null,
        from_addr: "old@example.com",
        to_addrs: [],
        cc_addrs: [],
        subject: "Old Gmail",
        snippet: null,
        body: null,
        label_ids: [],
        internal_date: null,
        occurred_at: "2000-01-01T00:00:00Z",
        ingested_at: "2000-01-01T00:00:00Z",
        dedupe_key: "old-gmail-row",
        reference_count: 0,
        last_referenced_at: null,
        referenced_by_runs: [],
      }],
      total: 267,
    });
    mockFetchRawDeviceApps.mockResolvedValue({ ok: true, apps: [], total: 0 });
    mockFetchRawDeviceContacts.mockResolvedValue({ ok: true, contacts: [], total: 0 });
    mockFetchRawDeviceHealth.mockResolvedValue({
      ok: true,
      observations: [{
        id: "health-today",
        device_id: "iphone-1",
        observation_type: "daily_summary",
        metric: "steps",
        value: 1249,
        unit: "count",
        start_at: "2026-05-17T00:00:00Z",
        end_at: "2999-05-18T00:00:00Z",
        local_date: "2026-05-17",
        source_app: "healthkit",
        payload: {},
        occurred_at: "2026-05-17T03:17:40.727Z",
        ingested_at: "2026-05-17T03:17:52.992Z",
        dedupe_key: "health-today",
        reference_count: 0,
        last_referenced_at: null,
        referenced_by_runs: [],
      }],
      total: 1,
    });

    render(<GoalsView composio={makeComposioState([{
      toolkit: "gmail",
      status: "ACTIVE",
      connectedAccountId: "gmail-account",
      label: null,
      userInfo: null,
    }])} />);

    await openWorkbenchRawPanel();

    await waitFor(() => {
      expect(screen.getByText("steps · daily_summary")).toBeTruthy();
    });
    expect(screen.getByText(/1249 count/)).toBeTruthy();
    expect(screen.getByDisplayValue("Smile iPhone (IOS) (1)")).toBeTruthy();
  });

  test("orders device raw rows by time across contacts and health", async () => {
    mockListUserDevices.mockResolvedValueOnce([
      {
        device_id: "iphone-1",
        platform: "ios",
        display_name: "Smile iPhone",
        app_version: null,
        model: null,
        status: "active",
        registered_at: "2026-05-01T00:00:00Z",
        last_seen_at: null,
        metadata: {},
      },
    ]);
    mockFetchRawDeviceApps.mockResolvedValue({ ok: true, apps: [], total: 0 });
    mockFetchRawDeviceContacts.mockResolvedValue({
      ok: true,
      contacts: [{
        id: "contact-1",
        snapshot_id: "contacts-snapshot",
        device_id: "iphone-1",
        display_name: "Old Contact",
        emails: [],
        phones: ["+155555501"],
        last_modified: null,
        occurred_at: "2000-05-10T03:49:57.636Z",
        ingested_at: "2000-05-10T03:49:58.000Z",
        dedupe_key: "contact-1",
        reference_count: 0,
        last_referenced_at: null,
        referenced_by_runs: [],
      }],
      total: 1,
    });
    mockFetchRawDeviceHealth.mockResolvedValue({
      ok: true,
      observations: [{
        id: "health-1",
        device_id: "iphone-1",
        observation_type: "daily_summary",
        metric: "steps",
        value: 8120,
        unit: "count",
        start_at: null,
        end_at: "2000-05-12T00:04:25.697Z",
        local_date: "2000-05-12",
        source_app: "healthkit",
        payload: {},
        occurred_at: "2000-05-12T00:04:25.697Z",
        ingested_at: "2000-05-12T00:04:26.000Z",
        dedupe_key: "health-1",
        reference_count: 0,
        last_referenced_at: null,
        referenced_by_runs: [],
      }],
      total: 1,
    });

    render(<GoalsView composio={makeComposioState([])} />);

    await openWorkbenchRawPanel();

    await waitFor(() => {
      expect(screen.getByText("steps · daily_summary")).toBeTruthy();
      expect(screen.getByText("Old Contact")).toBeTruthy();
    });
    const health = screen.getByText("steps · daily_summary");
    const contact = screen.getByText("Old Contact");
    expect(health.compareDocumentPosition(contact) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("fetches generic raw table after the raw panel opens", async () => {
    render(<GoalsView composio={makeComposioState()} />);

    await waitFor(() => expect(mockFetchProfileSnapshot).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockFetchRawDeviceHealth).toHaveBeenCalledTimes(1));
    await flushEffects();
    await waitFor(() => {
      expect(mockFetchRawTable).toHaveBeenCalledWith(
        "slack_messages",
        expect.objectContaining({ until: expect.any(String), limit: 1 }),
        expect.any(AbortSignal),
      );
    });

    await openWorkbenchRawPanel();

    await waitFor(() => {
      expect(mockFetchRawTable).toHaveBeenCalledWith(
        "slack_messages",
        expect.objectContaining({ until: expect.any(String), limit: 12 }),
      );
    });
  });
});
