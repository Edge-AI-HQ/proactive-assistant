import type { PluginListenerHandle, PermissionState } from '@capacitor/core';

export interface MediaNotebookPermissions {
  photos: PermissionState;
}

export interface PhotosEvent {
  count7d: number;
  withLocation: number;
  limitedAccess: boolean;
  oldest: string | null;
  newest: string | null;
  timestamp: number;
}

export interface MediaNotebookPlugin {
  requestPermissions(): Promise<MediaNotebookPermissions>;
  checkPermissions(): Promise<MediaNotebookPermissions>;
  startMonitoring(): Promise<void>;
  stopMonitoring(): Promise<void>;
  addListener(
    eventName: 'photos',
    listenerFunc: (event: PhotosEvent) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
