import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

import { AudioCaptureWeb } from './audio-capture';
import type { AudioCapturePlugin } from './audio-capture';
import type {
  AmbientTimelineEventDraftResult,
  GenerateTimelineEventOptions,
  ModelDownloadOptions,
  ModelDownloadProgressEvent,
  ModelListResult,
  ModelVerifyResult,
} from './types';
import { BatteryAdapter } from '../modules/battery/adapter';
import type { CalendarPlugin } from '../modules/calendar/definitions';
import { ContactsAdapter } from '../modules/contacts/adapter';
import type { DeviceStatePlugin } from '../modules/device-state/definitions';
import type { GeocoderPlugin } from '../modules/geocoder/definitions';
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

export const geocoder = registerPlugin<GeocoderPlugin>('Geocoder', {
  web: () => import('../modules/geocoder/web').then((m) => new m.GeocoderWeb()),
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

interface AmbientModelsPlugin {
  listModels(): Promise<ModelListResult>;
  startModelDownload(options: ModelDownloadOptions): Promise<void>;
  cancelModelDownload(options: { id: string }): Promise<void>;
  deleteModel(options: { id: string }): Promise<void>;
  verifyModel(options: { id: string }): Promise<ModelVerifyResult>;
  generateTimelineEvent(options: GenerateTimelineEventOptions): Promise<AmbientTimelineEventDraftResult>;
  addListener(
    eventName: 'modelDownloadProgress' | 'modelDownloadDone',
    listenerFunc: (event: ModelDownloadProgressEvent) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

class AmbientModelsWeb implements AmbientModelsPlugin {
  async listModels(): Promise<ModelListResult> {
    return { profiles: [], statuses: [] };
  }

  async startModelDownload(): Promise<void> {
    throw new Error('AmbientModels.startDownload is unavailable on web');
  }

  async cancelModelDownload(): Promise<void> {
    throw new Error('AmbientModels.cancelDownload is unavailable on web');
  }

  async deleteModel(): Promise<void> {
    throw new Error('AmbientModels.deleteModel is unavailable on web');
  }

  async verifyModel(): Promise<ModelVerifyResult> {
    throw new Error('AmbientModels.verifyModel is unavailable on web');
  }

  async generateTimelineEvent(): Promise<AmbientTimelineEventDraftResult> {
    throw new Error('AmbientModels.generateTimelineEvent is unavailable on web');
  }

  async addListener(): Promise<PluginListenerHandle> {
    return { remove: async () => {} };
  }

  async removeAllListeners(): Promise<void> {}
}

export const models = registerPlugin<AmbientModelsPlugin>('AmbientModels', {
  web: () => Promise.resolve(new AmbientModelsWeb()),
});
