import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import DataConnections from "./DataConnections";
import type { ComposioState } from "@/hooks/useComposio";
import type { InitTaskRow } from "@/hooks/useInitTask";

const { initTaskState } = vi.hoisted(() => ({
  initTaskState: {
    task: null as InitTaskRow | null,
    tasks: {} as Record<string, InitTaskRow | null>,
  },
}));

vi.mock("@/hooks/useInitTask", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/useInitTask")>("@/hooks/useInitTask");
  return {
    ...actual,
    useInitTask: (taskId: string | null) => {
      const hasTask = taskId ? Object.prototype.hasOwnProperty.call(initTaskState.tasks, taskId) : false;
      const task = taskId
        ? hasTask
          ? initTaskState.tasks[taskId]
          : taskId.startsWith("init.")
            ? initTaskState.task
            : null
        : null;
      return {
        task,
      loading: false,
        error: task ? null : "Task not found",
        terminal: Boolean(task && actual.isInitTaskFresh(task)),
      };
    },
  };
});

function makeComposioState(
  connections: ComposioState["connections"] = [
    {
      toolkit: "googlesuper",
      status: "ACTIVE",
      connectedAccountId: "google-workspace-account",
      label: "user@example.com",
      userInfo: null,
    },
  ],
): ComposioState {
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
    isToolkitConnected: vi.fn((toolkit: string) =>
      ["googlesuper", "gmail", "googlecalendar", "googledrive", "googledocs", "googlesheets"].includes(toolkit),
    ),
    reconnectAccount: vi.fn(async () => ({ ok: true })),
    createCustomMcpConnector: vi.fn(async () => ({
      ok: true,
      connector: {
        id: "custom_mcp_123",
        slug: "mcp_123",
        name: "News API",
        url: "https://mcp.pipedream.net/v2",
      },
      fetched: 3,
      rawInserted: 3,
      evolveTaskId: "evolve.mcp_123.custom_mcp_123",
    })),
    updateCustomMcpConnector: vi.fn(async () => ({
      ok: true,
      connector: {
        id: "custom_mcp_123",
        slug: "mcp_123",
        name: "News API Updated",
        url: "https://mcp.pipedream.net/v2",
      },
      fetched: 4,
      rawInserted: 1,
      evolveTaskId: "evolve.mcp_123.custom_mcp_123",
    })),
    deleteCustomMcpConnector: vi.fn(async () => ({ ok: true })),
  };
}

describe("DataConnections", () => {
  beforeEach(() => {
    initTaskState.task = null;
    initTaskState.tasks = {};
    window.localStorage.clear();
  });

  test("shows Google sub-connectors as connected when googlesuper is active", () => {
    render(<DataConnections composio={makeComposioState()} />);

    expect(screen.getByRole("button", { name: /Recommended.*1\s+\/\s+7/i })).toBeTruthy();
    expect(screen.getByText("Google Workspace")).toBeTruthy();
    expect(screen.getByText("Gmail")).toBeTruthy();
    expect(screen.getByText("Calendar")).toBeTruthy();
    expect(screen.getByText("Drive")).toBeTruthy();
    expect(screen.getByText("Docs")).toBeTruthy();
    expect(screen.getByText("Sheets")).toBeTruthy();
    expect(screen.getByText("Slides")).toBeTruthy();
    expect(screen.getByText("user@example.com")).toBeTruthy();
  });

  test("shows fanout sub-toolkit init counts instead of aggregate count", () => {
    initTaskState.task = {
      id: "init.googlesuper.google-workspace-account",
      type: "connector.init",
      status: "succeeded",
      payload: { toolkit: "googlesuper", limit: 100 },
      progress: {
        perToolkit: {
          gmail: { fetched: 100, rawInserted: 100 },
          googlecalendar: { fetched: 150, rawInserted: 150 },
          googledrive: { fetched: 200, rawInserted: 200 },
          googledocs: { fetched: 80, rawInserted: 80 },
          googlesheets: { fetched: 60, rawInserted: 60 },
        },
      },
      result: {
        rawInserted: 590,
        memoriesWritten: 0,
        skillsAdded: 0,
      },
      attempts: 1,
      max_attempts: 1,
      last_error_code: null,
      last_error_message: null,
      started_at: "2026-06-10T00:00:00.000Z",
      completed_at: new Date().toISOString(),
    };

    render(<DataConnections composio={makeComposioState()} />);

    expect(screen.getByText("Initialized · 100 fetched")).toBeTruthy();
    expect(screen.getByText("Initialized · 150 fetched")).toBeTruthy();
    expect(screen.getByText("Initialized · 200 fetched")).toBeTruthy();
    expect(screen.getByText("Initialized · 80 fetched")).toBeTruthy();
    expect(screen.getByText("Initialized · 60 fetched")).toBeTruthy();
    expect(screen.getAllByText("Initialized · 590 fetched")).toHaveLength(1);
  });

  test("shows sub-toolkit init counts for each Google workspace account", () => {
    initTaskState.task = {
      id: "init.googlesuper.google-workspace-account",
      type: "connector.init",
      status: "succeeded",
      payload: { toolkit: "googlesuper", limit: 100 },
      progress: {
        perToolkit: {
          gmail: { fetched: 100, rawInserted: 100 },
          googlecalendar: { fetched: 150, rawInserted: 150 },
          googledrive: { fetched: 200, rawInserted: 200 },
          googledocs: { fetched: 80, rawInserted: 80 },
          googlesheets: { fetched: 60, rawInserted: 60 },
        },
      },
      result: {
        rawInserted: 590,
        memoriesWritten: 0,
        skillsAdded: 0,
      },
      attempts: 1,
      max_attempts: 1,
      last_error_code: null,
      last_error_message: null,
      started_at: "2026-06-10T00:00:00.000Z",
      completed_at: new Date().toISOString(),
    };
    const state = makeComposioState([
      {
        toolkit: "googlesuper",
        status: "ACTIVE",
        connectedAccountId: "google-workspace-account",
        label: "user@example.com",
        userInfo: null,
      },
      {
        toolkit: "googlesuper",
        status: "ACTIVE",
        connectedAccountId: "google-workspace-account-2",
        label: "work@example.com",
        userInfo: null,
      },
    ]);

    render(<DataConnections composio={state} />);

    expect(screen.getAllByText("user@example.com").length).toBeGreaterThan(1);
    expect(screen.getAllByText("work@example.com").length).toBeGreaterThan(1);
    expect(screen.getAllByText("Initialized · 80 fetched")).toHaveLength(2);
    expect(screen.getAllByText("Initialized · 60 fetched")).toHaveLength(2);
  });

  test("shows total connector catalog size separately from loaded page size", async () => {
    const state = makeComposioState([]);
    state.loadCatalog = vi.fn(async () => ({
      ok: true,
      page: {
        items: [
          {
            slug: "hubspot",
            name: "HubSpot",
            logo: null,
            categories: ["crm"],
            auth_schemes: ["OAUTH2"],
            is_composio_managed: true,
          },
        ],
        nextCursor: "next-page",
        totalCount: 1234,
      },
    }));

    render(<DataConnections composio={state} />);

    expect(screen.getByText("1000+ supported sources")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /More data connectors/i }));

    await waitFor(() => {
      expect(screen.getByText("1,234 supported sources")).toBeTruthy();
      expect(screen.queryByText(/shown ·/i)).toBeNull();
    });
  });

  test("demotes recommended catalog items and shows add/count controls", async () => {
    initTaskState.task = {
      id: "init.gmail.gmail-account",
      type: "connector.init",
      status: "succeeded",
      payload: { toolkit: "gmail", limit: 100 },
      progress: {},
      result: {
        rawInserted: 42,
        memoriesWritten: 0,
        skillsAdded: 0,
      },
      attempts: 1,
      max_attempts: 1,
      last_error_code: null,
      last_error_message: null,
      started_at: "2026-06-10T00:00:00.000Z",
      completed_at: new Date().toISOString(),
    };
    const state = makeComposioState([
      {
        toolkit: "gmail",
        status: "ACTIVE",
        connectedAccountId: "gmail-account",
        label: "user@example.com",
        userInfo: null,
      },
    ]);
    state.loadCatalog = vi.fn(async () => ({
      ok: true,
      page: {
        items: [
          {
            slug: "gmail",
            name: "Gmail",
            logo: null,
            categories: ["email"],
            auth_schemes: ["OAUTH2"],
            is_composio_managed: true,
          },
          {
            slug: "hubspot",
            name: "HubSpot",
            logo: null,
            categories: ["crm"],
            auth_schemes: ["OAUTH2"],
            is_composio_managed: true,
          },
        ],
        nextCursor: null,
        totalCount: 2,
      },
    }));

    render(<DataConnections composio={state} />);
    fireEvent.click(screen.getByRole("button", { name: /More data connectors/i }));

    await waitFor(() => {
      expect(screen.getByText("HubSpot")).toBeTruthy();
      expect(screen.getAllByText("Gmail").length).toBeGreaterThan(1);
    });
    const results = screen.getByLabelText("Connector results");
    const text = results.textContent ?? "";
    expect(text.indexOf("HubSpot")).toBeLessThan(text.indexOf("Gmail"));
    expect(within(results).getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(within(results).getByRole("button", { name: "Add" })).toBeTruthy();
    expect(within(results).getByText("Initialized · 42 fetched")).toBeTruthy();

    await act(async () => {
      fireEvent.click(within(results).getByRole("button", { name: "Add" }));
    });
    expect(state.connectToolkit).toHaveBeenCalledWith("gmail");
  });

  test("hides recurring sync counts after connector initialization", async () => {
    initTaskState.tasks["sync.gmail.gmail-account"] = {
      id: "sync.gmail.gmail-account",
      type: "connector.sync",
      status: "queued",
      payload: { toolkit: "gmail", limit: 100 },
      progress: {
        stage: "done",
        fetched: 100,
        rawInserted: 17,
      },
      result: null,
      attempts: 1,
      max_attempts: 1,
      last_error_code: null,
      last_error_message: null,
      started_at: "2026-06-10T00:00:00.000Z",
      completed_at: null,
    };
    const state = makeComposioState([
      {
        toolkit: "gmail",
        status: "ACTIVE",
        connectedAccountId: "gmail-account",
        label: "user@example.com",
        userInfo: null,
      },
    ]);
    state.loadCatalog = vi.fn(async () => ({
      ok: true,
      page: {
        items: [
          {
            slug: "gmail",
            name: "Gmail",
            logo: null,
            categories: ["email"],
            auth_schemes: ["OAUTH2"],
            is_composio_managed: true,
          },
        ],
        nextCursor: null,
        totalCount: 1,
      },
    }));

    render(<DataConnections composio={state} />);
    fireEvent.click(screen.getByRole("button", { name: /More data connectors/i }));

    await waitFor(() => {
      expect(within(screen.getByLabelText("Connector results")).getByText("Gmail")).toBeTruthy();
    });
    expect(within(screen.getByLabelText("Connector results")).queryByText("Last sync · 100 fetched")).toBeNull();
    expect(within(screen.getByLabelText("Connector results")).queryByText(/Last sync/i)).toBeNull();
  });

  test("searches the full catalog through the backend and paginates results", async () => {
    const state = makeComposioState([]);
    state.loadCatalog = vi.fn(async (opts = {}) => {
      if (opts.query === "notion" && opts.cursor === "next-notion") {
        return {
          ok: true,
          page: {
            items: [
              {
                slug: "coda",
                name: "Coda",
                logo: null,
                categories: ["productivity"],
                auth_schemes: ["OAUTH2"],
                is_composio_managed: true,
              },
            ],
            nextCursor: null,
            totalCount: 2,
          },
        };
      }
      if (opts.query === "notion") {
        return {
          ok: true,
          page: {
            items: [
              {
                slug: "notion",
                name: "Notion",
                logo: null,
                categories: ["notes", "documents"],
                auth_schemes: ["OAUTH2"],
                is_composio_managed: true,
              },
            ],
            nextCursor: "next-notion",
            totalCount: 2,
          },
        };
      }
      return {
        ok: true,
        page: {
          items: [
            {
              slug: "hubspot",
              name: "HubSpot",
              logo: null,
              categories: ["crm"],
              auth_schemes: ["OAUTH2"],
              is_composio_managed: true,
            },
          ],
          nextCursor: null,
          totalCount: 1234,
        },
      };
    });

    render(<DataConnections composio={state} />);
    fireEvent.click(screen.getByRole("button", { name: /More data connectors/i }));

    await waitFor(() => {
      expect(screen.getByText("HubSpot")).toBeTruthy();
    });

    fireEvent.change(screen.getByPlaceholderText("Search connectors"), {
      target: { value: "notion" },
    });

    await waitFor(() => {
      expect(state.loadCatalog).toHaveBeenCalledWith({
        category: undefined,
        query: "notion",
        cursor: undefined,
        limit: 40,
      });
      expect(screen.getByText("Notion")).toBeTruthy();
      expect(screen.getByText("2 supported sources")).toBeTruthy();
      expect(screen.queryByText(/shown ·/i)).toBeNull();
    });

    const results = screen.getByLabelText("Connector results");
    Object.defineProperties(results, {
      scrollHeight: { configurable: true, value: 400 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, value: 190 },
    });
    fireEvent.scroll(results);

    await waitFor(() => {
      expect(state.loadCatalog).toHaveBeenCalledWith({
        category: undefined,
        query: "notion",
        cursor: "next-notion",
        limit: 40,
      });
      expect(screen.getByText("Coda")).toBeTruthy();
    });
  });

  test("uses Composio category values for filters with ampersands", async () => {
    const state = makeComposioState([]);
    state.loadCatalog = vi.fn(async () => ({
      ok: true,
      page: { items: [], nextCursor: null, totalCount: null },
    }));

    render(<DataConnections composio={state} />);
    fireEvent.click(screen.getByRole("button", { name: /More data connectors/i }));
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "file management & storage" },
    });

    await waitFor(() => {
      expect(state.loadCatalog).toHaveBeenCalledWith({
        category: "file management & storage",
        query: undefined,
        cursor: undefined,
        limit: 40,
      });
    });
  });

  test("shows an empty state for full-catalog searches with no results", async () => {
    const state = makeComposioState([]);
    state.loadCatalog = vi.fn(async (opts = {}) => ({
      ok: true,
      page: {
        items: opts.query ? [] : [
          {
            slug: "hubspot",
            name: "HubSpot",
            logo: null,
            categories: ["crm"],
            auth_schemes: ["OAUTH2"],
            is_composio_managed: true,
          },
        ],
        nextCursor: null,
        totalCount: opts.query ? 0 : 1234,
      },
    }));

    render(<DataConnections composio={state} />);
    fireEvent.click(screen.getByRole("button", { name: /More data connectors/i }));

    await waitFor(() => {
      expect(screen.getByText("HubSpot")).toBeTruthy();
    });

    fireEvent.change(screen.getByPlaceholderText("Search connectors"), {
      target: { value: "no-such-connector" },
    });

    await waitFor(() => {
      expect(state.loadCatalog).toHaveBeenCalledWith({
        category: undefined,
        query: "no-such-connector",
        cursor: undefined,
        limit: 40,
      });
      expect(screen.getByText("No connectors found")).toBeTruthy();
    });
  });

  test("opens a Remote MCP custom connector dialog instead of a Composio JSON form", async () => {
    const state = makeComposioState([]);

    render(<DataConnections composio={state} />);
    fireEvent.click(screen.getByRole("button", { name: /More data connectors/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Add custom connector/i })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /Add custom connector/i }));

    expect(screen.getByRole("dialog", { name: /Add custom connector/i })).toBeTruthy();
    expect(screen.getByPlaceholderText("Name")).toBeTruthy();
    expect(screen.getByPlaceholderText("Remote MCP server URL")).toBeTruthy();
    expect(screen.queryByText("BETA")).toBeNull();
    expect(screen.queryByPlaceholderText(/toolkit slug/i)).toBeNull();
    expect(screen.queryByText("API_KEY")).toBeNull();
    expect(screen.queryByText("Advanced settings")).toBeNull();
    expect(screen.queryByPlaceholderText("OAuth Client ID (optional)")).toBeNull();
    expect(screen.queryByPlaceholderText("OAuth Client Secret (optional)")).toBeNull();
  });

  test("validates custom MCP connector URL before backend submission", async () => {
    const state = makeComposioState([]);

    render(<DataConnections composio={state} />);
    fireEvent.click(screen.getByRole("button", { name: /More data connectors/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Add custom connector/i })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /Add custom connector/i }));
    fireEvent.change(screen.getByPlaceholderText("Name"), {
      target: { value: "Internal docs" },
    });
    fireEvent.change(screen.getByPlaceholderText("Remote MCP server URL"), {
      target: { value: "http://mcp.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(screen.getByText("Remote MCP server URL must use https")).toBeTruthy();
    expect(state.connectToolkit).not.toHaveBeenCalled();
    expect(state.createCustomMcpConnector).not.toHaveBeenCalled();
  });

  test("adds a valid Remote MCP custom connector to the list", async () => {
    const state = makeComposioState([]);

    render(<DataConnections composio={state} />);
    fireEvent.click(screen.getByRole("button", { name: /More data connectors/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Add custom connector/i })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /Add custom connector/i }));
    fireEvent.change(screen.getByPlaceholderText("Name"), {
      target: { value: "News API" },
    });
    fireEvent.change(screen.getByPlaceholderText("Remote MCP server URL"), {
      target: { value: "https://mcp.pipedream.net/v2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: /Add custom connector/i })).toBeNull();
      expect(screen.getByText("News API")).toBeTruthy();
      expect(screen.getByText("https://mcp.pipedream.net/v2")).toBeTruthy();
      expect(screen.getByText("3 fetched")).toBeTruthy();
    });
    expect(state.createCustomMcpConnector).toHaveBeenCalledWith({
      name: "News API",
      url: "https://mcp.pipedream.net/v2",
    });
    expect(state.connectToolkit).not.toHaveBeenCalled();
  });

  test("lets users edit and delete a connected custom MCP connector", async () => {
    const state = makeComposioState([
      {
        toolkit: "mcp_123",
        status: "ACTIVE",
        connectedAccountId: "custom_mcp_123",
        label: "News API",
        userInfo: {
          type: "custom_mcp",
          url: "https://mcp.pipedream.net/v2",
          lastFetchedCount: 100,
          lastRawInsertedCount: 102,
          lastEvolveTaskId: "evolve.mcp_123.custom_mcp_123",
        },
      },
    ]);

    render(<DataConnections composio={state} />);
    fireEvent.click(screen.getByRole("button", { name: /More data connectors/i }));

    await waitFor(() => {
      expect(screen.getByText("News API")).toBeTruthy();
      expect(screen.getByText("100 fetched")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Edit News API/i }));
    expect(screen.getByRole("dialog", { name: /Edit custom connector/i })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Name"), {
      target: { value: "News API Updated" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(state.updateCustomMcpConnector).toHaveBeenCalledWith("custom_mcp_123", {
        name: "News API Updated",
        url: "https://mcp.pipedream.net/v2",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: /Delete News API/i }));
    await waitFor(() => {
      expect(state.deleteCustomMcpConnector).toHaveBeenCalledWith("custom_mcp_123");
    });
  });
});
