import type { PluginListenerHandle, PermissionState } from '@capacitor/core';

export interface AudioAmbientPermissions {
  microphone: PermissionState;
}

export interface AmbientLevelEvent {
  averageDb: number;
  peakDb: number;
  isSilent: boolean;
  timestamp: number;
}

export interface AudioAmbientPlugin {
  requestPermissions(): Promise<AudioAmbientPermissions>;
  checkPermissions(): Promise<AudioAmbientPermissions>;
  startMonitoring(): Promise<void>;
  stopMonitoring(): Promise<void>;
  addListener(
    eventName: 'ambientLevel',
    listenerFunc: (event: AmbientLevelEvent) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
