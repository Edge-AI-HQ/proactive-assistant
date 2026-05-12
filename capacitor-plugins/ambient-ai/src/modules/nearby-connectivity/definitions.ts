import type { PluginListenerHandle, PermissionState } from '@capacitor/core';

export interface NearbyConnectivityPermissions {
  bluetooth: PermissionState;
}

export interface NearbyBTEvent {
  samples: number;
  rssiHistogram: string;
  timestamp: number;
}

export interface NearbyConnectivityPlugin {
  requestPermissions(): Promise<NearbyConnectivityPermissions>;
  checkPermissions(): Promise<NearbyConnectivityPermissions>;
  startMonitoring(): Promise<void>;
  stopMonitoring(): Promise<void>;
  addListener(
    eventName: 'nearbyBT',
    listenerFunc: (event: NearbyBTEvent) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
