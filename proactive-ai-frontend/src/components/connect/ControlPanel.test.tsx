import { render, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import ControlPanel from "@/components/connect/ControlPanel";
import type { ComposioState } from "@/hooks/useComposio";

vi.mock("@/components/connect/DataConnections", () => ({
  default: () => <div data-testid="data-connections" />,
  isDataSourceConnected: () => false,
  INPUT_CATEGORIES: [
    {
      name: "Work",
      icon: () => null,
      description: "Work sources",
      sources: [
        {
          name: "Gmail",
          composioId: "gmail",
          description: "Gmail workspace",
          icon: () => null,
          tier: 0,
        },
      ],
    },
  ],
}));

vi.mock("@/components/connect/DeviceConnections", () => ({
  default: () => <div data-testid="device-connections" />,
}));

vi.mock("@pin-ai/state", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useUserDevices: () => ({
    devices: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
    registerDevice: vi.fn(),
    revoke: vi.fn(),
  }),
}));

function makeComposioState(loadConnections: ComposioState["loadConnections"]): ComposioState {
  return {
    keyStatus: { configured: true },
    connections: [],
    statusLoading: false,
    loadingConns: false,
    loadStatus: vi.fn(async () => undefined),
    loadConnections,
    loadCatalog: vi.fn(async () => ({ ok: true, page: { items: [], nextCursor: null, totalCount: null } })),
    connectToolkit: vi.fn(async () => ({ ok: true })),
    disconnectAccount: vi.fn(async () => ({ ok: true })),
    waitForToolkit: vi.fn(async () => ({ connected: true })),
    cancelWait: vi.fn(),
    isToolkitConnected: vi.fn(() => false),
    reconnectAccount: vi.fn(async () => ({ ok: true })),
    createCustomMcpConnector: vi.fn(async () => ({ ok: true })),
    updateCustomMcpConnector: vi.fn(async () => ({ ok: true })),
    deleteCustomMcpConnector: vi.fn(async () => ({ ok: true })),
  };
}

describe("ControlPanel", () => {
  test("refreshes connector connections when the page opens", async () => {
    const loadConnections = vi.fn(async () => []);

    render(<ControlPanel composio={makeComposioState(loadConnections)} />);

    await waitFor(() => {
      expect(loadConnections).toHaveBeenCalledTimes(1);
    });
  });
});
