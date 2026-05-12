import { registerPlugin } from '@capacitor/core';

import { AudioCaptureWeb } from './audio-capture';
import type { AudioCapturePlugin } from './audio-capture';
import { BatteryAdapter } from '../modules/battery/adapter';
import type { CalendarPlugin } from '../modules/calendar/definitions';
import { ContactsAdapter } from '../modules/contacts/adapter';
import type { DeviceStatePlugin } from '../modules/device-state/definitions';
import type { MediaNotebookPlugin } from '../modules/media-notebook/definitions';
import type { NearbyConnectivityPlugin } from '../modules/nearby-connectivity/definitions';
import type { NotificationUsagePlugin } from '../modules/notification-usage/definitions';
import { HealthConnectAdapter } from '../modules/health-connect/adapter';
import { SensorFusionAdapter } from '../modules/sensor-fusion/adapter';
import type { VisitMonitorPlugin } from '../modules/visit-monitor/definitions';

export const audio = registerPlugin<AudioCapturePlugin>('AudioCapture', {
  web: () => Promise.resolve(new AudioCaptureWeb()),
});

export const visit = registerPlugin<VisitMonitorPlugin>('VisitMonitor', {
  web: () => import('../modules/visit-monitor/web').then((m) => new m.VisitMonitorWeb()),
});

export const device = registerPlugin<DeviceStatePlugin>('DeviceState', {
  web: () => import('../modules/device-state/web').then((m) => new m.DeviceStateWeb()),
});

export const calendar = registerPlugin<CalendarPlugin>('Calendar', {
  web: () => import('../modules/calendar/web').then((m) => new m.CalendarWeb()),
});

export const notifications = registerPlugin<NotificationUsagePlugin>('NotificationUsage', {
  web: () => import('../modules/notification-usage/web').then((m) => new m.NotificationUsageWeb()),
});

export const media = registerPlugin<MediaNotebookPlugin>('MediaNotebook', {
  web: () => import('../modules/media-notebook/web').then((m) => new m.MediaNotebookWeb()),
});

export const nearby = registerPlugin<NearbyConnectivityPlugin>('NearbyConnectivity', {
  web: () => import('../modules/nearby-connectivity/web').then((m) => new m.NearbyConnectivityWeb()),
});

export const sensor = new SensorFusionAdapter();
export const health = new HealthConnectAdapter();
export const battery = new BatteryAdapter();
export const contacts = new ContactsAdapter();
