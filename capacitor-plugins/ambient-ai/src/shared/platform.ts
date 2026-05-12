import { Capacitor } from '@capacitor/core';

/**
 * Returns true on a native (iOS / Android) platform; false on web with a
 * one-line warning. TS adapters use this to short-circuit `startMonitoring`
 * on web — consistent with the no-op `web.ts` stubs of the native plugins.
 */
export function ensureNative(label: string): boolean {
  if (!Capacitor.isNativePlatform()) {
    console.warn(`[${label}] not available on web platform`);
    return false;
  }
  return true;
}
