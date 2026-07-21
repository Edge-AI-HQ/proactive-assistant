import type { PinHardwareState } from "../../../modules/pin-hardware";

/**
 * The native `connected` flag means the MR20 write characteristic is ready.
 * The device list reports the earlier CoreBluetooth transport connection.
 */
export function hasConnectedPinPeripheral(state: PinHardwareState | null): boolean {
  if (!state) return false;
  if (state.connected) return true;
  return state.devices?.some((device) => device.connected === true) === true;
}

export function isPinHardwareScanning(
  state: PinHardwareState | null,
  scanPending: boolean,
): boolean {
  return state?.scanning === true || scanPending;
}
