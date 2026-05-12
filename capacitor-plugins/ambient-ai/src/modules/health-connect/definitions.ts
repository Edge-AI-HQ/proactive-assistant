import type { PluginListenerHandle } from '@capacitor/core';

export interface StepsEvent {
  stepsToday: number;
  timestamp: number;
}

export interface SleepEvent {
  /** Sleep duration in minutes. */
  durationMin: number;
  /** ISO 8601 date when the sleep session ended. */
  endedAt: string;
  timestamp: number;
}

export interface HeartRateEvent {
  /** Average resting heart rate (bpm) over the last 6 hours. */
  avgBpm6h: number;
  timestamp: number;
}

export interface HealthConnectPermissions {
  health: PermissionState;
}

export interface HealthConnectPlugin {
  requestPermissions(): Promise<HealthConnectPermissions>;
  checkPermissions(): Promise<HealthConnectPermissions>;
  startMonitoring(): Promise<void>;
  stopMonitoring(): Promise<void>;
  addListener(
    eventName: 'steps',
    listenerFunc: (event: StepsEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'sleep',
    listenerFunc: (event: SleepEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'heartRate',
    listenerFunc: (event: HeartRateEvent) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
