import type { PluginListenerHandle, PermissionState } from '@capacitor/core';

export interface VisitEvent {
  arrivalAt: number;
  departureAt: number | null;
  latitude: number;
  longitude: number;
  accuracy: number;
  confidence?: number;
}

export interface PositionResult {
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude: number;
  timestamp: number;
}

export interface ActivityEvent {
  type: 'stationary' | 'walking' | 'running' | 'automotive' | 'cycling';
  confidence: 'low' | 'medium' | 'high';
  timestamp: number;
}

export interface VisitMonitorPermissions {
  location: PermissionState;
}

export interface VisitMonitorPlugin {
  requestPermissions(): Promise<VisitMonitorPermissions>;
  checkPermissions(): Promise<VisitMonitorPermissions>;
  startMonitoring(): Promise<void>;
  stopMonitoring(): Promise<void>;
  getCurrentPosition(): Promise<PositionResult>;
  startActivityRecognition(): Promise<void>;
  stopActivityRecognition(): Promise<void>;
  addListener(
    eventName: 'visit',
    listenerFunc: (event: VisitEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'activity',
    listenerFunc: (event: ActivityEvent) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
