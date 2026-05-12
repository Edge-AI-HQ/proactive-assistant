import type { PluginListenerHandle } from '@capacitor/core';

export interface DeviceStateSnapshot {
  thermal: 'nominal' | 'fair' | 'serious' | 'critical';
  lowPower: boolean;
  timestamp: number;
}

export interface DeviceStatePlugin {
  getState(): Promise<DeviceStateSnapshot>;
  startMonitoring(): Promise<void>;
  stopMonitoring(): Promise<void>;
  addListener(
    eventName: 'deviceState',
    listenerFunc: (event: DeviceStateSnapshot) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
