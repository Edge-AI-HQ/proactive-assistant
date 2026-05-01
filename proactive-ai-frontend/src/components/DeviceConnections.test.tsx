import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import DeviceConnections from "./DeviceConnections";

vi.mock("@/lib/api", () => ({
  claimPairCode: vi.fn(),
}));

const { refreshMock, ensureDeviceMock } = vi.hoisted(() => ({
  refreshMock: vi.fn(),
  ensureDeviceMock: vi.fn(),
}));

vi.mock("@/hooks/useUserDevices", () => ({
  useUserDevices: () => ({
    devices: [],
    loading: false,
    error: null,
    refresh: refreshMock,
    registerDevice: vi.fn(),
    revoke: vi.fn(),
  }),
}));

vi.mock("@/lib/devices", () => ({
  ensureDevice: ensureDeviceMock,
  ingestSignals: vi.fn(),
}));

describe("DeviceConnections", () => {
  beforeEach(() => {
    refreshMock.mockClear();
    ensureDeviceMock.mockReset();
    ensureDeviceMock.mockImplementation(() => new Promise(() => {}));
  });

  test("hides pair-code controls while the flow is disabled", () => {
    render(<DeviceConnections />);

    expect(screen.queryByRole("button", { name: /pair with code/i })).toBeNull();
    expect(screen.queryByText(/6-character code/i)).toBeNull();
  });

  test("refreshes the device list after this client registers itself", async () => {
    ensureDeviceMock.mockResolvedValueOnce({
      deviceId: "android-device-id",
      deviceToken: "device-token",
      platform: "android",
    });

    render(<DeviceConnections />);

    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalled();
    });
  });
});
