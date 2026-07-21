import { describe, expect, it } from "vitest";

import type { PinHardwareState } from "../../../modules/pin-hardware";
import {
  hasConnectedPinPeripheral,
  isPinHardwareScanning,
} from "./pin-hardware-connection-state";

function state(overrides: Partial<PinHardwareState>): PinHardwareState {
  return {
    supported: true,
    connected: false,
    scanning: false,
    captureRunning: false,
    status: "idle",
    timestamp: 0,
    ...overrides,
  };
}

describe("hasConnectedPinPeripheral", () => {
  it("treats a transport-connected device as connected while services initialize", () => {
    expect(hasConnectedPinPeripheral(state({
      scanning: true,
      status: "discovering_services",
      deviceId: "connected-device",
      devices: [
        { id: "nearby-device", name: "YLF20_nearby", connected: false },
        { id: "connected-device", name: "YLF20_connected", connected: true },
      ],
    }))).toBe(true);
  });

  it("does not treat nearby devices as connected", () => {
    expect(hasConnectedPinPeripheral(state({
      scanning: true,
      devices: [
        { id: "nearby-device", name: "YLF20_nearby", connected: false },
      ],
    }))).toBe(false);
  });

  it("does not treat a pending cached peripheral as connected", () => {
    expect(hasConnectedPinPeripheral(state({
      status: "connecting",
      deviceId: "cached-device",
      devices: [
        { id: "cached-device", name: "YLF20_cached", connected: false },
      ],
    }))).toBe(false);
  });
});

describe("isPinHardwareScanning", () => {
  it("shows scanning immediately while the native request is pending", () => {
    expect(isPinHardwareScanning(state({ scanning: false }), true)).toBe(true);
  });

  it("keeps showing scanning after native state confirms it", () => {
    expect(isPinHardwareScanning(state({ scanning: true }), false)).toBe(true);
  });

  it("stops showing scanning when neither signal is active", () => {
    expect(isPinHardwareScanning(state({ scanning: false }), false)).toBe(false);
  });
});
