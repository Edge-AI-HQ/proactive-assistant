import type { PermissionState, PluginListenerHandle } from '@capacitor/core';

export interface SoundClassification {
  label: string;
  confidence: number;
}

export interface SoundClassifierEvent {
  classifications: SoundClassification[];
  timestamp: number;
}

export interface SoundClassifierPermissions {
  microphone: PermissionState;
}

export interface SoundClassifierPlugin {
  requestPermissions(): Promise<SoundClassifierPermissions>;
  checkPermissions(): Promise<SoundClassifierPermissions>;
  startListening(): Promise<void>;
  stopListening(): Promise<void>;
  addListener(
    eventName: 'classification',
    listenerFunc: (event: SoundClassifierEvent) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
