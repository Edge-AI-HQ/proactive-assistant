import type { PermissionState, PluginListenerHandle } from '@capacitor/core';

export interface CalendarPermissions {
  calendar: PermissionState;
}

export interface CalendarSummaryEvent {
  count24h: number;
  timestamp: number;
}

export interface CalendarEventEvent {
  title: string;
  startsAt: string;
  endsAt: string;
  attendeeCount: number;
  calendar: string;
  timestamp: number;
}

export interface CalendarPlugin {
  requestPermissions(): Promise<CalendarPermissions>;
  checkPermissions(): Promise<CalendarPermissions>;
  startMonitoring(): Promise<void>;
  stopMonitoring(): Promise<void>;
  addListener(
    eventName: 'calendarSummary',
    listenerFunc: (event: CalendarSummaryEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'calendarEvent',
    listenerFunc: (event: CalendarEventEvent) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
