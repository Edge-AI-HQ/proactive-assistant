import type { PluginListenerHandle } from '@capacitor/core';

export interface BatterySnapshot {
  /** Battery level as percent integer (0-100). */
  batteryPct: number;
  charging: boolean;
  timestamp: number;
}

export interface BatteryStartOptions {
  /** Polling interval in milliseconds. Defaults to 5 minutes. */
  intervalMs?: number;
}

export interface BatteryPlugin {
  getState(): Promise<BatterySnapshot>;
  startMonitoring(options?: BatteryStartOptions): Promise<void>;
  stopMonitoring(): Promise<void>;
  addListener(
    eventName: 'battery',
    listenerFunc: (event: BatterySnapshot) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
