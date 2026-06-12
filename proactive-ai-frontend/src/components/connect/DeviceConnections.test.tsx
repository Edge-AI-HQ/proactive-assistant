import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import DeviceConnections from "@/components/connect/DeviceConnections";

vi.mock("@pin-ai/core", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  claimPairCode: vi.fn(),
}));

const { devicesState, refreshMock, ensureDeviceMock } = vi.hoisted(() => ({
  devicesState: { devices: [] as any[] },
  refreshMock: vi.fn(),
  ensureDeviceMock: vi.fn(),
}));

vi.mock("@pin-ai/state", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useUserDevices: () => ({
    devices: devicesState.devices,
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
    devicesState.devices = [];
    refreshMock.mockClear();
    ensureDeviceMock.mockReset();
    ensureDeviceMock.mockImplementation(() => new Promise(() => {}));
  });

  test("hides pair-code controls while the flow is disabled", () => {
    render(<DeviceConnections />);

    expect(screen.queryByRole("button", { name: /pair with code/i })).toBeNull();
    expect(screen.queryByText(/6-character code/i)).toBeNull();
  });

  test("hides manual registration and this-device bootstrap controls", () => {
    render(<DeviceConnections />);

    expect(screen.queryByRole("button", { name: /manual/i })).toBeNull();
    expect(screen.queryByText(/this device/i)).toBeNull();
    expect(ensureDeviceMock).not.toHaveBeenCalled();
  });

  test("renders platform-specific icons for phones and hardware devices", () => {
    devicesState.devices = [
      {
        device_id: "ios-device-id",
        platform: "ios",
        display_name: "iPhone",
        app_version: "1.0",
        model: "iPhone",
        registered_at: "2026-05-02T00:00:00.000Z",
        last_seen_at: "2026-05-02T01:00:00.000Z",
        status: "active",
        metadata: {},
      },
      {
        device_id: "android-device-id",
        platform: "android",
        display_name: "Xiaomi 23127PN0CC",
        app_version: "16",
        model: "23127PN0CC",
        registered_at: "2026-05-02T00:00:00.000Z",
        last_seen_at: "2026-05-02T01:00:00.000Z",
        status: "active",
        metadata: {},
      },
      {
        device_id: "wearable-device-id",
        platform: "wearable",
        display_name: "OMI pendant",
        app_version: null,
        model: "omi_pendant_v1",
        registered_at: "2026-05-02T00:00:00.000Z",
        last_seen_at: null,
        status: "active",
        metadata: {},
      },
    ];

    render(<DeviceConnections />);

    expect(screen.getByLabelText("iOS device")).toBeTruthy();
    expect(screen.getByLabelText("Android device")).toBeTruthy();
    expect(screen.getByLabelText("Wearable device")).toBeTruthy();
  });
});
