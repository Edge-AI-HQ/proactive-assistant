import type { PluginListenerHandle } from '@capacitor/core';

import type { PlaceInfo } from '../geocoder/definitions';

export interface VisitEvent {
  id?: string;
  arrivalAt: number;
  departureAt: number | null;
  latitude: number;
  longitude: number;
  accuracy: number;
  confidence?: number;
  placeStatus?: 'pending' | 'resolved' | 'failed';
  /**
   * Reverse-geocoded POI metadata attached natively by `VisitMonitorPlugin`.
   * Optional: missing if the native geocode lookup failed or timed out.
   */
  place?: PlaceInfo;
}

export interface PendingVisit {
  id: string;
  payload: VisitEvent;
}

export interface PendingVisitsResult {
  visits: PendingVisit[];
}

export interface AckPendingVisitsOptions {
  ids: string[];
}

export type VisitLocationPermission =
  | 'always'
  | 'when_in_use'
  | 'denied'
  | 'restricted'
  | 'prompt';

export interface PositionResult {
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude: number;
  timestamp: number;
  /** Reverse-geocoded POI metadata attached natively. Optional. */
  place?: PlaceInfo;
}

export interface ActivityEvent {
  type: 'stationary' | 'walking' | 'running' | 'automotive' | 'cycling';
  confidence: 'low' | 'medium' | 'high';
  timestamp: number;
}

export interface VisitMonitorPermissions {
  location: VisitLocationPermission;
}

export interface VisitMonitoringState {
  authorization: VisitLocationPermission;
  nativeMonitoring: boolean;
  enabled: boolean;
  pendingVisitCount: number;
  storedVisitCount: number;
  lastNativeVisitAt: number | null;
  lastDrainAt: number | null;
  lastError: string | null;
}

export interface VisitMonitorPlugin {
  requestPermissions(): Promise<VisitMonitorPermissions>;
  checkPermissions(): Promise<VisitMonitorPermissions>;
  startMonitoring(): Promise<void>;
  stopMonitoring(): Promise<void>;
  drainPendingVisits(options?: { limit?: number }): Promise<PendingVisitsResult>;
  ackPendingVisits(options: AckPendingVisitsOptions): Promise<void>;
  getMonitoringState(): Promise<VisitMonitoringState>;
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
