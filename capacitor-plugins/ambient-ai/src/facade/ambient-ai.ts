import type { PluginListenerHandle } from '@capacitor/core';

import * as native from './native';
import type {
  ActivityEvent,
  AmbientAiFacade,
  AmbientEventMap,
  AmbientEventName,
  AmbientLevelEvent,
  AudioErrorEvent,
  AudioState,
  BatterySnapshot,
  CalendarEventEvent,
  CalendarSummaryEvent,
  ContactsSnapshot,
  DeviceStateSnapshot,
  FocusEvent,
  HeartRateEvent,
  ModelDownloadProgressEvent,
  NearbyBTEvent,
  NotificationCountEvent,
  PhotosEvent,
  SleepEvent,
  SoundClassificationEvent,
  SpeechBurstEvent,
  StepsEvent,
  TranscriptDraftEvent,
  TranscriptReadyEvent,
  TranscriptRefinedEvent,
  VisitEvent,
} from './types';

const noopHandle = (): Promise<PluginListenerHandle> =>
  Promise.resolve({ remove: async () => {} });

export const AmbientAi: AmbientAiFacade = {
  audio: {
    requestPermissions: () => native.audio.requestPermissions(),
    checkPermissions: () => native.audio.checkPermissions(),
    configure: (config) => native.audio.configure(config),
    startCapture: () => native.audio.startCapture(),
    stopCapture: () => native.audio.stopCapture(),
    getState: () => native.audio.getState(),
    drainPendingTranscripts: async () => {
      const result = await native.audio.drainPendingTranscripts();
      return result.transcripts;
    },
    listRecentCaptures: () => native.audio.listRecentCaptures(),
    playCapture: (options) => native.audio.playCapture(options),
    stopPlayback: () => native.audio.stopPlayback(),
  },

  sound: {
    requestPermissions: () => native.audio.requestPermissions(),
    checkPermissions: () => native.audio.checkPermissions(),
    startClassification: () => native.audio.startClassification(),
    stopClassification: () => native.audio.stopClassification(),
  },

  visit: {
    requestPermissions: () => native.visit.requestPermissions(),
    checkPermissions: () => native.visit.checkPermissions(),
    startMonitoring: () => native.visit.startMonitoring(),
    stopMonitoring: () => native.visit.stopMonitoring(),
    getCurrentPosition: () => native.visit.getCurrentPosition(),
    startActivityRecognition: () => native.visit.startActivityRecognition(),
    stopActivityRecognition: () => native.visit.stopActivityRecognition(),
  },

  geocoder: {
    reverseGeocode: (options) => native.geocoder.reverseGeocode(options),
  },

  device: {
    getState: () => native.device.getState(),
    startMonitoring: () => native.device.startMonitoring(),
    stopMonitoring: () => native.device.stopMonitoring(),
  },

  calendar: {
    requestPermissions: () => native.calendar.requestPermissions(),
    checkPermissions: () => native.calendar.checkPermissions(),
    startMonitoring: () => native.calendar.startMonitoring(),
    stopMonitoring: () => native.calendar.stopMonitoring(),
  },

  notifications: {
    requestPermissions: () => native.notifications.requestPermissions(),
    checkPermissions: () => native.notifications.checkPermissions(),
    startMonitoring: () => native.notifications.startMonitoring(),
    stopMonitoring: () => native.notifications.stopMonitoring(),
  },

  media: {
    requestPermissions: () => native.media.requestPermissions(),
    checkPermissions: () => native.media.checkPermissions(),
    startMonitoring: () => native.media.startMonitoring(),
    stopMonitoring: () => native.media.stopMonitoring(),
  },

  nearby: {
    requestPermissions: () => native.nearby.requestPermissions(),
    checkPermissions: () => native.nearby.checkPermissions(),
    startMonitoring: () => native.nearby.startMonitoring(),
    stopMonitoring: () => native.nearby.stopMonitoring(),
  },

  sensor: {
    requestPermissions: () => native.sensor.requestPermissions(),
    checkPermissions: () => native.sensor.checkPermissions(),
    startMonitoring: () => native.sensor.startMonitoring(),
    stopMonitoring: () => native.sensor.stopMonitoring(),
  },

  health: {
    requestPermissions: () => native.health.requestPermissions(),
    checkPermissions: () => native.health.checkPermissions(),
    startMonitoring: () => native.health.startMonitoring(),
    stopMonitoring: () => native.health.stopMonitoring(),
  },

  battery: {
    getState: () => native.battery.getState(),
    startMonitoring: (options) => native.battery.startMonitoring(options),
    stopMonitoring: () => native.battery.stopMonitoring(),
  },

  contacts: {
    requestPermissions: () => native.contacts.requestPermissions(),
    checkPermissions: () => native.contacts.checkPermissions(),
    startMonitoring: () => native.contacts.startMonitoring(),
    stopMonitoring: () => native.contacts.stopMonitoring(),
  },

  models: {
    list: () => native.models.listModels(),
    startDownload: (options) => native.models.startModelDownload(options),
    cancelDownload: (options) => native.models.cancelModelDownload(options),
    deleteModel: (options) => native.models.deleteModel(options),
    verifyModel: (options) => native.models.verifyModel(options),
  },

  addListener,

  async removeAllListeners(): Promise<void> {
    await Promise.all([
      native.audio.removeAllListeners(),
      native.visit.removeAllListeners(),
      native.device.removeAllListeners(),
      native.calendar.removeAllListeners(),
      native.notifications.removeAllListeners(),
      native.media.removeAllListeners(),
      native.nearby.removeAllListeners(),
      native.sensor.removeAllListeners(),
      native.health.removeAllListeners(),
      native.battery.removeAllListeners(),
      native.contacts.removeAllListeners(),
      native.models.removeAllListeners(),
    ]);
  },
};

function addListener<K extends AmbientEventName>(
  eventName: K,
  listenerFunc: (event: AmbientEventMap[K]) => void,
): Promise<PluginListenerHandle> {
  switch (eventName) {
    case 'activity':
      return native.visit.addListener('activity', listenerFunc as (event: ActivityEvent) => void);
    case 'altimeter':
      return native.sensor.addListener('altimeter', listenerFunc as (event: AmbientEventMap['altimeter']) => void);
    case 'ambientLevel':
      return native.audio.addListener('ambientLevel', listenerFunc as (event: AmbientLevelEvent) => void);
    case 'audioError':
      return native.audio.addListener('audioError', listenerFunc as (event: AudioErrorEvent) => void);
    case 'audioState':
      return native.audio.addListener('audioState', listenerFunc as (event: AudioState) => void);
    case 'battery':
      return native.battery.addListener('battery', listenerFunc as (event: BatterySnapshot) => void);
    case 'calendarEvent':
      return native.calendar.addListener('calendarEvent', listenerFunc as (event: CalendarEventEvent) => void);
    case 'calendarSummary':
      return native.calendar.addListener('calendarSummary', listenerFunc as (event: CalendarSummaryEvent) => void);
    case 'contacts':
      return native.contacts.addListener('contacts', listenerFunc as (event: ContactsSnapshot) => void);
    case 'deviceState':
      return native.device.addListener('deviceState', listenerFunc as (event: DeviceStateSnapshot) => void);
    case 'focus':
      return native.notifications.addListener('focus', listenerFunc as (event: FocusEvent) => void);
    case 'heartRate':
      return native.health.addListener('heartRate', listenerFunc as (event: HeartRateEvent) => void);
    case 'nearbyBT':
      return native.nearby.addListener('nearbyBT', listenerFunc as (event: NearbyBTEvent) => void);
    case 'notifications':
      return native.notifications.addListener('notifications', listenerFunc as (event: NotificationCountEvent) => void);
    case 'photos':
      return native.media.addListener('photos', listenerFunc as (event: PhotosEvent) => void);
    case 'sleep':
      return native.health.addListener('sleep', listenerFunc as (event: SleepEvent) => void);
    case 'soundClassification':
      return native.audio.addListener('soundClassification', listenerFunc as (event: SoundClassificationEvent) => void);
    case 'speechBurst':
      return native.audio.addListener('speechBurst', listenerFunc as (event: SpeechBurstEvent) => void);
    case 'steps':
      return native.health.addListener('steps', listenerFunc as (event: StepsEvent) => void);
    case 'transcriptDraft':
      return native.audio.addListener('transcriptDraft', listenerFunc as (event: TranscriptDraftEvent) => void);
    case 'transcriptReady':
      return native.audio.addListener('transcriptReady', listenerFunc as (event: TranscriptReadyEvent) => void);
    case 'transcriptRefined':
      return native.audio.addListener('transcriptRefined', listenerFunc as (event: TranscriptRefinedEvent) => void);
    case 'visit':
      return native.visit.addListener('visit', listenerFunc as (event: VisitEvent) => void);
    case 'modelDownloadProgress':
      return native.models.addListener(
        'modelDownloadProgress',
        listenerFunc as (event: ModelDownloadProgressEvent) => void,
      );
    case 'modelDownloadDone':
      return native.models.addListener(
        'modelDownloadDone',
        listenerFunc as (event: ModelDownloadProgressEvent) => void,
      );
    default:
      return noopHandle();
  }
}
