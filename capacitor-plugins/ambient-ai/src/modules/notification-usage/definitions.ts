import type { PluginListenerHandle, PermissionState } from '@capacitor/core';

export interface NotificationUsagePermissions {
  notifications: PermissionState;
}

export interface FocusEvent {
  focused: boolean;
  timestamp: number;
}

export interface NotificationCountEvent {
  pending: number;
  delivered: number;
  timestamp: number;
}

export interface NotificationUsagePlugin {
  requestPermissions(): Promise<NotificationUsagePermissions>;
  checkPermissions(): Promise<NotificationUsagePermissions>;
  startMonitoring(): Promise<void>;
  stopMonitoring(): Promise<void>;
  addListener(
    eventName: 'focus',
    listenerFunc: (event: FocusEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'notifications',
    listenerFunc: (event: NotificationCountEvent) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
