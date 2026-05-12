import type { PermissionState, PluginListenerHandle } from '@capacitor/core';

export interface ContactsSnapshot {
  total: number;
  withEmail: number;
  withPhone: number;
  timestamp: number;
}

export interface ContactsPermissions {
  contacts: PermissionState;
}

export interface ContactsPlugin {
  requestPermissions(): Promise<ContactsPermissions>;
  checkPermissions(): Promise<ContactsPermissions>;
  startMonitoring(): Promise<void>;
  stopMonitoring(): Promise<void>;
  addListener(
    eventName: 'contacts',
    listenerFunc: (event: ContactsSnapshot) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
