import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import DeviceConnections from "./DeviceConnections";

vi.mock("@/lib/api", () => ({
  claimPairCode: vi.fn(),
}));

vi.mock("@/hooks/useUserDevices", () => ({
  useUserDevices: () => ({
    devices: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
    registerDevice: vi.fn(),
    revoke: vi.fn(),
  }),
}));

vi.mock("@/lib/devices", () => ({
  ensureDevice: vi.fn(() => new Promise(() => {})),
  ingestSignals: vi.fn(),
}));

describe("DeviceConnections", () => {
  test("hides pair-code controls while the flow is disabled", () => {
    render(<DeviceConnections />);

    expect(screen.queryByRole("button", { name: /pair with code/i })).toBeNull();
    expect(screen.queryByText(/6-character code/i)).toBeNull();
  });
});
