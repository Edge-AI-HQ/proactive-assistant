import type { PluginListenerHandle } from '@capacitor/core';

export interface AltimeterEvent {
  /** Relative altitude change in meters since monitoring started. */
  relativeAltitude: number;
  /** Barometric pressure in kilopascals. */
  pressureKPa: number;
  timestamp: number;
}

export interface SensorFusionPermissions {
  motion: PermissionState;
}

export interface SensorFusionPlugin {
  requestPermissions(): Promise<SensorFusionPermissions>;
  checkPermissions(): Promise<SensorFusionPermissions>;
  startMonitoring(): Promise<void>;
  stopMonitoring(): Promise<void>;
  addListener(
    eventName: 'altimeter',
    listenerFunc: (event: AltimeterEvent) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
